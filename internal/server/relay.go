package server

import (
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	relayDefaultTTL        = 90 * time.Second
	relayMinTTL            = 15 * time.Second
	relayMaxTTL            = 300 * time.Second
	relayRoomMaxAge        = 24 * time.Hour
	relayMaxRooms          = 512
	relayMaxWait           = 20 * time.Second
	relayMaxURLLen         = 2048
	relayMaxWaitersPerRoom = 256
	relayMaxWaitersTotal   = 4096
	relayJanitorInterval   = 5 * time.Minute
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

type relayPeers struct {
	Total int `json:"total"`
	Recv  int `json:"recv"`
	Send  int `json:"send"`
}

type relayReceipts struct {
	Delivered int `json:"delivered"`
	Jumped    int `json:"jumped"`
}

type relaySnapshot struct {
	Room       string        `json:"room"`
	Seq        int64         `json:"seq"`
	Active     bool          `json:"active"`
	URL        string        `json:"url,omitempty"`
	Source     string        `json:"source,omitempty"`
	Host       string        `json:"host,omitempty"`
	CreatedAt  int64         `json:"createdAt,omitempty"`
	ExpiresAt  int64         `json:"expiresAt,omitempty"`
	ServerTime int64         `json:"serverTime"`
	Peers      relayPeers    `json:"peers"`
	Receipts   relayReceipts `json:"receipts"`
}

type subscriber struct {
	id      uint64
	roleSeq uint64
	cid     string
	role    string // "recv" | "send"
	ch      chan struct{}
}

type relayRoom struct {
	mu          sync.Mutex
	seq         int64
	item        *relayItem
	updated     time.Time
	waiters     map[chan struct{}]struct{}
	subs        map[uint64]*subscriber
	deliveredBy map[string]struct{}
	jumpedBy    map[string]struct{}
}

type relayHub struct {
	mu        sync.Mutex
	rooms     map[string]*relayRoom
	waiters   atomic.Int64
	nextSubID atomic.Uint64
	stopCh    chan struct{}
	doneCh    chan struct{}
	closeOnce sync.Once
}

func newRelayHub() *relayHub {
	return newRelayHubWithJanitor(relayJanitorInterval)
}

func newRelayHubWithJanitor(interval time.Duration) *relayHub {
	h := &relayHub{
		rooms:  make(map[string]*relayRoom),
		stopCh: make(chan struct{}),
		doneCh: make(chan struct{}),
	}
	if interval > 0 {
		go h.janitor(interval)
	} else {
		close(h.doneCh)
	}
	return h
}

func (h *relayHub) janitor(interval time.Duration) {
	defer close(h.doneCh)
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			h.sweep(time.Now())
		case <-h.stopCh:
			return
		}
	}
}

func (h *relayHub) Close() {
	h.closeOnce.Do(func() {
		close(h.stopCh)
		<-h.doneCh
	})
}

func (h *relayHub) sweep(now time.Time) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for id, rm := range h.rooms {
		rm.mu.Lock()
		expired := rm.item != nil && !rm.item.ExpiresAt.After(now)
		if expired {
			rm.item = nil
		}
		remove := (expired && now.Sub(rm.updated) > 5*time.Minute && len(rm.subs) == 0) || now.Sub(rm.updated) > relayRoomMaxAge
		if remove {
			if len(rm.waiters) > 0 || len(rm.subs) > 0 {
				rm.notifyLocked()
			}
			rm.mu.Unlock()
			delete(h.rooms, id)
			continue
		}
		rm.mu.Unlock()
	}
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
	if len(h.rooms) >= relayMaxRooms {
		return nil
	}
	rm := &relayRoom{
		updated:     time.Now(),
		waiters:     make(map[chan struct{}]struct{}),
		subs:        make(map[uint64]*subscriber),
		deliveredBy: make(map[string]struct{}),
		jumpedBy:    make(map[string]struct{}),
	}
	h.rooms[id] = rm
	return rm
}

