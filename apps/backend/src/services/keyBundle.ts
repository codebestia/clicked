/**
 * Prekey bundle fetch + one-time prekey consumption (#160).
 *
 * Builds the X3DH/Signal-style key bundle a sender needs to start an encrypted
 * session with a recipient device. The single one-time prekey (OTP) in the
 * bundle is *consumed* as it is handed out: it is claimed with one atomic
 * `UPDATE ... WHERE consumed = false ... RETURNING` guarded by `FOR UPDATE SKIP
 * LOCKED`, so two senders fetching concurrently can never receive the same OTP.
 * When the pool is exhausted the bundle is still returned with `oneTimePreKey:
 * null` — sessions can be established from the signed prekey alone.
 *
 * Only public key material and signatures are exposed; private keys never reach
 * the server, so nothing private can ever be returned.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { devices, oneTimePreKeys } from '../db/schema.js';

export interface PreKeyBundle {
  identityPublicKey: string;
  registrationId: number;
  signedPreKey: { keyId: number; publicKey: string; signature: string };
  oneTimePreKey: { keyId: number; publicKey: string } | null;
}

export type KeyBundleResult =
  | { ok: true; bundle: PreKeyBundle }
  | { ok: false; status: 404; error: string };

/**
 * Atomically claim the next unconsumed one-time prekey for a device.
 *
 * The whole select-and-mark is a single statement, so it is race-free under
 * concurrent fetches: `FOR UPDATE SKIP LOCKED` makes parallel callers skip a row
 * another transaction is already claiming rather than block on or re-read it.
 * Returns `null` when no unconsumed prekey remains.
 */
async function consumeOneTimePreKey(
  deviceId: string,
): Promise<{ keyId: number; publicKey: string } | null> {
  const rows = await db.execute<{ keyId: number; publicKey: string }>(sql`
    UPDATE ${oneTimePreKeys}
    SET consumed = true
    WHERE id = (
      SELECT id
      FROM ${oneTimePreKeys}
      WHERE device_id = ${deviceId} AND consumed = false
      ORDER BY key_id
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING key_id AS "keyId", public_key AS "publicKey"
  `);

  return rows[0] ?? null;
}

export async function fetchAndConsumeKeyBundle(
  userId: string,
  deviceId: string,
): Promise<KeyBundleResult> {
  const device = await db.query.devices.findFirst({
    where: and(eq(devices.id, deviceId), eq(devices.userId, userId)),
  });

  // Unknown or revoked devices are indistinguishable to callers — both 404.
  if (!device || device.revokedAt) {
    return { ok: false, status: 404, error: 'Device not found' };
  }

  const oneTimePreKey = await consumeOneTimePreKey(deviceId);

  return {
    ok: true,
    bundle: {
      identityPublicKey: device.identityPublicKey,
      registrationId: device.registrationId,
      signedPreKey: {
        keyId: device.signedPreKeyId,
        publicKey: device.signedPreKeyPublic,
        signature: device.signedPreKeySignature,
      },
      oneTimePreKey,
    },
  };
}
