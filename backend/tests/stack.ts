// Full in-process stack for buyer-agent and e2e tests: anvil + contracts, Vault (HTTP), HSP local
// stand-in, coordinator (HTTP, webhooks + polling), honest-1, honest-2, rogue. All real code paths.
import { createPublicKey } from "node:crypto";
import { type Address } from "viem";
import { generatePrivateKey, type PrivateKeyAccount } from "viem/accounts";
import { CATEGORIES, type HspConfig, HSP_DEFAULT_HEADERS, HSP_DEFAULT_PATHS, generateAuditorKey, merchantKey, seededRng } from "@sealed/core";
import { Vault, buildVaultServer, type VaultConfig } from "@sealed/vault";
import { buildStandIn } from "@sealed/hsp-standin";
import { Coordinator, buildCoordinatorServer } from "@sealed/coordinator";
import { buildSeller, pricedCatalog, type RogueOptions } from "@sealed/sellers";
import { BuyerTools, VaultAgentClient } from "@sealed/buyer-agent";
import { startChain, type TestChain } from "./harness.ts";
import { freePort } from "./flows.ts";

export const ADMIN_TOKEN = "stack-admin-token";
export const AGENT_TOKEN = "stack-agent-token";

export interface StackOptions {
  vault?: Partial<VaultConfig>;
  rogue?: Omit<RogueOptions, "cartSwap"> & { list?: bigint; reserve?: bigint; cartSwap?: boolean };
  mandate?: { max?: bigint; cap?: bigint };
}

export interface Stack {
  tc: TestChain;
  vault: Vault;
  vaultUrl: string;
  coordinator: Coordinator;
  coordinatorUrl: string;
  hsp: HspConfig;
  urls: { honest1: string; honest2: string; rogue: string };
  sellers: { honest1: ReturnType<typeof buildSeller>; honest2: ReturnType<typeof buildSeller>; rogue: ReturnType<typeof buildSeller> };
  mandate: { max: bigint; cap: bigint };
  buyerTools(): BuyerTools;
  stop(): Promise<void>;
}

