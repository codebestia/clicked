export function serializeMessage(message) {
    const { deletedAt, ...rest } = message;
    return {
        ...rest,
        ciphertext: deletedAt ? null : (message.ciphertext ?? null),
    };
}
//# sourceMappingURL=messages.js.map