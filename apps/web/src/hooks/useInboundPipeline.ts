'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { API_BASE_URL } from '@/lib/api';
import { getE2EDeviceId } from '@/lib/jwt';
import {
  mergeInboundMessage,
  processInboundEnvelope,
  sortBySequenceNumber,
  type EnvelopeInput,
} from '@/lib/crypto/processEnvelope';
import type {
  DeviceEnvelopeEvent,
  InboundMessage,
  MessageEditedEvent,
  MessageEnvelopeEvent,
  SyncEnvelope,
} from '@/lib/crypto/types';
import { deleteCachedPlaintext, setCachedPlaintext } from '@/lib/crypto/plaintextCache';
import { indexMessages, removeMessages } from '@/lib/search/searchClient';

interface NewMessageMeta {
  id: string;
  conversationId: string;
  senderId: string;
  senderDeviceId: string | null;
  contentType: string;
  sequenceNumber: number;
  createdAt: string;
  unavailable?: boolean;
}

interface UseInboundPipelineOptions {
  socket: Socket | null;
  token: string | null;
  conversationId: string;
}

interface UseInboundPipelineReturn {
  messages: InboundMessage[];
  deletedMessageIds: Set<string>;
  syncing: boolean;
}

/**
 * Inbound decryption + render pipeline (#296).
 *
 * Receives envelopes live (#144) or via sync (#137), looks up the sender
 * device's public key by senderDeviceId (#122), decrypts, verifies, and
 * exposes messages sorted by sequenceNumber for rendering.
 */
