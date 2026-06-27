type MessageLike = {
  ciphertext?: string | null;
  deletedAt?: Date | null;
  [key: string]: any;
};

export function serializeMessage<T extends MessageLike>(
  message: T,
): Omit<T, 'deletedAt'> & { ciphertext: string | null } {
  const { deletedAt, ...rest } = message;

  return {
    ...rest,
    ciphertext: deletedAt ? null : (message.ciphertext ?? null),
  };
}
