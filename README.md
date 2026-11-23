# Class Relay（课堂接力）

独立的纯 Web 课堂签到二维码接力工具（Go 零外部依赖单二进制 + 内置前端静态资源）。

- **发码端（教室现场）**：纯 Web 扫码，支持网页相机实时扫码、拍照/相册识码与粘贴链接，实时推送签到链接到指定房间。
- **收码端（远程同学）**：输入相同房间口令等待，收到链接后可一键跳转或生成防过期二维码长按识别。
- **纯内存短生命周期**：无需数据库，单链接默认 90 秒过期（15–300 秒可调），最多 512 个活跃房间，闲置 24 小时自动清理。

## 快速开始（本地运行）

需要 Go 1.24+：

```bash
go run ./cmd/class-relay
```

默认监听 `:8080`，访问 `http://localhost:8080/`。

验证测试：

```bash
go test -race -v ./...
```

## Docker 部署

```bash
cp .env.example .env
docker compose up -d --build
```

健康检查：`GET /healthz` 返回 `200 {"ok":true}`。

## Caddy HTTPS 反向代理示例

浏览器调用摄像头进行网页实时扫码要求 **HTTPS 域名**（本地 `localhost` 除外）。Caddyfile 示例：

```caddyfile
relay.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

开启反向代理后，请在 `.env` 中保持 `TRUST_PROXY=1`。

## HTTP API 概览

| 方法与路径 | 说明 |
|---|---|
| `GET /` | 前端页面（`/relay` 与 `/relay/` 自动 301 重定向至 `/` 并保留 query） |
| `GET /healthz` | 健康检查，返回 `{"ok":true}` |
| `POST /api/v1/relay/{room}` | 推送链接 `{url, source?, ttlSec?}`，房间名匹配 `^[A-Za-z0-9_-]{3,32}$` |
| `GET /api/v1/relay/{room}?since=0&wait=15` | 长轮询拉取当前有效链接（`wait` 上限 20 秒） |
| `DELETE /api/v1/relay/{room}` | 立即清除房间当前链接 |
