package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

const (
	ssePingInterval = 15 * time.Second
	sseWriteTimeout = 10 * time.Second
)

func (s *Server) handleRelaySSE(w http.ResponseWriter, r *http.Request) {
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
	defer s.unsubscribe(rm, sub)

	rc := http.NewResponseController(w)
	_ = rc.SetWriteDeadline(time.Time{})

	h := w.Header()
	h.Set("Content-Type", "text/event-stream; charset=utf-8")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	writeState := func() error {
		rm.mu.Lock()
		snap := rm.snapshotLocked(roomID, time.Now())
		rm.mu.Unlock()
		data, err := json.Marshal(snap)
		if err != nil {
			return err
		}
		_ = rc.SetWriteDeadline(time.Now().Add(sseWriteTimeout))
		if _, err := fmt.Fprintf(w, "id: %d\nevent: state\ndata: %s\n\n", snap.Seq, data); err != nil {
			return err
		}
		return rc.Flush()
	}

	// Drain notification triggered by our own subscribe before initial write.
	select {
	case <-sub.ch:
	default:
	}
	if err := writeState(); err != nil {
		return
	}

	ticker := time.NewTicker(ssePingInterval)
	defer ticker.Stop()

	for {
		select {
		case <-sub.ch:
			if err := writeState(); err != nil {
				return
			}
		case <-ticker.C:
			_ = rc.SetWriteDeadline(time.Now().Add(sseWriteTimeout))
			if _, err := w.Write([]byte(": ping\n\n")); err != nil {
				return
			}
			if err := rc.Flush(); err != nil {
				return
			}
		case <-r.Context().Done():
			return
		case <-s.relay.stopCh:
			return
		}
	}
}
