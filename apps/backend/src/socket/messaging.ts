import type { Server } from 'socket.io';
import { and, eq, lt, desc, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { conversations, conversationMembers, messages, files } from '../db/schema.js';
import type { AuthSocket } from '../middleware/socketAuth.js';
import { invalidateConversationCaches } from '../lib/conversationCache.js';
import { serializeMessage } from '../lib/messages.js';
import { redis } from '../lib/redis.js';

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
  // Payload: { conversationId: string; content: string }
  // Persists the message and broadcasts it to all room members.
  socket.on('send_message', async (payload: { conversationId: string; content: string; fileId?: string }) => {
    const { conversationId, content, fileId } = payload;

    if (!content?.trim() && !fileId) {
      socket.emit('error', { event: 'send_message', message: 'Content or file must be provided' });
      return;
    }

    const membership = await db.query.conversationMembers.findFirst({
      where: and(
        eq(conversationMembers.conversationId, conversationId),
        eq(conversationMembers.userId, userId),
      ),
    });

    if (!membership) {
      socket.emit('error', { event: 'send_message', message: 'Not a member of this conversation' });
      return;
    }

    if (fileId) {
      const file = await db.query.files.findFirst({
        where: eq(files.id, fileId),
      });
      if (!file) {
        socket.emit('error', { event: 'send_message', message: 'File not found' });
        return;
      }
      if (file.status !== 'ready') {
        socket.emit('error', { event: 'send_message', message: 'File is not ready' });
        return;
      }
    }

    const [message] = await db
      .insert(messages)
      .values({ conversationId, senderId: userId, content: content?.trim() ?? '', fileId })
      .returning();

    io.to(conversationId).emit('new_message', message);

    const members = await db.query.conversationMembers.findMany({
      where: eq(conversationMembers.conversationId, conversationId),
      columns: { userId: true },
    });

    await invalidateConversationCaches(members.map((member) => member.userId));
  });

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

      io.to(conversationId).emit('read_receipt', { userId, lastReadMessageId });
    },
  );

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

    socket.to(conversationId).emit('typing_start', { conversationId, userId });
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

    socket.to(conversationId).emit('typing_stop', { conversationId, userId });
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
          content: data.reply,
        })
        .returning();

      io.to(conversationId).emit('new_message', replyMessage);

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
