// class-relay：独立的课堂接力（二维码链接实时同步）服务。
//
// 配置（环境变量）：
//
//	ADDR        监听地址，默认 :8080
//	TRUST_PROXY 设为 1 或 true 时信任 X-Forwarded-For / X-Real-IP（反向代理后开启）
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/xihale/class-relay/internal/server"
)

func env(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

func envBool(key string) bool {
	v := strings.ToLower(strings.TrimSpace(os.Getenv(key)))
	return v == "1" || v == "true" || v == "yes"
}

func main() {
	opts := server.Options{
		TrustProxy: envBool("TRUST_PROXY"),
	}
	srv := server.New(opts)

	addr := env("ADDR", ":8080")
	hs := &http.Server{
		Addr:              addr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      40 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	go func() {
		log.Printf("class-relay 已启动：%s（反向代理信任：%v）", addr, opts.TrustProxy)
		if err := hs.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal(err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop

	log.Printf("收到退出信号，正在优雅关闭…")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := hs.Shutdown(ctx); err != nil {
		log.Printf("关闭服务出错：%v", err)
	}
}
