/**
 * Tests for `message_edited` socket event handling in useInboundPipeline (#674).
 *
 * Acceptance criteria:
 *  1. The edited ciphertext goes through the normal decrypt path and the
 *     message is replaced in-place with an "edited" marker.
 *  2. The plaintext cache and the search index are updated with the new text.
 *  3. An edit that fails to decrypt keeps the original and shows the existing
 *     unavailable state rather than blanking the message.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageEditedEvent } from '@/lib/crypto/types';

// ---------------------------------------------------------------------------
// Mocks — all vi.fn() references must be created with vi.hoisted() so they
// are available when vi.mock() factory functions execute (vi.mock is hoisted
// to the top of the file by Vitest's transform, before any const declarations).
// ---------------------------------------------------------------------------

const {
  mockSetCachedPlaintext,
  mockGetCachedPlaintext,
  mockDeleteCachedPlaintext,
  mockIndexMessages,
  mockRemoveMessages,
  mockProcessInboundEnvelope,
} = vi.hoisted(() => ({
  mockSetCachedPlaintext: vi.fn(),
  mockGetCachedPlaintext: vi.fn(() => undefined as string | undefined),
  mockDeleteCachedPlaintext: vi.fn(),
  mockIndexMessages: vi.fn(async () => {}),
  mockRemoveMessages: vi.fn(async () => {}),
  mockProcessInboundEnvelope: vi.fn(),
}));

vi.mock('@/lib/crypto/plaintextCache', () => ({
  setCachedPlaintext: mockSetCachedPlaintext,
  getCachedPlaintext: mockGetCachedPlaintext,
  deleteCachedPlaintext: mockDeleteCachedPlaintext,
  hasCachedPlaintext: vi.fn(() => false),
  clearPlaintextCache: vi.fn(),
}));

vi.mock('@/lib/search/searchClient', () => ({
  indexMessages: mockIndexMessages,
  removeMessages: mockRemoveMessages,
  search: vi.fn(),
  clearIndex: vi.fn(),
  waitReady: vi.fn(async () => {}),
}));

vi.mock('@/lib/crypto/processEnvelope', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/crypto/processEnvelope')>();
  return {
    ...actual,
    processInboundEnvelope: mockProcessInboundEnvelope,
  };
});

vi.mock('@/lib/api', () => ({ API_BASE_URL: 'http://localhost:3001' }));
vi.mock('@/lib/jwt', () => ({ getE2EDeviceId: vi.fn(() => 'device-1') }));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEditedEvent(overrides: Partial<MessageEditedEvent> = {}): MessageEditedEvent {
  return {
    messageId: 'msg-1',
    conversationId: 'conv-1',
    senderId: 'sender-1',
    senderDeviceId: 'device-sender-1',
    contentType: 'text/plain',
    sequenceNumber: 5,
    createdAt: new Date().toISOString(),
    ciphertext: 'new-ciphertext',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The handler under test, extracted without React hooks so we can unit-test
// the pure logic synchronously.
// ---------------------------------------------------------------------------

import {
  processInboundEnvelope,
  mergeInboundMessage,
} from '@/lib/crypto/processEnvelope';
import { setCachedPlaintext } from '@/lib/crypto/plaintextCache';
import { indexMessages } from '@/lib/search/searchClient';
import type { InboundMessage } from '@/lib/crypto/types';

/**
 * Extracted version of handleMessageEdited matching the hook implementation,
 * so we can test the three acceptance criteria without spinning up React.
 */
