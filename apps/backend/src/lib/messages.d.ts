type MessageLike = {
    ciphertext?: string | null;
    deletedAt?: Date | null;
    [key: string]: any;
};
export declare function serializeMessage<T extends MessageLike>(message: T): Omit<T, 'deletedAt'> & {
    ciphertext: string | null;
};
export {};
//# sourceMappingURL=messages.d.ts.map