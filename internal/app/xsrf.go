package app

import (
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	fhttp "github.com/bogdanfinn/fhttp"
)

// Gemini 在带登录 cookie 时要求 batchexecute 请求多带一个表单字段 at（XSRF token），
// 不带就直接 400，响应体形如 [["er",...,400,...,[{"48448350":["xsrf", ...]}]]]。
// 匿名请求不需要它，所以这个坑一直没暴露——一挂上有效 cookie，所有请求立刻全挂。
//
// token 来自 /app 页面 HTML 里的 "SNlM0e":"<token>:<毫秒时间戳>"，跟 cookie 会话
// 绑定，所以按 cookie 分别缓存。实测同一 token 可以复用，过期后服务端还是回 xsrf
// 错误，调用方拿到这个错要 invalidate 再取一次。
var (
	xsrfMu    sync.Mutex
	xsrfCache = map[string]xsrfEntry{}
)

type xsrfEntry struct {
	token   string
	pushID  string // 上传文件用的 Push-ID 头
	pctx    string // 上传文件用的 X-Client-Pctx 头
	fetched time.Time
}

// xsrfLastState is the outcome of the most recent login-token fetch, for /healthz:
// 0 = none yet, 1 = ok, 2 = failed.
var xsrfLastState atomic.Int32

func recordXSRFResult(err error) {
	if err == nil {
		xsrfLastState.Store(1)
	} else {
		xsrfLastState.Store(2)
	}
}

// xsrfLastOK reports the most recent token fetch outcome; nil = no fetch yet.
func xsrfLastOK() *bool {
	switch xsrfLastState.Load() {
	case 1:
		t := true
		return &t
	case 2:
		f := false
		return &f
	}
	return nil
}

// 页面上的 token 没写明有效期，取个保守值定期重取。
const xsrfTTL = 20 * time.Minute

var snlm0eRe = regexp.MustCompile(`"SNlM0e":"([^"]{10,200})"`)

// 上传要的两个页面参数，跟 XSRF token 同页取，省一次页面请求。
var pushIDRe = regexp.MustCompile(`"qKIAYe":"([^"]{4,400})"`)

var pctxRe = regexp.MustCompile(`"Ylro7b":"([^"]{4,400})"`)

// cookieKey 用 cookie 的短摘要当缓存键，避免把整串凭证塞进 map key。
func cookieKey(cookie string) string {
	sum := sha1.Sum([]byte(cookie))
	return hex.EncodeToString(sum[:8])
}

// invalidateXSRF 丢掉某个 cookie 的缓存 token，下次取会重新抓页面。
func invalidateXSRF(cookie string) {
	if cookie == "" {
		return
	}
	xsrfMu.Lock()
	delete(xsrfCache, cookieKey(cookie))
	xsrfMu.Unlock()
}

// getXSRF 取该 cookie 对应的 XSRF token；命中缓存且没过期就直接返回。
// cookie 为空（匿名）时返回空串——匿名请求不需要这个字段。
func getXSRF(cookie, proxyURL string) (string, error) {
	if cookie == "" {
		return "", nil
	}
	key := cookieKey(cookie)

	xsrfMu.Lock()
	if e, ok := xsrfCache[key]; ok && time.Since(e.fetched) < xsrfTTL {
		xsrfMu.Unlock()
		return e.token, nil
	}
	xsrfMu.Unlock()

	e, err := fetchAppTokens(cookie, proxyURL)
	recordXSRFResult(err)
	if err != nil {
		return "", err
	}
	xsrfMu.Lock()
	xsrfCache[key] = e
	xsrfMu.Unlock()
	return e.token, nil
}

// getUploadTokens 取上传要用的 Push-ID / X-Client-Pctx，跟 XSRF token 同一份缓存。
func getUploadTokens(cookie, proxyURL string) (pushID, pctx string, err error) {
	key := cookieKey(cookie)

	xsrfMu.Lock()
	if e, ok := xsrfCache[key]; ok && time.Since(e.fetched) < xsrfTTL {
		xsrfMu.Unlock()
		return e.pushID, e.pctx, nil
	}
	xsrfMu.Unlock()

	e, err := fetchAppTokens(cookie, proxyURL)
	recordXSRFResult(err)
	if err != nil {
		return "", "", err
	}
	xsrfMu.Lock()
	xsrfCache[key] = e
	xsrfMu.Unlock()
	return e.pushID, e.pctx, nil
}

