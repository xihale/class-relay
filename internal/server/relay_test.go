package server

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

type testEnv struct {
	t *testing.T
	s *Server
	h http.Handler
}

func newTestEnv(t *testing.T, opt Options) *testEnv {
	t.Helper()
	s := New(opt)
	t.Cleanup(s.Close)
	return &testEnv{t: t, s: s, h: s.Handler()}
}

func (e *testEnv) do(method, path string, body any) (int, map[string]any, *httptest.ResponseRecorder) {
	e.t.Helper()
	var rd *bytes.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			e.t.Fatal(err)
		}
		rd = bytes.NewReader(b)
	} else {
		rd = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, path, rd)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	rec := httptest.NewRecorder()
	e.h.ServeHTTP(rec, req)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out, rec
}

func TestRelayPushPollClearAndValidation(t *testing.T) {
	e := newTestEnv(t, Options{})

	// 非法房间名拒绝
	if code, _, _ := e.do("GET", "/api/v1/relay/bad!room", nil); code != 400 {
		t.Fatalf("bad room want 400 got %d", code)
	}
	if code, _, _ := e.do("GET", "/api/v1/relay/ab", nil); code != 400 {
		t.Fatalf("short room want 400 got %d", code)
	}
	if code, _, _ := e.do("POST", "/api/v1/relay/dorm402", map[string]any{"url": "javascript:alert(1)"}); code != 400 {
		t.Fatalf("javascript url want 400 got %d", code)
	}
	if code, _, _ := e.do("POST", "/api/v1/relay/dorm402", map[string]any{"url": "https://"}); code != 400 {
		t.Fatalf("empty host want 400 got %d", code)
	}
	longURL := "https://example.com/" + strings.Repeat("a", 2050)
	if code, _, _ := e.do("POST", "/api/v1/relay/dorm402", map[string]any{"url": longURL}); code != 400 {
		t.Fatalf("too long url want 400 got %d", code)
	}

	// 空房间即时轮询
	code, out, rec := e.do("GET", "/api/v1/relay/dorm402?since=0&wait=0", nil)
	if code != 200 || out["active"] != false {
		t.Fatalf("empty poll: %d %v", code, out)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("api Cache-Control want no-store got %q", cc)
	}

	// 推送有效链接（测试 TTL 下限夹紧：5 -> 15）
	code, out, _ = e.do("POST", "/api/v1/relay/dorm402", map[string]any{
		"url":    "https://v18.teachermate.cn/wechat-pro-student/#/sign?id=42",
		"source": "微助教",
		"ttlSec": 5,
	})
	if code != 200 || out["active"] != true || out["host"] != "v18.teachermate.cn" {
		t.Fatalf("push failed: %d %v", code, out)
	}
	ttlMs := int64(out["expiresAt"].(float64)) - int64(out["createdAt"].(float64))
	if ttlMs != 15000 {
		t.Fatalf("ttl clamp min want 15000ms got %dms", ttlMs)
	}
	if seq := int64(out["seq"].(float64)); seq != 1 {
		t.Fatalf("want seq 1 got %d", seq)
	}

	// 即时拉取应命中
	code, out, _ = e.do("GET", "/api/v1/relay/dorm402?since=0&wait=0", nil)
	if code != 200 || out["active"] != true || out["url"] != "https://v18.teachermate.cn/wechat-pro-student/#/sign?id=42" {
		t.Fatalf("poll hit failed: %d %v", code, out)
	}

	// 清除后恢复空状态
	code, out, _ = e.do("DELETE", "/api/v1/relay/dorm402", nil)
	if code != 200 || out["active"] != false {
		t.Fatalf("clear failed: %d %v", code, out)
	}
}

