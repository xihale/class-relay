// Package server 提供课堂接力（class-relay）的 HTTP API 及内置静态前端。
package server

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io/fs"
	"log"
	"mime"
	"net"
	"net/http"
	"path"
	"strconv"
	"strings"
	"time"
)

func init() {
	_ = mime.AddExtensionType(".wasm", "application/wasm")
}

//go:embed all:dist
var staticFS embed.FS

const cspHeader = "default-src 'self'; " +
	"script-src 'self' 'wasm-unsafe-eval'; " +
	"worker-src 'self'; " +
	"style-src 'self'; " +
	"img-src 'self' data: blob:; " +
	"media-src 'self' blob:; " +
	"connect-src 'self' ws: wss:; " +
	"base-uri 'none'; " +
	"frame-ancestors 'none'; " +
	"form-action 'self'"

// Options 控制服务行为。
type Options struct {
	TrustProxy bool
}

type staticAsset struct {
	raw         []byte
	gz          []byte
	etag        string
	gzETag      string
	contentType string
	cacheCtrl   string
}

type Server struct {
	relay      *relayHub
	trustProxy bool
	mux        *http.ServeMux
	assets     map[string]*staticAsset
}

func New(opt Options) *Server {
	s := &Server{
		relay:      newRelayHub(),
		trustProxy: opt.TrustProxy,
		mux:        http.NewServeMux(),
		assets:     buildStaticAssets(),
	}
	s.routes()
	return s
}

func (s *Server) Close() {
	if s.relay != nil {
		s.relay.Close()
	}
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
	m.HandleFunc("POST /api/v1/relay/{room}/receipt", s.handleRelayReceipt)
	m.HandleFunc("GET /api/v1/relay/{room}/ws", s.handleRelayWS)
	m.HandleFunc("GET /api/v1/relay/{room}/events", s.handleRelaySSE)

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

	m.Handle("GET /", http.HandlerFunc(s.handleStatic))
}

func isCompressibleExt(ext string) bool {
	switch ext {
	case ".wasm", ".js", ".css", ".html", ".svg":
		return true
	default:
		return false
	}
}

func buildStaticAssets() map[string]*staticAsset {
	sub, err := fs.Sub(staticFS, "dist")
	if err != nil {
		log.Fatalf("embedded static fs error: %v", err)
	}
	assets := make(map[string]*staticAsset)
	err = fs.WalkDir(sub, ".", func(p string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if d.IsDir() {
			return nil
		}
		raw, err := fs.ReadFile(sub, p)
		if err != nil {
			return err
		}
		urlPath := "/" + p
		sum := sha256.Sum256(raw)
		hashHex := hex.EncodeToString(sum[:8])
		ext := strings.ToLower(path.Ext(p))
		ct := mime.TypeByExtension(ext)
		if ct == "" {
			ct = http.DetectContentType(raw)
		}
		cc := "no-cache"
		switch {
		case strings.HasPrefix(urlPath, "/assets/"):
			cc = "public, max-age=31536000, immutable"
		case strings.HasPrefix(urlPath, "/vendor/"):
			cc = "public, max-age=604800"
		}
		asset := &staticAsset{
			raw:         raw,
			etag:        `"` + hashHex + `"`,
			contentType: ct,
			cacheCtrl:   cc,
		}
		if isCompressibleExt(ext) {
			var buf bytes.Buffer
			gw, err := gzip.NewWriterLevel(&buf, gzip.BestCompression)
			if err == nil {
				if _, werr := gw.Write(raw); werr == nil && gw.Close() == nil && buf.Len() < len(raw) {
					asset.gz = buf.Bytes()
					asset.gzETag = `"` + hashHex + `-gz"`
				}
			}
		}
		assets[urlPath] = asset
		return nil
	})
	if err != nil {
		log.Fatalf("walk embedded static fs error: %v", err)
	}
	return assets
}

func acceptsGzip(r *http.Request) bool {
	ae := r.Header.Get("Accept-Encoding")
	for _, part := range strings.Split(ae, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		enc, params, _ := strings.Cut(part, ";")
		if strings.EqualFold(strings.TrimSpace(enc), "gzip") {
			for _, p := range strings.Split(params, ";") {
				k, v, ok := strings.Cut(strings.TrimSpace(p), "=")
				if ok && strings.EqualFold(strings.TrimSpace(k), "q") {
					if q, err := strconv.ParseFloat(strings.TrimSpace(v), 64); err == nil && q == 0 {
						return false
					}
				}
			}
			return true
		}
	}
	return false
}

func ifNoneMatch(headerVal, etag string) bool {
	if headerVal == "" {
		return false
	}
	if strings.TrimSpace(headerVal) == "*" {
		return true
	}
	for _, part := range strings.Split(headerVal, ",") {
		tag := strings.TrimSpace(part)
		tag = strings.TrimPrefix(tag, "W/")
		if tag == etag {
			return true
		}
	}
	return false
}

func (s *Server) handleStatic(w http.ResponseWriter, r *http.Request) {
	urlPath := path.Clean(r.URL.Path)
	if urlPath == "/" {
		urlPath = "/index.html"
	}
	asset, ok := s.assets[urlPath]
	if !ok {
		http.NotFound(w, r)
		return
	}

	h := w.Header()
	h.Set("Cache-Control", asset.cacheCtrl)
	useGzip := asset.gz != nil && acceptsGzip(r)
	if asset.gz != nil {
		h.Set("Vary", "Accept-Encoding")
	}
	etag := asset.etag
	body := asset.raw
	if useGzip {
		etag = asset.gzETag
		body = asset.gz
	}
	h.Set("ETag", etag)

	if ifNoneMatch(r.Header.Get("If-None-Match"), etag) {
		w.WriteHeader(http.StatusNotModified)
		return
	}

	h.Set("Content-Type", asset.contentType)
	if useGzip {
		h.Set("Content-Encoding", "gzip")
	}
	h.Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(http.StatusOK)
	if r.Method != http.MethodHead {
		_, _ = w.Write(body)
	}
}

func isStreamingPath(p string) bool {
	return strings.HasSuffix(p, "/ws") || strings.HasSuffix(p, "/events")
}

func (s *Server) secure(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !isStreamingPath(r.URL.Path) {
			_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(15 * time.Second))
		}
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
