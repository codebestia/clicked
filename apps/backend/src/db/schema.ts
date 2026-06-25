import {
  pgTable,
  text,
  timestamp,
  uuid,
  boolean,
  integer,
  pgEnum,
  index,
  unique,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  username: text('username').unique(),
  avatarUrl: text('avatar_url'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const wallets = pgTable('wallets', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  address: text('address').notNull().unique(),
  isPrimary: boolean('is_primary').notNull().default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// ─── Devices & E2E prekey bundles (#160) ───────────────────────────────────────
//
// Every device advertises an X3DH/Signal-style key bundle so other users can
// open an end-to-end encrypted session with it:
//   - a long-term `identityPublicKey` + numeric `registrationId`
//   - one medium-term signed prekey (`signedPreKey*`), and
//   - a pool of single-use one-time prekeys (`one_time_pre_keys`).
//
// Only PUBLIC key material and signatures are stored here — private keys never
// leave the owning client. A one-time prekey is handed out at most once: it is
// claimed with a single atomic `UPDATE ... WHERE consumed = false ... RETURNING`
// so concurrent senders can never receive the same key. `revokedAt` soft-revokes
// a device, after which its bundle is no longer served.

export const devices = pgTable(
  'devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    identityPublicKey: text('identity_public_key').notNull(),
    registrationId: integer('registration_id').notNull(),
    signedPreKeyId: integer('signed_pre_key_id').notNull(),
    signedPreKeyPublic: text('signed_pre_key_public').notNull(),
    signedPreKeySignature: text('signed_pre_key_signature').notNull(),
    revokedAt: timestamp('revoked_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [index('devices_user_id_idx').on(table.userId)],
);

export const oneTimePreKeys = pgTable(
  'one_time_pre_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    keyId: integer('key_id').notNull(),
    publicKey: text('public_key').notNull(),
    consumed: boolean('consumed').notNull().default(false),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    // Partial-friendly lookup of the next unconsumed key for a device.
    index('one_time_pre_keys_device_consumed_idx').on(table.deviceId, table.consumed),
    unique('one_time_pre_keys_device_key_unique').on(table.deviceId, table.keyId),
  ],
);

// ─── Conversations ────────────────────────────────────────────────────────────

export const conversationTypeEnum = pgEnum('conversation_type', ['dm', 'group']);

export const conversations = pgTable('conversations', {
  id: uuid('id').primaryKey().defaultRandom(),
  type: conversationTypeEnum('type').notNull().default('dm'),
  name: text('name'),
  avatarUrl: text('avatar_url'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const conversationMembers = pgTable('conversation_members', {
  id: uuid('id').primaryKey().defaultRandom(),
  conversationId: uuid('conversation_id')
    .notNull()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  lastReadMessageId: uuid('last_read_message_id').references(() => messages.id, {
    onDelete: 'set null',
  }),
  isMuted: boolean('is_muted').notNull().default(false),
  isArchived: boolean('is_archived').notNull().default(false),
  joinedAt: timestamp('joined_at').notNull().defaultNow(),
});

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    senderId: uuid('sender_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    content: text('content').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    deletedAt: timestamp('deleted_at'),
  },
  (table) => [
    index('messages_content_search_idx').using(
      'gin',
      sql`to_tsvector('english', ${table.content})`,
    ),
  ],
);

// ─── Token transfers (#46) ────────────────────────────────────────────────────
//
// One row per Soroban `transfer` event the listener (services/stellarListener.ts)
// pulls off the contract. The `txHash` is unique so reconnects + replayed event
// pages upsert cleanly instead of producing duplicates.

export const tokenTransfers = pgTable('token_transfers', {
  id: uuid('id').primaryKey().defaultRandom(),
  conversationId: uuid('conversation_id')
    .notNull()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  senderId: uuid('sender_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  recipientAddress: text('recipient_address').notNull(),
  amount: text('amount').notNull(),
  tokenContractId: text('token_contract_id').notNull(),
  txHash: text('tx_hash').notNull().unique(),
  memo: text('memo'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// ─── Relations ────────────────────────────────────────────────────────────────

export const usersRelations = relations(users, ({ many }) => ({
  wallets: many(wallets),
  memberships: many(conversationMembers),
  messages: many(messages),
  transfers: many(tokenTransfers),
  devices: many(devices),
}));

export const walletsRelations = relations(wallets, ({ one }) => ({
  user: one(users, { fields: [wallets.userId], references: [users.id] }),
}));

export const devicesRelations = relations(devices, ({ one, many }) => ({
  user: one(users, { fields: [devices.userId], references: [users.id] }),
  oneTimePreKeys: many(oneTimePreKeys),
}));

export const oneTimePreKeysRelations = relations(oneTimePreKeys, ({ one }) => ({
  device: one(devices, { fields: [oneTimePreKeys.deviceId], references: [devices.id] }),
}));

export const conversationsRelations = relations(conversations, ({ many }) => ({
  members: many(conversationMembers),
  messages: many(messages),
  transfers: many(tokenTransfers),
}));

export const conversationMembersRelations = relations(conversationMembers, ({ one }) => ({
  conversation: one(conversations, {
    fields: [conversationMembers.conversationId],
    references: [conversations.id],
  }),
  user: one(users, { fields: [conversationMembers.userId], references: [users.id] }),
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  conversation: one(conversations, {
    fields: [messages.conversationId],
    references: [conversations.id],
  }),
  sender: one(users, { fields: [messages.senderId], references: [users.id] }),
}));

export const tokenTransfersRelations = relations(tokenTransfers, ({ one }) => ({
  conversation: one(conversations, {
    fields: [tokenTransfers.conversationId],
    references: [conversations.id],
  }),
  sender: one(users, {
    fields: [tokenTransfers.senderId],
    references: [users.id],
  }),
}));

// ─── Types ────────────────────────────────────────────────────────────────────

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Wallet = typeof wallets.$inferSelect;
export type NewWallet = typeof wallets.$inferInsert;
export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;
export type ConversationMember = typeof conversationMembers.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type TokenTransfer = typeof tokenTransfers.$inferSelect;
export type NewTokenTransfer = typeof tokenTransfers.$inferInsert;
export type Device = typeof devices.$inferSelect;
export type NewDevice = typeof devices.$inferInsert;
export type OneTimePreKey = typeof oneTimePreKeys.$inferSelect;
export type NewOneTimePreKey = typeof oneTimePreKeys.$inferInsert;