func TestRelayLongPollWakesOnPush(t *testing.T) {
	e := newTestEnv(t, Options{})

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	req := httptest.NewRequest("GET", "/api/v1/relay/room99?since=0&wait=5", nil).WithContext(ctx)
	rec := httptest.NewRecorder()

	done := make(chan struct{})
	go func() {
		defer close(done)
		e.h.ServeHTTP(rec, req)
	}()

	time.Sleep(40 * time.Millisecond)
	code, _, _ := e.do("POST", "/api/v1/relay/room99", map[string]any{
		"url":    "https://www.yuketang.cn/v/index",
		"source": "雨课堂",
	})
	if code != 200 {
		t.Fatalf("push failed: %d", code)
	}

	select {
	case <-done:
	case <-time.After(1 * time.Second):
		t.Fatal("long poll did not wake up promptly after push")
	}

	if rec.Code != 200 {
		t.Fatalf("long poll status %d", rec.Code)
	}
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out["active"] != true || out["source"] != "雨课堂" {
		t.Fatalf("unexpected long poll response: %v", out)
	}
}

func TestRelayHubEviction(t *testing.T) {
	hub := newRelayHub()
	defer hub.Close()
	base := time.Now().Add(-2 * time.Hour)
	for i := 0; i < relayMaxRooms; i++ {
		id := fmt.Sprintf("room_%03d", i)
		rm := hub.getRoom(id, true)
		rm.mu.Lock()
		rm.updated = base.Add(time.Duration(i) * time.Second)
		rm.mu.Unlock()
	}
	if len(hub.rooms) != relayMaxRooms {
		t.Fatalf("want %d rooms got %d", relayMaxRooms, len(hub.rooms))
	}
	// 添加第 513 个房间，应淘汰最旧的 room_000
	hub.getRoom("room_new", true)
	if len(hub.rooms) != relayMaxRooms {
		t.Fatalf("after eviction want %d rooms got %d", relayMaxRooms, len(hub.rooms))
	}
	if hub.getRoom("room_000", false) != nil {
		t.Fatalf("expected oldest room_000 to be evicted")
	}
	if hub.getRoom("room_new", false) == nil {
		t.Fatalf("expected room_new to exist")
	}
}

func TestHealthzRedirectsHeadersAndStatic(t *testing.T) {
	e := newTestEnv(t, Options{TrustProxy: true})

	// /healthz
	code, out, rec := e.do("GET", "/healthz", nil)
	if code != 200 || out["ok"] != true {
		t.Fatalf("/healthz want 200 ok:true got %d %v", code, out)
	}
	if csp := rec.Header().Get("Content-Security-Policy"); !strings.Contains(csp, "script-src 'self' 'wasm-unsafe-eval';") || !strings.Contains(csp, "worker-src 'self';") || strings.Contains(csp, "wx.qq.com") || !strings.Contains(csp, "img-src 'self' data: blob:") || !strings.Contains(csp, "media-src 'self' blob:") {
		t.Fatalf("unexpected CSP: %q", csp)
	}
	if pp := rec.Header().Get("Permissions-Policy"); pp != "camera=(self)" {
		t.Fatalf("unexpected Permissions-Policy: %q", pp)
	}

	// /relay 和 /relay/ 重定向保留 query 参数
	for _, p := range []string{"/relay?room=dorm402&mode=send", "/relay/?room=dorm402"} {
		req := httptest.NewRequest("GET", p, nil)
		rec := httptest.NewRecorder()
		e.h.ServeHTTP(rec, req)
		want := "/" + p[strings.Index(p, "?"):]
		if rec.Code != http.StatusMovedPermanently || rec.Header().Get("Location") != want {
			t.Fatalf("GET %s want 301 %q got %d %q", p, want, rec.Code, rec.Header().Get("Location"))
		}
	}

	// 静态首页
	req := httptest.NewRequest("GET", "/", nil)
	rec = httptest.NewRecorder()
	e.h.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("GET / want 200 got %d", rec.Code)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-cache" {
		t.Fatalf("GET / Cache-Control want no-cache got %q", cc)
	}

	// WASM 静态资源与长缓存
	reqWasm := httptest.NewRequest("GET", "/vendor/zxing_reader.wasm", nil)
	recWasm := httptest.NewRecorder()
	e.h.ServeHTTP(recWasm, reqWasm)
	if recWasm.Code != 200 {
		t.Fatalf("GET /vendor/zxing_reader.wasm want 200 got %d", recWasm.Code)
	}
	if ct := recWasm.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/wasm") {
		t.Fatalf("GET /vendor/zxing_reader.wasm Content-Type want prefix application/wasm got %q", ct)
	}
	if cc := recWasm.Header().Get("Cache-Control"); cc != "public, max-age=604800" {
		t.Fatalf("GET /vendor/zxing_reader.wasm Cache-Control want public, max-age=604800 got %q", cc)
	}

	// Web Worker 脚本与 no-cache
	reqWorker := httptest.NewRequest("GET", "/scanner-worker.js", nil)
	recWorker := httptest.NewRecorder()
	e.h.ServeHTTP(recWorker, reqWorker)
	if recWorker.Code != 200 {
		t.Fatalf("GET /scanner-worker.js want 200 got %d", recWorker.Code)
	}
	if cc := recWorker.Header().Get("Cache-Control"); cc != "no-cache" {
		t.Fatalf("GET /scanner-worker.js Cache-Control want no-cache got %q", cc)
	}

	// clientIP with TrustProxy
	r1 := httptest.NewRequest("GET", "/healthz", nil)
	r1.RemoteAddr = "127.0.0.1:12345"
	r1.Header.Set("X-Forwarded-For", "203.0.113.5, 10.0.0.1")
	if got := e.s.clientIP(r1); got != "203.0.113.5" {
		t.Fatalf("clientIP XFF want 203.0.113.5 got %q", got)
	}
	r2 := httptest.NewRequest("GET", "/healthz", nil)
	r2.RemoteAddr = "127.0.0.1:12345"
	r2.Header.Set("X-Real-IP", "198.51.100.7")
	if got := e.s.clientIP(r2); got != "198.51.100.7" {
		t.Fatalf("clientIP X-Real-IP want 198.51.100.7 got %q", got)
	}
}

