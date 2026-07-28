/**
 * Tests for server-side edit-chain resolution in GET /conversations/:id/messages.
 *
 * Each edit creates a new messages row with editsMessageId pointing to the root
 * of the chain. The history endpoint must exclude superseded versions so only
 * the newest row per chain appears in the response (issue #340).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// ── Database mock ─────────────────────────────────────────────────────────────

const mockFindMember = vi.fn();
const mockFindMessageFirst = vi.fn();
const mockFindMessages = vi.fn();

vi.mock('../db/index.js', () => ({
  db: {
    query: {
      conversationMembers: { findFirst: mockFindMember },
      messages: {
        findFirst: mockFindMessageFirst,
        findMany: mockFindMessages,
      },
    },
  },
}));

vi.mock('../db/schema.js', () => ({
  conversations: {},
  conversationMembers: {
    conversationId: 'conversationId',
    userId: 'userId',
  },
  messages: {
    id: 'id',
    conversationId: 'conversationId',
    senderId: 'senderId',
    ciphertext: 'ciphertext',
    createdAt: 'createdAt',
    deletedAt: 'deletedAt',
    editsMessageId: 'editsMessageId',
  },
  messageEnvelopes: { recipientDeviceId: 'recipientDeviceId' },
  tokenTransfers: {},
}));

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args: unknown[]) => args.filter(Boolean)),
  asc: vi.fn(),
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
  ne: vi.fn((col: unknown, val: unknown) => ({ col, val, op: 'ne' })),
  or: vi.fn((...args: unknown[]) => ({ op: 'or', args })),
  desc: vi.fn(),
  lt: vi.fn(),
  inArray: vi.fn(),
  count: vi.fn(),
  sql: vi.fn(() => 'not_superseded_expr'),
}));

vi.mock('../lib/redis.js', () => ({
  get redis() {
    return null;
  },
  CONV_CACHE_TTL: 30,
  convCacheKey: (userId: string) => `conversations:${userId}`,
}));

vi.mock('../lib/socket.js', () => ({
  getSocketServer: () => null,
}));

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { auth: { userId: string; deviceId: string } }).auth = {
      userId: 'user-1',
      deviceId: 'device-1',
    };
    next();
  },
}));

const { conversationsRouter } = await import('../routes/conversations.js');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/conversations', conversationsRouter);
  return app;
}

function makeMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg-1',
    conversationId: 'conv-1',
    senderId: 'user-1',
    senderDeviceId: null,
    contentType: 'text/plain',
    ciphertext: 'encrypted-content',
    fileId: null,
    editsMessageId: null,
    createdAt: new Date('2026-01-01T12:00:00Z'),
    deletedAt: null,
    sender: { id: 'user-1', username: 'alice', avatarUrl: null },
    envelopes: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFindMember.mockResolvedValue({ userId: 'user-1', conversationId: 'conv-1' });
});

// ── Membership guard ──────────────────────────────────────────────────────────

describe('GET /conversations/:id/messages — membership', () => {
  it('returns 403 for non-members', async () => {
    mockFindMember.mockResolvedValue(null);

    const res = await request(makeApp()).get('/conversations/conv-1/messages');

    expect(res.status).toBe(403);
  });
});

// ── Edit-chain filtering ───────────────────────────────────────────────────────

describe('GET /conversations/:id/messages — edit-chain server-side resolution', () => {
  it('passes a NOT EXISTS expression to findMany to exclude superseded versions', async () => {
    const { sql } = await import('drizzle-orm');
    mockFindMessages.mockResolvedValue([]);

    await request(makeApp()).get('/conversations/conv-1/messages');

    // sql tagged template must have been called to build the not-superseded guard
    expect(sql).toHaveBeenCalled();

    // The not_superseded_expr sentinel must appear in the where argument
    const whereArg = mockFindMessages.mock.calls[0][0].where;
    expect(JSON.stringify(whereArg)).toContain('not_superseded_expr');
  });

  it('returns only the latest version of an edited message', async () => {
    // Simulates DB returning only the newest edit (filter already applied)
    const latest = makeMessage({
      id: 'v2',
      editsMessageId: 'root',
      ciphertext: 'updated-content',
      createdAt: new Date('2026-01-01T12:05:00Z'),
      envelopes: [{ ciphertext: 'envelope-v2' }],
    });
    mockFindMessages.mockResolvedValue([latest]);

    const res = await request(makeApp()).get('/conversations/conv-1/messages');

    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(1);
    expect(res.body.messages[0].id).toBe('v2');
    expect(res.body.messages[0].ciphertext).toBe('updated-content');
    expect(res.body.messages[0].editsMessageId).toBe('root');
  });

  it('preserves unedited messages alongside the latest edit in a mixed list', async () => {
    // Unedited message + newest version of an edited chain
    const plain = makeMessage({ id: 'plain', editsMessageId: null });
    const latestEdit = makeMessage({
      id: 'v3',
      editsMessageId: 'root',
      createdAt: new Date('2026-01-01T12:10:00Z'),
    });
    mockFindMessages.mockResolvedValue([latestEdit, plain]);

    const res = await request(makeApp()).get('/conversations/conv-1/messages');

    expect(res.status).toBe(200);
    const ids = res.body.messages.map((m: { id: string }) => m.id);
    expect(ids).toContain('plain');
    expect(ids).toContain('v3');
    expect(ids).toHaveLength(2);
  });

  it('returns empty messages array when all messages in a conversation are superseded', async () => {
    // DB filter removes all rows — returns empty
    mockFindMessages.mockResolvedValue([]);

    const res = await request(makeApp()).get('/conversations/conv-1/messages');

    expect(res.status).toBe(200);
    expect(res.body.messages).toEqual([]);
    expect(res.body.nextCursor).toBeNull();
  });

  it('returns editsMessageId in each message payload so clients can track the chain root', async () => {
    const edited = makeMessage({
      id: 'v2',
      editsMessageId: 'root',
      envelopes: [{ ciphertext: 'cipher' }],
    });
    mockFindMessages.mockResolvedValue([edited]);

    const res = await request(makeApp()).get('/conversations/conv-1/messages');

    expect(res.status).toBe(200);
    expect(res.body.messages[0]).toHaveProperty('editsMessageId', 'root');
  });
});

// ── Pagination with filter ────────────────────────────────────────────────────

describe('GET /conversations/:id/messages — cursor pagination still applies', () => {
  it('resolves the cursor message id before applying the edit-chain filter', async () => {
    const cursorMessage = {
      id: 'cursor-msg',
      createdAt: new Date('2026-01-01T11:00:00Z'),
    };
    mockFindMessageFirst.mockResolvedValue(cursorMessage);
    mockFindMessages.mockResolvedValue([]);

    const res = await request(makeApp()).get(
      '/conversations/conv-1/messages?before=cursor-msg',
    );

    expect(res.status).toBe(200);
    expect(mockFindMessageFirst).toHaveBeenCalled();
    expect(mockFindMessages).toHaveBeenCalled();
  });

  it('returns 400 when the cursor message does not exist', async () => {
    mockFindMessageFirst.mockResolvedValue(null);

    const res = await request(makeApp()).get(
      '/conversations/conv-1/messages?before=nonexistent',
    );

    expect(res.status).toBe(400);
    expect(mockFindMessages).not.toHaveBeenCalled();
  });
});
