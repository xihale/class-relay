package server

import (
	"bufio"
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

	"github.com/coder/websocket"
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
	if _, ok := out["peers"].(map[string]any); !ok {
		t.Fatalf("expected peers in snapshot: %v", out)
	}
	if _, ok := out["receipts"].(map[string]any); !ok {
		t.Fatalf("expected receipts in snapshot: %v", out)
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
	csp := rec.Header().Get("Content-Security-Policy")
	for _, want := range []string{
		"default-src 'self';",
		"script-src 'self' 'wasm-unsafe-eval';",
		"worker-src 'self';",
		"style-src 'self';",
		"img-src 'self' data: blob:;",
		"media-src 'self' blob:;",
		"connect-src 'self' ws: wss:;",
		"base-uri 'none';",
		"frame-ancestors 'none';",
		"form-action 'self'",
	} {
		if !strings.Contains(csp, want) {
			t.Fatalf("CSP missing %q: %q", want, csp)
		}
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

	// /assets/* immutable 缓存
	var assetPath string
	for p := range e.s.assets {
		if strings.HasPrefix(p, "/assets/") {
			assetPath = p
			break
		}
	}
	if assetPath == "" {
		t.Fatal("expected at least one /assets/ file in embedded dist")
	}
	reqAsset := httptest.NewRequest("GET", assetPath, nil)
	recAsset := httptest.NewRecorder()
	e.h.ServeHTTP(recAsset, reqAsset)
	if recAsset.Code != 200 {
		t.Fatalf("GET %s want 200 got %d", assetPath, recAsset.Code)
	}
	if cc := recAsset.Header().Get("Cache-Control"); cc != "public, max-age=31536000, immutable" {
		t.Fatalf("GET %s Cache-Control want immutable got %q", assetPath, cc)
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

	var assetPath string
	for p := range e.s.assets {
		if strings.HasPrefix(p, "/assets/") && strings.HasSuffix(p, ".js") {
			assetPath = p
			break
		}
	}
	if assetPath == "" {
		t.Fatal("expected a .js asset under /assets/")
	}

	for _, tc := range []struct {
		path string
		ct   string
		cc   string
	}{
		{"/vendor/zxing_reader.wasm", "application/wasm", "public, max-age=604800"},
		{assetPath, "text/javascript", "public, max-age=31536000, immutable"},
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

func TestRestReceiptEndpoint(t *testing.T) {
	e := newTestEnv(t, Options{})

	// Push active item
	code, out, _ := e.do("POST", "/api/v1/relay/rcptroom", map[string]any{
		"url": "https://example.com/sign",
	})
	if code != 200 || int64(out["seq"].(float64)) != 1 {
		t.Fatalf("push failed: %d %v", code, out)
	}

	// Bad receipt kind
	if code, _, _ := e.do("POST", "/api/v1/relay/rcptroom/receipt", map[string]any{
		"seq": 1, "cid": "c1", "kind": "invalid",
	}); code != 400 {
		t.Fatalf("bad kind want 400 got %d", code)
	}

	// Delivered receipt
	code, out, _ = e.do("POST", "/api/v1/relay/rcptroom/receipt", map[string]any{
		"seq": 1, "cid": "c1", "kind": "delivered",
	})
	if code != 200 || out["ok"] != true {
		t.Fatalf("delivered receipt failed: %d %v", code, out)
	}
	rcpts := out["receipts"].(map[string]any)
	if int(rcpts["delivered"].(float64)) != 1 || int(rcpts["jumped"].(float64)) != 0 {
		t.Fatalf("unexpected receipts: %v", rcpts)
	}

	// Duplicate cid delivered should be idempotent
	code, out, _ = e.do("POST", "/api/v1/relay/rcptroom/receipt", map[string]any{
		"seq": 1, "cid": "c1", "kind": "delivered",
	})
	rcpts = out["receipts"].(map[string]any)
	if code != 200 || int(rcpts["delivered"].(float64)) != 1 {
		t.Fatalf("duplicate receipt should not double-count: %v", rcpts)
	}

	// Jumped receipt
	code, out, _ = e.do("POST", "/api/v1/relay/rcptroom/receipt", map[string]any{
		"seq": 1, "cid": "c1", "kind": "jumped",
	})
	rcpts = out["receipts"].(map[string]any)
	if code != 200 || int(rcpts["delivered"].(float64)) != 1 || int(rcpts["jumped"].(float64)) != 1 {
		t.Fatalf("jumped receipt failed: %v", rcpts)
	}

	// Stale seq should not record
	code, out, _ = e.do("POST", "/api/v1/relay/rcptroom/receipt", map[string]any{
		"seq": 99, "cid": "c2", "kind": "delivered",
	})
	rcpts = out["receipts"].(map[string]any)
	if code != 200 || int(rcpts["delivered"].(float64)) != 1 {
		t.Fatalf("stale seq should not count: %v", rcpts)
	}

	// New push resets receipts
	code, out, _ = e.do("POST", "/api/v1/relay/rcptroom", map[string]any{
		"url": "https://example.com/sign2",
	})
	rcpts = out["receipts"].(map[string]any)
	if code != 200 || int(rcpts["delivered"].(float64)) != 0 || int(rcpts["jumped"].(float64)) != 0 {
		t.Fatalf("push should reset receipts: %v", rcpts)
	}
}

func readWSJSON(t *testing.T, ctx context.Context, conn *websocket.Conn) map[string]any {
	t.Helper()
	_, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("ws read: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatalf("ws unmarshal %q: %v", string(data), err)
	}
	return m
}

func waitForWSState(t *testing.T, ctx context.Context, conn *websocket.Conn, pred func(map[string]any) bool) map[string]any {
	t.Helper()
	for {
		msg := readWSJSON(t, ctx, conn)
		if msg["type"] == "state" && pred(msg) {
			return msg
		}
	}
}

func TestWebSocketPeersPingPushClearAndReceipts(t *testing.T) {
	srv := New(Options{})
	t.Cleanup(srv.Close)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// Connect sender
	sendConn, _, err := websocket.Dial(ctx, wsURL+"/api/v1/relay/wsroom/ws?role=send&cid=s1", nil)
	if err != nil {
		t.Fatalf("dial sender: %v", err)
	}
	defer sendConn.CloseNow()

	st := readWSJSON(t, ctx, sendConn)
	if st["type"] != "state" {
		t.Fatalf("expected initial state, got %v", st)
	}
	peers := st["peers"].(map[string]any)
	if int(peers["total"].(float64)) != 1 || int(peers["send"].(float64)) != 1 || int(peers["recv"].(float64)) != 0 {
		t.Fatalf("unexpected sender initial peers: %v", peers)
	}

	// Connect receiver
	recvConn, _, err := websocket.Dial(ctx, wsURL+"/api/v1/relay/wsroom/ws?role=recv&cid=r1", nil)
	if err != nil {
		t.Fatalf("dial receiver: %v", err)
	}
	defer recvConn.CloseNow()

	// Both should see total=2, send=1, recv=1
	stRecv := waitForWSState(t, ctx, recvConn, func(m map[string]any) bool {
		p := m["peers"].(map[string]any)
		return int(p["total"].(float64)) == 2 && int(p["recv"].(float64)) == 1 && int(p["send"].(float64)) == 1
	})
	if stRecv["active"] != false {
		t.Fatalf("expected inactive initially: %v", stRecv)
	}
	waitForWSState(t, ctx, sendConn, func(m map[string]any) bool {
		p := m["peers"].(map[string]any)
		return int(p["total"].(float64)) == 2
	})

	// Ping -> Pong
	if err := sendConn.Write(ctx, websocket.MessageText, []byte(`{"type":"ping"}`)); err != nil {
		t.Fatal(err)
	}
	pong := readWSJSON(t, ctx, sendConn)
	if pong["type"] != "pong" || pong["serverTime"] == nil {
		t.Fatalf("expected pong, got %v", pong)
	}

	// Role switch: r1 switches to send, then back to recv
	if err := recvConn.Write(ctx, websocket.MessageText, []byte(`{"type":"role","role":"send"}`)); err != nil {
		t.Fatal(err)
	}
	waitForWSState(t, ctx, sendConn, func(m map[string]any) bool {
		p := m["peers"].(map[string]any)
		return int(p["send"].(float64)) == 2 && int(p["recv"].(float64)) == 0
	})
	if err := recvConn.Write(ctx, websocket.MessageText, []byte(`{"type":"role","role":"recv"}`)); err != nil {
		t.Fatal(err)
	}
	waitForWSState(t, ctx, sendConn, func(m map[string]any) bool {
		p := m["peers"].(map[string]any)
		return int(p["send"].(float64)) == 1 && int(p["recv"].(float64)) == 1
	})

	// WS push (invalid URL -> ack_push ok:false)
	if err := sendConn.Write(ctx, websocket.MessageText, []byte(`{"type":"push","reqId":"bad1","url":"javascript:alert(1)"}`)); err != nil {
		t.Fatal(err)
	}
	for {
		msg := readWSJSON(t, ctx, sendConn)
		if msg["type"] == "ack_push" {
			if msg["reqId"] != "bad1" || msg["ok"] != false || msg["error"] != "bad_url" {
				t.Fatalf("unexpected bad push ack: %v", msg)
			}
			break
		}
	}

	// WS push (valid URL)
	if err := sendConn.Write(ctx, websocket.MessageText, []byte(`{"type":"push","reqId":"req1","url":"https://v18.teachermate.cn/sign","source":"微助教","ttlSec":90}`)); err != nil {
		t.Fatal(err)
	}
	var gotAck bool
	for !gotAck {
		msg := readWSJSON(t, ctx, sendConn)
		if msg["type"] == "ack_push" {
			if msg["reqId"] != "req1" || msg["ok"] != true {
				t.Fatalf("unexpected push ack: %v", msg)
			}
			gotAck = true
		}
	}

	// Receiver gets broadcast
	recvPush := waitForWSState(t, ctx, recvConn, func(m map[string]any) bool {
		return m["active"] == true && int64(m["seq"].(float64)) == 1
	})
	if recvPush["url"] != "https://v18.teachermate.cn/sign" {
		t.Fatalf("unexpected pushed url: %v", recvPush)
	}

	// Receiver sends delivered + jumped receipts
	if err := recvConn.Write(ctx, websocket.MessageText, []byte(`{"type":"receipt","seq":1,"kind":"delivered"}`)); err != nil {
		t.Fatal(err)
	}
	if err := recvConn.Write(ctx, websocket.MessageText, []byte(`{"type":"receipt","seq":1,"kind":"jumped"}`)); err != nil {
		t.Fatal(err)
	}
	waitForWSState(t, ctx, sendConn, func(m map[string]any) bool {
		r := m["receipts"].(map[string]any)
		return int(r["delivered"].(float64)) == 1 && int(r["jumped"].(float64)) == 1
	})

	// WS clear
	if err := sendConn.Write(ctx, websocket.MessageText, []byte(`{"type":"clear","reqId":"clr1"}`)); err != nil {
		t.Fatal(err)
	}
	for {
		msg := readWSJSON(t, ctx, sendConn)
		if msg["type"] == "ack_push" && msg["reqId"] == "clr1" {
			if msg["ok"] != true {
				t.Fatalf("clear ack failed: %v", msg)
			}
			break
		}
	}
	waitForWSState(t, ctx, recvConn, func(m map[string]any) bool {
		return m["active"] == false && int64(m["seq"].(float64)) == 2
	})

	// Disconnect receiver -> sender sees peers drop to 1
	_ = recvConn.Close(websocket.StatusNormalClosure, "bye")
	waitForWSState(t, ctx, sendConn, func(m map[string]any) bool {
		p := m["peers"].(map[string]any)
		return int(p["total"].(float64)) == 1 && int(p["recv"].(float64)) == 0
	})
}

func TestSSEStreamingAndPeers(t *testing.T) {
	srv := New(Options{})
	t.Cleanup(srv.Close)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, "GET", ts.URL+"/api/v1/relay/sseroom/events?role=recv&cid=sse1", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("sse connect: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		t.Fatalf("sse status want 200 got %d", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "text/event-stream; charset=utf-8" {
		t.Fatalf("sse Content-Type got %q", ct)
	}
	if xab := resp.Header.Get("X-Accel-Buffering"); xab != "no" {
		t.Fatalf("sse X-Accel-Buffering got %q", xab)
	}

	reader := bufio.NewReader(resp.Body)
	readSSEState := func() map[string]any {
		t.Helper()
		var eventName, dataLine string
		for {
			line, err := reader.ReadString('\n')
			if err != nil {
				t.Fatalf("sse read: %v", err)
			}
			line = strings.TrimRight(line, "\r\n")
			if line == "" {
				if eventName == "state" && dataLine != "" {
					var m map[string]any
					if err := json.Unmarshal([]byte(dataLine), &m); err != nil {
						t.Fatalf("sse json: %v", err)
					}
					return m
				}
				eventName, dataLine = "", ""
				continue
			}
			if strings.HasPrefix(line, "event: ") {
				eventName = strings.TrimPrefix(line, "event: ")
			} else if strings.HasPrefix(line, "data: ") {
				dataLine = strings.TrimPrefix(line, "data: ")
			}
		}
	}

	// Initial SSE state
	st1 := readSSEState()
	peers := st1["peers"].(map[string]any)
	if st1["active"] != false || int(peers["total"].(float64)) != 1 || int(peers["recv"].(float64)) != 1 {
		t.Fatalf("unexpected initial SSE state: %v", st1)
	}

	// Push via REST -> SSE receives update
	pushResp, err := http.Post(ts.URL+"/api/v1/relay/sseroom", "application/json", strings.NewReader(`{"url":"https://www.yuketang.cn/sse","source":"雨课堂"}`))
	if err != nil {
		t.Fatal(err)
	}
	_ = pushResp.Body.Close()
	if pushResp.StatusCode != 200 {
		t.Fatalf("rest push failed: %d", pushResp.StatusCode)
	}

	st2 := readSSEState()
	if st2["active"] != true || st2["url"] != "https://www.yuketang.cn/sse" {
		t.Fatalf("unexpected SSE push update: %v", st2)
	}

	cancel()
}
