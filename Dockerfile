# 构建：docker build -t class-relay .
FROM node:22-alpine AS web
WORKDIR /src/web
RUN corepack enable
COPY web/package.json web/pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile || pnpm install
COPY web/ ./
RUN pnpm build

FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/ ./cmd/
COPY internal/ ./internal/
COPY --from=web /src/internal/server/dist ./internal/server/dist
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/class-relay ./cmd/class-relay

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/class-relay /class-relay
ENV ADDR=:8080
EXPOSE 8080
USER nonroot
ENTRYPOINT ["/class-relay"]
