package server

import (
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	relayDefaultTTL = 90 * time.Second
	relayMinTTL     = 15 * time.Second
	relayMaxTTL     = 300 * time.Second
	relayRoomMaxAge = 24 * time.Hour
	relayMaxRooms   = 512
	relayMaxWait    = 20 * time.Second
	relayMaxURLLen  = 2048
)

var relayRoomRe = regexp.MustCompile(`^[A-Za-z0-9_-]{3,32}$`)

type relayItem struct {
	Seq       int64     `json:"seq"`
	Room      string    `json:"room"`
	URL       string    `json:"url"`
	Source    string    `json:"source,omitempty"`
	Host      string    `json:"host"`
	CreatedAt time.Time `json:"createdAt"`
	ExpiresAt time.Time `json:"expiresAt"`
}

type relayRoom struct {
	mu      sync.Mutex
	seq     int64
	item    *relayItem
	updated time.Time
	waiters map[chan struct{}]struct{}
}

type relayHub struct {
	mu    sync.Mutex
	rooms map[string]*relayRoom
}

func newRelayHub() *relayHub {
	return &relayHub{rooms: make(map[string]*relayRoom)}
}

func (h *relayHub) getRoom(id string, create bool) *relayRoom {
	h.mu.Lock()
	defer h.mu.Unlock()
	if rm, ok := h.rooms[id]; ok {
		return rm
	}
	if !create {
		return nil
	}
	if len(h.rooms) >= relayMaxRooms {
		h.evictLocked(time.Now())
	}
	rm := &relayRoom{
		updated: time.Now(),
		waiters: make(map[chan struct{}]struct{}),
	}
	h.rooms[id] = rm
	return rm
}

// evictLocked removes expired or oldest rooms when the hub reaches capacity.
func (h *relayHub) evictLocked(now time.Time) {
	var oldestID string
	var oldestTime time.Time
	for id, rm := range h.rooms {
		rm.mu.Lock()
		expired := rm.item != nil && !rm.item.ExpiresAt.After(now) && now.Sub(rm.updated) > 5*time.Minute
		stale := now.Sub(rm.updated) > relayRoomMaxAge
		upd := rm.updated
		rm.mu.Unlock()
		if expired || stale {
			delete(h.rooms, id)
			continue
		}
		if oldestID == "" || upd.Before(oldestTime) {
			oldestID = id
			oldestTime = upd
		}
	}
	if len(h.rooms) >= relayMaxRooms && oldestID != "" {
		delete(h.rooms, oldestID)
	}
}

func (rm *relayRoom) notifyLocked() {
	for ch := range rm.waiters {
		close(ch)
		delete(rm.waiters, ch)
	}
}

func (rm *relayRoom) activeItemLocked(now time.Time) *relayItem {
	if rm.item == nil || !rm.item.ExpiresAt.After(now) {
		return nil
	}
	cp := *rm.item
	return &cp
}

func validRelayURL(raw string) (*url.URL, string) {
	raw = strings.TrimSpace(raw)
	if raw == "" || len(raw) > relayMaxURLLen {
		return nil, "链接不能为空且长度不能超过 2048 字符"
	}
	u, err := url.Parse(raw)
	if err != nil || u == nil {
		return nil, "链接格式不正确"
	}
	scheme := strings.ToLower(u.Scheme)
	if (scheme != "http" && scheme != "https") || u.Host == "" {
		return nil, "仅支持 http:// 或 https:// 链接"
	}
	return u, ""
}

func clampSource(s string) string {
	s = strings.TrimSpace(s)
	r := []rune(s)
	if len(r) > 24 {
		return string(r[:24])
	}
	return s
}

