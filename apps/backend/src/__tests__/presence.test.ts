import { describe, expect, it, beforeEach, vi } from 'vitest';
import { setOnline, refreshPresence, setOffline, markDeviceOffline, isOnline } from '../services/presence.js';

type FakeRedis = {
  data: Map<string, Map<string, string>>;
  ttl: Map<string, number>;
  hset: ReturnType<typeof vi.fn>;
  hdel: ReturnType<typeof vi.fn>;
  hgetall: ReturnType<typeof vi.fn>;
  expire: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
  exists: ReturnType<typeof vi.fn>;
};

function createRedis(): FakeRedis {
  const data = new Map<string, Map<string, string>>();
  const ttl = new Map<string, number>();

  return {
    data,
    ttl,
    hset: vi.fn(async (key: string, field: string, value: string) => {
      const entry = data.get(key) ?? new Map<string, string>();
      entry.set(field, value);
      data.set(key, entry);
    }),
    hdel: vi.fn(async (key: string, field: string) => {
      const entry = data.get(key);
      if (!entry) return 0;
      const removed = entry.delete(field) ? 1 : 0;
      if (entry.size === 0) {
        data.delete(key);
      }
      return removed;
    }),
    hgetall: vi.fn(async (key: string) => {
      const entry = data.get(key);
      return Object.fromEntries(entry ?? new Map());
    }),
    expire: vi.fn(async (key: string, seconds: number) => {
      ttl.set(key, seconds);
      return 1;
    }),
    del: vi.fn(async (key: string) => {
      data.delete(key);
      ttl.delete(key);
      return 1;
    }),
    exists: vi.fn(async (key: string) => (data.has(key) ? 1 : 0)),
  } as unknown as FakeRedis;
}

describe('presence service', () => {
  let redis: FakeRedis;

  beforeEach(() => {
    redis = createRedis();
  });

  it('tracks presence per device and keeps other devices online', async () => {
    await setOnline(redis as never, 'user-1', 'device-a');
    await setOnline(redis as never, 'user-1', 'device-b');

    expect(await isOnline(redis as never, 'user-1')).toBe(true);

    await setOffline(redis as never, 'user-1', 'device-a');

    expect(await isOnline(redis as never, 'user-1')).toBe(true);
  });

  it('refreshes presence for the specific device and removes it on timeout', async () => {
    await setOnline(redis as never, 'user-1', 'device-a');
    await refreshPresence(redis as never, 'user-1', 'device-a');

    await markDeviceOffline(redis as never, 'user-1', 'device-a');

    expect(await isOnline(redis as never, 'user-1')).toBe(false);
  });
});
