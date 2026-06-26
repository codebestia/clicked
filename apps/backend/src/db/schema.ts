import {
  pgTable,
  text,
  timestamp,
  uuid,
  boolean,
  integer,
  pgEnum,
  index,
  uniqueIndex,
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

export const devices = pgTable('devices', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  deviceId: text('device_id').notNull(),
  deviceName: text('device_name').notNull(),
  platform: text('platform').notNull(),
  identityPublicKey: text('identity_public_key').notNull(),
  registrationId: text('registration_id'),
  isRevoked: boolean('is_revoked').notNull().default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const devicePrekeys = pgTable('device_prekeys', {
  id: uuid('id').primaryKey().defaultRandom(),
  deviceId: uuid('device_id')
    .notNull()
    .references(() => devices.id, { onDelete: 'cascade' }),
  prekey: text('prekey').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

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

// ─── User devices (#153) ──────────────────────────────────────────────────────
//
// Device identity registry for end-to-end encryption. Each row is one device a
// user has registered, holding its long-term identity public key. A device is
// never hard-deleted — revoking sets `revokedAt` so historical sessions stay
// auditable. `(userId, deviceId)` is unique so a client re-registering the same
// device upserts instead of duplicating, and the partial index keeps lookups of
// a user's *active* devices fast.

export const devicePlatformEnum = pgEnum('device_platform', ['web', 'ios', 'android']);

export const userDevices = pgTable(
  'user_devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deviceId: text('device_id').notNull(),
    deviceName: text('device_name').notNull(),
    platform: devicePlatformEnum('platform').notNull(),
    identityPublicKey: text('identity_public_key').notNull(),
    registrationId: integer('registration_id'),
    lastSeenAt: timestamp('last_seen_at'),
    revokedAt: timestamp('revoked_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('user_devices_user_id_device_id_unique').on(table.userId, table.deviceId),
    index('user_devices_user_id_active_idx')
      .on(table.userId)
      .where(sql`${table.revokedAt} IS NULL`),
  ],
);

// ─── Treasury Proposals (#130) ────────────────────────────────────────────────
//
// Synced from GROUP_TREASURY_CONTRACT_ID events by the Stellar listener.
// Idempotent upsert on (contractId, proposalId).

export const treasuryProposalStatusEnum = pgEnum('treasury_proposal_status', [
  'active',
  'approved',
  'rejected',
  'executed',
  'expired',
]);

export const treasuryProposals = pgTable(
  'treasury_proposals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contractId: text('contract_id').notNull(),
    proposalId: text('proposal_id').notNull(),
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    status: treasuryProposalStatusEnum('status').notNull().default('active'),
    approvalsCount: integer('approvals_count').notNull().default(0),
    rejectionsCount: integer('rejections_count').notNull().default(0),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('treasury_proposals_contract_proposal_idx').on(table.contractId, table.proposalId),
  ],
);

export type TreasuryProposal = typeof treasuryProposals.$inferSelect;
export type NewTreasuryProposal = typeof treasuryProposals.$inferInsert;

// ─── Relations ────────────────────────────────────────────────────────────────

export const usersRelations = relations(users, ({ many }) => ({
  wallets: many(wallets),
  memberships: many(conversationMembers),
  messages: many(messages),
  transfers: many(tokenTransfers),
  devices: many(userDevices),
}));

export const walletsRelations = relations(wallets, ({ one }) => ({
  user: one(users, { fields: [wallets.userId], references: [users.id] }),
}));

export const conversationsRelations = relations(conversations, ({ many }) => ({
  members: many(conversationMembers),
  messages: many(messages),
  transfers: many(tokenTransfers),
  treasuryProposals: many(treasuryProposals),
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

export const devicesRelations = relations(devices, ({ one, many }) => ({
  user: one(users, { fields: [devices.userId], references: [users.id] }),
  prekeys: many(devicePrekeys),
}));

export const devicePrekeysRelations = relations(devicePrekeys, ({ one }) => ({
  device: one(devices, { fields: [devicePrekeys.deviceId], references: [devices.id] }),
}));

export const userDevicesRelations = relations(userDevices, ({ one }) => ({
  user: one(users, { fields: [userDevices.userId], references: [users.id] }),
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
export type DevicePrekey = typeof devicePrekeys.$inferSelect;
export type NewDevicePrekey = typeof devicePrekeys.$inferInsert;
export type UserDevice = typeof userDevices.$inferSelect;
export type NewUserDevice = typeof userDevices.$inferInsert;