func (s *Server) handleRelayPush(w http.ResponseWriter, r *http.Request) {
	roomID := r.PathValue("room")
	if !relayRoomRe.MatchString(roomID) {
		writeErr(w, http.StatusBadRequest, "bad_room", "房间口令需为 3–32 位字母、数字、_ 或 -")
		return
	}
	var req struct {
		URL    string `json:"url"`
		Source string `json:"source"`
		TTLSec int    `json:"ttlSec"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	parsed, errMsg := validRelayURL(req.URL)
	if errMsg != "" {
		writeErr(w, http.StatusBadRequest, "bad_url", errMsg)
		return
	}
	ttl := relayDefaultTTL
	if req.TTLSec > 0 {
		ttl = time.Duration(req.TTLSec) * time.Second
		if ttl < relayMinTTL {
			ttl = relayMinTTL
		} else if ttl > relayMaxTTL {
			ttl = relayMaxTTL
		}
	}

	now := time.Now()
	rm := s.relay.getRoom(roomID, true)
	rm.mu.Lock()
	rm.seq++
	item := &relayItem{
		Seq:       rm.seq,
		Room:      roomID,
		URL:       parsed.String(),
		Source:    clampSource(req.Source),
		Host:      parsed.Host,
		CreatedAt: now,
		ExpiresAt: now.Add(ttl),
	}
	rm.item = item
	rm.updated = now
	rm.notifyLocked()
	cp := *item
	rm.mu.Unlock()

	writeJSON(w, http.StatusOK, map[string]any{
		"room":       cp.Room,
		"seq":        cp.Seq,
		"active":     true,
		"url":        cp.URL,
		"source":     cp.Source,
		"host":       cp.Host,
		"createdAt":  cp.CreatedAt.UnixMilli(),
		"expiresAt":  cp.ExpiresAt.UnixMilli(),
		"serverTime": now.UnixMilli(),
	})
}

func (s *Server) handleRelayPoll(w http.ResponseWriter, r *http.Request) {
	roomID := r.PathValue("room")
	if !relayRoomRe.MatchString(roomID) {
		writeErr(w, http.StatusBadRequest, "bad_room", "房间口令需为 3–32 位字母、数字、_ 或 -")
		return
	}
	q := r.URL.Query()
	var since int64
	if raw := q.Get("since"); raw != "" {
		if v, err := strconv.ParseInt(raw, 10, 64); err == nil && v >= 0 {
			since = v
		}
	}
	var waitDur time.Duration
	if raw := q.Get("wait"); raw != "" {
		if v, err := strconv.Atoi(raw); err == nil && v > 0 {
			waitDur = time.Duration(v) * time.Second
			if waitDur > relayMaxWait {
				waitDur = relayMaxWait
			}
		}
	}

	rm := s.relay.getRoom(roomID, waitDur > 0)
	if rm == nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"room":       roomID,
			"seq":        0,
			"active":     false,
			"serverTime": time.Now().UnixMilli(),
		})
		return
	}

	rm.mu.Lock()
	now := time.Now()
	cur := rm.activeItemLocked(now)
	hasNewer := cur != nil && cur.Seq > since
	if !hasNewer && waitDur > 0 {
		ch := make(chan struct{})
		rm.waiters[ch] = struct{}{}
		rm.mu.Unlock()

		timer := time.NewTimer(waitDur)
		select {
		case <-ch:
		case <-timer.C:
		case <-r.Context().Done():
			timer.Stop()
			rm.mu.Lock()
			delete(rm.waiters, ch)
			rm.mu.Unlock()
			return
		}
		timer.Stop()

		rm.mu.Lock()
		delete(rm.waiters, ch)
		now = time.Now()
		cur = rm.activeItemLocked(now)
	}
	seq := rm.seq
	rm.mu.Unlock()

	if cur == nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"room":       roomID,
			"seq":        seq,
			"active":     false,
			"serverTime": now.UnixMilli(),
		})
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"room":       roomID,
		"seq":        cur.Seq,
		"active":     true,
		"url":        cur.URL,
		"source":     cur.Source,
		"host":       cur.Host,
		"createdAt":  cur.CreatedAt.UnixMilli(),
		"expiresAt":  cur.ExpiresAt.UnixMilli(),
		"serverTime": now.UnixMilli(),
	})
}

func (s *Server) handleRelayClear(w http.ResponseWriter, r *http.Request) {
	roomID := r.PathValue("room")
	if !relayRoomRe.MatchString(roomID) {
		writeErr(w, http.StatusBadRequest, "bad_room", "房间口令需为 3–32 位字母、数字、_ 或 -")
		return
	}
	rm := s.relay.getRoom(roomID, false)
	now := time.Now()
	var seq int64
	if rm != nil {
		rm.mu.Lock()
		rm.seq++
		rm.item = nil
		rm.updated = now
		seq = rm.seq
		rm.notifyLocked()
		rm.mu.Unlock()
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"room":       roomID,
		"seq":        seq,
		"active":     false,
		"serverTime": now.UnixMilli(),
	})
}
