/**
 * Stellar event listener for `token_transfer` (#46) and `group_treasury` multisig (#130).
 *
 * Subscribes to contract events emitted by the `token_transfer` and
 * `group_treasury` Soroban contracts. The listener:
 *
 *   - Polls Soroban RPC `getEvents` on a short interval (cursor-based).
 *   - Reconnects automatically after a transient failure with exponential
 *     backoff capped at 30 seconds.
 *   - Upserts on the unique `tx_hash` / `(contractId, proposalId)` so
 *     reconnects that re-read a page produce no duplicates.
 *   - After each treasury proposal DB update, emits a
 *     `treasury_proposal_updated` Socket.IO event to the relevant room.
 *   - Logs errors via the standard backend logger but never rethrows out
 *     of `runForever`, so the API server stays up even if the chain is
 *     unreachable.
 */
import { rpc } from '@stellar/stellar-sdk';
import { db } from '../db/index.js';
import { tokenTransfers, messages, conversations, users, treasuryProposals } from '../db/schema.js';
import { eq, sql } from 'drizzle-orm';
import { getSocketServer } from '../lib/socket.js';
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_BACKOFF_BASE_MS = 1_000;
const DEFAULT_BACKOFF_MAX_MS = 30_000;
const consoleLogger = {
    info: (msg, ctx) => console.log(`[stellar-listener] ${msg}`, ctx ?? ''),
    warn: (msg, ctx) => console.warn(`[stellar-listener] ${msg}`, ctx ?? ''),
    error: (msg, ctx) => console.error(`[stellar-listener] ${msg}`, ctx ?? ''),
};
/**
 * Default persistence: upsert on `txHash`, attempting to associate the
 * transfer with a message whose id matches the decoded memo bytes (if any).
 */
async function defaultPersistEvent(event) {
    let conversationId = null;
    let senderId = null;
    if (event.memoHex) {
        try {
            const memo = Buffer.from(event.memoHex, 'hex').toString('utf-8').trim();
            // The contract emits a message UUID in the memo when the transfer
            // originated from a chat message; non-UUID memos are ignored.
            if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(memo)) {
                const [existing] = await db
                    .select({
                    id: messages.id,
                    conversationId: messages.conversationId,
                    senderId: messages.senderId,
                })
                    .from(messages)
                    .where(eq(messages.id, memo))
                    .limit(1);
                if (existing) {
                    conversationId = existing.conversationId;
                    senderId = existing.senderId;
                }
            }
        }
        catch {
            // Non-fatal — memo just stays raw, no association.
        }
    }
    // Fallbacks if not found (required columns in tokenTransfers)
    if (!conversationId || !senderId) {
        const [fallbackConv] = await db.select({ id: conversations.id }).from(conversations).limit(1);
        const [fallbackUser] = await db.select({ id: users.id }).from(users).limit(1);
        if (!fallbackConv || !fallbackUser) {
            return;
        }
        conversationId = fallbackConv.id;
        senderId = fallbackUser.id;
    }
    await db
        .insert(tokenTransfers)
        .values({
        txHash: event.txHash,
        conversationId,
        senderId,
        recipientAddress: event.to,
        amount: event.amount,
        tokenContractId: 'placeholder_token_contract_id',
        memo: event.memoHex ?? null,
    })
        .onConflictDoUpdate({
        target: tokenTransfers.txHash,
        set: {
            createdAt: sql `now()`,
        },
    });
}
/**
 * Default treasury proposal persistence (#130).
 * Upserts on (contractId, proposalId), then emits treasury_proposal_updated
 * to the relevant Socket.IO room.
 */
async function defaultPersistTreasuryEvent(event) {
    const statusMap = {
        proposal_created: 'active',
        proposal_approved: 'approved',
        proposal_rejected: 'rejected',
        proposal_executed: 'executed',
        proposal_expired: 'expired',
    };
    const newStatus = statusMap[event.eventType];
    const [row] = await db
        .insert(treasuryProposals)
        .values({
        contractId: event.contractId,
        proposalId: event.proposalId,
        status: newStatus,
        approvalsCount: event.approvalsCount ?? 0,
        rejectionsCount: event.rejectionsCount ?? 0,
    })
        .onConflictDoUpdate({
        target: [treasuryProposals.contractId, treasuryProposals.proposalId],
        set: {
            status: newStatus,
            approvalsCount: event.approvalsCount !== undefined
                ? event.approvalsCount
                : sql `${treasuryProposals.approvalsCount}`,
            rejectionsCount: event.rejectionsCount !== undefined
                ? event.rejectionsCount
                : sql `${treasuryProposals.rejectionsCount}`,
            updatedAt: sql `now()`,
        },
    })
        .returning();
    if (!row)
        return;
    const payload = {
        proposalId: row.proposalId,
        status: row.status,
        approvalsCount: row.approvalsCount,
        rejectionsCount: row.rejectionsCount,
    };
    // Emit to the linked conversation room if known; fall back to a contract-scoped room.
    const room = row.conversationId ?? `treasury:${row.contractId}`;
    getSocketServer()?.to(room).emit('treasury_proposal_updated', payload);
}
/**
 * Run the listener loop until `signal` aborts (or process exit). Never
 * throws — RPC / DB errors are logged and the loop backs off.
 */
