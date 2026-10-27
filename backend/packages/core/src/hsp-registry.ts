import type { HspCartContents, HspConfig } from "./hsp.ts";

/*
 * What the HSP gateway accepts, from the official docs (onboarding "supported chain tokens", cart
 * mandate and API reference pages, v2.3.0 of 2026-10-16) and HashKey's SDK token tables. Used to
 * reject a bad cart or an unsupported pinned token locally instead of getting a 10001 from HSP.
 */

export interface HspToken {
  /** network name used in cart `method_data[].data.network` */
  network: string;
  chainId: number;
  coin: string;
  /** lowercase; HashKey's docs are not always EIP-55 checksummed */
  address: string;
  decimals: number;
  protocol: "eip3009" | "permit2";
  testnet: boolean;
  /** EIP-712 domain of the token, where HashKey's SDK states it */
  domain?: { name: string; version: string };
}

const t = (network: string, chainId: number, coin: string, address: string, decimals: number, protocol: HspToken["protocol"], testnet: boolean, domain?: HspToken["domain"]): HspToken => ({
  network,
  chainId,
  coin,
  address: address.toLowerCase(),
  decimals,
  protocol,
  testnet,
  ...(domain ? { domain } : {}),
});

export const HSP_TOKENS: readonly HspToken[] = [
  // mainnet
  t("ethereum", 1, "HSK", "0xe7c6bf469e97eeb0bfb74c8dbff5bd47d4c1c98a", 18, "permit2", false),
  t("ethereum", 1, "USDT", "0xdac17f958d2ee523a2206206994597c13d831ec7", 6, "permit2", false),
  t("ethereum", 1, "USDC", "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", 6, "eip3009", false, { name: "USD Coin", version: "2" }),
  t("hashkey", 177, "USDC", "0x054ed45810DbBAb8B27668922D110669c9D88D0a", 6, "eip3009", false, { name: "Bridged USDC", version: "2" }),
  t("hashkey", 177, "USDT", "0xf1b50ed67a9e2cc94ad3c477779e2d4cbfff9029", 6, "permit2", false),
  t("base", 8453, "USDC", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", 6, "eip3009", false),
  t("arbitrum", 42161, "USDC", "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", 6, "eip3009", false),
  t("arbitrum", 42161, "USDT", "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", 6, "permit2", false),
  t("bsc", 56, "USDT", "0x55d398326f99059fF775485246999027B3197955", 18, "permit2", false),
  // testnet
  t("sepolia", 11155111, "USDC", "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", 6, "eip3009", true, { name: "USD Coin", version: "2" }),
  t("sepolia", 11155111, "USDT", "0xff5588b3b38dff1b4b49bfdcbf985e84d8751a0e", 6, "permit2", true),
  t("sepolia", 11155111, "HSK", "0x31bdac8e4b897e470b70ebe286f94245baa793c2", 18, "permit2", true),
  t("base-sepolia", 84532, "USDC", "0x036CbD53842c5426634e7929541eC2318f3dCF7e", 6, "eip3009", true, { name: "USD Coin", version: "2" }),
  t("hashkey-testnet", 133, "USDC", "0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6", 6, "eip3009", true, { name: "USD Coin", version: "2" }),
  t("hashkey-testnet", 133, "USDT", "0x372325443233fEbaC1F6998aC750276468c83CC6", 6, "permit2", true),
  t("bsc-testnet", 97, "USDT", "0xBDec532A2675D3a6a091624b1FE878Ff58a43997", 18, "permit2", true),
  t("arbitrum-sepolia", 421614, "USDT", "0xc52f0FD29292393D253420205BF1dDCc5a0ED224", 6, "permit2", true),
  t("arbitrum-sepolia", 421614, "USDC", "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d", 6, "eip3009", true),
];

export function findHspToken(chainId: number, address: string): HspToken | undefined {
  const a = address.toLowerCase();
  return HSP_TOKENS.find((x) => x.chainId === chainId && x.address === a);
}

/** The token Sealed should pin on a chain: HSP-supported and EIP-3009 (the escrow needs the authorization nonce). */
export function recommendedHspToken(chainId: number): HspToken | undefined {
  return HSP_TOKENS.find((x) => x.chainId === chainId && x.protocol === "eip3009");
}

/**
 * Why `address` cannot be settled through HSP on `chainId` for Sealed, or null if it can.
 * Sealed escrows only work with EIP-3009 tokens, so Permit2-only tokens (USDT, HSK) are refused too.
 */
export function hspTokenError(chainId: number, address: string, coin?: string): string | null {
  const known = findHspToken(chainId, address);
  const rec = recommendedHspToken(chainId);
  const hint = rec ? ` Use ${rec.coin} ${rec.address} (${rec.network}).` : " HSP lists no EIP-3009 token for this chain.";
  if (!known) return `token ${address} is not an HSP-supported token on chain ${chainId}.${hint}`;
  if (known.protocol !== "eip3009") return `${known.coin} on ${known.network} settles with ${known.protocol}, but Sealed's escrow needs EIP-3009.${hint}`;
  if (coin && coin !== known.coin) return `HSP_COIN is ${coin} but ${address} is ${known.coin} on ${known.network}`;
  return null;
}

// ------------------------------------------------------------------ cart validation

const X402 = "https://www.x402.org";
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const DECIMALS = 18;

function scaled(value: unknown): bigint | null {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(String(value ?? "").trim());
  if (!m || (m[2]?.length ?? 0) > DECIMALS) return null;
  return BigInt(m[1]!) * 10n ** BigInt(DECIMALS) + BigInt(((m[2] ?? "") + "0".repeat(DECIMALS)).slice(0, DECIMALS));
}

const sameMethod = (m: string) => m.trim().replace(/\/$/, "") === X402;

/**
 * The gateway's cart rules, checked before submission (a violation is HTTP 400, code 10001, and no
 * payment session is created). Returns every problem found; empty means the cart looks valid.
 * `checkTokens` also requires each method to be a token HSP supports (off for the local stand-in).
 */
export function validateCartContents(c: HspCartContents, o: { checkTokens?: boolean; now?: number } = {}): string[] {
  const out: string[] = [];
  const now = o.now ?? Date.now();
  if (!c.id) out.push("contents.id (cart_mandate_id) is required");
  if (!c.merchant_name) out.push("merchant_name is required");
  if (typeof c.user_cart_confirmation_required !== "boolean") out.push("user_cart_confirmation_required must be a boolean");
  if (!RFC3339.test(c.cart_expiry ?? "") || Number.isNaN(Date.parse(c.cart_expiry))) out.push("cart_expiry must be an RFC 3339 timestamp");
  else if (Date.parse(c.cart_expiry) <= now) out.push("cart_expiry is in the past");

  const d = c.payment_request?.details;
  if (!d?.id) out.push("details.id (payment_request_id) is required");

  const methods = c.payment_request?.method_data ?? [];
  if (methods.length === 0) out.push("method_data needs at least one payment method");
  methods.forEach((m, i) => {
    const at = `method_data[${i}]`;
    if (!sameMethod(m.supported_methods ?? "")) out.push(`${at}.supported_methods must be https://www.x402.org/`);
    const x = m.data;
    if (x?.x402Version !== 2) out.push(`${at}.data.x402Version must be 2`);
    if (!x?.network) out.push(`${at}.data.network is required`);
    if (!Number.isInteger(x?.chain_id)) out.push(`${at}.data.chain_id must be an integer`);
    if (!ADDRESS.test(x?.contract_address ?? "")) out.push(`${at}.data.contract_address is not an address`);
    if (!ADDRESS.test(x?.pay_to ?? "")) out.push(`${at}.data.pay_to is not an address`);
    if (!x?.coin) out.push(`${at}.data.coin is required`);
    if (o.checkTokens && x && ADDRESS.test(x.contract_address ?? "")) {
      const known = findHspToken(x.chain_id, x.contract_address);
      const err = hspTokenError(x.chain_id, x.contract_address, x.coin);
      if (err) out.push(`${at}: ${err}`);
      else if (known && known.network !== x.network) out.push(`${at}.data.network is ${x.network}, HSP calls chain ${x.chain_id} "${known.network}"`);
    }
  });

  const total = scaled(d?.total?.amount?.value);
  if (d?.total?.amount?.currency !== "USD") out.push("details.total currency must be USD");
  if (total === null || total <= 0n) out.push("details.total must be a decimal greater than 0");
  let sum = 0n;
  let itemsOk = true;
  for (const it of d?.display_items ?? []) {
    const v = scaled(it.amount?.value);
    if (it.amount?.currency !== "USD") out.push(`display item "${it.label}" currency must be USD`);
    if (v === null) {
      out.push(`display item "${it.label}" amount is not a decimal`);
      itemsOk = false;
    } else sum += v;
  }
  if (itemsOk && total !== null && (d?.display_items?.length ?? 0) > 0 && sum !== total) out.push("sum(display_items) must equal details.total");
  return out;
}

/** Fields of the HSP config the cart builder needs. */
export type CartConfig = Pick<HspConfig, "x402Method" | "networkName" | "coin" | "merchantName">;

/** The AP2 cart for one escrow session: one method (the pinned token, paying the escrow), one line item. */
export function buildSessionCartContents(o: {
  cfg: CartConfig;
  chainId: number;
  token: string;
  escrow: string;
  /** token-denominated decimal, e.g. "5.00" */
  amount: string;
  cartMandateId: string;
  paymentRequestId: string;
  label: string;
  expiresAt: Date;
}): HspCartContents {
  return {
    id: o.cartMandateId,
    user_cart_confirmation_required: true,
    payment_request: {
      method_data: [
        {
          supported_methods: o.cfg.x402Method,
          data: { x402Version: 2, network: o.cfg.networkName, chain_id: o.chainId, contract_address: o.token as `0x${string}`, pay_to: o.escrow as `0x${string}`, coin: o.cfg.coin },
        },
      ],
      details: {
        id: o.paymentRequestId,
        display_items: [{ label: o.label, amount: { currency: "USD", value: o.amount } }],
        total: { label: "Total", amount: { currency: "USD", value: o.amount } },
      },
    },
    cart_expiry: o.expiresAt.toISOString(),
    merchant_name: o.cfg.merchantName,
  };
}