// evictLocked removes expired or oldest idle rooms when the hub reaches capacity.
func (h *relayHub) evictLocked(now time.Time) {
	var oldestID string
	var oldestTime time.Time
	for id, rm := range h.rooms {
		rm.mu.Lock()
		expired := rm.item != nil && !rm.item.ExpiresAt.After(now) && now.Sub(rm.updated) > 5*time.Minute && len(rm.subs) == 0
		stale := now.Sub(rm.updated) > relayRoomMaxAge
		hasActive := len(rm.waiters) > 0 || len(rm.subs) > 0
		upd := rm.updated
		if expired || stale {
			if hasActive {
				rm.notifyLocked()
			}
			rm.mu.Unlock()
			delete(h.rooms, id)
			continue
		}
		rm.mu.Unlock()
		if !hasActive && (oldestID == "" || upd.Before(oldestTime)) {
			oldestID = id
			oldestTime = upd
		}
	}
	if len(h.rooms) >= relayMaxRooms && oldestID != "" {
		delete(h.rooms, oldestID)
	}
}

func (rm *relayRoom) notifyLocked() {
	for _, sub := range rm.subs {
		select {
		case sub.ch <- struct{}{}:
		default:
		}
	}
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

func (rm *relayRoom) peersLocked() relayPeers {
	var recv, send int
	latestByCID := make(map[string]*subscriber, len(rm.subs))
	for _, sub := range rm.subs {
		if sub.cid == "" {
			if sub.role == "send" {
				send++
			} else {
				recv++
			}
			continue
		}
		prev, exists := latestByCID[sub.cid]
		if !exists || sub.roleSeq > prev.roleSeq {
			latestByCID[sub.cid] = sub
		}
	}
	for _, sub := range latestByCID {
		if sub.role == "send" {
			send++
		} else {
			recv++
		}
	}
	return relayPeers{
		Total: recv + send,
		Recv:  recv,
		Send:  send,
	}
}

func (rm *relayRoom) receiptsLocked(now time.Time) relayReceipts {
	if rm.item == nil || !rm.item.ExpiresAt.After(now) {
		return relayReceipts{}
	}
	return relayReceipts{
		Delivered: len(rm.deliveredBy),
		Jumped:    len(rm.jumpedBy),
	}
}

func (rm *relayRoom) snapshotLocked(roomID string, now time.Time) relaySnapshot {
	snap := relaySnapshot{
		Room:       roomID,
		Seq:        rm.seq,
		Active:     false,
		ServerTime: now.UnixMilli(),
		Peers:      rm.peersLocked(),
		Receipts:   rm.receiptsLocked(now),
	}
	if cur := rm.activeItemLocked(now); cur != nil {
		snap.Active = true
		snap.URL = cur.URL
		snap.Source = cur.Source
		snap.Host = cur.Host
		snap.CreatedAt = cur.CreatedAt.UnixMilli()
		snap.ExpiresAt = cur.ExpiresAt.UnixMilli()
	}
	return snap
}

func emptySnapshot(roomID string, now time.Time) relaySnapshot {
	return relaySnapshot{
		Room:       roomID,
		Seq:        0,
		Active:     false,
		ServerTime: now.UnixMilli(),
	}
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

func clampCID(s string) string {
	s = strings.TrimSpace(s)
	r := []rune(s)
	if len(r) > 64 {
		return string(r[:64])
	}
	return s
}

func normalizeRole(role string) string {
	if strings.EqualFold(strings.TrimSpace(role), "send") {
		return "send"
	}
	return "recv"
}

func (s *Server) pushToRoom(roomID, rawURL, source string, ttlSec int) (relaySnapshot, int, string, string) {
	parsed, errMsg := validRelayURL(rawURL)
	if errMsg != "" {
		return relaySnapshot{}, http.StatusBadRequest, "bad_url", errMsg
	}
	ttl := relayDefaultTTL
	if ttlSec > 0 {
		ttl = time.Duration(ttlSec) * time.Second
		if ttl < relayMinTTL {
			ttl = relayMinTTL
		} else if ttl > relayMaxTTL {
			ttl = relayMaxTTL
		}
	}

	now := time.Now()
	rm := s.relay.getRoom(roomID, true)
	if rm == nil {
		return relaySnapshot{}, http.StatusTooManyRequests, "too_many_rooms", "房间数量已达上限，请稍后再试"
	}
	rm.mu.Lock()
	rm.seq++
	rm.item = &relayItem{
		Seq:       rm.seq,
		Room:      roomID,
		URL:       parsed.String(),
		Source:    clampSource(source),
		Host:      parsed.Host,
		CreatedAt: now,
		ExpiresAt: now.Add(ttl),
	}
	rm.deliveredBy = make(map[string]struct{})
	rm.jumpedBy = make(map[string]struct{})
	rm.updated = now
	rm.notifyLocked()
	snap := rm.snapshotLocked(roomID, now)
	rm.mu.Unlock()

	return snap, http.StatusOK, "", ""
}

func (s *Server) clearRoom(roomID string) relaySnapshot {
	now := time.Now()
	rm := s.relay.getRoom(roomID, false)
	if rm == nil {
		return emptySnapshot(roomID, now)
	}
	rm.mu.Lock()
	rm.seq++
	rm.item = nil
	rm.deliveredBy = make(map[string]struct{})
	rm.jumpedBy = make(map[string]struct{})
	rm.updated = now
	rm.notifyLocked()
	snap := rm.snapshotLocked(roomID, now)
	rm.mu.Unlock()
	return snap
}

func (s *Server) recordReceipt(roomID string, seq int64, cid, kind string) relayReceipts {
	rm := s.relay.getRoom(roomID, false)
	if rm == nil {
		return relayReceipts{}
	}
	now := time.Now()
	rm.mu.Lock()
	defer rm.mu.Unlock()
	if rm.item != nil && rm.item.ExpiresAt.After(now) && seq == rm.seq && cid != "" {
		changed := false
		switch kind {
		case "delivered":
			if _, exists := rm.deliveredBy[cid]; !exists {
				rm.deliveredBy[cid] = struct{}{}
				changed = true
			}
		case "jumped":
			if _, exists := rm.jumpedBy[cid]; !exists {
				rm.jumpedBy[cid] = struct{}{}
				changed = true
			}
		}
		if changed {
			rm.updated = now
			rm.notifyLocked()
		}
	}
	return rm.receiptsLocked(now)
}

func (s *Server) subscribe(roomID, cid, role string) (*relayRoom, *subscriber, int, string, string) {
	rm := s.relay.getRoom(roomID, true)
	if rm == nil {
		return nil, nil, http.StatusTooManyRequests, "too_many_rooms", "房间数量已达上限，请稍后再试"
	}

	id := s.relay.nextSubID.Add(1)
	sub := &subscriber{
		id:      id,
		roleSeq: id,
		cid:     clampCID(cid),
		role:    normalizeRole(role),
		ch:      make(chan struct{}, 1),
	}

	rm.mu.Lock()
	if len(rm.subs)+len(rm.waiters) >= relayMaxWaitersPerRoom {
		rm.mu.Unlock()
		return nil, nil, http.StatusTooManyRequests, "too_many_waiters", "当前房间等待连接数已达上限，请稍后再试"
	}
	if s.relay.waiters.Add(1) > relayMaxWaitersTotal {
		s.relay.waiters.Add(-1)
		rm.mu.Unlock()
		return nil, nil, http.StatusTooManyRequests, "too_many_waiters", "服务等待连接数已达上限，请稍后再试"
	}
	rm.subs[sub.id] = sub
	rm.updated = time.Now()
	rm.notifyLocked()
	rm.mu.Unlock()

	return rm, sub, http.StatusOK, "", ""
}

func (s *Server) unsubscribe(rm *relayRoom, sub *subscriber) {
	rm.mu.Lock()
	if _, ok := rm.subs[sub.id]; ok {
		delete(rm.subs, sub.id)
		s.relay.waiters.Add(-1)
		rm.updated = time.Now()
		rm.notifyLocked()
	}
	rm.mu.Unlock()
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
	snap, status, errCode, errMsg := s.pushToRoom(roomID, req.URL, req.Source, req.TTLSec)
	if errCode != "" {
		writeErr(w, status, errCode, errMsg)
		return
	}
	writeJSON(w, http.StatusOK, snap)
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

	if waitDur > 0 {
		_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(waitDur + 10*time.Second))
	}

	rm := s.relay.getRoom(roomID, waitDur > 0)
	if rm == nil {
		if waitDur > 0 {
			writeErr(w, http.StatusTooManyRequests, "too_many_rooms", "房间数量已达上限，请稍后再试")
			return
		}
		writeJSON(w, http.StatusOK, emptySnapshot(roomID, time.Now()))
		return
	}

	rm.mu.Lock()
	now := time.Now()
	cur := rm.activeItemLocked(now)
	hasNewer := (cur != nil && cur.Seq > since) || (cur == nil && since > 0 && rm.seq > since)
	if !hasNewer && waitDur > 0 {
		if len(rm.subs)+len(rm.waiters) >= relayMaxWaitersPerRoom {
			rm.mu.Unlock()
			writeErr(w, http.StatusTooManyRequests, "too_many_waiters", "当前房间等待连接数已达上限，请稍后再试")
			return
		}
		if s.relay.waiters.Add(1) > relayMaxWaitersTotal {
			s.relay.waiters.Add(-1)
			rm.mu.Unlock()
			writeErr(w, http.StatusTooManyRequests, "too_many_waiters", "服务等待连接数已达上限，请稍后再试")
			return
		}
		defer s.relay.waiters.Add(-1)

		ch := make(chan struct{})
		rm.waiters[ch] = struct{}{}
		rm.mu.Unlock()

		timer := time.NewTimer(waitDur)
		select {
		case <-ch:
		case <-timer.C:
		case <-s.relay.stopCh:
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
	}
	snap := rm.snapshotLocked(roomID, now)
	rm.mu.Unlock()

	writeJSON(w, http.StatusOK, snap)
}

func (s *Server) handleRelayClear(w http.ResponseWriter, r *http.Request) {
	roomID := r.PathValue("room")
	if !relayRoomRe.MatchString(roomID) {
		writeErr(w, http.StatusBadRequest, "bad_room", "房间口令需为 3–32 位字母、数字、_ 或 -")
		return
	}
	snap := s.clearRoom(roomID)
	writeJSON(w, http.StatusOK, snap)
}

func (s *Server) handleRelayReceipt(w http.ResponseWriter, r *http.Request) {
	roomID := r.PathValue("room")
	if !relayRoomRe.MatchString(roomID) {
		writeErr(w, http.StatusBadRequest, "bad_room", "房间口令需为 3–32 位字母、数字、_ 或 -")
		return
	}
	var req struct {
		Seq  int64  `json:"seq"`
		CID  string `json:"cid"`
		Kind string `json:"kind"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if req.Kind != "delivered" && req.Kind != "jumped" {
		writeErr(w, http.StatusBadRequest, "bad_receipt", "回执类型仅支持 delivered 或 jumped")
		return
	}
	cid := clampCID(req.CID)
	if cid == "" {
		cid = clampCID("ip:" + s.clientIP(r))
	}
	receipts := s.recordReceipt(roomID, req.Seq, cid, req.Kind)
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":       true,
		"receipts": receipts,
	})
}
