import { createPublicKey } from "node:crypto";
import { describe, expect, it } from "vitest";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { keccak256, toHex, zeroHash, type Address } from "viem";
import {
  MerkleTree,
  verifyMerkleProof,
  zeroHashes,
  poseidon,
  commitmentOf,
  nullifierOf,
  nextNote,
  newSecrets,
  revocationKeyOf,
  revocationTagOf,
  toField,
  SNARK_FIELD,
  randomField,
  signQuote,
  checkQuote,
  nextDeliveryChain,
  canonicalJson,
  hspHash,
  unitsToDecimal,
  decimalToUnits,
  signWebhook,
  verifyWebhook,
  merchantKey,
  signEs256k,
  verifyEs256k,
  generateAuditorKey,
  encryptToAuditor,
  decryptAsAuditor,
  startPolicy,
  respond,
  seededRng,
  computeSessionId,
  type Note,
} from "../src/index.ts";

const token = "0x00000000000000000000000000000000000000aa" as Address;
const seller = "0x00000000000000000000000000000000000000bb" as Address;

function note(): Note {
  return {
    rules: { maxRemaining: 50_000_000n, perDealCap: 20_000_000n, categories: [1, 2, 3], sellers: [seller], token, expiry: 2_000_000_000n },
    secrets: newSecrets(),
  };
}

describe("poseidon", () => {
  it("matches circomlib reference vector", () => {
    // circomlib poseidon([1,2])
    expect(poseidon([1n, 2n])).toBe(7853200120776062878684798364095072458815029376092732009249414926327459813530n);
  });
});

describe("merkle", () => {
  it("empty root is the zero hash at depth", () => {
    expect(new MerkleTree(4).root).toBe(zeroHashes(4)[4]);
  });
  it("proofs verify for every leaf and root matches incremental build", () => {
    const t = new MerkleTree(20);
    for (let i = 0; i < 7; i++) t.insert(BigInt(i + 100));
    for (let i = 0; i < 7; i++) expect(verifyMerkleProof(t.proof(i))).toBe(true);
    expect(t.proof(3).root).toBe(t.root);
  });
  it("tampered proof fails", () => {
    const t = new MerkleTree(4, [1n, 2n, 3n]);
    const p = t.proof(1);
    p.leaf = 9n;
    expect(verifyMerkleProof(p)).toBe(false);
  });
});

describe("note", () => {
  it("commitment changes with every secret and rule", () => {
    const n = note();
    const c = commitmentOf(n);
    expect(commitmentOf({ ...n, secrets: { ...n.secrets, salt: n.secrets.salt + 1n } })).not.toBe(c);
    expect(commitmentOf({ ...n, rules: { ...n.rules, perDealCap: 1n } })).not.toBe(c);
    expect(c < SNARK_FIELD).toBe(true);
  });
  it("nullifier is deterministic per note and differs for the next note", () => {
    const n = note();
    expect(nullifierOf(n)).toBe(nullifierOf(n));
    expect(nullifierOf(nextNote(n, 1n))).not.toBe(nullifierOf(n));
  });
  it("next note keeps rules and revocation tag, reduces budget", () => {
    const n = note();
    const m = nextNote(n, 5_000_000n);
    expect(m.rules.maxRemaining).toBe(45_000_000n);
    expect(revocationTagOf(m.secrets)).toBe(revocationTagOf(n.secrets));
    expect(revocationTagOf(n.secrets)).toBe(poseidon([revocationKeyOf(n.secrets)]));
    expect(() => nextNote(n, 60_000_000n)).toThrow();
  });
  it("toField reduces keccak output", () => {
    const h = keccak256(toHex("x"));
    expect(toField(h)).toBe(BigInt(h) % SNARK_FIELD);
    expect(randomField() < SNARK_FIELD).toBe(true);
  });
  it("session id binds buyer and deadline", () => {
    const base = { chainId: 1, escrow: token, nullifier: 5n, buyer: seller, seller, deadline: 10n };
    expect(computeSessionId(base)).not.toBe(computeSessionId({ ...base, deadline: 11n }));
    expect(computeSessionId(base)).not.toBe(computeSessionId({ ...base, buyer: token }));
  });
});

