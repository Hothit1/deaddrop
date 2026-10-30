// File encryption and key sealing, using only node:crypto.
//
// - Files: AES-256-GCM with a random 32-byte content key.
//   Ciphertext layout: iv(12) | tag(16) | data.
// - Key delivery: "sealed box" style. The keeper makes an ephemeral x25519 key,
//   does ECDH with the recipient's x25519 public key, derives an AES key with
//   HKDF-SHA256 and encrypts the content key. Sealed = epk(32) | iv(12) | tag(16) | ct(32).
//   Only the holder of the recipient's private key can open it.
import { createCipheriv, createDecipheriv, createHash, createPublicKey, createPrivateKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from "node:crypto";

const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const INFO = Buffer.from("deaddrop-seal-v1");

export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

export function encryptFile(plaintext) {
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([c.update(plaintext), c.final()]);
  const ciphertext = Buffer.concat([iv, c.getAuthTag(), data]);
  return { key, ciphertext, hash: sha256(ciphertext) };
}

export function decryptFile(ciphertext, key) {
  const d = createDecipheriv("aes-256-gcm", key, ciphertext.subarray(0, 12));
  d.setAuthTag(ciphertext.subarray(12, 28));
  return Buffer.concat([d.update(ciphertext.subarray(28)), d.final()]);
}

/** New x25519 identity; `publicKey` is the base64 raw key registered on chain. */
export function newIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return {
    publicKey: publicKey.export({ format: "der", type: "spki" }).subarray(12).toString("base64"),
    privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  };
}

const pubFromRaw = (b64) => createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, Buffer.from(b64, "base64")]), format: "der", type: "spki" });
const privFromB64 = (b64) => createPrivateKey({ key: Buffer.from(b64, "base64"), format: "der", type: "pkcs8" });

function wrapKey(shared, epk, recipient) {
  return Buffer.from(hkdfSync("sha256", shared, Buffer.concat([epk, Buffer.from(recipient, "base64")]), INFO, 32));
}

export function seal(contentKey, recipientPubB64) {
  const eph = generateKeyPairSync("x25519");
  const epk = eph.publicKey.export({ format: "der", type: "spki" }).subarray(12);
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: pubFromRaw(recipientPubB64) });
  const k = wrapKey(shared, epk, recipientPubB64);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", k, iv);
  const ct = Buffer.concat([c.update(contentKey), c.final()]);
  return Buffer.concat([epk, iv, c.getAuthTag(), ct]).toString("base64");
}

export function open(sealedB64, identity) {
  const b = Buffer.from(sealedB64, "base64");
  const epk = b.subarray(0, 32);
  const shared = diffieHellman({ privateKey: privFromB64(identity.privateKey), publicKey: pubFromRaw(epk.toString("base64")) });
  const k = wrapKey(shared, epk, identity.publicKey);
  const d = createDecipheriv("aes-256-gcm", k, b.subarray(32, 44));
  d.setAuthTag(b.subarray(44, 60));
  return Buffer.concat([d.update(b.subarray(60)), d.final()]);
}