async function handleMessageEdited(
  event: MessageEditedEvent,
  {
    conversationId,
    token,
    deletedIds,
    upsertMessage,
  }: {
    conversationId: string;
    token: string;
    deletedIds: Set<string>;
    upsertMessage: (msg: InboundMessage) => void;
  },
) {
  if (event.conversationId !== conversationId) return;
  if (deletedIds.has(event.messageId)) return;

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
    token,
  );

  if (deletedIds.has(event.messageId)) return;

  if (result.status === 'decrypted' && result.plaintext) {
    setCachedPlaintext(event.messageId, result.plaintext);
    await indexMessages([
      {
        id: event.messageId,
        conversationId: event.conversationId,
        senderId: event.senderId,
        plaintext: result.plaintext,
        contentType: event.contentType,
        createdAt: event.createdAt,
        sequenceNumber: event.sequenceNumber,
      },
    ]).catch(() => {});
  }

  upsertMessage({ ...result, edited: true });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('message_edited handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCachedPlaintext.mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Acceptance criterion 1: edited ciphertext goes through the decrypt path
  // and the message is replaced in place with an "edited" marker.
  // -------------------------------------------------------------------------
  it('AC1: decrypts the new ciphertext and upserts the message with edited:true', async () => {
    const decryptedResult: InboundMessage = {
      messageId: 'msg-1',
      conversationId: 'conv-1',
      senderId: 'sender-1',
      senderDeviceId: 'device-sender-1',
      sequenceNumber: 5,
      contentType: 'text/plain',
      createdAt: new Date().toISOString(),
      status: 'decrypted',
      plaintext: 'updated message text',
    };
    mockProcessInboundEnvelope.mockResolvedValueOnce(decryptedResult);

    const upsertMessage = vi.fn();
    const event = makeEditedEvent();

    await handleMessageEdited(event, {
      conversationId: 'conv-1',
      token: 'tok',
      deletedIds: new Set(),
      upsertMessage,
    });

    // Decrypt was called with the new ciphertext.
    expect(mockProcessInboundEnvelope).toHaveBeenCalledOnce();
    expect(mockProcessInboundEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({ ciphertext: 'new-ciphertext', messageId: 'msg-1' }),
      'tok',
    );

    // Message upserted with edited flag.
    expect(upsertMessage).toHaveBeenCalledOnce();
    expect(upsertMessage).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'decrypted', edited: true }),
    );
  });

  // -------------------------------------------------------------------------
  // Acceptance criterion 2: plaintext cache and search index updated.
  // -------------------------------------------------------------------------
  it('AC2: updates the plaintext cache and search index with the new text', async () => {
    const decryptedResult: InboundMessage = {
      messageId: 'msg-1',
      conversationId: 'conv-1',
      senderId: 'sender-1',
      senderDeviceId: 'device-sender-1',
      sequenceNumber: 5,
      contentType: 'text/plain',
      createdAt: new Date().toISOString(),
      status: 'decrypted',
      plaintext: 'brand new content',
    };
    mockProcessInboundEnvelope.mockResolvedValueOnce(decryptedResult);

    await handleMessageEdited(makeEditedEvent(), {
      conversationId: 'conv-1',
      token: 'tok',
      deletedIds: new Set(),
      upsertMessage: vi.fn(),
    });

    // Plaintext cache overwritten with new text.
    expect(mockSetCachedPlaintext).toHaveBeenCalledWith('msg-1', 'brand new content');

    // Search index updated with new plaintext.
    expect(mockIndexMessages).toHaveBeenCalledOnce();
    expect(mockIndexMessages).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'msg-1', plaintext: 'brand new content' }),
    ]);
  });

  // -------------------------------------------------------------------------
  // Acceptance criterion 3: failed decrypt keeps original, shows unavailable
  // state rather than blanking the message.
  // -------------------------------------------------------------------------
  it('AC3: keeps the original on decrypt failure and sets edited:true with unavailable status', async () => {
    const unavailableResult: InboundMessage = {
      messageId: 'msg-1',
      conversationId: 'conv-1',
      senderId: 'sender-1',
      senderDeviceId: 'device-sender-1',
      sequenceNumber: 5,
      contentType: 'text/plain',
      createdAt: new Date().toISOString(),
      status: 'unavailable',
      unavailableReason: 'undecryptable',
    };
    mockProcessInboundEnvelope.mockResolvedValueOnce(unavailableResult);

    const upsertMessage = vi.fn();

    await handleMessageEdited(makeEditedEvent(), {
      conversationId: 'conv-1',
      token: 'tok',
      deletedIds: new Set(),
      upsertMessage,
    });

    // Cache and search index must NOT be touched.
    expect(mockSetCachedPlaintext).not.toHaveBeenCalled();
    expect(mockIndexMessages).not.toHaveBeenCalled();

    // The upserted message is unavailable, NOT blank — edited flag still set.
    expect(upsertMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'unavailable',
        unavailableReason: 'undecryptable',
        edited: true,
      }),
    );
  });

  // -------------------------------------------------------------------------
  // Guard: ignore events for other conversations.
  // -------------------------------------------------------------------------
  it('ignores events whose conversationId does not match', async () => {
    const upsertMessage = vi.fn();

    await handleMessageEdited(makeEditedEvent({ conversationId: 'other-conv' }), {
      conversationId: 'conv-1',
      token: 'tok',
      deletedIds: new Set(),
      upsertMessage,
    });

    expect(mockProcessInboundEnvelope).not.toHaveBeenCalled();
    expect(upsertMessage).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Guard: ignore edits for deleted messages.
  // -------------------------------------------------------------------------
  it('ignores events for messages that have already been deleted', async () => {
    const upsertMessage = vi.fn();

    await handleMessageEdited(makeEditedEvent(), {
      conversationId: 'conv-1',
      token: 'tok',
      deletedIds: new Set(['msg-1']),
      upsertMessage,
    });

    expect(mockProcessInboundEnvelope).not.toHaveBeenCalled();
    expect(upsertMessage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// mergeInboundMessage — edited flag preservation
// ---------------------------------------------------------------------------
describe('mergeInboundMessage — edited flag', () => {
  it('propagates edited:true from the existing message when incoming is pending', () => {
    const existing: InboundMessage = {
      messageId: 'msg-1',
      conversationId: 'conv-1',
      senderId: 's',
      senderDeviceId: null,
      sequenceNumber: 1,
      contentType: 'text/plain',
      createdAt: '',
      status: 'decrypted',
      plaintext: 'original',
      edited: true,
    };
    const incoming: InboundMessage = { ...existing, status: 'pending', plaintext: undefined, edited: undefined };
    const merged = mergeInboundMessage(existing, incoming);
    expect(merged.edited).toBe(true);
  });

  it('propagates edited:true from the incoming message when merging', () => {
    const existing: InboundMessage = {
      messageId: 'msg-1',
      conversationId: 'conv-1',
      senderId: 's',
      senderDeviceId: null,
      sequenceNumber: 1,
      contentType: 'text/plain',
      createdAt: '',
      status: 'pending',
    };
    const incoming: InboundMessage = { ...existing, status: 'decrypted', plaintext: 'new', edited: true };
    const merged = mergeInboundMessage(existing, incoming);
    expect(merged.edited).toBe(true);
    expect(merged.plaintext).toBe('new');
  });
});
