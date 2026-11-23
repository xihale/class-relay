// Package server 提供课堂接力（class-relay）的 HTTP API 及内置静态前端。
package server

import (
	"embed"
	"encoding/json"
	"errors"
	"io/fs"
	"log"
	"net"
	"net/http"
	"strings"
)

//go:embed all:static
var staticFS embed.FS

const cspHeader = "default-src 'self'; " +
	"script-src 'self'; " +
	"style-src 'self'; " +
	"img-src 'self' data: blob:; " +
	"connect-src 'self'; " +
	"media-src 'self' blob:; " +
	"frame-ancestors 'none'"

// Options 控制服务行为。
type Options struct {
	TrustProxy bool
}

type Server struct {
	relay      *relayHub
	trustProxy bool
	mux        *http.ServeMux
}

func New(opt Options) *Server {
	s := &Server{
		relay:      newRelayHub(),
		trustProxy: opt.TrustProxy,
		mux:        http.NewServeMux(),
	}
	s.routes()
	return s
}

func (s *Server) Handler() http.Handler {
	return s.secure(s.mux)
}

func (s *Server) routes() {
	m := s.mux

	m.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	})

	m.HandleFunc("POST /api/v1/relay/{room}", s.handleRelayPush)
	m.HandleFunc("GET /api/v1/relay/{room}", s.handleRelayPoll)
	m.HandleFunc("DELETE /api/v1/relay/{room}", s.handleRelayClear)

	// 兼容旧 /relay 与 /relay/ 路径，保留原始 query 参数重定向到 /
	redirectRoot := func(w http.ResponseWriter, r *http.Request) {
		target := "/"
		if r.URL.RawQuery != "" {
			target += "?" + r.URL.RawQuery
		}
		http.Redirect(w, r, target, http.StatusMovedPermanently)
	}
	m.HandleFunc("GET /relay", redirectRoot)
	m.HandleFunc("GET /relay/{$}", redirectRoot)

	sub, err := fs.Sub(staticFS, "static")
	if err != nil {
		log.Fatalf("embedded static fs error: %v", err)
	}
	m.Handle("GET /", noCache(http.FileServerFS(sub)))
}

func noCache(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		next.ServeHTTP(w, r)
	})
}

func (s *Server) secure(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Content-Security-Policy", cspHeader)
		h.Set("Permissions-Policy", "camera=(self)")
		if strings.HasPrefix(r.URL.Path, "/api/") {
			h.Set("Cache-Control", "no-store")
		}
		r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
		next.ServeHTTP(w, r)
	})
}

func (s *Server) clientIP(r *http.Request) string {
	if s.trustProxy {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			if first := strings.TrimSpace(strings.Split(xff, ",")[0]); first != "" {
				return first
			}
		}
		if xri := strings.TrimSpace(r.Header.Get("X-Real-IP")); xri != "" {
			return xri
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]string{"error": code, "message": msg})
}

func readJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	dec := json.NewDecoder(r.Body)
	if err := dec.Decode(v); err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			writeErr(w, http.StatusRequestEntityTooLarge, "too_large", "请求体太大")
		} else {
			writeErr(w, http.StatusBadRequest, "bad_request", "请求格式不正确")
		}
		return false
	}
	return true
}
