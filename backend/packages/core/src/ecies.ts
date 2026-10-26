import { createCipheriv, createDecipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";
import { type Hex, bytesToHex, hexToBytes } from "viem";

// ECIES over secp256k1: ephemeral ECDH + HKDF-SHA256 + AES-256-GCM.
// Ciphertext layout: ephemeralPub(65) || iv(12) || tag(16) || ciphertext.

const INFO = Buffer.from("sealed-auditor-v1");

export function generateAuditorKey(): { privateKey: Hex; publicKey: Hex } {
  const ecdh = createECDH("secp256k1");
  ecdh.generateKeys();
  return { privateKey: bytesToHex(ecdh.getPrivateKey()), publicKey: bytesToHex(ecdh.getPublicKey()) };
}

function deriveKey(shared: Buffer, ephPub: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", shared, ephPub, INFO, 32));
}

export function encryptToAuditor(auditorPublicKey: Hex, plaintext: string): Hex {
  const eph = createECDH("secp256k1");
  eph.generateKeys();
  const ephPub = eph.getPublicKey();
  const key = deriveKey(eph.computeSecret(Buffer.from(hexToBytes(auditorPublicKey))), ephPub);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return bytesToHex(Buffer.concat([ephPub, iv, cipher.getAuthTag(), ct]));
}

export function decryptAsAuditor(auditorPrivateKey: Hex, ciphertext: Hex): string {
  const buf = Buffer.from(hexToBytes(ciphertext));
  const ephPub = buf.subarray(0, 65);
  const iv = buf.subarray(65, 77);
  const tag = buf.subarray(77, 93);
  const ct = buf.subarray(93);
  const ecdh = createECDH("secp256k1");
  ecdh.setPrivateKey(Buffer.from(hexToBytes(auditorPrivateKey)));
  const key = deriveKey(ecdh.computeSecret(ephPub), ephPub);
  const d = createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}
