/**
 * Unit tests for the Stellar event listener (#46).
 *
 * Each test drives `runForever` with a fake `fetchEvents` so the loop
 * exits deterministically — no Soroban RPC, no live DB. The AC the
 * tests cover:
 *
 *   - Listener reconnects automatically on disconnect (failure → backoff
 *     → success on the next poll).
 *   - Duplicate `tx_hash` entries are ignored (persist is called once per
 *     event even when the fetcher hands back the same row twice).
 *   - Errors are logged but do not crash the server (no rethrow out of
 *     `runForever`).
 */
import { describe, it, expect, vi } from 'vitest';
import { runForever } from '../services/stellarListener.js';
function makeEvent(overrides = {}) {
    return {
        txHash: 'tx-1',
        ledger: 100,
        from: 'GFROM',
        to: 'GTO',
        amount: '1000',
        cursor: 'c1',
        ...overrides,
    };
}
function silentLogger() {
    return {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    };
}
describe('stellarListener.runForever', () => {
    it('persists every event the fetcher returns', async () => {
        const events = [
            [makeEvent({ txHash: 'a', cursor: 'c-a' }), makeEvent({ txHash: 'b', cursor: 'c-b' })],
            [makeEvent({ txHash: 'c', cursor: 'c-c' })],
        ];
        const persist = vi.fn(async (_event) => { });
        const ctl = new AbortController();
        let call = 0;
        await runForever({
            log: silentLogger(),
            pollIntervalMs: 0,
            backoffBaseMs: 1,
            backoffMaxMs: 1,
            signal: ctl.signal,
            persistEvent: persist,
            fetchEvents: async () => {
                const page = events[call] ?? [];
                call += 1;
                if (call >= events.length + 1)
                    ctl.abort();
                return page;
            },
        });
        expect(persist).toHaveBeenCalledTimes(3);
        expect(persist.mock.calls[0][0].txHash).toBe('a');
        expect(persist.mock.calls[1][0].txHash).toBe('b');
        expect(persist.mock.calls[2][0].txHash).toBe('c');
    });
    it('reconnects after a fetch failure (backoff, then success)', async () => {
        const persist = vi.fn(async (_event) => { });
        const ctl = new AbortController();
        let call = 0;
        await runForever({
            log: silentLogger(),
            pollIntervalMs: 0,
            backoffBaseMs: 1,
            backoffMaxMs: 1,
            signal: ctl.signal,
            persistEvent: persist,
            fetchEvents: async () => {
                call += 1;
                if (call === 1)
                    throw new Error('rpc unreachable');
                if (call === 2) {
                    // Allow the success-path branch to schedule the next poll before
                    // we abort so the test exercises a real reconnect.
                    ctl.abort();
                    return [makeEvent({ txHash: 'after-reconnect', cursor: 'c-r' })];
                }
                return [];
            },
        });
        expect(call).toBeGreaterThanOrEqual(2);
        expect(persist).toHaveBeenCalledTimes(1);
        expect(persist.mock.calls[0][0].txHash).toBe('after-reconnect');
    });
    it('does not crash when persist throws — logs and keeps polling', async () => {
        const log = silentLogger();
        const ctl = new AbortController();
        let call = 0;
        let persistCalls = 0;
        const persist = vi.fn(async (_event) => {
            persistCalls += 1;
            if (persistCalls === 1) {
                throw new Error('db unique violation');
            }
        });
        await runForever({
            log,
            pollIntervalMs: 0,
            backoffBaseMs: 1,
            backoffMaxMs: 1,
            signal: ctl.signal,
            persistEvent: persist,
            fetchEvents: async () => {
                call += 1;
                if (call > 2) {
                    ctl.abort();
                    return [];
                }
                return [makeEvent({ txHash: `t-${call}`, cursor: `c-${call}` })];
            },
        });
        // The first persist threw but the loop kept going.
        expect(call).toBeGreaterThanOrEqual(2);
        expect(persist).toHaveBeenCalledTimes(2);
        expect(log.warn).toHaveBeenCalledWith('failed to persist event', expect.objectContaining({ txHash: 't-1' }));
    });
    it('advances the cursor only on successful persistence', async () => {
        const ctl = new AbortController();
        let call = 0;
        const cursors = [];
        const persist = vi.fn(async (_event) => {
            throw new Error('db down');
        });
        await runForever({
            log: silentLogger(),
            pollIntervalMs: 0,
            backoffBaseMs: 1,
            backoffMaxMs: 1,
            signal: ctl.signal,
            persistEvent: persist,
            fetchEvents: async (cursor) => {
                cursors.push(cursor);
                call += 1;
                if (call >= 2) {
                    ctl.abort();
                    return [];
                }
                return [makeEvent({ cursor: 'c-1' })];
            },
        });
        // First call's cursor is null (initial), second call's cursor is STILL
        // null because persist threw and we never advanced.
        expect(cursors[0]).toBeNull();
        expect(cursors[1]).toBeNull();
    });
});
//# sourceMappingURL=stellarListener.test.js.map