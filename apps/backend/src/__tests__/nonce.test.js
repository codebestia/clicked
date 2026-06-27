import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createNonce, consumeNonce } from '../lib/nonce.js';
describe('Nonce store', () => {
    const wallet = 'GABCDEFGHIJKLMNOP';
    it('creates a 32-char hex nonce', () => {
        const nonce = createNonce(wallet);
        expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    });
    it('consuming a valid nonce returns true', () => {
        const nonce = createNonce(wallet);
        expect(consumeNonce(wallet, nonce)).toBe(true);
    });
    it('consuming the same nonce twice returns false (single-use)', () => {
        const nonce = createNonce(wallet);
        consumeNonce(wallet, nonce);
        expect(consumeNonce(wallet, nonce)).toBe(false);
    });
    it('consuming a wrong nonce returns false', () => {
        createNonce(wallet);
        expect(consumeNonce(wallet, 'wrong-nonce')).toBe(false);
    });
    it('consuming a nonce for an unknown wallet returns false', () => {
        expect(consumeNonce('UNKNOWN_WALLET', 'any-nonce')).toBe(false);
    });
    describe('expiry', () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });
        afterEach(() => {
            vi.useRealTimers();
        });
        it('rejects a nonce after 5 minutes have passed', () => {
            const nonce = createNonce(wallet);
            // Advance time past the 5-minute TTL
            vi.advanceTimersByTime(5 * 60 * 1000 + 1);
            expect(consumeNonce(wallet, nonce)).toBe(false);
        });
        it('accepts a nonce just before expiry', () => {
            const nonce = createNonce(wallet);
            vi.advanceTimersByTime(5 * 60 * 1000 - 1);
            expect(consumeNonce(wallet, nonce)).toBe(true);
        });
    });
});
//# sourceMappingURL=nonce.test.js.map