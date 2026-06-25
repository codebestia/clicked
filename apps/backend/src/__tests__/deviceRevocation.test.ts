import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFindDevice = vi.fn();
const mockFindMembers = vi.fn();
const mockCount = vi.fn();
const mockUpdateReturning = vi.fn();
const mockDeleteWhere = vi.fn();

const tx = {
  update: vi.fn(() => ({
    set: vi.fn(() => ({ where: vi.fn(() => ({ returning: mockUpdateReturning })) })),
  })),
  delete: vi.fn(() => ({ where: mockDeleteWhere })),
};

const mockTransaction = vi.fn(
  (cb: (t: typeof tx) => Promise<unknown>) => cb(tx) as Promise<unknown>,
);

vi.mock('../db/index.js', () => ({
  db: {
    query: {
      devices: { findFirst: mockFindDevice },
      conversationMembers: { findMany: mockFindMembers },
    },
    $count: mockCount,
    transaction: mockTransaction,
  },
}));

vi.mock('../db/schema.js', () => ({
  devices: { id: 'id', userId: 'userId', revokedAt: 'revokedAt' },
  devicePrekeys: { deviceId: 'deviceId' },
  conversationMembers: { userId: 'userId', conversationId: 'conversationId' },
}));

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args: unknown[]) => args.filter(Boolean)),
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
  isNull: vi.fn((col: unknown) => ({ col, op: 'isNull' })),
  sql: vi.fn(),
}));

const { revokeDevice } = await import('../services/deviceRevocation.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('revokeDevice', () => {
  it('returns 404 when the device is missing', async () => {
    mockFindDevice.mockResolvedValue(undefined);

    const result = await revokeDevice('user-1', 'dev-1');

    expect(result).toEqual({ ok: false, status: 404, error: 'Device not found' });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('returns 403 when the device belongs to someone else', async () => {
    mockFindDevice.mockResolvedValue({ id: 'dev-1', userId: 'other', revokedAt: null });

    const result = await revokeDevice('user-1', 'dev-1');

    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it('returns 409 when the device is already revoked', async () => {
    mockFindDevice.mockResolvedValue({
      id: 'dev-1',
      userId: 'user-1',
      revokedAt: new Date(),
    });

    const result = await revokeDevice('user-1', 'dev-1');

    expect(result).toMatchObject({ ok: false, status: 409, error: 'Device is already revoked' });
  });

  it('returns 409 when it is the last active device', async () => {
    mockFindDevice.mockResolvedValue({ id: 'dev-1', userId: 'user-1', revokedAt: null });
    mockCount.mockResolvedValue(1);

    const result = await revokeDevice('user-1', 'dev-1');

    expect(result).toMatchObject({
      ok: false,
      status: 409,
      error: 'Cannot revoke the last active device',
    });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('revokes, deletes prekeys, and returns shared conversations', async () => {
    const revoked = { id: 'dev-1', userId: 'user-1', revokedAt: new Date() };
    mockFindDevice.mockResolvedValue({ id: 'dev-1', userId: 'user-1', revokedAt: null });
    mockCount.mockResolvedValue(2);
    mockUpdateReturning.mockResolvedValue([revoked]);
    mockFindMembers.mockResolvedValue([{ conversationId: 'conv-1' }, { conversationId: 'conv-2' }]);

    const result = await revokeDevice('user-1', 'dev-1');

    expect(result).toEqual({
      ok: true,
      device: revoked,
      conversationIds: ['conv-1', 'conv-2'],
    });
    expect(tx.delete).toHaveBeenCalled();
    expect(mockDeleteWhere).toHaveBeenCalled();
  });

  it('returns 409 when the atomic revoke loses a race', async () => {
    mockFindDevice.mockResolvedValue({ id: 'dev-1', userId: 'user-1', revokedAt: null });
    mockCount.mockResolvedValue(2);
    mockUpdateReturning.mockResolvedValue([]);

    const result = await revokeDevice('user-1', 'dev-1');

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(mockFindMembers).not.toHaveBeenCalled();
  });
});
