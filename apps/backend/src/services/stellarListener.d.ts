export interface StellarTransferEvent {
    /** Soroban tx hash that produced the event. */
    txHash: string;
    /** Ledger sequence the event was included in. */
    ledger: number;
    /** Stellar address that authorised the transfer. */
    from: string;
    /** Stellar address that received the transfer. */
    to: string;
    /** Amount in token units (i128 as decimal string). */
    amount: string;
    /** Raw memo bytes hex-encoded (matches the contract's emitted memo). */
    memoHex?: string;
    /** Cursor token the next `fetchEvents` call should resume from. */
    cursor: string;
}
export type TreasuryProposalStatus = 'active' | 'approved' | 'rejected' | 'executed' | 'expired';
export interface TreasuryProposalEvent {
    /** The contract that emitted the event. */
    contractId: string;
    /** Soroban event type name, e.g. "proposal_created". */
    eventType: 'proposal_created' | 'proposal_approved' | 'proposal_rejected' | 'proposal_executed' | 'proposal_expired';
    proposalId: string;
    approvalsCount?: number | undefined;
    rejectionsCount?: number | undefined;
    /** Cursor token for the next `fetchTreasuryEvents` call. */
    cursor: string;
}
export interface StellarListenerDeps {
    /** Optional logger; defaults to a console wrapper. */
    log?: {
        info: (msg: string, ctx?: unknown) => void;
        warn: (msg: string, ctx?: unknown) => void;
        error: (msg: string, ctx?: unknown) => void;
    };
    /** Fetches the next page of token-transfer events starting at `cursor`. */
    fetchEvents: (cursor: string | null) => Promise<StellarTransferEvent[]>;
    /** Fetches the next page of treasury proposal events starting at `cursor`. */
    fetchTreasuryEvents?: (cursor: string | null) => Promise<TreasuryProposalEvent[]>;
    /** Persistence layer; swapped out in tests. */
    persistEvent?: (event: StellarTransferEvent) => Promise<void>;
    /** Treasury event persistence; swapped out in tests. */
    persistTreasuryEvent?: (event: TreasuryProposalEvent) => Promise<void>;
    /** Pause between successful polls (default 5s). */
    pollIntervalMs?: number;
    /** Initial backoff after a failure (doubles up to `backoffMaxMs`). */
    backoffBaseMs?: number;
    backoffMaxMs?: number;
    /** Abort signal that breaks out of `runForever`. */
    signal?: AbortSignal;
}
/**
 * Run the listener loop until `signal` aborts (or process exit). Never
 * throws — RPC / DB errors are logged and the loop backs off.
 */
export declare function runForever(deps: StellarListenerDeps): Promise<void>;
/**
 * Build a default fetcher that talks to a Soroban RPC server and filters
 * events by the configured `token_transfer` contract id. Returns a thunk
 * suitable for passing into `runForever({ fetchEvents })`.
 */
export declare function buildRpcFetcher(opts: {
    rpcUrl: string;
    contractId: string;
    pageSize?: number;
}): StellarListenerDeps['fetchEvents'];
/**
 * Build a fetcher for GROUP_TREASURY_CONTRACT_ID multisig proposal events (#130).
 * Listens for: proposal_created, proposal_approved, proposal_rejected,
 * proposal_executed, proposal_expired.
 */
export declare function buildTreasuryRpcFetcher(opts: {
    rpcUrl: string;
    contractId: string;
    pageSize?: number;
}): NonNullable<StellarListenerDeps['fetchTreasuryEvents']>;
//# sourceMappingURL=stellarListener.d.ts.map