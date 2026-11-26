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

  it('creates and persists a random 5-digit room on fresh boot and migrates legacy dorm402', () => {
    const first = initialRoom();
    expect(first).toMatch(/^\d{5}$/);
    expect(localStorage.getItem('class-relay-room')).toBe(first);
    expect(loadRecentRooms()[0]).toBe(first);

    // Subsequent loads keep the same generated room
    expect(initialRoom()).toBe(first);

    // Legacy hardcoded dorm402 is migrated to a fresh random 5-digit room
    localStorage.setItem('class-relay-room', 'dorm402');
    const migrated = initialRoom();
    expect(migrated).toMatch(/^\d{5}$/);
    expect(migrated).not.toBe('dorm402');
  });

  it('honors explicit ?room= query parameter and records recent rooms up to 5', () => {
    history.replaceState(null, '', '/?room=54321');
    expect(initialRoom()).toBe('54321');
    expect(localStorage.getItem('class-relay-room')).toBe('54321');

    for (const r of ['10203', '20304', '30405', '40506', '50607', '20304']) {
      recordRecentRoom(r);
    }
    expect(loadRecentRooms()).toEqual(['20304', '50607', '40506', '30405', '10203']);
  });
});
