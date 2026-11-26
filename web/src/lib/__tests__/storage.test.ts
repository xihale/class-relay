import { beforeEach, describe, expect, it } from 'vitest';
import {
  initialRoom,
  loadRecentRooms,
  randomRoomId,
  recordRecentRoom,
} from '../storage';

describe('storage room helpers', () => {
  beforeEach(() => {
    localStorage.clear();
    history.replaceState(null, '', '/');
  });

  it('generates a random 5-digit numeric room ID avoiding trivial repeats', () => {
    for (let i = 0; i < 40; i++) {
      const id = randomRoomId();
      expect(id).toMatch(/^\d{5}$/);
      expect(Number(id)).toBeGreaterThanOrEqual(10000);
      expect(Number(id)).toBeLessThanOrEqual(99999);
      expect(/^(\d)\1{4}$/.test(id)).toBe(false);
    }
  });

  it('always generates a fresh random 5-digit room on bare / without persisting or polluting recentRooms', () => {
    localStorage.setItem('class-relay-room', 'dorm402');
    const first = initialRoom();
    expect(first).toMatch(/^\d{5}$/);
    expect(localStorage.getItem('class-relay-room')).toBeNull();
    expect(loadRecentRooms()).toEqual([]);

    localStorage.setItem('class-relay-room', 'dorm408');
    expect(initialRoom()).toMatch(/^\d{5}$/);
    expect(localStorage.getItem('class-relay-room')).toBeNull();

    localStorage.setItem('class-relay-room', '54321');
    const third = initialRoom();
    expect(third).toMatch(/^\d{5}$/);
    expect(localStorage.getItem('class-relay-room')).toBeNull();
    expect(loadRecentRooms()).toEqual([]);
  });

  it('ignores legacy ?room=dorm402 (case-insensitive) and returns a fresh random room', () => {
    history.replaceState(null, '', '/?room=dorm402');
    const fromLower = initialRoom();
    expect(fromLower).toMatch(/^\d{5}$/);
    expect(fromLower.toLowerCase()).not.toBe('dorm402');
    expect(loadRecentRooms()).toEqual([]);

    history.replaceState(null, '', '/?room=DORM402');
    const fromUpper = initialRoom();
    expect(fromUpper).toMatch(/^\d{5}$/);
    expect(fromUpper.toLowerCase()).not.toBe('dorm402');
    expect(loadRecentRooms()).toEqual([]);
  });

  it('honors explicit non-legacy ?room= query parameter and records it in recentRooms', () => {
    history.replaceState(null, '', '/?room=54321');
    expect(initialRoom()).toBe('54321');
    expect(loadRecentRooms()).toEqual(['54321']);
  });

  it('filters out legacy dorm402 from recentRooms and preserves up to 5 MRU rooms', () => {
    localStorage.setItem('class-relay-recent-rooms', JSON.stringify(['dorm402', '10203']));
    expect(loadRecentRooms()).toEqual(['10203']);

    expect(recordRecentRoom('dorm402')).toEqual(['10203']);
    expect(recordRecentRoom('DORM402')).toEqual(['10203']);

    for (const r of ['20304', '30405', '40506', '50607', '60708', '20304']) {
      recordRecentRoom(r);
    }
    expect(loadRecentRooms()).toEqual(['20304', '60708', '50607', '40506', '30405']);
  });
});