func TestRelayPollImmediateAfterDelete(t *testing.T) {
	e := newTestEnv(t, Options{})

	code, out, _ := e.do("POST", "/api/v1/relay/clearroom", map[string]any{
		"url": "https://example.com/a",
	})
	if code != 200 || int64(out["seq"].(float64)) != 1 {
		t.Fatalf("push failed: %d %v", code, out)
	}

	code, out, _ = e.do("DELETE", "/api/v1/relay/clearroom", nil)
	if code != 200 || int64(out["seq"].(float64)) != 2 {
		t.Fatalf("delete failed: %d %v", code, out)
	}

	// Client with since=1 polling with wait=5 must return immediately with seq=2, active=false.
	start := time.Now()
	code, out, _ = e.do("GET", "/api/v1/relay/clearroom?since=1&wait=5", nil)
	elapsed := time.Since(start)
	if code != 200 || out["active"] != false || int64(out["seq"].(float64)) != 2 {
		t.Fatalf("unexpected poll response: %d %v", code, out)
	}
	if elapsed > 500*time.Millisecond {
		t.Fatalf("poll blocked %v instead of returning immediately after DELETE", elapsed)
	}
}

func TestStaticGzipAndETag304(t *testing.T) {
	e := newTestEnv(t, Options{})

	for _, tc := range []struct {
		path string
		ct   string
		cc   string
	}{
		{"/vendor/zxing_reader.wasm", "application/wasm", "public, max-age=604800"},
		{"/scanner-worker.js", "text/javascript", "no-cache"},
	} {
		// Uncompressed request
		reqRaw := httptest.NewRequest("GET", tc.path, nil)
		recRaw := httptest.NewRecorder()
		e.h.ServeHTTP(recRaw, reqRaw)
		if recRaw.Code != 200 {
			t.Fatalf("%s raw want 200 got %d", tc.path, recRaw.Code)
		}
		if ct := recRaw.Header().Get("Content-Type"); !strings.HasPrefix(ct, tc.ct) {
			t.Fatalf("%s Content-Type want prefix %q got %q", tc.path, tc.ct, ct)
		}
		if cc := recRaw.Header().Get("Cache-Control"); cc != tc.cc {
			t.Fatalf("%s Cache-Control want %q got %q", tc.path, tc.cc, cc)
		}
		rawETag := recRaw.Header().Get("ETag")
		if rawETag == "" || strings.HasSuffix(rawETag, `-gz"`) {
			t.Fatalf("%s unexpected raw ETag %q", tc.path, rawETag)
		}
		if vary := recRaw.Header().Get("Vary"); vary != "Accept-Encoding" {
			t.Fatalf("%s Vary want Accept-Encoding got %q", tc.path, vary)
		}

		// Gzipped request
		reqGz := httptest.NewRequest("GET", tc.path, nil)
		reqGz.Header.Set("Accept-Encoding", "br, gzip")
		recGz := httptest.NewRecorder()
		e.h.ServeHTTP(recGz, reqGz)
		if recGz.Code != 200 {
			t.Fatalf("%s gz want 200 got %d", tc.path, recGz.Code)
		}
		if ce := recGz.Header().Get("Content-Encoding"); ce != "gzip" {
			t.Fatalf("%s Content-Encoding want gzip got %q", tc.path, ce)
		}
		gzETag := recGz.Header().Get("ETag")
		if !strings.HasSuffix(gzETag, `-gz"`) || gzETag == rawETag {
			t.Fatalf("%s unexpected gz ETag %q", tc.path, gzETag)
		}
		gr, err := gzip.NewReader(bytes.NewReader(recGz.Body.Bytes()))
		if err != nil {
			t.Fatalf("%s gzip reader: %v", tc.path, err)
		}
		decompressed, err := io.ReadAll(gr)
		_ = gr.Close()
		if err != nil {
			t.Fatalf("%s gzip read: %v", tc.path, err)
		}
		if !bytes.Equal(decompressed, recRaw.Body.Bytes()) {
			t.Fatalf("%s decompressed body mismatch", tc.path)
		}

		// 304 Not Modified for gzip ETag
		req304Gz := httptest.NewRequest("GET", tc.path, nil)
		req304Gz.Header.Set("Accept-Encoding", "gzip")
		req304Gz.Header.Set("If-None-Match", gzETag)
		rec304Gz := httptest.NewRecorder()
		e.h.ServeHTTP(rec304Gz, req304Gz)
		if rec304Gz.Code != http.StatusNotModified || rec304Gz.Body.Len() != 0 {
			t.Fatalf("%s 304 gz want 304 empty got %d len=%d", tc.path, rec304Gz.Code, rec304Gz.Body.Len())
		}

		// Encoding-aware ETag: raw ETag with Accept-Encoding: gzip must return 200, not 304
		reqMismatch := httptest.NewRequest("GET", tc.path, nil)
		reqMismatch.Header.Set("Accept-Encoding", "gzip")
		reqMismatch.Header.Set("If-None-Match", rawETag)
		recMismatch := httptest.NewRecorder()
		e.h.ServeHTTP(recMismatch, reqMismatch)
		if recMismatch.Code != http.StatusOK {
			t.Fatalf("%s raw ETag with gzip encoding want 200 got %d", tc.path, recMismatch.Code)
		}

		// Accept-Encoding: gzip;q=0 must not compress
		reqQ0 := httptest.NewRequest("GET", tc.path, nil)
		reqQ0.Header.Set("Accept-Encoding", "gzip;q=0")
		recQ0 := httptest.NewRecorder()
		e.h.ServeHTTP(recQ0, reqQ0)
		if recQ0.Header().Get("Content-Encoding") != "" {
			t.Fatalf("%s q=0 should not gzip", tc.path)
		}
	}
}

