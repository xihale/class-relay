# 构建：docker build -t class-relay .
FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/class-relay ./cmd/class-relay

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/class-relay /class-relay
ENV ADDR=:8080
EXPOSE 8080
USER nonroot
ENTRYPOINT ["/class-relay"]
