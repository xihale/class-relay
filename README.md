# Class Relay（课堂接力）

独立的纯 Web 课堂签到二维码接力工具（Go 单二进制内置 Preact + Vite 前端静态资源，支持 WebSocket 实时同步、SSE 与长轮询自动降级）。

- **发码端（教室现场）**：纯 Web 扫码，支持网页相机实时扫码、拍照/相册识码与粘贴链接，毫秒级推送签到链接到指定房间，并实时查看在线人数与送达/跳转回执。
- **收码端（远程同学）**：输入相同房间口令等待，收到链接后可一键跳转或生成防过期二维码长按识别。
- **纯内存短生命周期**：无需数据库，单链接默认 90 秒过期（15–300 秒可调），最多 512 个活跃房间，闲置 24 小时自动清理。

## 快速开始（本地运行）

需要 Go 1.24+（如需修改前端，另需 Node.js 22+ 与 pnpm）：

```bash
go run ./cmd/class-relay
```

默认监听 `:8080`，访问 `http://localhost:8080/`。

验证测试：

```bash
go test -race -v ./...
```

## Docker 部署

单容器启动：

```bash
cp .env.example .env
docker compose up -d --build
```

启用内置 Caddy 自动 HTTPS（TLS 1.3 + HTTP/3 QUIC，需开放 TCP/UDP 443）：

```bash
RELAY_DOMAIN=relay.example.com docker compose --profile edge up -d --build
```

健康检查：`GET /healthz` 返回 `200 {"ok":true}`。反向代理后请在 `.env` 中保持 `TRUST_PROXY=1`。

## HTTP / 实时协议 API 概览

| 方法与路径 | 说明 |
|---|---|
| `GET /` | 内置前端页面（`/relay` 与 `/relay/` 自动 301 重定向至 `/` 并保留 query） |
| `GET /healthz` | 健康检查，返回 `{"ok":true}` |
| `GET /api/v1/relay/{room}/ws?role=recv\|send&cid=...` | WebSocket 主通道：双向推送、清除、角色切换、回执与实时状态广播 |
| `GET /api/v1/relay/{room}/events?role=recv\|send&cid=...` | SSE 降级通道：`event: state` 实时状态流与 15s 心跳 |
| `POST /api/v1/relay/{room}` | 推送链接 `{url, source?, ttlSec?}`，房间名匹配 `^[A-Za-z0-9_-]{3,32}$` |
| `GET /api/v1/relay/{room}?since=0&wait=15` | 长轮询降级拉取当前有效链接、在线人数与回执（`wait` 上限 20 秒） |
| `DELETE /api/v1/relay/{room}` | 立即清除房间当前链接 |
| `POST /api/v1/relay/{room}/receipt` | 上报回执 `{seq, cid, kind: "delivered" \| "jumped"}` |
