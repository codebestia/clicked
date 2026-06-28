import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

const mockFindMembership = vi.fn();
const mockFindProposal = vi.fn();
const mockFindMany = vi.fn();
const mockInsert = vi.fn();
const mockValues = vi.fn();
const mockReturning = vi.fn();
const mockUpdate = vi.fn();
const mockSet = vi.fn();
const mockWhere = vi.fn();
const mockExecute = vi.fn();

const mockInvokeTreasuryAction = vi.fn();

vi.mock('../db/index.js', () => ({
  db: {
    query: {
      conversationMembers: { findFirst: mockFindMembership },
      treasuryProposals: { findFirst: mockFindProposal, findMany: mockFindMany },
    },
    insert: mockInsert,
    update: mockUpdate,
    execute: mockExecute,
  },
}));

vi.mock('../db/schema.js', () => ({
  conversationMembers: { conversationId: 'conversation_id', userId: 'user_id' },
  treasuryProposals: { id: 'id', status: 'status', proposalId: 'proposal_id' },
  conversations: { id: 'id' },
}));

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { auth: { userId: string } }).auth = { userId: 'user-1' };
    next();
  },
}));

vi.mock('../lib/treasury.js', () => ({
  invokeTreasuryAction: mockInvokeTreasuryAction,
}));

const { treasuryRouter } = await import('../routes/treasury.js');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/treasury', treasuryRouter);
  return app;
}

beforeEach(() => {
  vi.resetAllMocks();
  mockValues.mockReturnValue({ returning: mockReturning });
  mockInsert.mockReturnValue({ values: mockValues });
  mockSet.mockReturnValue({ where: mockWhere });
  mockUpdate.mockReturnValue({ set: mockSet });
  mockWhere.mockReturnValue({ returning: mockReturning });
  mockReturning.mockResolvedValue([{ id: 'proposal-db-id', proposalId: 'onchain-1', status: 'active' }]);
  mockFindMembership.mockResolvedValue({ id: 'membership-1' });
  mockFindProposal.mockResolvedValue({
    id: 'proposal-db-id',
    conversationId: '123e4567-e89b-12d3-a456-426614174000',
    proposalId: 'onchain-1',
    status: 'active',
  });
  mockFindMany.mockResolvedValue([]);
  mockInvokeTreasuryAction.mockResolvedValue({ onChainId: 'onchain-1', status: 'pending' });
});

describe('treasury routes', () => {
  it('returns 403 for non-members creating a proposal', async () => {
    mockFindMembership.mockResolvedValueOnce(undefined);

    const res = await request(makeApp())
      .post('/treasury/propose')
      .send({
        amount: 10,
        token: 'USD',
        recipient: 'G' + 'A'.repeat(55),
        ttl: '24h',
        conversationId: '123e4567-e89b-12d3-a456-426614174000',
      });

    expect(res.status).toBe(403);
    expect(mockInvokeTreasuryAction).not.toHaveBeenCalled();
  });

  it('creates a proposal and returns pending status for members', async () => {
    mockReturning.mockResolvedValueOnce([{ id: 'proposal-db-id', proposalId: 'onchain-1', status: 'active' }]);
    mockInvokeTreasuryAction.mockResolvedValueOnce({ onChainId: 'onchain-1', status: 'pending' });

    const res = await request(makeApp())
      .post('/treasury/propose')
      .send({
        amount: 10,
        token: 'USD',
        recipient: 'G' + 'A'.repeat(55),
        ttl: '24h',
        conversationId: '123e4567-e89b-12d3-a456-426614174000',
      });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: 'proposal-db-id', onChainId: 'onchain-1', status: 'pending' });
    expect(mockInvokeTreasuryAction).toHaveBeenCalledWith('propose', expect.any(Object));
  });

  it('updates the db row status to match the on-chain approval state', async () => {
    mockFindMembership.mockResolvedValueOnce({ id: 'membership-1' });
    mockFindProposal.mockResolvedValueOnce({
      id: 'proposal-db-id',
      conversationId: '123e4567-e89b-12d3-a456-426614174000',
      proposalId: 'onchain-1',
      status: 'active',
    });
    mockReturning.mockResolvedValueOnce([{ id: 'proposal-db-id', status: 'approved' }]);
    mockInvokeTreasuryAction.mockResolvedValueOnce({ status: 'approved' });

    const res = await request(makeApp()).post('/treasury/proposals/proposal-db-id/approve');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('approved');
    expect(mockUpdate).toHaveBeenCalled();
  });
});
