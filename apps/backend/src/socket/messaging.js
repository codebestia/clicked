import { randomUUID } from 'node:crypto';
import { and, eq, lt, desc, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { conversations, conversationMembers, messages, messageEnvelopes, devices } from '../db/schema.js';
import { invalidateConversationCaches } from '../lib/conversationCache.js';
import { serializeMessage } from '../lib/messages.js';
import { redis } from '../lib/redis.js';
const PAGE_SIZE = 30;
export function registerMessagingHandlers(io, socket) {
    const userId = socket.auth.userId;
    // ── join_room ──────────────────────────────────────────────────────────────
    // Payload: { conversationId: string }
    // Guards that the caller is a member before subscribing them to the room.
    socket.on('join_room', async (payload) => {
        const { conversationId } = payload;
        const membership = await db.query.conversationMembers.findFirst({
            where: and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, userId)),
        });
        if (!membership) {
            socket.emit('error', { event: 'join_room', message: 'Not a member of this conversation' });
            return;
        }
        await socket.join(conversationId);
        socket.emit('room_joined', { conversationId });
    });
    // ── send_message ───────────────────────────────────────────────────────────
    // Payload: { conversationId: string; messageId: string; contentType?: string; envelopes?: { recipientDeviceId: string; ciphertext: string }[]; ciphertext?: string; senderDeviceId?: string; }
    // Persists the message and envelopes, broadcasts it to all room members, and acks the sender.
    socket.on('send_message', async (payload) => {
        const { conversationId, messageId, contentType = 'text/plain', envelopes = [], ciphertext, senderDeviceId, } = payload;
        if (!messageId) {
            socket.emit('error', { event: 'send_message', message: 'messageId is required' });
            return;
        }
        const membership = await db.query.conversationMembers.findFirst({
            where: and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, userId)),
        });
        if (!membership) {
            socket.emit('error', { event: 'send_message', message: 'Not a member of this conversation' });
            return;
        }
        try {
            const insertResult = await db.execute(sql `
          INSERT INTO messages (id, conversation_id, sender_id, sender_device_id, content_type, ciphertext, sequence_number)
          VALUES (
            ${messageId}::uuid,
            ${conversationId}::uuid,
            ${userId}::uuid,
            ${senderDeviceId ? sql `${senderDeviceId}::uuid` : sql `NULL::uuid`},
            ${contentType},
            ${ciphertext ?? null},
            COALESCE((SELECT MAX(sequence_number) FROM messages WHERE conversation_id = ${conversationId}::uuid), 0) + 1
          )
          ON CONFLICT (id) DO NOTHING
          RETURNING id, sequence_number, created_at
        `);
            if (insertResult.length === 0) {
                // Idempotent: already exists. Fetch it to return ACK.
                const existing = await db.query.messages.findFirst({
                    where: eq(messages.id, messageId),
                });
                if (existing) {
                    socket.emit('message_ack', { messageId, sequenceNumber: existing.sequenceNumber });
                }
                return;
            }
            const messageData = insertResult[0];
            if (envelopes.length > 0) {
                const deviceIds = envelopes.map(e => e.recipientDeviceId);
                const devicesList = await db.query.devices.findMany({
                    where: sql `id = ANY(ARRAY[${sql.join(deviceIds.map(d => sql `${d}::uuid`), sql `, `)}])`
                });
                const deviceUserMap = new Map(devicesList.map(d => [d.id, d.userId]));
                const envelopeValues = envelopes
                    .filter(e => deviceUserMap.has(e.recipientDeviceId))
                    .map(e => ({
                    messageId,
                    recipientDeviceId: e.recipientDeviceId,
                    recipientUserId: deviceUserMap.get(e.recipientDeviceId),
                    ciphertext: e.ciphertext
                }));
                if (envelopeValues.length > 0) {
                    await db.insert(messageEnvelopes).values(envelopeValues);
                }
            }
            const messageToEmit = await db.query.messages.findFirst({
                where: eq(messages.id, messageId),
                with: { sender: { columns: { id: true, username: true, avatarUrl: true } } },
            });
            io.to(conversationId).emit('new_message', serializeMessage(messageToEmit));
            socket.emit('message_ack', { messageId, sequenceNumber: messageData.sequence_number });
            const members = await db.query.conversationMembers.findMany({
                where: eq(conversationMembers.conversationId, conversationId),
                columns: { userId: true },
            });
            await invalidateConversationCaches(members.map((member) => member.userId));
        }
        catch (error) {
            console.error('send_message error:', error);
            socket.emit('error', { event: 'send_message', message: 'Failed to send message' });
        }
    });
    // ── message_history ────────────────────────────────────────────────────────
    // Payload: { conversationId: string; before?: string } (before = message id cursor)
    // Returns the last PAGE_SIZE messages, optionally before a cursor for pagination.
    socket.on('message_history', async (payload) => {
        const { conversationId, before } = payload;
        const membership = await db.query.conversationMembers.findFirst({
            where: and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, userId)),
        });
        if (!membership) {
            socket.emit('error', {
                event: 'message_history',
                message: 'Not a member of this conversation',
            });
            return;
        }
        let cursor;
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
    socket.on('message_read', async (payload) => {
        const { conversationId, lastReadMessageId } = payload;
        const membership = await db.query.conversationMembers.findFirst({
            where: and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, userId)),
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
            .where(and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, userId)));
        io.to(conversationId).emit('read_receipt', { userId, lastReadMessageId });
    });
    // ── create_conversation ────────────────────────────────────────────────────
    // Payload: { type: 'dm'|'group'; name?: string; memberIds: string[] }
    // Creates a conversation and adds all members (including caller).
    socket.on('create_conversation', async (payload) => {
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
    });
    // ── typing_start ────────────────────────────────────────────────────────────
    // Payload: { conversationId: string }
    // Broadcasts to the room excluding the sender. No DB write.
    socket.on('typing_start', async (payload) => {
        const { conversationId } = payload;
        const membership = await db.query.conversationMembers.findFirst({
            where: and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, userId)),
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
    socket.on('typing_stop', async (payload) => {
        const { conversationId } = payload;
        const membership = await db.query.conversationMembers.findFirst({
            where: and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, userId)),
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
    socket.on('ask_assistant', async (payload) => {
        const { conversationId, content } = payload;
        if (!content?.trim().startsWith('@assistant')) {
            return;
        }
        const membership = await db.query.conversationMembers.findFirst({
            where: and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, userId)),
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
            const data = (await response.json());
            // Ensure assistant user exists (upsert)
            // Usually done via migration, but we can safely do it here or assume it exists.
            // To be safe, we'll try to insert it and ignore conflict.
            await db.execute(sql `
        INSERT INTO users (id, username, avatar_url)
        VALUES (${ASSISTANT_USER_ID}, 'Assistant', 'https://ui-avatars.com/api/?name=AI&background=0D8ABC&color=fff')
        ON CONFLICT (id) DO NOTHING
      `);
            // Add to conversation members if not already
            await db.execute(sql `
        INSERT INTO conversation_members (conversation_id, user_id)
        VALUES (${conversationId}, ${ASSISTANT_USER_ID})
        ON CONFLICT DO NOTHING
      `);
            // Post the reply
            const [replyMessage] = await db
                .insert(messages)
                .values({
                id: randomUUID(),
                conversationId,
                senderId: ASSISTANT_USER_ID,
                ciphertext: data.reply,
            })
                .returning();
            io.to(conversationId).emit('new_message', replyMessage);
            const members = await db.query.conversationMembers.findMany({
                where: eq(conversationMembers.conversationId, conversationId),
                columns: { userId: true },
            });
            await invalidateConversationCaches(members.map((member) => member.userId));
        }
        catch (err) {
            console.error('ask_assistant error:', err);
            socket.emit('error', { event: 'ask_assistant', message: 'Failed to get AI reply' });
        }
    });
}
//# sourceMappingURL=messaging.js.map