export async function startStack(o: StackOptions = {}): Promise<Stack> {
  const tc = await startChain();
  await tc.mint(tc.keys.buyer.address, 1_000_000_000n);
  const closers: { close(): Promise<unknown> }[] = [];
  const listen = async (app: { listen(o: { host: string; port: number }): Promise<string>; close(): Promise<unknown> }) => {
    const port = await freePort();
    await app.listen({ host: "127.0.0.1", port });
    closers.push(app);
    return `http://127.0.0.1:${port}`;
  };

  // Vault
  const vault = new Vault({
    chainId: 31337,
    rpcUrl: tc.rpcUrl,
    deployment: tc.deployment,
    account: tc.keys.vault,
    buyer: tc.keys.buyer.address,
    auditorPublicKey: generateAuditorKey().publicKey,
    dbPath: ":memory:",
    globalProbeLimit: 40,
    perSellerNegotiations: 3,
    sellerCooldownMs: 0,
    responseDelayMs: 20,
    sessionSeconds: 3600,
    autoRotate: true,
    rng: seededRng(11),
    ...o.vault,
  });
  const vaultUrl = await listen(buildVaultServer(vault, { adminToken: ADMIN_TOKEN, agentToken: AGENT_TOKEN, responseDelayMs: vault.cfg.responseDelayMs }));

  // HSP local stand-in with two merchants: Sealed's coordinator, and the rogue's own account
  const standinPort = await freePort();
  const coordPort = await freePort();
  const standinUrl = `http://127.0.0.1:${standinPort}`;
  const coordinatorUrl = `http://127.0.0.1:${coordPort}`;
  const merchantPk = generatePrivateKey();
  const roguePk = generatePrivateKey();
  const hsp: HspConfig = {
    baseUrl: standinUrl,
    payerBaseUrl: standinUrl,
    appKey: "sealed-app",
    appSecret: "sealed-secret",
    merchantPrivateKey: merchantPk,
    merchantName: "Sealed",
    webhookSecret: "sealed-webhook",
    paths: HSP_DEFAULT_PATHS,
    headers: HSP_DEFAULT_HEADERS,
    jwtAudience: "HashkeyMerchant",
    x402Method: "https://www.x402.org/",
    networkName: "local",
    coin: "dUSDC",
    webhookEventIdField: "request_id",
    successStatuses: ["payment-included", "payment-safe", "payment-finalized"],
    failedStatuses: ["payment-failed"],
    localStandIn: true,
  };
  const rogueHsp: HspConfig = { ...hsp, appKey: "rogue-app", appSecret: "rogue-secret", merchantPrivateKey: roguePk, merchantName: "rogue", webhookSecret: "rogue-secret" };
  const standin = buildStandIn({
    chainId: 31337,
    rpcUrl: tc.rpcUrl,
    token: tc.deployment.token,
    decimals: 6,
    hsp,
    relayer: tc.keys.relayer,
    merchants: [
      { name: "Sealed", appKey: hsp.appKey, appSecret: hsp.appSecret, webhookSecret: hsp.webhookSecret, publicKey: createPublicKey(merchantKey(merchantPk)), webhookUrl: `${coordinatorUrl}/hsp/webhook` },
      { name: "rogue", appKey: rogueHsp.appKey, appSecret: rogueHsp.appSecret, webhookSecret: rogueHsp.webhookSecret, publicKey: createPublicKey(merchantKey(roguePk)) },
    ],
    publicUrl: standinUrl,
    dbPath: ":memory:",
  });
  await standin.listen({ host: "127.0.0.1", port: standinPort });
  closers.push(standin);

  // Coordinator (webhooks + a background poller)
  const coordinator = new Coordinator({ chainId: 31337, rpcUrl: tc.rpcUrl, deployment: tc.deployment, account: tc.keys.coordinator, hsp, decimals: 6, dbPath: ":memory:" });
  const capp = buildCoordinatorServer(coordinator);
  await capp.listen({ host: "127.0.0.1", port: coordPort });
  closers.push(capp);
  let polling = true;
  const poll = async () => {
    while (polling) {
      await coordinator.pollOnce().catch(() => undefined);
      await new Promise((r) => setTimeout(r, 500));
    }
  };
  void poll();

  // Sellers
  const common = { chainId: 31337, rpcUrl: tc.rpcUrl, deployment: tc.deployment, coordinatorUrl, dataAssets: [tc.deployment.token] };
  const mk = async (name: string, account: PrivateKeyAccount, list: bigint, reserve: bigint, rogue?: RogueOptions) => {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const app = buildSeller({ ...common, name, account, publicUrl: url, items: pricedCatalog({ listPrice: list, reservePrice: reserve }), rogue });
    await app.listen({ host: "127.0.0.1", port });
    closers.push(app);
    return { app, url };
  };
  const r = o.rogue ?? {};
  const h1 = await mk("honest-1", tc.keys.seller1, 12_000_000n, 6_000_000n);
  const h2 = await mk("honest-2", tc.keys.seller2, 14_000_000n, 7_000_000n);
  const rg = await mk("rogue", tc.keys.rogue, r.list ?? 30_000_000n, r.reserve ?? 1_000_000n, {
    injection: r.injection ?? true,
    urgentFee: r.urgentFee,
    probe: r.probe,
    cartSwap: r.cartSwap ? { hsp: rogueHsp } : undefined,
  });

  // The user seals a mandate (admin path, never through the agent)
  const mandate = { max: o.mandate?.max ?? 50_000_000n, cap: o.mandate?.cap ?? 10_000_000n };
  const block = await tc.pub.getBlock();
  await vault.seal({
    maxAmount: mandate.max,
    perDealCap: mandate.cap,
    categories: [CATEGORIES["data.nav"], CATEGORIES["data.holders"], CATEGORIES["data.transfers"]],
    sellers: [tc.keys.seller1.address, tc.keys.seller2.address, tc.keys.rogue.address] as Address[],
    expiry: block.timestamp + 7n * 86_400n,
  });

  return {
    tc,
    vault,
    vaultUrl,
    coordinator,
    coordinatorUrl,
    hsp,
    urls: { honest1: h1.url, honest2: h2.url, rogue: rg.url },
    sellers: { honest1: h1.app, honest2: h2.app, rogue: rg.app },
    mandate,
    buyerTools: () =>
      new BuyerTools({
        chainId: 31337,
        rpcUrl: tc.rpcUrl,
        deployment: tc.deployment,
        wallet: tc.keys.buyer,
        vault: new VaultAgentClient(vaultUrl, AGENT_TOKEN),
        hsp: { baseUrl: standinUrl, payerBaseUrl: standinUrl, paths: HSP_DEFAULT_PATHS, x402Method: hsp.x402Method, jwtAudience: hsp.jwtAudience },
        coordinatorUrl,
        sellerUrls: [h1.url, h2.url, rg.url],
        fundingTimeoutMs: 30_000,
      }),
    async stop() {
      polling = false;
      for (const c of closers.reverse()) await c.close().catch(() => undefined);
      await tc.stop();
    },
  };
}
