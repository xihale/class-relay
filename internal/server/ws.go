package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/coder/websocket"
)

const (
	wsReadLimit    = 16 * 1024
	wsPingInterval = 20 * time.Second
	wsWriteTimeout = 5 * time.Second
)

type wsStateMsg struct {
	Type string `json:"type"`
	relaySnapshot
}

type wsPongMsg struct {
	Type       string `json:"type"`
	ServerTime int64  `json:"serverTime"`
}

type wsAckPushMsg struct {
	Type    string         `json:"type"`
	ReqID   string         `json:"reqId,omitempty"`
	OK      bool           `json:"ok"`
	State   *relaySnapshot `json:"state,omitempty"`
	Error   string         `json:"error,omitempty"`
	Message string         `json:"message,omitempty"`
}

type wsClientMsg struct {
	Type   string `json:"type"`
	ReqID  string `json:"reqId"`
	Role   string `json:"role"`
	Seq    int64  `json:"seq"`
	Kind   string `json:"kind"`
	URL    string `json:"url"`
	Source string `json:"source"`
	TTLSec int    `json:"ttlSec"`
}

func (s *Server) wsOriginPatterns(r *http.Request) []string {
	if !s.trustProxy {
		return nil
	}
	xfh := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-Host"), ",")[0])
	if xfh == "" || strings.EqualFold(xfh, r.Host) {
		return nil
	}
	return []string{r.Host, xfh}
}

func (s *Server) handleRelayWS(w http.ResponseWriter, r *http.Request) {
	roomID := r.PathValue("room")
	if !relayRoomRe.MatchString(roomID) {
		writeErr(w, http.StatusBadRequest, "bad_room", "房间口令需为 3–32 位字母、数字、_ 或 -")
		return
	}

	q := r.URL.Query()
	rm, sub, status, errCode, errMsg := s.subscribe(roomID, q.Get("cid"), q.Get("role"))
	if errCode != "" {
		writeErr(w, status, errCode, errMsg)
		return
	}

	_ = http.NewResponseController(w).SetWriteDeadline(time.Time{})

	opts := &websocket.AcceptOptions{
		CompressionMode: websocket.CompressionDisabled,
		OriginPatterns:  s.wsOriginPatterns(r),
	}
	conn, err := websocket.Accept(w, r, opts)
	if err != nil {
		s.unsubscribe(rm, sub)
		return
	}
	defer func() {
		s.unsubscribe(rm, sub)
		_ = conn.CloseNow()
	}()

	conn.SetReadLimit(wsReadLimit)

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	directCh := make(chan []byte, 16)
	writerDone := make(chan struct{})

	writeText := func(data []byte) error {
		wctx, wcancel := context.WithTimeout(ctx, wsWriteTimeout)
		defer wcancel()
		return conn.Write(wctx, websocket.MessageText, data)
	}

	sendState := func() error {
		rm.mu.Lock()
		snap := rm.snapshotLocked(roomID, time.Now())
		rm.mu.Unlock()
		data, err := json.Marshal(wsStateMsg{
			Type:          "state",
			relaySnapshot: snap,
		})
		if err != nil {
			return err
		}
		return writeText(data)
	}

	// Single dedicated writer goroutine: all conn.Write and conn.Ping calls happen here.
	go func() {
		defer close(writerDone)
		defer cancel()

		// Drain any notification triggered by our own subscribe before initial send.
		select {
		case <-sub.ch:
		default:
		}
		if err := sendState(); err != nil {
			return
		}

		pingTicker := time.NewTicker(wsPingInterval)
		defer pingTicker.Stop()

		for {
			select {
			case <-ctx.Done():
				return
			case <-s.relay.stopCh:
				_ = conn.Close(websocket.StatusGoingAway, "server shutting down")
				return
			case data := <-directCh:
				if err := writeText(data); err != nil {
					return
				}
			case <-sub.ch:
				if err := sendState(); err != nil {
					return
				}
			case <-pingTicker.C:
				pctx, pcancel := context.WithTimeout(ctx, wsWriteTimeout)
				err := conn.Ping(pctx)
				pcancel()
				if err != nil {
					return
				}
			}
		}
	}()

	enqueueDirect := func(v any) {
		data, err := json.Marshal(v)
		if err != nil {
			return
		}
		select {
		case directCh <- data:
		case <-ctx.Done():
		}
	}

	// Reader loop
	for {
		msgType, data, err := conn.Read(ctx)
		if err != nil {
			break
		}
		if msgType != websocket.MessageText {
			continue
		}
		var msg wsClientMsg
		if err := json.Unmarshal(data, &msg); err != nil {
			continue
		}
		switch msg.Type {
		case "ping":
			enqueueDirect(wsPongMsg{
				Type:       "pong",
				ServerTime: time.Now().UnixMilli(),
			})
		case "role":
			newRole := normalizeRole(msg.Role)
			rm.mu.Lock()
			if sub.role != newRole {
				sub.role = newRole
				sub.roleSeq = s.relay.nextSubID.Add(1)
				rm.updated = time.Now()
				rm.notifyLocked()
			}
			rm.mu.Unlock()
		case "receipt":
			if msg.Kind == "delivered" || msg.Kind == "jumped" {
				cid := sub.cid
				if cid == "" {
					cid = fmt.Sprintf("sub-%d", sub.id)
				}
				s.recordReceipt(roomID, msg.Seq, cid, msg.Kind)
			}
		case "push":
			snap, _, errCode, errMsg := s.pushToRoom(roomID, msg.URL, msg.Source, msg.TTLSec)
			if errCode != "" {
				enqueueDirect(wsAckPushMsg{
					Type:    "ack_push",
					ReqID:   msg.ReqID,
					OK:      false,
					Error:   errCode,
					Message: errMsg,
				})
			} else {
				enqueueDirect(wsAckPushMsg{
					Type:  "ack_push",
					ReqID: msg.ReqID,
					OK:    true,
					State: &snap,
				})
			}
		case "clear":
			snap := s.clearRoom(roomID)
			enqueueDirect(wsAckPushMsg{
				Type:  "ack_push",
				ReqID: msg.ReqID,
				OK:    true,
				State: &snap,
			})
		}
	}

	cancel()
	<-writerDone
}
