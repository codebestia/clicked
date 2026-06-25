import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFindDevice = vi.fn();
const mockExecute = vi.fn();

vi.mock('../db/index.js', () => ({
  db: {
    query: { devices: { findFirst: mockFindDevice } },
    execute: mockExecute,
  },
}));

vi.mock('../db/schema.js', () => ({
  devices: { id: 'id', userId: 'userId' },
  oneTimePreKeys: { deviceId: 'deviceId', keyId: 'keyId', consumed: 'consumed' },
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => args.filter(Boolean),
  eq: (col: unknown, val: unknown) => ({ col, val }),
  sql: vi.fn(),
}));

const { fetchAndConsumeKeyBundle } = await import('../services/keyBundle.js');

const DEVICE = {
  id: 'dev-1',
  userId: 'user-1',
  identityPublicKey: 'identity-pub',
  registrationId: 4242,
  signedPreKeyId: 7,
  signedPreKeyPublic: 'spk-pub',
  signedPreKeySignature: 'spk-sig',
  revokedAt: null,
  createdAt: new Date('2026-01-01'),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('fetchAndConsumeKeyBundle', () => {
  it('returns 404 for an unknown device and does not touch prekeys', async () => {
    mockFindDevice.mockResolvedValue(undefined);

    const result = await fetchAndConsumeKeyBundle('user-1', 'dev-1');

    expect(result).toEqual({ ok: false, status: 404, error: 'Device not found' });
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('returns 404 for a revoked device and does not consume a prekey', async () => {
    mockFindDevice.mockResolvedValue({ ...DEVICE, revokedAt: new Date('2026-06-01') });

    const result = await fetchAndConsumeKeyBundle('user-1', 'dev-1');

    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('returns the bundle and consumes one one-time prekey', async () => {
    mockFindDevice.mockResolvedValue(DEVICE);
    mockExecute.mockResolvedValue([{ keyId: 100, publicKey: 'otp-pub' }]);

    const result = await fetchAndConsumeKeyBundle('user-1', 'dev-1');

    expect(result).toEqual({
      ok: true,
      bundle: {
        identityPublicKey: 'identity-pub',
        registrationId: 4242,
        signedPreKey: { keyId: 7, publicKey: 'spk-pub', signature: 'spk-sig' },
        oneTimePreKey: { keyId: 100, publicKey: 'otp-pub' },
      },
    });
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it('returns oneTimePreKey: null when the pool is exhausted', async () => {
    mockFindDevice.mockResolvedValue(DEVICE);
    mockExecute.mockResolvedValue([]);

    const result = await fetchAndConsumeKeyBundle('user-1', 'dev-1');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bundle.oneTimePreKey).toBeNull();
      // The signed prekey is still served so a session can be established.
      expect(result.bundle.signedPreKey.keyId).toBe(7);
    }
  });

  it('never exposes private key material', async () => {
    mockFindDevice.mockResolvedValue(DEVICE);
    mockExecute.mockResolvedValue([{ keyId: 100, publicKey: 'otp-pub' }]);

    const result = await fetchAndConsumeKeyBundle('user-1', 'dev-1');

    if (!result.ok) throw new Error('expected a bundle');
    const serialized = JSON.stringify(result.bundle).toLowerCase();
    expect(serialized).not.toContain('private');
    expect(serialized).not.toContain('secret');
    expect(Object.keys(result.bundle).sort()).toEqual([
      'identityPublicKey',
      'oneTimePreKey',
      'registrationId',
      'signedPreKey',
    ]);
  });

  it('hands out distinct prekeys to concurrent fetches, then null', async () => {
    // Emulate the DB-side atomic claim: each UPDATE pops one key from the pool.
    const pool = [
      { keyId: 1, publicKey: 'a' },
      { keyId: 2, publicKey: 'b' },
    ];
    mockFindDevice.mockResolvedValue(DEVICE);
    mockExecute.mockImplementation(() => {
      const claimed = pool.shift();
      return Promise.resolve(claimed ? [claimed] : []);
    });

    const [first, second, third] = await Promise.all([
      fetchAndConsumeKeyBundle('user-1', 'dev-1'),
      fetchAndConsumeKeyBundle('user-1', 'dev-1'),
      fetchAndConsumeKeyBundle('user-1', 'dev-1'),
    ]);

    const otps = [first, second, third].map((r) => (r.ok ? r.bundle.oneTimePreKey : undefined));
    const issued = otps.filter((o): o is { keyId: number; publicKey: string } => o != null);

    expect(issued).toHaveLength(2);
    expect(new Set(issued.map((o) => o.keyId)).size).toBe(2); // no key handed out twice
    expect(otps.filter((o) => o === null)).toHaveLength(1); // exhausted fetch gets null
  });
});
