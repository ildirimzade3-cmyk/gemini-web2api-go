package app

import (
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	tls_client "github.com/bogdanfinn/tls-client"
	"github.com/bogdanfinn/tls-client/profiles"
)

var (
	clientCache   = map[string]tls_client.HttpClient{}
	clientCacheMu sync.RWMutex
)

// resolveProfile maps a config string to a tls-client ClientProfile.
// Defaults to Chrome_146 (matches Python v2's curl_cffi chrome146).
func resolveProfile(name string) profiles.ClientProfile {
	switch strings.ToLower(name) {
	case "chrome_120":
		return profiles.Chrome_120
	case "chrome_124":
		return profiles.Chrome_124
	case "chrome_131":
		return profiles.Chrome_131
	case "chrome_133":
		return profiles.Chrome_133
	case "chrome_144":
		return profiles.Chrome_144
	case "chrome_146", "chrome146":
		return profiles.Chrome_146
	case "firefox_120":
		return profiles.Firefox_120
	case "firefox_123":
		return profiles.Firefox_123
	case "firefox_147", "firefox147":
		return profiles.Firefox_147
	case "safari_16_0":
		return profiles.Safari_16_0
	case "safari_ios_17_0":
		return profiles.Safari_IOS_17_0
	default:
		return profiles.Chrome_146
	}
}

// geminiBaseURL is the web app origin. A variable only so tests can point the
// StreamGenerate and /app calls at a local server.
var geminiBaseURL = "https://gemini.google.com"

// Timeout model for upstream calls.

// Google's "thinking" and writing time is not ours to cut: a generation call
// carries no client-side time limit. What bounds it is (a) the inbound request
// context (a client disconnect cancels the Google call), and (b) generationCeiling,
// a dead-connection guard only. Small control requests (XSRF/bl page fetch,
// RotateCookies, uploads, media downloads) keep the short request_timeout_sec.
const (
	// generationCeiling bounds one whole generation, retries included. It exists
	// only so a silently dead connection cannot pin a slot forever; it is far above
	// any real answer time.
	generationCeiling = 600 * time.Second
	// upstreamKeepAlive is the TCP keepalive period on upstream connections, so a
	// half-dead connection is detected while a long answer is being waited for.
	upstreamKeepAlive = 30 * time.Second
	// upstreamDialTimeout bounds only the TCP connect of the stdlib (proxy) path.
	upstreamDialTimeout = 30 * time.Second
)

// getTLSClient returns the control-request tls-client (Chrome 146 fingerprint) for
// direct connections only: request_timeout_sec is a hard total timeout, body read
// included. Generation calls use getTLSGenClient.
// For proxied connections we use stdlib (see getStdlibClient) — tls-client's SOCKS5
// implementation is fragile compared to net/http.
func getTLSClient() tls_client.HttpClient {
	return cachedTLSClient(rtCfg().Impersonate, rtCfg().RequestTimeout)
}

// getTLSGenClient returns the generation tls-client: no http.Client.Timeout, the
// caller's context and generationCeiling are the only bounds.
func getTLSGenClient() tls_client.HttpClient {
	return cachedTLSClient("gen:"+rtCfg().Impersonate, 0)
}

// cachedTLSClient builds (once per key) a tls-client. timeoutSec == 0 means no
// total timeout. WithDialer carries the TCP keepalive; tls-client overwrites the
// dialer's connect timeout with timeoutSec (0 = bounded by the request context).
func cachedTLSClient(key string, timeoutSec int) tls_client.HttpClient {
	clientCacheMu.RLock()
	if c, ok := clientCache[key]; ok {
		clientCacheMu.RUnlock()
		return c
	}
	clientCacheMu.RUnlock()

	clientCacheMu.Lock()
	defer clientCacheMu.Unlock()
	if c, ok := clientCache[key]; ok {
		return c
	}
	opts := []tls_client.HttpClientOption{
		tls_client.WithTimeoutSeconds(timeoutSec),
		tls_client.WithClientProfile(resolveProfile(rtCfg().Impersonate)),
		tls_client.WithNotFollowRedirects(),
		tls_client.WithDialer(net.Dialer{KeepAlive: upstreamKeepAlive}),
	}
	client, err := tls_client.NewHttpClient(tls_client.NewNoopLogger(), opts...)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[client] tls-client init failed: %v\n", err)
		os.Exit(1)
	}
	clientCache[key] = client
	return client
}

