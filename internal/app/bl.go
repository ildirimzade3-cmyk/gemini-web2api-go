package app

import (
	"fmt"
	"regexp"
	"sync"
	"time"
)

// bl 是上游前端的构建版本号，形如 boq_gemini-web-uiserver_20261007.01_p0，
// 每个 StreamGenerate 请求都要带。它埋在 /app 页面 HTML 的 "cfb2h" 字段里。
// （2026-10 上游把服务名从 assistant-bard-web-server 改成了 gemini-web-uiserver，
// 新旧两个值实测都还能用；校验正则已放宽不钉服务名，见 blValueRe。）
//
// 钉死一个值是能用的 —— 实测落后好几个月的旧值仍然正常。但"仍然可用"不等于"永远可用"，
// 而这个值一旦被上游弃用，表现是所有请求大面积失败，排查时很难第一时间想到
// 是个版本号过期了。既然 xsrf.go 本来就在抓 /app 页面，顺手取一下成本几乎为零。
var (
	blMu       sync.RWMutex
	blFetched  string    // 抓到的最新值，空表示还没抓到
	blFetchAt  time.Time // 上次抓取尝试的时间（成功失败都记，避免失败时疯狂重试）
	blFetching bool      // 有一次抓取正在飞
	blValueAt  time.Time // 抓到当前 blFetched 的时刻（healthz 用）
	blForcedAt time.Time // 上次强制刷新的时刻（5 分钟地板，见 forceRefreshBL）
)

// bl 变化的粒度是天，隔几小时看一眼足够。
const blTTL = 6 * time.Hour

var cfb2hRe = regexp.MustCompile(`"cfb2h":"([^"]{10,120})"`)

// blValueRe 卡住形状：boq_<服务名>_<8位日期>.<2位>_p<数字>。
// 页面上的 cfb2h 理论上就是这个格式，但它是外部输入，直接拿去拼 URL 等于让
// 上游页面决定我们发什么请求。形状对不上就当没抓到，继续用配置里钉的值 ——
// 宁可落后，不可乱发。
//
// 服务名那段不钉死（原来钉的是 assistant-bard-web-server）：2026-10 上游把服务
// 改名成 gemini-web-uiserver，钉死服务名会让自动跟随把新值当"形状不对"拒掉，于是
// 永远回退到配置里那个旧值。只校验 boq_ 前缀 + 日期.版本_p 后缀这个总体形状，
// 服务名随它改——够挡住抓错的垃圾，又扛得住改名。
var blValueRe = regexp.MustCompile(`^boq_[a-z0-9-]+_\d{8}\.\d{2}_p\d+$`)

// currentBL 返回这次请求该用的 bl。
//
// 不阻塞：过期时只是踢一次后台抓取，本次仍返回当前值。bl 是缓慢变化的版本号，
// 用旧值最多是落后几个版本（实测落后两个多月仍可用），不值得为它给每个请求
// 加一次页面抓取的延迟。auto 关掉时永远用配置里的值。
func currentBL(proxyURL string) string {
	// A bl a repair adopted (repair.go) was validated by a canary and beats both
	// the pinned and the scraped value.
	if bl, _ := learnedBL(); bl != "" {
		return bl
	}
	pinned := rtCfg().GeminiBL
	if !rtCfg().GeminiBLAuto {
		return pinned
	}

	blMu.RLock()
	val, fetchedAt, inflight := blFetched, blFetchAt, blFetching
	blMu.RUnlock()

	if !inflight && time.Since(fetchedAt) > blTTL {
		blMu.Lock()
		// 双检：并发请求下只放一个 goroutine 去抓。
		if !blFetching && time.Since(blFetchAt) > blTTL {
			blFetching = true
			go refreshBL(proxyURL)
		}
		blMu.Unlock()
	}

	if val != "" {
		return val
	}
	return pinned
}

// refreshBL 抓一次 /app 把 cfb2h 取出来。匿名抓即可，这个值跟登录态无关。
func refreshBL(proxyURL string) {
	defer func() {
		blMu.Lock()
		blFetching = false
		blFetchAt = time.Now() // 成功失败都记，失败时也要等满 TTL 再试
		blMu.Unlock()
	}()

	got, err := scrapeBL(proxyURL)
	if err != nil {
		logf("[bl] %v，继续用当前值", err)
		return
	}
	applyScrapedBL(got)
}

// scrapeBL fetches /app anonymously and returns a shape-validated bl value.
func scrapeBL(proxyURL string) (string, error) {
	body, err := fetchAppPage("", proxyURL)
	if err != nil {
		return "", fmt.Errorf("抓 /app 失败: %w", err)
	}
	m := cfb2hRe.FindSubmatch(body)
	if m == nil {
		return "", fmt.Errorf("页面里没有 cfb2h")
	}
	got := string(m[1])
	if !blValueRe.MatchString(got) {
		return "", fmt.Errorf("抓到的值形状不对，忽略: %q", truncate(got, 60))
	}
	return got, nil
}

// applyScrapedBL stores a scraped value and reports whether it differs from the
// value that was in effect until now. A change is written to the event log.
func applyScrapedBL(got string) (changed bool) {
	prev := rtCfg().GeminiBL
	blMu.Lock()
	if blFetched != "" {
		prev = blFetched
	}
	blFetched = got
	blValueAt = time.Now()
	blMu.Unlock()
	if got == prev {
		return false
	}
	logf("[bl] 更新为 %s（此前是 %s）", got, prev)
	LogEvent(EventBLChanged, fmt.Sprintf("bl %s -> %s", prev, got))
	return true
}

// blForceFloor is the minimum gap between two forced re-scrapes, so a burst of
// failing requests cannot hammer the /app page.
const blForceFloor = 5 * time.Minute

// forceRefreshBL re-scrapes bl right now (a request just failed in a way a stale
// bl explains: an unexplained 400 or unparseable frames). It respects blForceFloor
// and returns true only when the effective bl actually changed, i.e. when
// retrying the request can make a difference. With gemini_bl_auto off the pinned
// value is authoritative and nothing is scraped.
func forceRefreshBL(proxyURL string) bool {
	if !rtCfg().GeminiBLAuto {
		return false
	}
	blMu.Lock()
	if time.Since(blForcedAt) < blForceFloor {
		blMu.Unlock()
		return false
	}
	blForcedAt = time.Now()
	blMu.Unlock()

	got, err := scrapeBL(proxyURL)
	if err != nil {
		logf("[bl] 强制刷新失败: %v", err)
		return false
	}
	return applyScrapedBL(got)
}

// blStatus describes where the bl in use comes from, for /healthz: "repair" (a
// learned value), "auto" (scraped) or "config" (pinned). ageSec is nil when the
// value is the pinned config value (its age is unknown).
func blStatus() (ageSec *int64, source string) {
	if bl, at := learnedBL(); bl != "" {
		a := int64(time.Since(time.Unix(at, 0)).Seconds())
		return &a, "repair"
	}
	blMu.RLock()
	defer blMu.RUnlock()
	if rtCfg().GeminiBLAuto && blFetched != "" {
		a := int64(time.Since(blValueAt).Seconds())
		return &a, "auto"
	}
	return nil, "config"
}
