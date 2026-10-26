import {
  createECDH,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
  type KeyObject,
} from "node:crypto";
import { HSP_WEBHOOK_MAX_AGE_SECONDS, hspHash, type HspCartContents } from "./hsp.ts";

// TODO(HSP-DOCS): the request-signing message layout, the JWT claims and the webhook signature
// layout below follow public HSK integrations. Confirm them against the official HSP manual.

export function b64url(data: Buffer | string): string {
  return Buffer.from(data).toString("base64url");
}

function decodePart(part: string): Record<string, unknown> | null {
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** HMAC-SHA256 over METHOD \n PATH \n QUERY \n sha256hex(body) \n timestamp \n nonce. TODO(HSP-DOCS) */
export function requestSignature(o: { method: string; path: string; query: string; body: string; timestamp: string; nonce: string; secret: string }): string {
  const bodyHash = o.body ? createHash("sha256").update(o.body, "utf8").digest("hex") : "";
  const msg = [o.method.toUpperCase(), o.path, o.query, bodyHash, o.timestamp, o.nonce].join("\n");
  return createHmac("sha256", o.secret).update(msg, "utf8").digest("hex");
}

export function signedRequestValues(o: { method: string; path: string; query?: string; body?: string; secret: string }) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomBytes(16).toString("hex");
  const signature = requestSignature({ method: o.method, path: o.path, query: o.query ?? "", body: o.body ?? "", timestamp, nonce, secret: o.secret });
  return { timestamp, nonce, signature };
}

/** Verify a signed request (used by the HSP local stand-in). Returns null when valid. */
export function checkSignedRequest(
  given: { appKey: string; timestamp: string; nonce: string; signature: string },
  req: { method: string; path: string; query: string; body: string },
  creds: { appKey: string; secret: string },
  nowSec = Math.floor(Date.now() / 1000),
): string | null {
  if (given.appKey !== creds.appKey) return "unknown app key";
  if (!/^\d+$/.test(given.timestamp) || !given.nonce) return "missing timestamp or nonce";
  if (Math.abs(nowSec - Number(given.timestamp)) > 300) return "stale request";
  const expected = Buffer.from(requestSignature({ ...req, timestamp: given.timestamp, nonce: given.nonce, secret: creds.secret }), "hex");
  const got = Buffer.from(given.signature, "hex");
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return "bad signature";
  return null;
}

// ---------------------------------------------------------------- webhooks

/** `t=<unix>,v1=<hex>` with v1 = HMAC-SHA256(secret, `${t}.${rawBody}`). TODO(HSP-DOCS) */
export function signWebhook(secret: string, rawBody: string, ts = Math.floor(Date.now() / 1000)): string {
  return `t=${ts},v1=${createHmac("sha256", secret).update(`${ts}.${rawBody}`, "utf8").digest("hex")}`;
}

/** Returns null when the webhook is authentic and fresh, otherwise the reason. */
export function verifyWebhook(secret: string, header: string | undefined, rawBody: string, nowSec = Math.floor(Date.now() / 1000)): string | null {
  if (!header) return "missing signature header";
  let t = "";
  let v1 = "";
  for (const part of header.split(",")) {
    const p = part.trim();
    if (p.startsWith("t=")) t = p.slice(2);
    else if (p.startsWith("v1=")) v1 = p.slice(3);
  }
  if (!/^\d+$/.test(t) || !/^[0-9a-f]+$/i.test(v1)) return "malformed signature header";
  if (nowSec - Number(t) > HSP_WEBHOOK_MAX_AGE_SECONDS) return "webhook too old";
  if (Number(t) - nowSec > 60) return "webhook timestamp in the future";
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`, "utf8").digest();
  const got = Buffer.from(v1, "hex");
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return "bad webhook signature";
  return null;
}

// ---------------------------------------------------------------- JWTs

export function signHs256(payload: Record<string, unknown>, key: Buffer | string): string {
  const input = `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64url(JSON.stringify(payload))}`;
  return `${input}.${createHmac("sha256", key).update(input).digest("base64url")}`;
}

export function verifyHs256(token: string, key: Buffer | string): Record<string, unknown> | null {
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) return null;
  const expected = createHmac("sha256", key).update(`${h}.${p}`).digest();
  const got = Buffer.from(s, "base64url");
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null;
  return decodePart(p);
}

/** secp256k1 key from 0x-hex or PEM. */
export function merchantKey(key: string): KeyObject {
  const k = key.trim().replace(/\\n/g, "\n");
  if (k.includes("BEGIN")) return createPrivateKey(k);
  const d = Buffer.from(k.replace(/^0x/, ""), "hex");
  if (d.length !== 32) throw new Error("HSP merchant key must be 32-byte hex or PEM");
  const ecdh = createECDH("secp256k1");
  ecdh.setPrivateKey(d);
  const pub = ecdh.getPublicKey();
  return createPrivateKey({
    key: { kty: "EC", crv: "secp256k1", d: b64url(d), x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33, 65)) },
    format: "jwk",
  });
}

/** PEM of the public key, to register with HashKey. */
export function merchantPublicPem(key: KeyObject): string {
  return createPublicKey(key).export({ type: "spki", format: "pem" }).toString();
}

export function signEs256k(payload: Record<string, unknown>, key: KeyObject): string {
  const input = `${b64url(JSON.stringify({ alg: "ES256K", typ: "JWT" }))}.${b64url(JSON.stringify(payload))}`;
  return `${input}.${sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}

export function verifyEs256k(token: string, key: KeyObject): Record<string, unknown> | null {
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) return null;
  try {
    const pubKey = key.type === "public" ? key : createPublicKey(key);
    const ok = verify("sha256", Buffer.from(`${h}.${p}`), { key: pubKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));
    return ok ? decodePart(p) : null;
  } catch {
    return null;
  }
}

/** merchant_authorization JWT over a cart. TODO(HSP-DOCS): claim names. */
export function merchantAuthorization(contents: HspCartContents, o: { merchantName: string; audience: string; key: KeyObject; ttlSeconds?: number }): string {
  const iat = Math.floor(Date.now() / 1000);
  return signEs256k(
    {
      iss: o.merchantName,
      sub: o.merchantName,
      aud: o.audience,
      iat,
      exp: iat + (o.ttlSeconds ?? 3600),
      jti: `JWT-${iat}-${randomBytes(4).toString("hex")}`,
      cart_hash: hspHash(contents),
    },
    o.key,
  );
}

/**
 * The payer's user_authorization binding cart and payment mandates.
 * TODO(HSP-DOCS): public integrations sign this HS256 keyed with the payer address; confirm the
 * algorithm and key with the manual.
 */
export function userAuthorization(o: { payer: string; audience: string; cartContents: unknown; paymentContents: unknown; expiresAt: number }): string {
  const iat = Math.floor(Date.now() / 1000);
  return signHs256(
    {
      aud: o.audience,
      nonce: `0x${randomBytes(32).toString("hex")}`,
      iat,
      exp: Math.max(o.expiresAt, iat + 60),
      iss: o.payer,
      transaction_data: [hspHash(o.cartContents), hspHash(o.paymentContents)],
    },
    Buffer.from(o.payer),
  );
}
