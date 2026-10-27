// HSP readiness check: run it before the first real-HSP purchase, and again whenever .env changes.
//   npm run hsp:check            reads backend/.env
//   npm run hsp:check -- --local reads backend/.env.local
//
// Offline checks (no credentials needed): merchant key, ES256K cart signature, pinned token vs
// HSP's supported list, on-chain token facts, a sample cart against the gateway's rules.
// Online checks (need HSP_BASE_URL, HSP_APP_KEY, HSP_APP_SECRET): one read-only, signed
// GET /merchant/payments for an id that does not exist. It creates nothing and spends nothing.
import { createPublicClient, parseAbi } from "viem";
import {
  HspApiError,
  HspClient,
  buildSessionCartContents,
  chainFor,
  envInt,
  eip3009Abi,
  findHspToken,
  hspConfigFromEnv,
  hspHash,
  hspTokenError,
  loadDeployment,
  loadEnv,
  merchantAuthorization,
  merchantKey,
  merchantPublicPem,
  readTokenDomain,
  recommendedHspToken,
  rpcTransport,
  sessionCartMandateId,
  sessionPaymentRequestId,
  validateCartContents,
  verifyEs256k,
} from "@sealed/core";

const env = loadEnv();
const chainId = envInt("CHAIN_ID", 31337);
const standIn = env.HSP_LOCAL_STANDIN === "1" || env.HSP_LOCAL_STANDIN === "true";

let failed = 0;
const mark = (ok: boolean | null, name: string, detail = "") => {
  if (ok === false) failed++;
  console.log(`${ok === true ? "ok  " : ok === false ? "FAIL" : "todo"}  ${name}${detail ? `\n        ${detail.replaceAll("\n", "\n        ")}` : ""}`);
};

console.log(`HSP readiness, chain ${chainId}\n`);
if (standIn) mark(false, "HSP_LOCAL_STANDIN is on", "This check is for the real gateway. Set HSP_LOCAL_STANDIN=0 (or unset it) in backend/.env.");

// ---- config (placeholders fill what is not set yet, so the offline checks can still run)
const missing = ["HSP_BASE_URL", "HSP_APP_KEY", "HSP_APP_SECRET"].filter((k) => !env[k]);
const cfg = hspConfigFromEnv(
  { ...env, HSP_LOCAL_STANDIN: "0", HSP_BASE_URL: env.HSP_BASE_URL || "https://merchant-qa.hashkeymerchant.com", HSP_APP_KEY: env.HSP_APP_KEY || "unset", HSP_APP_SECRET: env.HSP_APP_SECRET || "unset" },
  chainId,
);
mark(
  missing.length === 0 ? true : null,
  "HSP credentials",
  missing.length === 0 ? `base ${cfg.baseUrl}, app key ${cfg.appKey.slice(0, 4)}…` : `still needed from the HSP dashboard: ${missing.join(", ")} (online checks are skipped)`,
);
if (env.HSP_BASE_URL) {
  const prod = /hsp\.hashkey\.com/.test(env.HSP_BASE_URL);
  const stg = /merchant-stg/.test(env.HSP_BASE_URL);
  const mainnet = chainId === 177;
  if ((prod || stg) !== mainnet) mark(false, "base URL matches the chain", `${env.HSP_BASE_URL} serves ${prod || stg ? "mainnet tokens only" : "testnet (QA)"}, but CHAIN_ID is ${chainId}`);
}

// ---- merchant key and cart signature
let publicPem: string | null = null;
try {
  const key = merchantKey(cfg.merchantPrivateKey);
  publicPem = merchantPublicPem(key);
  const probe = buildSessionCartContents({
    cfg,
    chainId,
    token: "0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6",
    escrow: "0x000000000000000000000000000000000000dEaD",
    amount: "1.00",
    cartMandateId: "SEALED-PREFLIGHT",
    paymentRequestId: "SEALED-PR-PREFLIGHT",
    label: "preflight",
    expiresAt: new Date(Date.now() + 600_000),
  });
  const jwt = merchantAuthorization(probe, { merchantName: cfg.merchantName, audience: cfg.jwtAudience, key });
  const claims = verifyEs256k(jwt, key);
  const header = JSON.parse(Buffer.from(jwt.split(".")[0]!, "base64url").toString());
  mark(
    !!claims && claims.cart_hash === hspHash(probe) && claims.aud === cfg.jwtAudience && header.alg === "ES256K",
    "merchant key signs a valid ES256K merchant_authorization",
    `aud "${cfg.jwtAudience}" (docs say HashkeyMerchant; the Node SDK uses HashKeyMerchant: if HSP answers 10002, set HSP_JWT_AUDIENCE to the other spelling)`,
  );
} catch (e) {
  mark(false, "merchant key", `${(e as Error).message}. Set HSP_MERCHANT_PRIVATE_KEY to the PEM file (backend/.hsp/merchant_private_key.pem).`);
}