describe("quotes", () => {
  it("signed quote verifies; tampering is detected", async () => {
    const acct = privateKeyToAccount(generatePrivateKey());
    const q = await signQuote(acct, { serviceId: "nav", quote: 10n, calls: 5, sellerNonce: keccak256(toHex("n")) });
    expect(await checkQuote(q, acct.address)).toBeNull();
    expect(await checkQuote({ ...q, quote: 9n }, acct.address)).toMatch(/commitment/);
    expect(await checkQuote(q, seller)).toMatch(/seller/);
  });
});

describe("vouchers", () => {
  it("delivery chain is order-sensitive", () => {
    const a = keccak256(toHex("a"));
    const b = keccak256(toHex("b"));
    expect(nextDeliveryChain(nextDeliveryChain(zeroHash, a), b)).not.toBe(nextDeliveryChain(nextDeliveryChain(zeroHash, b), a));
  });
});

describe("hsp helpers", () => {
  it("canonical json sorts keys recursively", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [{ y: 1, x: 2 }] } })).toBe('{"a":{"c":[{"x":2,"y":1}],"d":2},"b":1}');
    expect(hspHash({ a: 1, b: 2 })).toBe(hspHash({ b: 2, a: 1 }));
  });
  it("amount conversions round-trip and reject excess precision", () => {
    expect(unitsToDecimal(12_500_000n, 6)).toBe("12.50");
    expect(unitsToDecimal(1n, 6)).toBe("0.000001");
    expect(decimalToUnits("12.50", 6)).toBe(12_500_000n);
    expect(() => decimalToUnits("1.0000001", 6)).toThrow();
  });
  it("webhook signatures: valid, tampered, stale", () => {
    const body = '{"x":1}';
    const now = Math.floor(Date.now() / 1000);
    expect(verifyWebhook("s", signWebhook("s", body, now), body, now)).toBeNull();
    expect(verifyWebhook("s", signWebhook("s", body, now), '{"x":2}', now)).toMatch(/bad/);
    expect(verifyWebhook("s", signWebhook("s", body, now - 301), body, now)).toMatch(/old/);
    expect(verifyWebhook("s", undefined, body, now)).toMatch(/missing/);
  });
  it("ES256K JWT round trip", () => {
    const k = merchantKey(generatePrivateKey());
    const jwt = signEs256k({ a: 1 }, k);
    expect(verifyEs256k(jwt, k)).toMatchObject({ a: 1 });
    expect(verifyEs256k(jwt, createPublicKey(k))).toMatchObject({ a: 1 });
    expect(verifyEs256k(jwt.slice(0, -2) + "AA", k)).toBeNull();
  });
});

describe("auditor encryption", () => {
  it("round trips and fails with the wrong key", () => {
    const a = generateAuditorKey();
    const b = generateAuditorKey();
    const ct = encryptToAuditor(a.publicKey, "max 50 USDC");
    expect(decryptAsAuditor(a.privateKey, ct)).toBe("max 50 USDC");
    expect(() => decryptAsAuditor(b.privateKey, ct)).toThrow();
  });
});

describe("offer policy", () => {
  it("never offers above the hidden target and target stays within [theta(1-alpha), theta]", () => {
    for (let seed = 1; seed < 200; seed++) {
      const rng = seededRng(seed);
      const theta = 20_000_000n;
      const s = startPolicy(theta, rng);
      expect(s.target <= theta && s.target >= 15_000_000n).toBe(true);
      let prev = 0n;
      for (;;) {
        const d = respond(s, 100_000_000n, rng);
        if (d.decision !== "counter") break;
        expect(d.offer <= s.target).toBe(true);
        expect(d.offer >= prev).toBe(true);
        prev = d.offer;
      }
      expect(s.done).toBe(true);
    }
  });
  it("accepts a quote iff it is at or below the target", () => {
    const s = startPolicy(20_000_000n, seededRng(7));
    const t = s.target;
    expect(respond({ ...s }, t + 1n, seededRng(1)).decision).not.toBe("accept");
    expect(respond({ ...s }, t, seededRng(1)).decision).toBe("accept");
  });
});
