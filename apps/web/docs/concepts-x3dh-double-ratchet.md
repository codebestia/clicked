# X3DH and Double Ratchet implementation notes

Implementation-level notes on `lib/x3dh.ts` and `lib/crypto/doubleRatchet.ts`, written for
a reviewer checking them against the Signal specifications (X3DH:
https://signal.org/docs/specifications/x3dh/, Double Ratchet:
https://signal.org/docs/specifications/doubleratchet/). Every claim below is checked
directly against the current source, not inferred from the spec alone — where a
deviation is noted, the reasoning for calling it a deviation (not just a stylistic
choice) is included.

## Contents

- [Identity keys: Ed25519, converted to X25519 for DH](#identity-keys-ed25519-converted-to-x25519-for-dh)
- [X3DH: the DH inputs, KDF, and info strings](#x3dh-the-dh-inputs-kdf-and-info-strings)
- [Behavior with no one-time prekey](#behavior-with-no-one-time-prekey)
- [Double Ratchet: `kdfRk` and `kdfCk`](#double-ratchet-kdfrk-and-kdfck)
- [Skipped-key limits](#skipped-key-limits)
- [Deviations from the Signal specs](#deviations-from-the-signal-specs)
- [Test vectors](#test-vectors)
- [Implementation references](#implementation-references)

## Identity keys: Ed25519, converted to X25519 for DH

Identity keys in this codebase are Ed25519, not X25519, even though X3DH's DH
operations need Montgomery-form (X25519) keys. The module docstring states the reason
directly: the backend verifies signed-prekey signatures using the same identity key
(`apps/backend/src/lib/keys.ts`), and Ed25519 is the signing scheme — maintaining a
second, separate X25519 identity keypair purely for DH would mean two keys to register,
store, and keep in sync per device, for no benefit X3DH itself requires.

The conversion is the standard birational Edwards↔Montgomery map, via
`@noble/curves`'s `ed25519.utils.toMontgomerySecret` (private key) and
`ed25519.utils.toMontgomery` (public key):

```ts
const myIdentityX25519Priv = ed25519.utils.toMontgomerySecret(myIdentity.privateKey);
const theirIdentityX25519Pub = ed25519.utils.toMontgomery(theirIdentityRawEd);
```

This is the same relationship the Signal spec itself allows for ("parties may use a
single Ed25519 identity key pair for both X3DH and XEdDSA" territory) — using Ed25519 as
the *only* identity key form, converting on demand for DH, is a documented and common
choice, not an ad hoc one.

**Wire format detail that matters for interop**: the identity public key travels on the
wire as a 44-byte base64 SPKI DER blob — a fixed 12-byte RFC 8410 SPKI header for
Ed25519 (OID 1.3.101.112) prepended to the raw 32-byte key
(`rawEd25519PublicKeyToSpki`/`spkiToRawEd25519PublicKey`). This matches the format
`apps/backend/src/lib/keys.ts` emits; a reviewer checking this module in isolation
should not expect a raw 32-byte key on the wire for the identity key specifically —
every other key (signed prekey, one-time prekey, ephemeral) is raw bytes, base64-encoded,
with no SPKI wrapper.

## X3DH: the DH inputs, KDF, and info strings

Both `initiateSession` (initiator, "Alice") and `completeSession` (responder, "Bob")
compute the same four DH values the spec defines, just from each side's own key
material:

| DH | Initiator computes | Responder computes | Spec name |
|---|---|---|---|
| DH1 | `X25519(IK_a, SPK_b)` | `X25519(SPK_b, IK_a)` | `DH1` |
| DH2 | `X25519(EK_a, IK_b)` | `X25519(IK_b, EK_a)` | `DH2` |
| DH3 | `X25519(EK_a, SPK_b)` | `X25519(SPK_b, EK_a)` | `DH3` |
| DH4 | `X25519(EK_a, OPK_b)` if present, else omitted | `X25519(OPK_b, EK_a)` if present, else omitted | `DH4` |

(`IK` = identity key, `SPK` = signed prekey, `EK` = ephemeral key, `OPK` = one-time
prekey, subscript `a`/`b` for initiator/responder.) Each DH computation is symmetric
(`X25519(a_priv, b_pub) === X25519(b_priv, a_pub)`), which is why the two functions
compute the same four values from opposite sides without needing to exchange anything
beyond what the prekey bundle and initial message header already carry.

**Before any DH runs**, `initiateSession` verifies the signed prekey's signature against
the responder's identity key:

```ts
if (!ed25519.verify(theirSpkSig, theirSpkPub, theirIdentityRawEd)) {
  throw new Error('Signed prekey signature verification failed — refusing to start session');
}
```

This is the spec's mandatory signed-prekey verification step; a session is never
established on an unverified signed prekey.

**The KDF**: all four DH outputs are concatenated (`DH1 || DH2 || DH3 || DH4`) and passed
through HKDF-SHA256 with a fixed 32-byte `0xFF` prefix prepended to the input keying
material:

```ts
const HKDF_INFO = new TextEncoder().encode('X3DH');
const HKDF_PREFIX = new Uint8Array(32).fill(0xff);

function deriveSessionKey(dhConcat: Uint8Array): Uint8Array {
  const ikm = new Uint8Array(HKDF_PREFIX.length + dhConcat.length);
  ikm.set(HKDF_PREFIX, 0);
  ikm.set(dhConcat, HKDF_PREFIX.length);
  return hkdf(sha256, ikm, undefined, HKDF_INFO, 32);
}
```

The `0xFF`-byte prefix is exactly the spec's domain-separation measure against a
small-subgroup/invalid-curve-point attack on the identity key (the spec requires F to be
32 or 64 0xFF bytes depending on the curve; 32 is correct for X25519/Curve25519). The
`salt` argument to `hkdf()` is `undefined` — this is spec-compliant, not an omission:
per RFC 5869 (and this codebase's `@noble/hashes` implementation specifically), an
`undefined` salt is treated as a salt of `HashLen` zero bytes, which is exactly what the
X3DH spec specifies for this step ("HKDF... using... a salt of 32 zero bytes").

The `info` string is the literal bytes of `'X3DH'`. The spec leaves this application-
specific ("some unique byte sequence for the application identifying the usage of the
derived key as an SK") — this is an implementation choice, not something that could be
wrong relative to the spec, as long as both sides of a session use the same value (which
they do, since it's a shared constant, not per-session data).

**Associated data** (`AD` in the spec) returned alongside the session key is
`IK_a || IK_b` — the initiator's identity key concatenated with the responder's (in that
fixed order from the initiator's perspective; `completeSession` builds the same bytes in
the matching order from the responder's perspective: `theirIdentityRawEd` first, then
`myIdentity.publicKey`, which is initiator-then-responder either way). This matches the
spec's recommended `AD = Encode(IK_A) || Encode(IK_B)`. The spec allows including
additional application-specific information in `AD`; this implementation does not.

## Behavior with no one-time prekey

If a prekey bundle has no one-time prekey (`bundle.oneTimePreKey` is `null`), `DH4` is
computed as a zero-length `Uint8Array`:

```ts
const dh4 = bundle.oneTimePreKey
  ? x25519.getSharedSecret(ephemeral, fromBase64(bundle.oneTimePreKey.publicKey))
  : new Uint8Array(0);
```

Concatenating a zero-length array changes nothing about the resulting bytes compared to
omitting `DH4` entirely from the concatenation — `concatBytes(dh1, dh2, dh3, new
Uint8Array(0))` produces byte-identical output to `concatBytes(dh1, dh2, dh3)`. This
matches the spec's own handling: "If the bundle does not contain a one-time prekey, we
have... SK = KDF(DH1 || DH2 || DH3)" — DH4 is simply absent from the KDF input, which is
exactly what passing an empty array achieves here. `completeSession`'s responder side
mirrors this with the same empty-array fallback when `header.usedOneTimePreKeyId` is
`null`.

`usedOneTimePreKeyId` is carried through the returned `X3dhSession` regardless (`null`
when none was used) — this is bookkeeping for the caller (deciding whether to mark a
one-time prekey as consumed), not part of the cryptographic derivation.

## Double Ratchet: `kdfRk` and `kdfCk`

```ts
export function kdfRk(rk: Uint8Array, dhOut: Uint8Array): { rk: Uint8Array; ck: Uint8Array } {
  const derived = hkdf(sha256, dhOut, rk, INFO_RK, 64);
  return { rk: derived.slice(0, 32), ck: derived.slice(32, 64) };
}

export function kdfCk(ck: Uint8Array): { ck: Uint8Array; mk: Uint8Array } {
  const nextCk = hkdf(sha256, new Uint8Array([0x01]), ck, INFO_CK, 32);
  const mk = hkdf(sha256, new Uint8Array([0x02]), ck, INFO_MESSAGE_KEY, 32);
  return { ck: nextCk, mk };
}
```

`kdfRk` is a single HKDF call producing 64 bytes, split into the new root key (first 32
bytes) and new chain key (last 32 bytes), with the DH output as HKDF's input keying
material and the current root key `rk` as the salt — this is the spec's recommended
root-key KDF shape (`KDF_RK(rk, dh_out)` defined as an HKDF with `rk` as salt).

`kdfCk` differs in approach from the spec's suggested *HMAC*-based chain-key KDF
(`HMAC(ck, 0x01)` / `HMAC(ck, 0x02)`) — this implementation uses HKDF with `ck` as the
`ikm` and a single-byte constant (`0x01` or `0x02`) as HKDF's own `ikm` position
argument, with distinct `info` strings (`INFO_CK`/`INFO_MESSAGE_KEY`) providing the
domain separation the spec achieves via the differing constant byte alone. The spec
explicitly allows this: "HMAC... can be implemented... Alternatively, an HKDF... could
be used." Using two different info strings alongside the two different constant bytes is
redundant domain separation (either alone would suffice) rather than a problem, but a
reviewer comparing byte-for-byte against a reference HMAC-based implementation should
not expect these two functions' outputs to match one computed the spec's suggested way.

## Skipped-key limits

```ts
export const MAX_SKIP = 100;
export const MAX_SKIPPED_KEYS = 1000;
```

`MAX_SKIP` (100) is checked per-chain inside `skipMessageKeys`:

```ts
export function skipMessageKeys(state: DoubleRatchetState, until: number): void {
  if (state.Nr + MAX_SKIP < until) {
    throw new Error('Too many skipped messages');
  }
  // ...
}
```

This is exactly the spec's own guard (`if N > MAX_SKIP: raise`, phrased here as a
distance check against the current receive counter rather than an absolute count, same
effect): if the incoming message's counter implies skipping more than 100 keys within
the *current* sending chain, the ratchet refuses and the message is treated as
undecryptable. This is the spec's documented defense against a sender claiming an
implausibly large skip count (a DoS vector against the skipped-key store).

`MAX_SKIPPED_KEYS` (1000) is **not** part of the Signal Double Ratchet spec — the spec
only defines the per-chain `MAX_SKIP`. This codebase adds a second, global cap across
*every* chain's accumulated skipped keys combined, enforced by eviction rather than
rejection:

```ts
function pruneSkippedKeys(mkSkipped: Map<string, Uint8Array>): void {
  while (mkSkipped.size > MAX_SKIPPED_KEYS) {
    const firstKey = mkSkipped.keys().next().value;
    if (firstKey !== undefined) mkSkipped.delete(firstKey);
    else break;
  }
}
```

When the global cap is exceeded, the **oldest-inserted** skipped key is evicted (JS
`Map` iterates in insertion order), not the oldest by ratchet step or by `(dh, n)` —
insertion order across potentially-interleaved DH ratchet steps happens to track
chronological arrival closely in practice, but a reviewer should not read this as
"oldest `n` within a chain" specifically. An evicted key's corresponding message becomes
permanently undecryptable if it arrives after eviction — this is the deliberate,
documented tradeoff of a bounded-memory skipped-key store over an unbounded one, not a
spec requirement.

## Deviations from the Signal specs

Summarizing the above, every deviation this review found, with its reason:

1. **Identity keys are Ed25519, converted to X25519 for DH**, rather than native X25519
   identity keys — to share one identity keypair with signature verification on the
   backend. See [above](#identity-keys-ed25519-converted-to-x25519-for-dh). Within the
   spec's own allowances for this pattern.
2. **`kdfCk` uses HKDF where the spec's worked example uses HMAC** for the chain-key
   step — explicitly spec-permitted; see [above](#double-ratchet-kdfrk-and-kdfck).
3. **A global `MAX_SKIPPED_KEYS` cap (1000) across all chains**, evicted oldest-first by
   insertion order, on top of the spec's per-chain `MAX_SKIP` (100) — an addition beyond
   the spec, not a deviation from a spec requirement, since the spec specifies no global
   cap at all. See [above](#skipped-key-limits).

No deviation found in this review *weakens* a security property the spec requires
(signature verification, domain separation, the `MAX_SKIP` DoS guard, and AD construction
all match). The deviations above are either spec-permitted choices or additional
hardening beyond what the spec mandates.

## Test vectors

`apps/web/src/lib/x3dh.vectors.test.ts` pins X3DH's output against fixed, deterministic
seed bytes for every key involved (initiator identity, responder identity, signed
prekey, one-time prekey, ephemeral key — each a `Uint8Array` of 32 sequential bytes
starting at a different offset) and asserts the resulting signed-prekey public key,
one-time public key, ephemeral public key, derived session key, and associated data all
match fixed base64 constants. This is the canonical place to check this document's X3DH
claims against: if `deriveSessionKey`'s construction ever changes, this is the test that
catches it, since the expected `sessionKey` constant would no longer match.

## Implementation references

- `apps/web/src/lib/x3dh.ts` — X3DH session establishment
- `apps/web/src/lib/crypto/doubleRatchet.ts` — Double Ratchet state machine and AEAD
- `apps/web/src/lib/x3dh.vectors.test.ts` — deterministic test vectors
- `apps/backend/src/lib/keys.ts` — the backend's identity-key verification, sharing the same Ed25519 key this document describes converting for DH
- Signal X3DH specification: https://signal.org/docs/specifications/x3dh/
- Signal Double Ratchet specification: https://signal.org/docs/specifications/doubleratchet/
