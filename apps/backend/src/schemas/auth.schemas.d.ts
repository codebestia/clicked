import { z } from 'zod';
export declare const ChallengeSchema: z.ZodObject<{
    walletAddress: z.ZodString;
}, z.core.$strip>;
export declare const DeviceSchema: z.ZodObject<{
    deviceId: z.ZodString;
    deviceName: z.ZodString;
    platform: z.ZodString;
    identityPublicKey: z.ZodString;
    registrationId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const VerifySchema: z.ZodObject<{
    walletAddress: z.ZodString;
    signature: z.ZodString;
    nonce: z.ZodString;
    identityPublicKey: z.ZodString;
}, z.core.$strip>;
export type ChallengeBody = z.infer<typeof ChallengeSchema>;
export type DeviceBody = z.infer<typeof DeviceSchema>;
export type VerifyBody = z.infer<typeof VerifySchema>;
//# sourceMappingURL=auth.schemas.d.ts.map