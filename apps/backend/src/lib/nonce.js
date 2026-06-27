import { randomBytes } from 'crypto';
const TTL_MS = 5 * 60 * 1000;
const store = new Map();
export function createNonce(walletAddress) {
    const nonce = randomBytes(16).toString('hex');
    store.set(walletAddress, { nonce, expiresAt: Date.now() + TTL_MS });
    return nonce;
}
export function consumeNonce(walletAddress, nonce) {
    const entry = store.get(walletAddress);
    if (!entry)
        return false;
    store.delete(walletAddress);
    if (Date.now() > entry.expiresAt)
        return false;
    return entry.nonce === nonce;
}
//# sourceMappingURL=nonce.js.map