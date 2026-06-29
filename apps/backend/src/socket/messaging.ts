import type { Server } from 'socket.io';
import { and, eq, lt, desc, sql, inArray } from 'drizzle-orm';

import { db } from '../db/index.js';
import {
  conversations,
  conversationMembers,
  messages,
  messageEnvelopes,
  userDevices,
  files,
} from '../db/schema.js';
import type { AuthSocket } from '../middleware/socketAuth.js';
import { invalidateConversationCaches } from '../lib/conversationCache.js';
import { serializeMessage } from '../lib/messages.js';
import { redis } from '../lib/redis.js';
import { deliverMessage } from '../services/deliveryPipeline.js';
import { publishEphemeral, readMissedEvents } from '../services/resumeStream.js';

const PAGE_SIZE = 30;

export function registerMessagingHandlers(io: Server, socket: AuthSocket): void {
  const userId = socket.auth!.userId;
  const typingTimers = new Map<string, NodeJS.Timeout>();

  socket.on('disconnect', () => {
    for (const [timerKey, timer] of typingTimers.entries()) {
      clearTimeout(timer);
      const idx = timerKey.indexOf(':');
      const cid = idx === -1 ? timerKey : timerKey.slice(0, idx);
      const did = idx === -1 ? undefined : timerKey.slice(idx + 1);

      const rp: { conversationId: string; userId: string; deviceId?: string } = {
        conversationId: cid,
        userId,
      };

      if (did) rp.deviceId = did;

      socket.to(cid).emit('typing_stop', rp);
    }

    typingTimers.clear();
  });

  // ── join_room ──────────────────────────────────────────────────────────────
  socket.on('join_room', async (payload: { conversationId: string }) => {
    const { conversationId } = payload;

    const membership = await db.query.conversationMembers.findFirst({
      where: and(
        eq(conversationMembers.conversationId, conversationId),
        eq(conversationMembers.userId, userId),
      ),
    });

    if (!membership) {
      socket.emit('error', { event: 'join_room', message: 'Not a member of this conversation' });
      return;
    }

    await socket.join(conversationId);
    socket.emit('room_joined', { conversationId });
  });

  // ── send_message ───────────────────────────────────────────────────────────
  socket.on(
    'send_message',
    async (payload: {
      conversationId: string;
      messageId?: string;
      content?: string;
      contentType?: string;
      ciphertext?: string;
      envelopes?: Array<{ recipientDeviceId: string; ciphertext: string }>;
    }) => {
      const { conversationId, messageId, content, contentType, ciphertext, envelopes } = payload;
      const deviceId = socket.auth!.deviceId;

      const membership = await db.query.conversationMembers.findFirst({
        where: and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, userId),
        ),
      });

      if (!membership) {
        socket.emit('error', {
          event: 'send_message',
          message: 'Not a member of this conversation',
        });
        return;
      }

      // Clear active typing state as soon as the member attempts to send.
      for (const [timerKey, timer] of typingTimers.entries()) {
        if (timerKey === conversationId || timerKey.startsWith(`${conversationId}:`)) {
          clearTimeout(timer);
          typingTimers.delete(timerKey);

          const idx = timerKey.indexOf(':');
          const did = idx === -1 ? undefined : timerKey.slice(idx + 1);

          const rp: { conversationId: string; userId: string; deviceId?: string } = {
            conversationId,
            userId,
          };

          if (did) rp.deviceId = did;

          socket.to(conversationId).emit('typing_stop', rp);
        }
      }

      if (!messageId) {
        socket.emit('error', { event: 'send_message', message: 'messageId is required' });
        return;
      }

      const effectiveCiphertext = ciphertext ?? content ?? null;

      if (!effectiveCiphertext?.trim() && (!envelopes || envelopes.length === 0)) {
        socket.emit('error', { event: 'send_message', message: 'Message content is empty' });
        return;
      }

      const existing = await db.query.messages.findFirst({
        where: eq(messages.id, messageId),
        columns: { sequenceNumber: true },
      });

      if (existing) {
        socket.emit('message_ack', { messageId, sequenceNumber: existing.sequenceNumber });
        return;
      }

      const isFile = contentType && contentType !== 'text/plain';
      if (isFile) {
        const file = await db.query.files.findFirst({
          where: eq(files.id, messageId),
        });

        if (!file || file.status !== 'ready') {
          socket.emit('error', { event: 'send_message', message: 'Referenced file is not ready or not found' });
          return;
        }
      }

      const [message] = await db
        .insert(messages)
        .values({
          id: messageId,
          conversationId,
          senderId: userId,
          senderDeviceId: deviceId,
          contentType: contentType || 'text/plain',
          ciphertext: effectiveCiphertext,
        })
        .returning();

      if (envelopes && envelopes.length > 0) {
        const deviceIds = envelopes.map((e) => e.recipientDeviceId);

        const devicesList = await db.query.userDevices.findMany({
          where: inArray(userDevices.id, deviceIds),
          columns: { id: true, userId: true },
        });

        const deviceToUser = new Map(devicesList.map((d) => [d.id, d.userId]));

        const validEnvelopes = envelopes
          .filter((env) => deviceToUser.has(env.recipientDeviceId))
          .map((env) => ({
            messageId,
            recipientDeviceId: env.recipientDeviceId,
            recipientUserId: deviceToUser.get(env.recipientDeviceId)!,
            ciphertext: env.ciphertext,
          }));

        if (validEnvelopes.length > 0) {
          await db.insert(messageEnvelopes).values(validEnvelopes);
        }
      }

      if (message) {
        socket.emit('message_ack', {
          messageId,
          sequenceNumber: message.sequenceNumber,
        });
        await deliverMessage(io, message, conversationId);
      }

      const members = await db.query.conversationMembers.findMany({
        where: eq(conversationMembers.conversationId, conversationId),
        columns: { userId: true },
      });

      await invalidateConversationCaches(members.map((member) => member.userId));
    },
  );

  // ── edit_message ───────────────────────────────────────────────────────────
  socket.on(
    'edit_message',
    async (payload: {
      originalMessageId: string;
      messageId: string;
      contentType?: string;
      ciphertext?: string;
      envelopes?: Array<{ recipientDeviceId: string; ciphertext: string }>;
    }) => {
      const { originalMessageId, messageId, contentType, ciphertext, envelopes } = payload;
      const deviceId = socket.auth!.deviceId;

      if (!originalMessageId || !messageId) {
        socket.emit('error', {
          event: 'edit_message',
          message: 'originalMessageId and messageId are required',
        });
        return;
      }

      if (!ciphertext?.trim() && (!envelopes || envelopes.length === 0)) {
        socket.emit('error', { event: 'edit_message', message: 'Message content is empty' });
        return;
      }

      const original = await db.query.messages.findFirst({
        where: eq(messages.id, originalMessageId),
      });

      if (!original) {
        socket.emit('error', { event: 'edit_message', message: 'Original message not found' });
        return;
      }

      if (original.senderId !== userId) {
        socket.emit('error', {
          event: 'edit_message',
          message: 'Only the original sender can edit this message',
        });
        return;
      }

      const rootMessageId = original.editsMessageId ?? original.id;
      const conversationId = original.conversationId;

      const existing = await db.query.messages.findFirst({
        where: eq(messages.id, messageId),
        columns: { sequenceNumber: true },
      });

      if (existing) {
        socket.emit('message_ack', { messageId, sequenceNumber: existing.sequenceNumber });
        return;
      }

      const effectiveContentType = contentType || original.contentType;
      const isFile = effectiveContentType && effectiveContentType !== 'text/plain';
      
      if (isFile) {
        const file = await db.query.files.findFirst({
          where: eq(files.id, messageId),
        });

        if (!file || file.status !== 'ready') {
          socket.emit('error', { event: 'edit_message', message: 'Referenced file is not ready or not found' });
          return;
        }
      }

      const [message] = await db
        .insert(messages)
        .values({
          id: messageId,
          conversationId,
          senderId: userId,
          senderDeviceId: deviceId,
          contentType: contentType || original.contentType,
          ciphertext: ciphertext || null,
          editsMessageId: rootMessageId,
        })
        .returning();

      if (envelopes && envelopes.length > 0) {
        const deviceIds = envelopes.map((e) => e.recipientDeviceId);

        const devicesList = await db.query.userDevices.findMany({
          where: inArray(userDevices.id, deviceIds),
          columns: { id: true, userId: true },
        });

        const deviceToUser = new Map(devicesList.map((d) => [d.id, d.userId]));

        const validEnvelopes = envelopes
          .filter((env) => deviceToUser.has(env.recipientDeviceId))
          .map((env) => ({
            messageId,
            recipientDeviceId: env.recipientDeviceId,
            recipientUserId: deviceToUser.get(env.recipientDeviceId)!,
            ciphertext: env.ciphertext,
          }));

        if (validEnvelopes.length > 0) {
          await db.insert(messageEnvelopes).values(validEnvelopes);
        }
      }

      if (message) {
        socket.emit('message_ack', { messageId, sequenceNumber: message.sequenceNumber });
        io.to(conversationId).emit('new_message', message);
      }

      io.to(conversationId).emit('message_edited', {
        originalMessageId: rootMessageId,
        newMessageId: messageId,
      });

      const members = await db.query.conversationMembers.findMany({
        where: eq(conversationMembers.conversationId, conversationId),
        columns: { userId: true },
      });

      await invalidateConversationCaches(members.map((member) => member.userId));
    },
  );

  // ── message_history ────────────────────────────────────────────────────────
  socket.on('message_history', async (payload: { conversationId: string; before?: string }) => {
    const { conversationId, before } = payload;

    const membership = await db.query.conversationMembers.findFirst({
      where: and(
        eq(conversationMembers.conversationId, conversationId),
        eq(conversationMembers.userId, userId),
      ),
    });

    if (!membership) {
      socket.emit('error', {
        event: 'message_history',
        message: 'Not a member of this conversation',
      });
      return;
    }

    let cursor: Date | undefined;

    if (before) {
      const ref = await db.query.messages.findFirst({
        where: eq(messages.id, before),
      });
      cursor = ref?.createdAt;
    }

    const history = await db.query.messages.findMany({
      where: cursor
        ? and(eq(messages.conversationId, conversationId), lt(messages.createdAt, cursor))
        : eq(messages.conversationId, conversationId),
      orderBy: desc(messages.createdAt),
      limit: PAGE_SIZE,
      with: { sender: { columns: { id: true, username: true, avatarUrl: true } } },
    });

    socket.emit('message_history', {
      conversationId,
      messages: history.reverse().map((message) => serializeMessage(message)),
    });
  });

  // ── delete_message ─────────────────────────────────────────────────────────
  socket.on('delete_message', async (payload: { messageId: string }) => {
    const { messageId } = payload;
    if (!messageId) return;

    const message = await db.query.messages.findFirst({
      where: eq(messages.id, messageId),
    });

    if (!message || message.senderId !== userId) {
      socket.emit('error', { event: 'delete_message', message: 'Message not found or not sender' });
      return;
    }

    await db
      .update(messages)
      .set({ deletedAt: new Date(), ciphertext: null })
      .where(eq(messages.id, messageId));

    await db.delete(messageEnvelopes).where(eq(messageEnvelopes.messageId, messageId));

    io.to(message.conversationId).emit('message_deleted', { messageId });
  });

  // ── message_read ───────────────────────────────────────────────────────────
  socket.on(
    'message_read',
    async (payload: { conversationId: string; lastReadMessageId: string }) => {
      const { conversationId, lastReadMessageId } = payload;

      const membership = await db.query.conversationMembers.findFirst({
        where: and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, userId),
        ),
      });

      if (!membership) {
        socket.emit('error', {
          event: 'message_read',
          message: 'Not a member of this conversation',
        });
        return;
      }

      const message = await db.query.messages.findFirst({
        where: and(eq(messages.id, lastReadMessageId), eq(messages.conversationId, conversationId)),
      });

      if (!message) {
        socket.emit('error', {
          event: 'message_read',
          message: 'Message not found in conversation',
        });
        return;
      }

      await db
        .update(conversationMembers)
        .set({ lastReadMessageId })
        .where(
          and(
            eq(conversationMembers.conversationId, conversationId),
            eq(conversationMembers.userId, userId),
          ),
        );

      io.to(conversationId).volatile.emit('read_receipt', { userId, lastReadMessageId });

      if (redis) {
        const members = await db.query.conversationMembers.findMany({
          where: eq(conversationMembers.conversationId, conversationId),
          columns: { userId: true },
        });

        await publishEphemeral(
          redis,
          members.map((member) => member.userId),
          { type: 'read_receipt', data: { conversationId, userId, lastReadMessageId } },
        );
      }
    },
  );

  // ── resume ────────────────────────────────────────────────────────────────
  socket.on('resume', async (payload: { lastEventId?: string }) => {
    if (!redis) {
      socket.emit('resume_complete', { lastEventId: null, syncRequired: true });
      return;
    }

    const lastEventId = typeof payload?.lastEventId === 'string' ? payload.lastEventId : '';

    const missed = await readMissedEvents(redis, userId, lastEventId);

    for (const event of missed) {
      socket.emit('ephemeral_replay', {
        id: event.id,
        type: event.type,
        data: event.data,
      });
    }

    const newCursor = missed.length > 0 ? missed[missed.length - 1]!.id : lastEventId || null;
    socket.emit('resume_complete', { lastEventId: newCursor, syncRequired: true });
  });

  // ── create_conversation ───────────────────────────────────────────────────
  socket.on(
    'create_conversation',
    async (payload: { type: 'dm' | 'group'; name?: string; memberIds: string[] }) => {
      const { type, name, memberIds } = payload;

      const allMembers = Array.from(new Set([userId, ...memberIds]));

      const [conversation] = await db.insert(conversations).values({ type, name }).returning();

      if (!conversation) {
        socket.emit('error', {
          event: 'create_conversation',
          message: 'Failed to create conversation',
        });
        return;
      }

      await db
        .insert(conversationMembers)
        .values(allMembers.map((uid) => ({ conversationId: conversation.id, userId: uid })));

      socket.emit('conversation_created', conversation);

      await invalidateConversationCaches(allMembers);
    },
  );

  // ── typing_start ──────────────────────────────────────────────────────────
  socket.on(
    'typing_start',
    async (payload?: { conversationId?: string; deviceId?: string; [key: string]: unknown }) => {
      if (
        !payload ||
        typeof payload.conversationId !== 'string' ||
        !payload.conversationId.trim()
      ) {
        socket.emit('error', { event: 'typing_start', message: 'Invalid conversationId' });
        return;
      }

      const conversationId = payload.conversationId.trim();

      if (!socket.rooms?.has(conversationId)) {
        const membership = await db.query.conversationMembers.findFirst({
          where: and(
            eq(conversationMembers.conversationId, conversationId),
            eq(conversationMembers.userId, userId),
          ),
        });

        if (!membership) {
          socket.emit('error', {
            event: 'typing_start',
            message: 'Not a member of this conversation',
          });
          return;
        }
      }

      const relayPayload: { conversationId: string; userId: string; deviceId?: string } = {
        conversationId,
        userId,
      };

      if (typeof payload.deviceId === 'string' && payload.deviceId.trim()) {
        relayPayload.deviceId = payload.deviceId.trim();
      }

      const timerKey = relayPayload.deviceId
        ? `${conversationId}:${relayPayload.deviceId}`
        : conversationId;

      const existingTimer = typingTimers.get(timerKey);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      const timer = setTimeout(() => {
        typingTimers.delete(timerKey);
        socket.to(conversationId).emit('typing_stop', relayPayload);
      }, 5000);

      typingTimers.set(timerKey, timer);

      socket.to(conversationId).emit('typing_start', relayPayload);
    },
  );

  // ── typing_stop ───────────────────────────────────────────────────────────
  socket.on(
    'typing_stop',
    async (payload?: { conversationId?: string; deviceId?: string; [key: string]: unknown }) => {
      if (
        !payload ||
        typeof payload.conversationId !== 'string' ||
        !payload.conversationId.trim()
      ) {
        socket.emit('error', { event: 'typing_stop', message: 'Invalid conversationId' });
        return;
      }

      const conversationId = payload.conversationId.trim();

      if (!socket.rooms?.has(conversationId)) {
        const membership = await db.query.conversationMembers.findFirst({
          where: and(
            eq(conversationMembers.conversationId, conversationId),
            eq(conversationMembers.userId, userId),
          ),
        });

        if (!membership) {
          socket.emit('error', {
            event: 'typing_stop',
            message: 'Not a member of this conversation',
          });
          return;
        }
      }

      const relayPayload: { conversationId: string; userId: string; deviceId?: string } = {
        conversationId,
        userId,
      };

      if (typeof payload.deviceId === 'string' && payload.deviceId.trim()) {
        relayPayload.deviceId = payload.deviceId.trim();
      }

      const timerKey = relayPayload.deviceId
        ? `${conversationId}:${relayPayload.deviceId}`
        : conversationId;

      const existingTimer = typingTimers.get(timerKey);
      if (existingTimer) {
        clearTimeout(existingTimer);
        typingTimers.delete(timerKey);
      }

      socket.to(conversationId).emit('typing_stop', relayPayload);
    },
  );

  // ── ask_assistant ─────────────────────────────────────────────────────────
  const ASSISTANT_USER_ID = '00000000-0000-4000-8000-000000000000';

  socket.on('ask_assistant', async (payload: { conversationId: string; content: string }) => {
    const { conversationId, content } = payload;

    if (!content?.trim().startsWith('@assistant')) {
      return;
    }

    const membership = await db.query.conversationMembers.findFirst({
      where: and(
        eq(conversationMembers.conversationId, conversationId),
        eq(conversationMembers.userId, userId),
      ),
    });

    if (!membership) {
      socket.emit('error', {
        event: 'ask_assistant',
        message: 'Not a member of this conversation',
      });
      return;
    }

    if (redis) {
      const rlKey = `rl:ask_assistant:${userId}`;
      const count = await redis.incr(rlKey);

      if (count === 1) {
        await redis.expire(rlKey, 60);
      }

      if (count > 5) {
        socket.emit('error', { event: 'rate_limited', message: 'Rate limit exceeded' });
        return;
      }
    }

    try {
      const response = await fetch('http://localhost:8000/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: content, conversation_id: conversationId }),
      });

      if (!response.ok) {
        throw new Error('AI agent error');
      }

      const data = (await response.json()) as { reply: string };

      await db.execute(sql`
        INSERT INTO users (id, username, avatar_url)
        VALUES (
          ${ASSISTANT_USER_ID},
          'Assistant',
          'https://ui-avatars.com/api/?name=AI&background=0D8ABC&color=fff'
        )
        ON CONFLICT (id) DO NOTHING
      `);

      await db.execute(sql`
        INSERT INTO conversation_members (conversation_id, user_id)
        VALUES (${conversationId}, ${ASSISTANT_USER_ID})
        ON CONFLICT DO NOTHING
      `);

      const [replyMessage] = await db
        .insert(messages)
        .values({
          conversationId,
          senderId: ASSISTANT_USER_ID,
          contentType: 'text/plain',
          ciphertext: data.reply,
        })
        .returning();

      io.to(conversationId).volatile.emit('new_message', replyMessage);

      const members = await db.query.conversationMembers.findMany({
        where: eq(conversationMembers.conversationId, conversationId),
        columns: { userId: true },
      });

      await invalidateConversationCaches(members.map((member) => member.userId));
    } catch (err) {
      console.error('ask_assistant error:', err);
      socket.emit('error', { event: 'ask_assistant', message: 'Failed to get AI reply' });
    }
  });
}
