import { z } from 'zod';

export const ChallengeSchema = z.object({
  walletAddress: z.string().min(1, 'walletAddress is required'),
});

export const DeviceSchema = z.object({
  deviceId: z.string().min(1, 'deviceId is required'),
  deviceName: z.string().min(1, 'deviceName is required'),
  platform: z.string().min(1, 'platform is required'),
  identityPublicKey: z.string().min(1, 'identityPublicKey is required'),
  registrationId: z.string().optional(),
});

export const VerifySchema = z.object({
  walletAddress: z.string().min(1, 'walletAddress is required'),
  signature: z.string().min(1, 'signature is required'),
  nonce: z.string().min(1, 'nonce is required'),
  /**
   * Base64-encoded Ed25519 identity public key for the device initiating sign-in.
   * A device row is created (or looked up) by this key and its id is embedded in
   * the returned JWT as `deviceId`.
   */
  identityPublicKey: z.string().min(1, 'identityPublicKey is required'),
});

export type ChallengeBody = z.infer<typeof ChallengeSchema>;
export type DeviceBody = z.infer<typeof DeviceSchema>;
export type VerifyBody = z.infer<typeof VerifySchema>;