export function useInboundPipeline({
  socket,
  token,
  conversationId,
}: UseInboundPipelineOptions): UseInboundPipelineReturn {
  const [messagesById, setMessagesById] = useState<Map<string, InboundMessage>>(new Map());
  const [syncing, setSyncing] = useState(false);
  const [deletedMessageIds, setDeletedMessageIds] = useState<Set<string>>(new Set());
  const deletedMessageIdsRef = useRef(new Set<string>());

  const pendingCiphertext = useRef(
    new Map<string, { ciphertext: string; sequenceNumber: number; conversationId: string }>(),
  );
  const pendingMeta = useRef(new Map<string, NewMessageMeta>());
  const syncCursor = useRef(0);
  const processing = useRef(new Set<string>());

  const upsertMessage = useCallback((incoming: InboundMessage) => {
    if (deletedMessageIdsRef.current.has(incoming.messageId)) return;

    setMessagesById((prev) => {
      const next = new Map(prev);
      const existing = next.get(incoming.messageId);
      next.set(incoming.messageId, mergeInboundMessage(existing, incoming));
      return next;
    });
  }, []);

  const handleEnvelope = useCallback(
    async (input: EnvelopeInput) => {
      if (!token || input.conversationId !== conversationId) return;
      if (deletedMessageIdsRef.current.has(input.messageId)) return;
      if (processing.current.has(input.messageId)) return;

      processing.current.add(input.messageId);

      try {
        const result = await processInboundEnvelope(input, token);

        if (deletedMessageIdsRef.current.has(input.messageId)) {
          deleteCachedPlaintext(input.messageId);
          return;
        }

        upsertMessage(result);
      } finally {
        processing.current.delete(input.messageId);
      }
    },
    [token, conversationId, upsertMessage],
  );

  const tryProcessPending = useCallback(
    (messageId: string) => {
      const ciphertextEntry = pendingCiphertext.current.get(messageId);
      const meta = pendingMeta.current.get(messageId);
      if (!ciphertextEntry || !meta) return;

      pendingCiphertext.current.delete(messageId);
      pendingMeta.current.delete(messageId);

      void handleEnvelope({
        messageId,
        conversationId: meta.conversationId,
        senderId: meta.senderId,
        senderDeviceId: meta.senderDeviceId,
        sequenceNumber: meta.sequenceNumber,
        contentType: meta.contentType,
        createdAt: meta.createdAt,
        ciphertext: ciphertextEntry.ciphertext,
      });
    },
    [handleEnvelope],
  );

  const ingestCiphertext = useCallback(
    (messageId: string, ciphertext: string, partial: Partial<EnvelopeInput>) => {
      if (deletedMessageIdsRef.current.has(messageId)) return;

      if (partial.conversationId && partial.conversationId !== conversationId) return;

      const meta = pendingMeta.current.get(messageId);
      if (meta) {
        void handleEnvelope({
          messageId,
          conversationId: meta.conversationId,
          senderId: meta.senderId,
          senderDeviceId: meta.senderDeviceId,
          sequenceNumber: meta.sequenceNumber,
          contentType: meta.contentType,
          createdAt: meta.createdAt,
          ciphertext,
        });
        return;
      }

      pendingCiphertext.current.set(messageId, {
        ciphertext,
        sequenceNumber: partial.sequenceNumber ?? 0,
        conversationId: partial.conversationId ?? conversationId,
      });
    },
    [conversationId, handleEnvelope],
  );

  const ingestMeta = useCallback(
    (meta: NewMessageMeta) => {
      if (deletedMessageIdsRef.current.has(meta.id)) return;

      if (meta.conversationId !== conversationId) return;

      if (meta.unavailable) {
        upsertMessage({
          messageId: meta.id,
          conversationId: meta.conversationId,
          senderId: meta.senderId,
          senderDeviceId: meta.senderDeviceId,
          sequenceNumber: meta.sequenceNumber,
          contentType: meta.contentType,
          createdAt: meta.createdAt,
          status: 'unavailable',
          unavailableReason: 'pre-link',
        });
        return;
      }

      pendingMeta.current.set(meta.id, meta);
      tryProcessPending(meta.id);

      // Track metadata-only messages so they appear as pending until ciphertext arrives.
      upsertMessage({
        messageId: meta.id,
        conversationId: meta.conversationId,
        senderId: meta.senderId,
        senderDeviceId: meta.senderDeviceId,
        sequenceNumber: meta.sequenceNumber,
        contentType: meta.contentType,
        createdAt: meta.createdAt,
        status: 'pending',
      });
    },
    [conversationId, tryProcessPending, upsertMessage],
  );

  const runSync = useCallback(async () => {
    if (!token) return;
    const e2eDeviceId = getE2EDeviceId(token);
    if (!e2eDeviceId) return;

    setSyncing(true);
    try {
      let cursor = syncCursor.current;
      let hasMore = true;

      while (hasMore) {
        const params = new URLSearchParams({
          deviceId: e2eDeviceId,
          sinceSequence: String(cursor),
        });
        const res = await fetch(`${API_BASE_URL}/sync?${params}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) break;

        const body = (await res.json()) as {
          envelopes: SyncEnvelope[];
          nextCursor: number;
          hasMore: boolean;
        };

        for (const env of body.envelopes) {
          if (env.conversationId !== conversationId) continue;
          cursor = Math.max(cursor, env.sequenceNumber);
          void handleEnvelope({
            messageId: env.messageId,
            conversationId: env.conversationId,
            senderId: env.senderId,
            senderDeviceId: env.senderDeviceId,
            sequenceNumber: env.sequenceNumber,
            contentType: env.contentType,
            createdAt: env.messageCreatedAt ?? env.createdAt,
            ciphertext: env.ciphertext,
          });
        }

        syncCursor.current = body.nextCursor;
        hasMore = body.hasMore;
      }
    } finally {
      setSyncing(false);
    }
  }, [token, conversationId, handleEnvelope]);

  const handleMessageDeleted = useCallback((event: { messageId: string }) => {
    const { messageId } = event;

    deletedMessageIdsRef.current.add(messageId);

    setDeletedMessageIds((prev) => {
      const next = new Set(prev);
      next.add(messageId);
      return next;
    });

    pendingCiphertext.current.delete(messageId);
    pendingMeta.current.delete(messageId);

    deleteCachedPlaintext(messageId);

    void removeMessages([messageId]).catch((error) => {
      console.warn('Failed to remove deleted message from search index', error);
    });
  }, []);

  /**
   * Handles `message_edited` from the socket (#674).
   *
   * Re-runs the full decrypt path on the new ciphertext so the edited text
   * goes through the same key-lookup and verification as an original message.
   * On success: replaces the plaintext cache entry, updates the search index,
   * and sets `edited: true` on the stored message so the UI can show a marker.
   * On failure: keeps the existing message intact and surfaces the
   * unavailable reason — the original plaintext (if any) is preserved.
   */
  const handleMessageEdited = useCallback(
    async (event: MessageEditedEvent) => {
      if (event.conversationId !== conversationId) return;
      if (deletedMessageIdsRef.current.has(event.messageId)) return;

      // Run the envelope through the normal decrypt pipeline.
      const result = await processInboundEnvelope(
        {
          messageId: event.messageId,
          conversationId: event.conversationId,
          senderId: event.senderId,
          senderDeviceId: event.senderDeviceId,
          sequenceNumber: event.sequenceNumber,
          contentType: event.contentType,
          createdAt: event.createdAt,
          ciphertext: event.ciphertext,
        },
        token ?? '',
      );

      if (deletedMessageIdsRef.current.has(event.messageId)) return;

      if (result.status === 'decrypted' && result.plaintext) {
        // Overwrite the cache so subsequent renders show the updated text.
        setCachedPlaintext(event.messageId, result.plaintext);

        // Reflect the edit in the search index.
        void indexMessages([
          {
            id: event.messageId,
            conversationId: event.conversationId,
            senderId: event.senderId,
            plaintext: result.plaintext,
            contentType: event.contentType,
            createdAt: event.createdAt,
            sequenceNumber: event.sequenceNumber,
          },
        ]).catch((error) => {
          console.warn('Failed to update search index for edited message', error);
        });
      }
      // On decrypt failure the result carries status:'unavailable'. We still
      // upsert so the UI reflects the unavailable state, but we do NOT blank an
      // already-decrypted message — mergeInboundMessage prefers 'decrypted'.
      // We always mark edited:true so the marker stays visible either way.
      upsertMessage({ ...result, edited: true });
    },
    [token, conversationId, upsertMessage],
  );

  // Live envelope delivery (#144).
  useEffect(() => {
    if (!socket) return;

    function onMessageEnvelope(event: MessageEnvelopeEvent) {
      if (event.conversationId !== conversationId) return;
      void handleEnvelope({
        messageId: event.messageId,
        conversationId: event.conversationId,
        senderId: event.senderId,
        senderDeviceId: event.senderDeviceId,
        sequenceNumber: event.sequenceNumber,
        contentType: event.contentType,
        createdAt: event.createdAt,
        ciphertext: event.ciphertext,
      });
    }

    function onDeviceEnvelope(event: DeviceEnvelopeEvent) {
      if (event.conversationId !== conversationId) return;
      ingestCiphertext(event.messageId, event.ciphertext, {
        conversationId: event.conversationId,
        sequenceNumber: event.sequenceNumber,
      });
    }

    function onNewMessage(msg: NewMessageMeta) {
      ingestMeta(msg);
    }

    socket.on('message_envelope', onMessageEnvelope);
    socket.on('device_envelope', onDeviceEnvelope);
    socket.on('new_message', onNewMessage);
    socket.on('message_deleted', handleMessageDeleted);
    socket.on('message_edited', (event: MessageEditedEvent) => {
      void handleMessageEdited(event);
    });

    return () => {
      socket.off('message_envelope', onMessageEnvelope);
      socket.off('device_envelope', onDeviceEnvelope);
      socket.off('new_message', onNewMessage);
      socket.off('message_deleted', handleMessageDeleted);
      socket.off('message_edited');
    };
  }, [socket, conversationId, handleEnvelope, ingestCiphertext, ingestMeta, handleMessageDeleted, handleMessageEdited]);

  // Offline sync on connect (#137).
  useEffect(() => {
    if (!token) return;
    void runSync();
  }, [token, conversationId, runSync]);

  const messages = useMemo(
    () => sortBySequenceNumber(Array.from(messagesById.values())),
    [messagesById],
  );

  return { messages, deletedMessageIds, syncing };
}
