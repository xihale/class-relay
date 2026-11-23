package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
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
	if csp := rec.Header().Get("Content-Security-Policy"); !strings.Contains(csp, "script-src 'self';") || strings.Contains(csp, "wx.qq.com") || !strings.Contains(csp, "img-src 'self' data: blob:") || !strings.Contains(csp, "media-src 'self' blob:") {
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