func TestRelayWaiterCaps429(t *testing.T) {
	e := newTestEnv(t, Options{})

	// Per-room cap
	rm := e.s.relay.getRoom("caproom", true)
	rm.mu.Lock()
	for i := 0; i < relayMaxWaitersPerRoom; i++ {
		rm.waiters[make(chan struct{})] = struct{}{}
	}
	rm.mu.Unlock()

	code, out, _ := e.do("GET", "/api/v1/relay/caproom?since=0&wait=5", nil)
	if code != http.StatusTooManyRequests || out["error"] != "too_many_waiters" {
		t.Fatalf("per-room cap want 429 too_many_waiters got %d %v", code, out)
	}

	// Global cap
	e.s.relay.waiters.Store(relayMaxWaitersTotal)
	code, out, _ = e.do("GET", "/api/v1/relay/otherroom?since=0&wait=5", nil)
	if code != http.StatusTooManyRequests || out["error"] != "too_many_waiters" {
		t.Fatalf("global cap want 429 too_many_waiters got %d %v", code, out)
	}
	e.s.relay.waiters.Store(0)
}

func TestRelayEvictionProtectsActiveWaiters(t *testing.T) {
	hub := newRelayHub()
	defer hub.Close()

	base := time.Now().Add(-2 * time.Hour)
	var waiterCh chan struct{}
	for i := 0; i < relayMaxRooms; i++ {
		id := fmt.Sprintf("wroom_%03d", i)
		rm := hub.getRoom(id, true)
		rm.mu.Lock()
		rm.updated = base.Add(time.Duration(i) * time.Second)
		if i == 0 {
			waiterCh = make(chan struct{})
			rm.waiters[waiterCh] = struct{}{}
		}
		rm.mu.Unlock()
	}

	// Evicting to make room for wroom_new must skip wroom_000 (has active waiter) and evict wroom_001.
	if rm := hub.getRoom("wroom_new", true); rm == nil {
		t.Fatal("expected wroom_new to be created")
	}
	if hub.getRoom("wroom_000", false) == nil {
		t.Fatal("expected wroom_000 with active waiter to be preserved")
	}
	if hub.getRoom("wroom_001", false) != nil {
		t.Fatal("expected idle oldest wroom_001 to be evicted")
	}

	// If an active-waiter room is stale (> relayRoomMaxAge), eviction must notify waiter before deleting.
	rm0 := hub.getRoom("wroom_000", false)
	rm0.mu.Lock()
	rm0.updated = time.Now().Add(-relayRoomMaxAge - time.Minute)
	rm0.mu.Unlock()

	if rm := hub.getRoom("wroom_new2", true); rm == nil {
		t.Fatal("expected wroom_new2 to be created")
	}
	select {
	case <-waiterCh:
	default:
		t.Fatal("expected waiter channel on stale room to be closed before eviction")
	}
	if hub.getRoom("wroom_000", false) != nil {
		t.Fatal("expected stale wroom_000 to be evicted")
	}
}

