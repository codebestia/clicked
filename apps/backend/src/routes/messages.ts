import { Router } from 'express';
import type { IRouter } from 'express';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { conversationMembers, messages, messageEnvelopes } from '../db/schema.js';
import { requireAuth, type AuthRequest } from '../middleware/auth.js';
import { invalidateConversationCaches } from '../lib/conversationCache.js';
import { getSocketServer } from '../lib/socket.js';

export const messagesRouter: IRouter = Router();

messagesRouter.use(requireAuth);

messagesRouter.delete('/:id', async (req: AuthRequest, res) => {
  const userId = req.auth!.userId;
  const messageId = req.params['id'] as string | undefined;

  if (!messageId) {
    res.status(400).json({ error: 'Message id is required' });
    return;
  }

  const message = await db.query.messages.findFirst({
    where: eq(messages.id, messageId),
  });

  if (!message) {
    res.status(404).json({ error: 'Message not found' });
    return;
  }

  if (message.senderId !== userId) {
    res.status(403).json({ error: 'You can only delete your own messages' });
    return;
  }

  await db
    .update(messages)
    .set({ deletedAt: new Date(), ciphertext: null })
    .where(and(eq(messages.id, messageId), eq(messages.senderId, userId)));

  await db.delete(messageEnvelopes).where(eq(messageEnvelopes.messageId, messageId));

  getSocketServer()?.to(message.conversationId).emit('message_deleted', {
    messageId: message.id,
    conversationId: message.conversationId,
  });

  const members = await db.query.conversationMembers.findMany({
    where: eq(conversationMembers.conversationId, message.conversationId),
    columns: { userId: true },
  });

  await invalidateConversationCaches(members.map((member) => member.userId));

  res.status(204).send();
});
