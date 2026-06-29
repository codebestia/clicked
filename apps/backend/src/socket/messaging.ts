import type { Server } from 'socket.io';
import { and, eq, lt, desc, sql, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  conversations,
  conversationMembers,
  messages,
  messageEnvelopes,
  userDevices,
  uploads,
} from '../db/schema.js';
import type { AuthSocket } from '../middleware/socketAuth.js';
import { invalidateConversationCaches } from '../lib/conversationCache.js';
import { serializeMessage } from '../lib/messages.js';
import { redis } from '../lib/redis.js';
import { publishEphemeral, readMissedEvents } from '../services/resumeStream.js';

const PAGE_SIZE = 30;

export function registerMessagingHandlers(io: Server, socket: AuthSocket): void {
  const userId = socket.auth!.userId;

  // ── join_room ──────────────────────────────────────────────────────────────
  // Payload: { conversationId: string }
  // Guards that the caller is a member before subscribing them to the room.
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
  // Payload: { conversationId, messageId, contentType, ciphertext, envelopes }
  // Persists the message and broadcasts it to all room members.
  socket.on(
    'send_message',
    async (payload: {
      conversationId: string;
      messageId: string;
      contentType?: string;
      ciphertext?: string;
      envelopes?: Array<{ recipientDeviceId: string; ciphertext: string }>;
    }) => {
      const { conversationId, messageId, contentType, ciphertext, envelopes } = payload;
      const deviceId = socket.auth!.deviceId;

      if (!messageId) {
        socket.emit('error', { event: 'send_message', message: 'messageId is required' });
        return;
      }

      if (!ciphertext?.trim() && (!envelopes || envelopes.length === 0)) {
        socket.emit('error', { event: 'send_message', message: 'Message content is empty' });
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
          event: 'send_message',
          message: 'Not a member of this conversation',
        });
        return;
      }

      // If the message is a file type, verify the file upload is complete and ready
      if (contentType && contentType !== 'text/plain' && contentType !== 'system') {
        const upload = await db.query.uploads.findFirst({
          where: eq(uploads.id, messageId),
        });

        if (!upload || upload.status !== 'ready') {
          socket.emit('error', {
            event: 'send_message',
            message: 'File upload is pending or not found',
          });
          return;
        }
      }

      // Idempotency check
      const existing = await db.query.messages.findFirst({
        where: eq(messages.id, messageId),
        columns: { sequenceNumber: true },
      });

      if (existing) {
        socket.emit('message_ack', { messageId, sequenceNumber: existing.sequenceNumber });
        return;
      }

      const [message] = await db
        .insert(messages)
        .values({
          id: messageId,
          conversationId,
          senderId: userId,
          senderDeviceId: deviceId,
          contentType: contentType || 'text/plain',
          ciphertext: ciphertext || null,
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

      // Emit acknowledgment to sender
      if (message) {
        socket.emit('message_ack', { messageId, sequenceNumber: message.sequenceNumber });
      }

      io.to(conversationId).emit('new_message', message);

      const members = await db.query.conversationMembers.findMany({
        where: eq(conversationMembers.conversationId, conversationId),
        columns: { userId: true },
      });

      await invalidateConversationCaches(members.map((member) => member.userId));
    },
  );

  // ── edit_message ─────────────────────────────────────────────────────────────
  // Payload: { originalMessageId, messageId, contentType?, ciphertext?, envelopes? }
  // An edit is never an in-place plaintext mutation (#190). It is a brand-new
  // message carrying fresh ciphertext + envelopes, linked back to the original
  // via `editsMessageId`. Only the original sender may edit. We broadcast both
  // `new_message` (so devices receive the new ciphertext to decrypt) and
  // `message_edited` (so clients render the newest version with an "edited"
  // marker and supersede the original).
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

      // Edit authorship is restricted to the original sender.
      if (original.senderId !== userId) {
        socket.emit('error', {
          event: 'edit_message',
          message: 'Only the original sender can edit this message',
        });
        return;
      }

      // Always link to the root original so a chain of edits collapses to one
      // logical message: editing an edit still points back to the first version.
      const rootMessageId = original.editsMessageId ?? original.id;
      const conversationId = original.conversationId;

      // Idempotency: a retried edit with the same new messageId is a no-op.
      const existing = await db.query.messages.findFirst({
        where: eq(messages.id, messageId),
        columns: { sequenceNumber: true },
      });

      if (existing) {
        socket.emit('message_ack', { messageId, sequenceNumber: existing.sequenceNumber });
        return;
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
  // Payload: { conversationId: string; before?: string } (before = message id cursor)
  // Returns the last PAGE_SIZE messages, optionally before a cursor for pagination.
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
  // Payload: { messageId: string }
  // Sender retraction
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
  // Payload: { conversationId: string; lastReadMessageId: string }
  // Persists the caller's read position and broadcasts to the room.
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

      // Ensure message exists in this conversation (prevents spoofed reads)
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

      // Persist this receipt to each member's resume stream so a member who is
      // offline right now can replay it on reconnect. The receipt is ephemeral
      // (Redis only) — the underlying messages are recovered via envelope sync.
      // Skip the member lookup entirely when there is no stream to write to.
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

  // ── resume ───────────────────────────────────────────────────────────────────
  // Payload: { lastEventId?: string }
  // On reconnect, replay the lightweight ephemeral events this device missed
  // (receipts, presence, system notices) from its short-lived Redis stream, then
  // tell the client to run a full envelope sync for durable messages — which live
  // in Postgres and are intentionally never placed on the resume stream.
  socket.on('resume', async (payload: { lastEventId?: string }) => {
    if (!redis) {
      // No replay backend available; the client must fall back to a full sync.
      socket.emit('resume_complete', { lastEventId: null, syncRequired: true });
      return;
    }

    const lastEventId = typeof payload?.lastEventId === 'string' ? payload.lastEventId : '';

    const missed = await readMissedEvents(redis, userId, lastEventId);
    for (const event of missed) {
      socket.emit('ephemeral_replay', { id: event.id, type: event.type, data: event.data });
    }

    const newCursor = missed.length > 0 ? missed[missed.length - 1]!.id : lastEventId || null;
    socket.emit('resume_complete', { lastEventId: newCursor, syncRequired: true });
  });

  // ── create_conversation ────────────────────────────────────────────────────
  // Payload: { type: 'dm'|'group'; name?: string; memberIds: string[] }
  // Creates a conversation and adds all members (including caller).
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
  // ── typing_start ────────────────────────────────────────────────────────────
  // Payload: { conversationId: string }
  // Broadcasts to the room excluding the sender. No DB write.
  socket.on('typing_start', async (payload: { conversationId: string }) => {
    const { conversationId } = payload;

    const membership = await db.query.conversationMembers.findFirst({
      where: and(
        eq(conversationMembers.conversationId, conversationId),
        eq(conversationMembers.userId, userId),
      ),
    });

    if (!membership) {
      socket.emit('error', { event: 'typing_start', message: 'Not a member of this conversation' });
      return;
    }

    socket.to(conversationId).volatile.emit('typing_start', { conversationId, userId });
  });

  // ── typing_stop ─────────────────────────────────────────────────────────────
  // Payload: { conversationId: string }
  // Broadcasts to the room excluding the sender. No DB write.
  socket.on('typing_stop', async (payload: { conversationId: string }) => {
    const { conversationId } = payload;

    const membership = await db.query.conversationMembers.findFirst({
      where: and(
        eq(conversationMembers.conversationId, conversationId),
        eq(conversationMembers.userId, userId),
      ),
    });

    if (!membership) {
      socket.emit('error', { event: 'typing_stop', message: 'Not a member of this conversation' });
      return;
    }

    socket.to(conversationId).volatile.emit('typing_stop', { conversationId, userId });
  });

  // ── ask_assistant ──────────────────────────────────────────────────────────
  // Payload: { conversationId: string; content: string }
  // Forwards to AI agent and posts reply from reserved assistant user.
  // Rate-limit: 5 requests per user per minute.
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

    // Rate limiting
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

    // Forward to AI agent
    try {
      const response = await fetch('http://localhost:8000/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: content,
          conversation_id: conversationId,
        }),
      });

      if (!response.ok) {
        throw new Error('AI agent error');
      }

      const data = (await response.json()) as { reply: string };

      // Ensure assistant user exists (upsert)
      // Usually done via migration, but we can safely do it here or assume it exists.
      // To be safe, we'll try to insert it and ignore conflict.
      await db.execute(sql`
        INSERT INTO users (id, username, avatar_url)
        VALUES (${ASSISTANT_USER_ID}, 'Assistant', 'https://ui-avatars.com/api/?name=AI&background=0D8ABC&color=fff')
        ON CONFLICT (id) DO NOTHING
      `);

      // Add to conversation members if not already
      await db.execute(sql`
        INSERT INTO conversation_members (conversation_id, user_id)
        VALUES (${conversationId}, ${ASSISTANT_USER_ID})
        ON CONFLICT DO NOTHING
      `);

      // Post the reply
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
