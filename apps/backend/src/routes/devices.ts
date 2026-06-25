/**
 * Device routes — prekey management.
 *
 * Issue #159: POST /devices/:id/prekeys
 * Uploads a signed prekey + batch of one-time prekeys for a device.
 * Only the device owner may call this endpoint.
 */

import { Router, type Router as RouterType } from 'express';
import { createVerify } from 'node:crypto';
import { eq, count, desc, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { devices, signedPreKeys, oneTimePreKeys } from '../db/schema.js';
import { requireAuth, type AuthRequest } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';

export const devicesRouter: RouterType = Router();

devicesRouter.use(requireAuth);

// ─── Schemas ──────────────────────────────────────────────────────────────────

const PreKeySchema = z.object({
  keyId: z.number().int().nonnegative(),
  publicKey: z.string().min(1, 'publicKey is required'),
});

const UploadPreKeysSchema = z.object({
  signedPreKey: PreKeySchema.extend({
    signature: z.string().min(1, 'signature is required'),
  }),
  oneTimePreKeys: z.array(PreKeySchema).min(1, 'At least one one-time prekey is required'),
});

/** Maximum number of stored one-time prekeys per device. */
const OTP_CAP = 200;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Verifies an Ed25519 signature over `publicKey` (raw bytes, decoded from base64)
 * using `identityPublicKey` (base64-encoded SubjectPublicKeyInfo DER, as stored in
 * the devices table).
 *
 * Returns true on valid, false on invalid or unrecognisable key format.
 */
function verifySignedPreKey(
  identityPublicKeyB64: string,
  publicKeyB64: string,
  signatureB64: string,
): boolean {
  try {
    const identityKeyDer = Buffer.from(identityPublicKeyB64, 'base64');
    const publicKeyBytes = Buffer.from(publicKeyB64, 'base64');
    const signatureBytes = Buffer.from(signatureB64, 'base64');

    const verifier = createVerify('Ed25519');
    verifier.update(publicKeyBytes);
    return verifier.verify({ key: identityKeyDer, format: 'der', type: 'spki' }, signatureBytes);
  } catch {
    return false;
  }
}

// ─── GET /devices ─────────────────────────────────────────────────────────────

devicesRouter.get('/', async (req: AuthRequest, res) => {
  const { userId, deviceId: currentDeviceId } = req.auth!;

  try {
    const rows = await db.query.devices.findMany({
      where: eq(devices.userId, userId),
      orderBy: [
        sql`case when ${devices.isRevoked} = false then 0 else 1 end`,
        desc(devices.createdAt),
      ],
    });

    res.json(
      rows.map((device) => ({
        id: device.id,
        identityPublicKey: device.identityPublicKey,
        isRevoked: device.isRevoked,
        createdAt: device.createdAt,
        current: device.id === currentDeviceId,
      })),
    );
  } catch {
    res.status(500).json({ error: 'Failed to list devices' });
  }
});

// ─── POST /devices/:id/prekeys ─────────────────────────────────────────────────

devicesRouter.post('/:id/prekeys', validate(UploadPreKeysSchema), async (req: AuthRequest, res) => {
  const deviceId = req.params['id'] as string;
  const callerId = req.auth!.userId;

  // Fetch the device and verify ownership.
  const device = await db.query.devices.findFirst({
    where: eq(devices.id, deviceId),
  });

  if (!device) {
    res.status(404).json({ error: 'Device not found' });
    return;
  }

  if (device.userId !== callerId) {
    res.status(403).json({ error: 'Only the device owner may upload prekeys' });
    return;
  }

  if (device.isRevoked) {
    res.status(403).json({ error: 'Device is revoked' });
    return;
  }

  const { signedPreKey, oneTimePreKeys: otpBatch } = req.body as z.infer<
    typeof UploadPreKeysSchema
  >;

  // Validate the signed prekey signature against the device identity key.
  const sigValid = verifySignedPreKey(
    device.identityPublicKey,
    signedPreKey.publicKey,
    signedPreKey.signature,
  );

  if (!sigValid) {
    res.status(400).json({ error: 'Signed prekey signature is invalid' });
    return;
  }

  // Enforce the one-time prekey cap before inserting.
  const [otpCountRow] = await db
    .select({ total: count() })
    .from(oneTimePreKeys)
    .where(eq(oneTimePreKeys.deviceId, deviceId));

  const currentCount = otpCountRow?.total ?? 0;
  const available = OTP_CAP - currentCount;

  if (available <= 0) {
    res.status(422).json({
      error: `One-time prekey cap of ${OTP_CAP} reached. Consume existing prekeys before uploading more.`,
    });
    return;
  }

  // Trim the incoming batch to stay within the cap.
  const trimmedBatch = otpBatch.slice(0, available);

  // Upsert the signed prekey (one per device — replace on keyId conflict).
  await db
    .insert(signedPreKeys)
    .values({
      deviceId,
      keyId: signedPreKey.keyId,
      publicKey: signedPreKey.publicKey,
      signature: signedPreKey.signature,
    })
    .onConflictDoUpdate({
      target: [signedPreKeys.deviceId],
      set: {
        keyId: signedPreKey.keyId,
        publicKey: signedPreKey.publicKey,
        signature: signedPreKey.signature,
        createdAt: new Date(),
      },
    });

  // Insert one-time prekeys, ignoring conflicts on (deviceId, keyId).
  if (trimmedBatch.length > 0) {
    await db
      .insert(oneTimePreKeys)
      .values(
        trimmedBatch.map((k) => ({
          deviceId,
          keyId: k.keyId,
          publicKey: k.publicKey,
        })),
      )
      .onConflictDoNothing({ target: [oneTimePreKeys.deviceId, oneTimePreKeys.keyId] });
  }

  res.status(200).json({
    uploadedSignedPreKey: true,
    uploadedOneTimePreKeys: trimmedBatch.length,
    capped: trimmedBatch.length < otpBatch.length,
  });
});