// ---- pinned token vs HSP's supported list, and on-chain facts
const knownChain = chainId === 133 || chainId === 177;
let deployment: ReturnType<typeof loadDeployment> | null = null;
try {
  deployment = loadDeployment(chainId);
} catch (e) {
  mark(null, "deployment", `${(e as Error).message}`);
}
if (deployment && knownChain) {
  const problem = hspTokenError(chainId, deployment.token, cfg.coin);
  mark(problem === null, "pinned token is HSP-supported and EIP-3009", problem ?? `${cfg.coin} ${deployment.token} on ${cfg.networkName}`);
  if (problem) {
    const rec = recommendedHspToken(chainId);
    if (rec) console.log(`        fix: PINNED_TOKEN=${rec.address} TOKEN_DECIMALS=${rec.decimals} HSP_COIN=${rec.coin}, then: npm run deploy -- --network ${chainId === 177 ? "mainnet" : "testnet"}`);
  }

  try {
    const pub = createPublicClient({ chain: chainFor(chainId, env.HSK_RPC_URL!), transport: rpcTransport(env.HSK_RPC_URL) });
    const known = findHspToken(chainId, deployment.token);
    const [domain, decimals, auth] = await Promise.all([
      readTokenDomain(pub, deployment.token),
      pub.readContract({ address: deployment.token, abi: parseAbi(["function decimals() view returns (uint8)"]), functionName: "decimals" }),
      pub.readContract({ address: deployment.token, abi: eip3009Abi, functionName: "authorizationState", args: ["0x0000000000000000000000000000000000000001", `0x${"00".repeat(32)}`] }).then(() => true, () => false),
    ]);
    const want = envInt("TOKEN_DECIMALS", 6);
    mark(Number(decimals) === want, "token decimals match TOKEN_DECIMALS", `on chain ${decimals}, TOKEN_DECIMALS=${want}`);
    mark(auth, "token answers authorizationState (EIP-3009)");
    if (known?.domain) mark(domain.name === known.domain.name && domain.version === known.domain.version, "token EIP-712 domain matches HashKey's SDK", `on chain "${domain.name}" v${domain.version}, SDK "${known.domain.name}" v${known.domain.version}`);
  } catch (e) {
    mark(false, "reading the token on chain", `${(e as Error).message.split("\n")[0]} (is HSK_RPC_URL set and reachable?)`);
  }

  // a cart exactly as the coordinator will build it, against the gateway's rules
  const cart = buildSessionCartContents({
    cfg,
    chainId,
    token: deployment.token,
    escrow: deployment.escrow,
    amount: "5.00",
    cartMandateId: sessionCartMandateId(chainId, `0x${"ab".repeat(32)}`),
    paymentRequestId: sessionPaymentRequestId(`0x${"ab".repeat(32)}`),
    label: "preflight",
    expiresAt: new Date(Date.now() + 1_800_000),
  });
  const problems = validateCartContents(cart, { checkTokens: true });
  mark(problems.length === 0, "a session cart passes the gateway's rules", problems.join("\n"));
} else if (deployment) {
  mark(null, "token checks", `chain ${chainId} is not an HSP chain (133 testnet or 177 mainnet)`);
}

// ---- webhook endpoint
const hook = env.HSP_WEBHOOK_PUBLIC_URL;
if (!hook) mark(null, "webhook URL", "set HSP_WEBHOOK_PUBLIC_URL to the public HTTPS URL of the coordinator's /hsp/webhook (tunnel it for the demo), then enter the same URL under My Account → app → Payment webhook URL");
else if (!hook.startsWith("https://")) mark(false, "webhook URL is HTTPS", `${hook} (HSP only delivers to HTTPS)`);
else {
  try {
    const r = await fetch(`${new URL(hook).origin}/health`, { signal: AbortSignal.timeout(5000) });
    mark(r.ok, "webhook host reaches the coordinator", `${new URL(hook).origin}/health → HTTP ${r.status}`);
  } catch (e) {
    mark(false, "webhook host reaches the coordinator", `${(e as Error).message} (is the tunnel up and the coordinator running?)`);
  }
}

// ---- online: one signed, read-only request
if (missing.length === 0 && !standIn) {
  try {
    const rows = await new HspClient(cfg).payments({ cart_mandate_id: "SEALED-PREFLIGHT-NONEXISTENT" });
    mark(true, "HSP accepts our HMAC signature", `GET /merchant/payments → ${rows.length} rows`);
  } catch (e) {
    const err = e as HspApiError;
    const code = /code (\d+)/.exec(err.message)?.[1];
    if (err.status === 401 || code === "10002") mark(false, "HSP accepts our HMAC signature", `${err.message}\nCheck HSP_APP_KEY/HSP_APP_SECRET, the system clock (±300 s), and QA vs production in HSP_BASE_URL.`);
    else if (err.status === 403 || code === "10006") mark(false, "HSP accepts our HMAC signature", `${err.message}\nThe app lacks permission: ask HashKey to enable it.`);
    else if (err.status !== undefined) mark(true, "HSP accepts our HMAC signature", `authenticated; the id simply does not exist (${err.message})`);
    else mark(false, "reaching HSP", err.message);
  }
}

if (publicPem) console.log(`\nMerchant public key to register with HashKey:\n${publicPem}`);
console.log(failed ? `${failed} check(s) failed.` : "No failures.");
process.exitCode = failed ? 1 : 0;