export async function runForever(deps) {
    const log = deps.log ?? consoleLogger;
    const persist = deps.persistEvent ?? defaultPersistEvent;
    const persistTreasury = deps.persistTreasuryEvent ?? defaultPersistTreasuryEvent;
    const pollMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const backoffBase = deps.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    const backoffMax = deps.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;
    let cursor = null;
    let treasuryCursor = null;
    let consecutiveFailures = 0;
    log.info('listener starting');
    while (!deps.signal?.aborted) {
        try {
            const events = await deps.fetchEvents(cursor);
            consecutiveFailures = 0;
            for (const event of events) {
                try {
                    await persist(event);
                    cursor = event.cursor;
                }
                catch (err) {
                    log.warn('failed to persist event', {
                        txHash: event.txHash,
                        error: err instanceof Error ? err.message : String(err),
                    });
                }
            }
            // Poll treasury events when a fetcher is provided (#130).
            if (deps.fetchTreasuryEvents) {
                const treasuryEvents = await deps.fetchTreasuryEvents(treasuryCursor);
                for (const event of treasuryEvents) {
                    try {
                        await persistTreasury(event);
                        treasuryCursor = event.cursor;
                    }
                    catch (err) {
                        log.warn('failed to persist treasury event', {
                            proposalId: event.proposalId,
                            error: err instanceof Error ? err.message : String(err),
                        });
                    }
                }
            }
            await wait(pollMs, deps.signal);
        }
        catch (err) {
            consecutiveFailures += 1;
            const delay = Math.min(backoffBase * Math.pow(2, consecutiveFailures - 1), backoffMax);
            log.error('fetch failed; reconnecting after backoff', {
                attempt: consecutiveFailures,
                delayMs: delay,
                error: err instanceof Error ? err.message : String(err),
            });
            await wait(delay, deps.signal);
        }
    }
    log.info('listener stopped (signal aborted)');
}
function wait(ms, signal) {
    if (signal?.aborted)
        return Promise.resolve();
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
        }, { once: true });
    });
}
// ── Production wiring ────────────────────────────────────────────────────────
/**
 * Build a default fetcher that talks to a Soroban RPC server and filters
 * events by the configured `token_transfer` contract id. Returns a thunk
 * suitable for passing into `runForever({ fetchEvents })`.
 */
export function buildRpcFetcher(opts) {
    const server = new rpc.Server(opts.rpcUrl, { allowHttp: opts.rpcUrl.startsWith('http://') });
    const pageSize = opts.pageSize ?? 100;
    const eventServer = server;
    return async (cursor) => {
        const startLedger = cursor ? undefined : undefined; // resume on cursor only
        const response = await eventServer.getEvents({
            startLedger,
            cursor: cursor ?? undefined,
            filters: [
                {
                    type: 'contract',
                    contractIds: [opts.contractId],
                    topics: [['transfer']],
                },
            ],
            limit: pageSize,
        });
        const events = response.events ?? [];
        return events
            .filter((e) => e.txHash && e.value?.from && e.value?.to && e.value?.amount != null)
            .map((e) => {
            const event = {
                txHash: e.txHash,
                ledger: e.ledger ?? 0,
                from: e.value.from,
                to: e.value.to,
                amount: String(e.value.amount),
                cursor: e.pagingToken ?? '',
            };
            if (e.value?.memo !== undefined) {
                event.memoHex = e.value.memo;
            }
            return event;
        });
    };
}
/**
 * Build a fetcher for GROUP_TREASURY_CONTRACT_ID multisig proposal events (#130).
 * Listens for: proposal_created, proposal_approved, proposal_rejected,
 * proposal_executed, proposal_expired.
 */
export function buildTreasuryRpcFetcher(opts) {
    const server = new rpc.Server(opts.rpcUrl, { allowHttp: opts.rpcUrl.startsWith('http://') });
    const pageSize = opts.pageSize ?? 100;
    const TREASURY_TOPICS = [
        'proposal_created',
        'proposal_approved',
        'proposal_rejected',
        'proposal_executed',
        'proposal_expired',
    ];
    const eventServer = server;
    return async (cursor) => {
        const response = await eventServer.getEvents({
            startLedger: undefined,
            cursor: cursor ?? undefined,
            filters: [
                {
                    type: 'contract',
                    contractIds: [opts.contractId],
                    topics: [TREASURY_TOPICS],
                },
            ],
            limit: pageSize,
        });
        const events = response.events ?? [];
        return events
            .filter((e) => {
            const topic = e.topic?.[0];
            return e.value?.id != null && TREASURY_TOPICS.includes(topic);
        })
            .map((e) => {
            const eventType = e.topic[0];
            return {
                contractId: e.contractId ?? opts.contractId,
                eventType,
                proposalId: String(e.value.id),
                approvalsCount: e.value?.approvals,
                rejectionsCount: e.value?.rejections,
                cursor: e.pagingToken ?? '',
            };
        });
    };
}
//# sourceMappingURL=stellarListener.js.map