// fetchAppPage 抓 gemini.google.com/app 的 HTML。
// 走跟主请求相同的出口：配了代理走 stdlib，没配走 tls-client，
// 免得页面里取到的 token 和后续请求来自两个不同 IP。
// cookie 传空串就是匿名抓（页面照样返回，只是没有登录态字段）。
func fetchAppPage(cookie, proxyURL string) ([]byte, error) {
	pageURL := geminiBaseURL + "/app"

	headers := map[string]string{
		"Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
		"Accept-Language": "en-US,en;q=0.9",
	}
	if cookie != "" {
		headers["Cookie"] = cookie
	}

	var body []byte
	if proxyURL != "" {
		req, err := http.NewRequest("GET", pageURL, nil)
		if err != nil {
			return nil, err
		}
		applyChromeHeaders(req)
		for k, v := range headers {
			req.Header.Set(k, v)
		}
		resp, err := getStdlibClient(proxyURL).Do(req)
		if err != nil {
			return nil, errUnavailable("fetch /app", err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			return nil, appPageStatusError(resp.StatusCode, resp.Header.Get("Location"),
				resp.Header.Get("Retry-After"), cookie != "")
		}
		body, err = io.ReadAll(resp.Body)
		if err != nil {
			return nil, errUnavailable("fetch /app", err)
		}
	} else {
		req, err := fhttp.NewRequest("GET", pageURL, nil)
		if err != nil {
			return nil, err
		}
		for k, v := range headers {
			req.Header.Set(k, v)
		}
		resp, err := getTLSClient().Do(req)
		if err != nil {
			return nil, errUnavailable("fetch /app", err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			return nil, appPageStatusError(resp.StatusCode, resp.Header.Get("Location"),
				resp.Header.Get("Retry-After"), cookie != "")
		}
		body, err = io.ReadAll(resp.Body)
		if err != nil {
			return nil, errUnavailable("fetch /app", err)
		}
	}
	return body, nil
}

// appPageStatusError classifies a non-200 answer to the /app page fetch. The
// "HTTP <code>" text stays in the message: explainCookieFailure matches on it.
func appPageStatusError(status int, location, retryAfter string, signedIn bool) error {
	ue := classifyHTTPFailure(status, "", location, retryAfter, signedIn)
	ue.Detail = fmt.Sprintf("fetch /app: HTTP %d", status)
	if strings.Contains(strings.ToLower(location), "/sorry") {
		ue.Detail += " (redirected to sorry)"
	}
	return ue
}

// fetchAppTokens 抓一次 /app 页面，把三个 token 一起抠出来。
func fetchAppTokens(cookie, proxyURL string) (xsrfEntry, error) {
	body, err := fetchAppPage(cookie, proxyURL)
	if err != nil {
		return xsrfEntry{}, err
	}
	e := xsrfEntry{fetched: time.Now()}
	if m := snlm0eRe.FindSubmatch(body); m != nil {
		e.token = string(m[1])
	} else if cookie != "" {
		// 带 cookie 却拿不到 token = cookie 已失效被当成匿名。匿名本就没这字段，不算错。
		return xsrfEntry{}, errNoAccount("no SNlM0e in page (cookie expired or not signed in)")
	}
	if p := pushIDRe.FindSubmatch(body); p != nil {
		e.pushID = string(p[1])
	}
	if p := pctxRe.FindSubmatch(body); p != nil {
		e.pctx = string(p[1])
	}
	return e, nil
}

// isXSRFError 判断上游 400 是不是 XSRF token 的问题。
// 响应体形如：[["er",null,...,400,...,[{"48448350":["xsrf","<新token>",...]}]]]
func isXSRFError(raw string) bool {
	return strings.Contains(raw, `"xsrf"`)
}