// ─── Stdlib HTTP client for proxied requests ─────────────────────────────────
//
// 走代理时改用 stdlib 而不是 tls-client，因为：
// 1. stdlib 的 http.ProxyURL 原生支持 socks5:// / socks5h:// / http:// / https://，
//    已知能过我们手头的代理。
// 2. tls-client 自带的 SOCKS 实现在某些代理端会 EOF（已实测）。
//
// 代价要写清楚：走代理时 Google 看到的是**我们自己的 TLS 指纹**，即 Go 标准库的，
// 不是 Chrome 146 的。HTTP CONNECT 只建隧道，TLS 是我们跟目标端到端握的。
// JA3 回显实测：stdlib 直连和过代理是同一个 JA3（03117a8e…），而同一个代理下换成
// tls-client 就变成另一个（2d25c563…）——两条判据都说明代理不介入 TLS。
//
// 但这不构成换回 tls-client 的理由：同时起跑的对照里 tls-client Chrome_146 打到
// 111 次被拦、Go stdlib 103 次，差 8 次；而同配置换个出口的方差能到 36%
// （151 vs 111）。指纹差异真实存在，对封禁阈值没有可观测影响。
//
// 不走代理时仍然用 getTLSClient（保留 utls/chrome146 真指纹优势）。

var (
	stdlibClientCache sync.Map // proxyURL -> *http.Client (control requests)
	stdlibGenCache    sync.Map // proxyURL -> *http.Client (generation requests)
)

// getStdlibClient returns the control-request http.Client routed through proxyURL
// (request_timeout_sec total timeout). proxyURL must not be empty (caller checks).
func getStdlibClient(proxyURL string) *http.Client {
	return cachedStdlibClient(&stdlibClientCache, proxyURL, time.Duration(rtCfg().RequestTimeout)*time.Second)
}

// getStdlibGenClient is the generation variant: no http.Client.Timeout.
func getStdlibGenClient(proxyURL string) *http.Client {
	return cachedStdlibClient(&stdlibGenCache, proxyURL, 0)
}

func cachedStdlibClient(cache *sync.Map, proxyURL string, timeout time.Duration) *http.Client {
	if cached, ok := cache.Load(proxyURL); ok {
		return cached.(*http.Client)
	}
	t := &http.Transport{
		MaxIdleConns:        100,
		MaxIdleConnsPerHost: 20,
		IdleConnTimeout:     90 * time.Second,
		DisableCompression:  false,
		// 走代理时不强求 HTTP/2，部分代理不支持。
		ForceAttemptHTTP2: false,
		// TCP keepalive on the upstream connection; the timeout bounds connect only.
		DialContext: (&net.Dialer{
			Timeout:   upstreamDialTimeout,
			KeepAlive: upstreamKeepAlive,
		}).DialContext,
		TLSHandshakeTimeout: 15 * time.Second,
		// No ResponseHeaderTimeout: Google may think for minutes before the first byte.
	}
	if u, err := url.Parse(proxyURL); err == nil {
		t.Proxy = http.ProxyURL(u)
	}
	c := &http.Client{
		Timeout:   timeout,
		Transport: t,
		// 跟 tls-client 一致：不自动跟随重定向（302 是诊断信号）
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	actual, _ := cache.LoadOrStore(proxyURL, c)
	return actual.(*http.Client)
}

// loadCookie reads the cookie file (Netscape one-line format or JSON).
// loadCookie 返回 (cookie 串, SAPISID)。只有旁路探测在用 —— 正式请求那条路
// 在 streamGenerate 里自己挑号，因为它还要挨个换号和绑定出口。
//
// cookie 只有 cookie 池一个来源：挑一个 enabled 账号（最久未用优先，自动轮转
// 分散单 IP 上限）。池空 = 匿名。原来那条「池空回落单 cookie」的路径已经取消，
// 它的值在启动时被 seedCookiesFromConfig 并进池子了。
//
// 第三个返回值是池里那条记录的 ID，请求结束后拿它调 markCookieByStatus 回写健康度。
func loadCookie() (cookie, sapisid string) {
	if a, ok := pickCookieAccount(); ok {
		return a.Cookie, extractSAPISID(a.Cookie)
	}
	return "", ""
}

func makeSAPISIDHash(sapisid string) string {
	ts := time.Now().Unix()
	h := sha1.Sum([]byte(fmt.Sprintf("%d %s https://gemini.google.com", ts, sapisid)))
	return fmt.Sprintf("SAPISIDHASH %d_%s", ts, hex.EncodeToString(h[:]))
}

// ChromeUA 是给 stdlib 走代理时用的 Chrome 146 真实 UA 模板。
const ChromeUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36"

// applyChromeHeaders 给 stdlib 请求填上模拟 Chrome 146 的应用层 header。
// utls 那层做 TLS/HTTP2 指纹我们做不到（走代理），但 header 一定要齐。
func applyChromeHeaders(req *http.Request) {
	req.Header.Set("User-Agent", ChromeUA)
	req.Header.Set("Sec-CH-UA", `"Chromium";v="146", "Google Chrome";v="146", "Not?A_Brand";v="24"`)
	req.Header.Set("Sec-CH-UA-Mobile", "?0")
	req.Header.Set("Sec-CH-UA-Platform", `"Windows"`)
	req.Header.Set("Sec-Fetch-Dest", "empty")
	req.Header.Set("Sec-Fetch-Mode", "cors")
	req.Header.Set("Sec-Fetch-Site", "same-origin")
}