func TestRelayJanitorAndShutdownNoLeak(t *testing.T) {
	before := runtime.NumGoroutine()
	hub := newRelayHubWithJanitor(10 * time.Millisecond)

	rm := hub.getRoom("stale_room", true)
	rm.mu.Lock()
	rm.updated = time.Now().Add(-relayRoomMaxAge - time.Minute)
	rm.item = &relayItem{
		Seq:       1,
		Room:      "stale_room",
		URL:       "https://example.com",
		ExpiresAt: time.Now().Add(-time.Minute),
	}
	waitCh := make(chan struct{})
	rm.waiters[waitCh] = struct{}{}
	rm.mu.Unlock()

	deadline := time.Now().Add(1 * time.Second)
	for time.Now().Before(deadline) {
		if hub.getRoom("stale_room", false) == nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if hub.getRoom("stale_room", false) != nil {
		t.Fatal("janitor did not purge stale room")
	}
	select {
	case <-waitCh:
	default:
		t.Fatal("janitor did not notify waiter on purged stale room")
	}

	hub.Close()
	hub.Close() // idempotent

	// Allow runtime scheduler a brief moment to park exited goroutine.
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		runtime.Gosched()
	}()
	wg.Wait()
	if after := runtime.NumGoroutine(); after > before+1 {
		t.Fatalf("goroutine leak detected: before=%d after=%d", before, after)
	}
}
