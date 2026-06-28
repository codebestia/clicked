import { Router } from 'express';
import { and, desc, eq, or } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { conversationMembers, treasuryProposals } from '../db/schema.js';
import { requireAuth, type AuthRequest } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { invokeTreasuryAction } from '../lib/treasury.js';

export const treasuryRouter = Router();

treasuryRouter.use(requireAuth);

const proposeSchema = z.object({
  amount: z.number().positive(),
  token: z.string().min(1),
  recipient: z.string().regex(/^G[A-Z2-7]{55}$/, 'Invalid Stellar public key'),
  ttl: z.enum(['24h', '72h', '7d']),
  conversationId: z.string().uuid(),
});

const statusFromOnChain = (status?: string) => {
  switch (status) {
    case 'approved':
      return 'approved';
    case 'rejected':
      return 'rejected';
    case 'executed':
      return 'executed';
    case 'expired':
      return 'expired';
    case 'pending':
    case 'active':
    default:
      return 'active';
  }
};

async function ensureConversationMember(userId: string, conversationId?: string | null) {
  if (!conversationId) {
    return false;
  }

  const membership = await db.query.conversationMembers.findFirst({
    where: and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, userId)),
  });

  return Boolean(membership);
}

async function findProposalByIdentifier(id: string) {
  return db.query.treasuryProposals.findFirst({
    where: or(eq(treasuryProposals.id, id), eq(treasuryProposals.proposalId, id)),
  });
}

async function syncProposalStatus(proposalId: string, onChainStatus?: string) {
  const dbStatus = statusFromOnChain(onChainStatus);
  const [updatedProposal] = await db
    .update(treasuryProposals)
    .set({ status: dbStatus, updatedAt: new Date() })
    .where(eq(treasuryProposals.id, proposalId))
    .returning();

  return updatedProposal;
}

treasuryRouter.post('/propose', validate(proposeSchema), async (req, res) => {
  const auth = (req as AuthRequest).auth!;
  const body = req.body as z.infer<typeof proposeSchema>;

  if (!(await ensureConversationMember(auth.userId, body.conversationId))) {
    res.status(403).json({ error: 'Not a member of this conversation' });
    return;
  }

  try {
    const onChainResult = await invokeTreasuryAction('propose', {
      ...body,
      proposer: auth.userId,
    });

    const [createdProposal] = await db
      .insert(treasuryProposals)
      .values({
        contractId: process.env['GROUP_TREASURY_CONTRACT_ID'] ?? 'placeholder-contract-id',
        proposalId: onChainResult.onChainId,
        conversationId: body.conversationId,
        status: statusFromOnChain(onChainResult.status),
      })
      .returning();

    if (!createdProposal) {
      res.status(500).json({ error: 'Failed to persist treasury proposal' });
      return;
    }

    res.status(201).json({
      id: createdProposal.id,
      onChainId: createdProposal.proposalId,
      status: onChainResult.status,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create treasury proposal', details: error });
  }
});

treasuryRouter.post('/proposals/:id/approve', async (req, res) => {
  const auth = (req as AuthRequest).auth!;
  const proposal = await findProposalByIdentifier(req.params['id']);

  if (!proposal) {
    res.status(404).json({ error: 'Treasury proposal not found' });
    return;
  }

  if (!(await ensureConversationMember(auth.userId, proposal.conversationId))) {
    res.status(403).json({ error: 'Not a member of this conversation' });
    return;
  }

  try {
    const onChainResult = await invokeTreasuryAction('approve', {
      proposalId: proposal.proposalId,
      proposer: auth.userId,
    });
    const updatedProposal = await syncProposalStatus(proposal.id, onChainResult.status);

    res.json({
      id: updatedProposal.id,
      onChainId: updatedProposal.proposalId,
      status: onChainResult.status,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to approve treasury proposal', details: error });
  }
});

treasuryRouter.post('/proposals/:id/reject', async (req, res) => {
  const auth = (req as AuthRequest).auth!;
  const proposal = await findProposalByIdentifier(req.params['id']);

  if (!proposal) {
    res.status(404).json({ error: 'Treasury proposal not found' });
    return;
  }

  if (!(await ensureConversationMember(auth.userId, proposal.conversationId))) {
    res.status(403).json({ error: 'Not a member of this conversation' });
    return;
  }

  try {
    const onChainResult = await invokeTreasuryAction('reject', {
      proposalId: proposal.proposalId,
      proposer: auth.userId,
    });
    const updatedProposal = await syncProposalStatus(proposal.id, onChainResult.status);

    res.json({
      id: updatedProposal.id,
      onChainId: updatedProposal.proposalId,
      status: onChainResult.status,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to reject treasury proposal', details: error });
  }
});

treasuryRouter.post('/proposals/:id/execute', async (req, res) => {
  const auth = (req as AuthRequest).auth!;
  const proposal = await findProposalByIdentifier(req.params['id']);

  if (!proposal) {
    res.status(404).json({ error: 'Treasury proposal not found' });
    return;
  }

  if (!(await ensureConversationMember(auth.userId, proposal.conversationId))) {
    res.status(403).json({ error: 'Not a member of this conversation' });
    return;
  }

  try {
    const onChainResult = await invokeTreasuryAction('execute', {
      proposalId: proposal.proposalId,
      proposer: auth.userId,
    });
    const updatedProposal = await syncProposalStatus(proposal.id, onChainResult.status);

    res.json({
      id: updatedProposal.id,
      onChainId: updatedProposal.proposalId,
      status: onChainResult.status,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to execute treasury proposal', details: error });
  }
});

treasuryRouter.get('/proposals', async (req, res) => {
  const auth = (req as AuthRequest).auth!;
  const conversationId = req.query['conversationId'] as string | undefined;

  if (conversationId && !(await ensureConversationMember(auth.userId, conversationId))) {
    res.status(403).json({ error: 'Not a member of this conversation' });
    return;
  }

  const where = conversationId ? eq(treasuryProposals.conversationId, conversationId) : undefined;
  const proposals = await db.query.treasuryProposals.findMany({
    where,
    orderBy: desc(treasuryProposals.createdAt),
  });

  res.json(proposals);
});

treasuryRouter.get('/proposals/:id', async (req, res) => {
  const auth = (req as AuthRequest).auth!;
  const proposal = await findProposalByIdentifier(req.params['id']);

  if (!proposal) {
    res.status(404).json({ error: 'Treasury proposal not found' });
    return;
  }

  if (!(await ensureConversationMember(auth.userId, proposal.conversationId))) {
    res.status(403).json({ error: 'Not a member of this conversation' });
    return;
  }

  res.json(proposal);
});
