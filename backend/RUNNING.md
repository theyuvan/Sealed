# Sealed backend: running, testing, deploying

The spec is [README.md](../README.md). This file covers how to run the backend, where the code departs from the spec and why, what's still unverified, and how to deploy.

## Layout

```
Sealed/
├── circuits/    spend.circom, lib/, build/ (wasm, zkey, verification key), scripts/setup.mjs, test/
├── contracts/   Foundry project (src, test, script, deployments, lib submodules)
├── backend/     everything Node: package.json, node_modules, packages/ (core, prover), services/, scripts/, tests/, .env, .tools/
├── README.md
├── Task.md
└── .gitignore   (.gitmodules also stays at the root: git requires it there for the contracts/lib submodules)
```

All commands below run from `backend/`.

## Run everything locally (one command)

```bash
cd backend
npm install
npm run dev        # anvil + deploy + fund + HSP local stand-in + coordinator + vault + sellers + buyer agent
npm run e2e:local  # in a second terminal: seal -> negotiate -> prove -> open -> fund via HSP -> vouchers -> close -> receipt
npm run e2e:local -- --llm   # same, driven by the LLM buyer agent (Gemini by default)
```

What `npm run dev` does:

- Downloads Foundry and Circom into `backend/.tools/bin` if they're missing (`npm run tools`).
- Generates throwaway local keys into `backend/.env.local` (gitignored, never printed).
- Starts anvil and deploys with `contracts/script/Deploy.s.sol`.
- Mints dev stablecoin to the buyer.
- Starts these services:

| Service | Port |
|---|---|
| vault | 7001 |
| buyer-agent | 7002 |
| honest-1 | 7101 |
| honest-2 | 7102 |
| rogue | 7103 |
| coordinator | 7201 |
| HSP local stand-in | 7301 |

Locally, HSP is the **HSP local stand-in** (`HSP_LOCAL_STANDIN=1`). It's development-only and refuses to run on chain 177. Real HSP is selected with `HSP_LOCAL_STANDIN=0` plus HashKey credentials.

Other tools:

| Command | What it does |
|---|---|
| `npm run circuits:setup` | Rebuilds the circuit, the Groth16 setup and `contracts/src/SpendVerifier.sol`. **This changes the verifier.** Then rerun `npm run circuits:fixtures`. |
| `npm run fund` | Balances of every service wallet. `-- --send-gas 0.5` sends HSK for gas and asks first. |
| `npm run hsp:check` | HSP Agentic Payment readiness: MCP endpoint alive (egress IP allowlisted?), all eight tools present with their live argument names, `get_chain_config` against the deployed token. Creates nothing. `npm run hsp:check:api` is the older signed Merchant API check. |
| `npx tsx services/adversary/src/main.ts --runs 2000` | Budget-inference report (`--live` scores the Vault's recorded traces). |
| `npx tsx scripts/auditor-decrypt.ts` | Auditor view of sealed rules (needs `AUDITOR_PRIVATE_KEY`). |

## Run on HSK testnet

Already deployed (see `contracts/deployments/133.json`); `backend/.env` holds the testnet config and wallets.

```bash
cd backend
npm start                                   # services against the chain in backend/.env (HSP local stand-in while HSP_LOCAL_STANDIN=1)
npm run e2e                                 # scripted buyer, in a second terminal
E2E_SELLER_URL=http://127.0.0.1:7102 npm run e2e -- --llm   # Gemini buyer agent
npm run fund                                # wallet balances; --send-gas / --mint-dev to top up
```

Notes from the testnet runs:
- The Vault allows 3 negotiations per seller (kept across mandates). When a seller is used up, point `E2E_SELLER_URL` at another one.
- Gemini free tier: 20 requests/day per model, and one purchase is about 13–15 requests. Change `GEMINI_MODEL` or enable billing when it runs out.
- `npm run e2e:local` runs against the local stack from `npm run dev` (`.env.local`).

## Frontend (owner dashboard)

`frontend/` is a Next.js app wired to the live services (see `frontend/README.md`). With the stack running (`npm run dev`, or `npm start` on testnet):

```bash
npm run web      # http://localhost:3000  (runs the frontend dev server; first time: cd ../frontend && npm install)
```

Its server-side route handlers hold the Vault admin token and call the Vault, buyer agent, coordinator and sellers; the browser never sees a token. Pages: dashboard (seal, rotate, revoke, probe limits, circuit facts, spend proofs), negotiate (a real run, step by step), receipts (on-chain links, the proof's public signals, re-verify), attacks (the adversary report). The Vault gained admin-only `GET /meta`, `GET /proofs` and `POST /circuit/verify`, and the coordinator `GET /sessions`, for this.

## MCP server for the buyer tools

`npm run buyer:mcp` serves the buyer's seven tools (`discover_sellers`, `request_quote`, `propose`, `open_session`, `call_service`, `check_delivery`, `close_session`) over MCP on stdio, so any MCP client can act as the buyer. It uses the same `BuyerTools` code as the built-in LLM agent and the same tool schemas (`TOOL_DEFS`), so there is nothing extra to keep in sync.

Start the stack first (`npm run dev`, or `npm start` on testnet), then register the server with your client. These launch commands work from any directory:

```jsonc
// Claude Desktop: claude_desktop_config.json
{ "mcpServers": { "sealed-buyer": {
    "command": "npm",
    "args": ["--prefix", "C:/Users/<you>/Sealed/backend", "run", "--silent", "buyer:mcp"]
} } }
```

```bash
# Claude Code
claude mcp add sealed-buyer -- npm --prefix C:/Users/<you>/Sealed/backend run --silent buyer:mcp
```

On Node older than 22.13, add `"env": { "NODE_OPTIONS": "--experimental-sqlite" }` (Claude Desktop) or `-e NODE_OPTIONS=--experimental-sqlite` (Claude Code). The server reads `backend/.env` itself (buyer wallet key, Vault agent token); the client never needs those values.

What the client gets, and what it does not:

- **No mandate.** The tool list has no way to read, set, reveal or revoke the mandate. Budget, caps and allow-lists stay in the Vault; the tools return only offers, accept/counter/walk, deliveries and receipts. The process also removes every other secret from its environment before the first tool runs.
- **Untrusted caller.** Arguments are checked against the declared schema: unknown arguments, missing ones and non-strings are refused before any tool runs.
- **One tool at a time.** Calls are queued, so negotiation and payment steps never interleave.
- **Spending tools are flagged.** `open_session`, `call_service` and `close_session` carry `destructiveHint: true` and `check_delivery` and `discover_sellers` are read-only, so clients can ask for confirmation before money moves.
- **Same limits as the LLM agent.** Every spend still needs a Vault proof and a delivery that passed the deterministic checks. The Vault's probe limits (40 evaluations per mandate, 3 negotiations per seller, 30 s cooldown) apply to MCP clients too.

Notes: one server process is one buyer session, with sessions and quotes kept in memory. `open_session` waits for chain confirmation and the HSP funding, which can exceed an MCP client's default request timeout on testnet (60 s in the TypeScript SDK): raise it if the client allows.

## Tests

```bash
npm test   # = test:core, test:circuits, test:contracts (forge), test:services, test:e2e
```

| Suite | Count | What it covers |
|---|---|---|
| core | 18 | Poseidon vs circomlib, Merkle mirror, notes, quotes, HSP crypto, ECIES, offer policy |
| circuits | 12 | Valid spend; over per-deal cap; over remaining budget; seller not allowed; wrong category; wrong token; expired; reused or forged nullifier; revoked or forged tag; wrong root; public-signal binding |
| contracts | 52 | Unit and fuzz tests (512 runs each); real-proof tests with the generated verifier; 6 invariants (128 runs × depth 64) |
| services | 41 + 1 skipped | Vault (real proofs on anvil), coordinator (real stand-in + webhooks + polling), sellers, buyer agent (full stack), adversary |
| e2e | 9 + 1 skipped | Happy path; one test group per rogue attack (README 9.3); all attacks fail |

The 2 skipped tests drive the real Claude model. They run when `ANTHROPIC_API_KEY` or `LLM_API_KEY` is set (this costs API credit).

Adversary result (2,000 simulated negotiations, a seller that never concedes):

| Adversary | Baseline (budget in prompt) | Sealed |
|---|---|---|
| Algorithm-aware | 0.0% error (recovers the budget exactly) | 9.2% error |
| Generic trend estimator | 5.0% error | 14.1% error |

Sealed reduces behavioral leakage; it does not eliminate it.

## Where the code differs from the README, and why

1. **Revocation.** The registry has `revoke(revocationKey)`, not `revoke(commitment, ownerSig)`. The two README formulas also disagree (§7.1 vs §8).
   - The circuit publishes `revTag = Poseidon(revKey)`, with `revKey = Poseidon(mandateId, ownerSecret)`.
   - Revoking reveals `revKey`, and the contract recomputes the tag. Only the owner can revoke, and nothing links back to the owner.
2. **Session id** = `keccak(chainid, escrow, nullifier, buyer, seller, deadline)`. Buyer and deadline were added so that someone who copies a proof from the mempool can't open the session with their own buyer address.
3. **`open(...)`** also takes the full `bytes32 cartHash`; the proof only carries it reduced into the SNARK field. `pubSignals` is `uint256[12]`. `sessionKeyHash` is the session key's address, which is itself a hash of the public key.
4. **`/proof/spend`** takes `{negotiationId, cart}` and the Vault recomputes `cartHash` itself. This is what defeats the "urgent fee" attack. The Vault also generates the per-session voucher key.
5. **Agent token scope.** The buyer agent's token works only on `/negotiation/*`, `/proof/spend` and `/voucher/sign`. `/mandate/seal|revoke|rotate|status` need the user's admin token, because sealing takes the mandate values as input.
6. **`close()`** can only be called by the seller before the deadline, so the buyer can't settle with an older, smaller voucher. After the deadline, anyone can call it.
7. **Probe limits.** Per-seller negotiation counts survive a mandate rotation. The global evaluation count resets with the new mandate.
8. **One HSP merchant account.** The coordinator creates orders for every seller; a seller has to sign to request its own session's order. Separate accounts per seller would need separate credentials.
9. **Allow-list sizes.** Up to 16 categories and 16 sellers per mandate (Merkle depth 4).
10. **Trusted setup.** Phase 1 is the PSE Perpetual Powers of Tau (`ppot_0080_15`), because the Hermez mirror returns 403. Phase 2 is one random contribution plus a beacon: a hackathon setup, not a ceremony.

## HSP Agentic Payment (the QA route used for the hackathon)

HashKey's hackathon guide (`hsp-agentic-payment_EN.md`, 2026-10-30) replaces the signed Merchant API with a hosted MCP server, `https://mcp-qa.hashkeymerchant.com/` (Streamable HTTP). It is the default whenever `HSP_LOCAL_STANDIN=0`.

| | |
|---|---|
| Credentials | none. HSP keeps the App Key/Secret and the ES256K merchant key. Sealed sends `merchant_name` (the team's reporting name, `HSP_MERCHANT_NAME`) and `pay_to` (the SessionEscrow) |
| Merchant side (coordinator) | `create_order` with the cart mandate (no `merchant_authorization`), then `query_payment` every poll. No webhooks. Funds a session at `payment-safe` / `payment-finalized` only, with `attribution_verified: true` |
| Payer side (buyer) | `prepare_payment` -> the buyer checks the typed data (chain, token, payee = escrow, amount = session cap, no fee, short validity) -> signs -> `finalize_payment` -> `submit_payment`. A quote lasts 5 minutes; an expired quote (30043) is prepared and signed again |
| Nonce | chosen by HSP, not our session id. The coordinator therefore identifies the transfer by the transaction hash HSP reports, checks its Transfer/AuthorizationUsed logs, refuses a hash another session already used, and calls `SessionEscrow.markFundedByTransfer` (new; the escrow still requires the tokens to be there) |
| Tool arguments | read from each tool's live input schema (the guide says to), with known aliases; an argument we cannot place, or one the schema requires that we do not supply, stops the call |
| Allowlisting | HSP must add the machine's public egress IP before it can connect |

Setup: get the egress IP allowlisted; `HSP_LOCAL_STANDIN=0`; `PINNED_TOKEN=0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6 TOKEN_DECIMALS=6` and redeploy the escrow on chain 133 (needs the new `markFundedByTransfer`, so a redeploy is required anyway); fund the buyer wallet with that token (HashKey provides test tokens); `npm run hsp:check`. The buyer pays from its own key (`BUYER_WALLET_PRIVATE_KEY`), so no OKX Agentic Wallet is needed. Tests run the whole flow against a stand-in that mimics the eight tools (`buildMcpStandIn`, also `HSP_MODE=mcp HSP_LOCAL_STANDIN=1 npm run dev`-style); it proves our side, not HSP's.

Still unknown until the first real run: the exact shape of `get_chain_config`, `get_order` and `query_payment` results (parsed tolerantly), whether HSP adds a fee (`gas_fee_advanced`; the buyer refuses to sign if `token_total_raw` is not the session cap), and whether the relay is `transferWithAuthorization` to our contract address.

## HSP wire details: verified against HashKey's docs, and what is still open

Sources: the [HashKey Merchant docs](https://hashkey-merchant.github.io/) (v2.3.0, 2026-10-16), the [official SDKs](https://github.com/hashkey-merchant/sdks) (Go, Node, Python) and the [AP2 repo](https://github.com/google-agentic-commerce/AP2). Run `npm run hsp:check` to test your setup against them (offline checks need no credentials; with credentials it also sends one read-only signed request).

### Verified

| Area | Detail |
|---|---|
| Hosts | QA/testnet `https://merchant-qa.hashkeymerchant.com`; staging `https://merchant-stg.hashkeymerchant.com` and production `https://hsp.hashkey.com` accept mainnet tokens only |
| Merchant routes | `POST /api/v1/merchant/orders` (one-time), `POST .../orders/reusable`, `GET .../merchant/payments`, `GET .../payments/reusable`; envelope `{code, msg, data}`, code 0 = success |
| Request signing | `X-App-Key`, `X-Timestamp` (±300 s), `X-Nonce`, `X-Signature` = hex HMAC-SHA256(app_secret, `METHOD\nPATH\nQUERY\nsha256hex(canonical body)\ntimestamp\nnonce`) |
| `merchant_authorization` | ES256K JWT; claims `iss`, `sub` (merchant name), `aud`, `iat`, `exp`, `jti`, `cart_hash` = sha256 hex of canonical JSON of `contents` |
| Cart rules | `x402Version` 2, `supported_methods` `https://www.x402.org/`, all currencies `USD`, `sum(display_items) = total`, RFC 3339 `cart_expiry`; `cart_mandate_id` and `payment_request_id` are each single-use (`40001`, `10004`) |
| Tokens | Only registered tokens settle. EIP-3009: USDC (and base/arbitrum USDC). Permit2: every USDT and HSK. Sealed needs EIP-3009. Table in `packages/core/src/hsp-registry.ts` |
| Statuses | `payment-required`, `-submitted`, `-verified`, `-processing`, `-included`, `-safe`, `-finalized` (terminal), `-failed` (terminal). Webhooks fire on included, safe, finalized and failed |
| Webhook | HTTPS only, 2xx within 10 s, `X-Signature: t=<unix>,v1=hex(HMAC(app_secret, t + "." + rawBody))`, ±300 s, 6 retries (1 m, 5 m, 15 m, 1 h, 6 h, 24 h). Body has `request_id`, `payment_request_id`, `cart_mandate_id`, `status`, `tx_signature` and amounts as decimals |
| Cart lookup by flow | `GET /api/v1/checkout/orders/{flow_id}`, no auth, returns `{payment_request_id, cartmandate, status, amount}` (Go SDK `routes.go`) |
| Payment mandate shape | `payment_mandate_contents` {`payment_mandate_id` = payment_request_id, `payment_details_id` = client-generated request id, `payment_details_total`, `payment_response`, `merchant_agent`, `timestamp`} + `user_authorization` (Go SDK `types/ap2.go`) |
| EIP-3009 typed data | `TransferWithAuthorization(from,to,value,validAfter,validBefore,nonce)` with the token's own name and version (Go SDK `crypto/signing.go`) |

### Still open (ask HashKey; the registration message lists these)

1. **`POST /api/v1/payment/pay-mandate` request body.** The docs name the route (architecture diagram) but not the body or headers. We send `{flow_id, payment_mandate}`.
2. **`user_authorization` format.** AP2 defines it as an SD-JWT-VC (an issuer-signed JWT with a `cnf` claim, plus a key-binding JWT with `aud`, `nonce`, `sd_hash`, `transaction_data` = hashes of the cart and payment contents). We currently sign an HS256 JWT keyed by the payer address with `transaction_data`, which a real gateway will probably reject.
3. **How HSP relays.** `transferWithAuthorization` (assumed) or `receiveWithAuthorization` (would break an escrow payee), and whether `pay_to` may be a contract.
4. **Fees.** `pay_amount` can exceed `order_amount` (service, network, gas). The coordinator refuses to fund unless HSP's `pay_amount` equals the session cap, so ask for `service_rate` 0.0000 and gas advanced by the merchant.
5. **A testnet USDC faucet or mint** for chain 133 (`0x8FE3…53c6`), so the buyer wallet can pay.
6. **JWT `aud` spelling.** Docs say `HashkeyMerchant`, the Node SDK says `HashKeyMerchant` (`HSP_JWT_AUDIENCE` switches it).
7. **RPC limits.** HSK's `eth_getLogs` range (`LOGS_CHUNK`, default 5,000) and whether `--legacy` gas is needed.
8. **Live Claude agent.** Not exercised here (no API key in this environment).

## Mainnet deployment (not done: needs your go-ahead, it spends real HSK)

```bash
# 1. backend/.env: CHAIN_ID=177, HSK_RPC_URL=https://mainnet.hsk.xyz, HSP_LOCAL_STANDIN=0, real HSP credentials,
#    PINNED_TOKEN=<verified stablecoin>, DEPLOYER/COORDINATOR/VAULT/BUYER/SELLER keys, AUDITOR_PUBLIC_KEY,
#    VAULT_ADMIN_TOKEN / VAULT_AGENT_TOKEN (distinct, random), LLM_API_KEY
# 2. rehearse on testnet first
npm run deploy -- --network testnet          # add --legacy if fee estimation fails
# 3. gas for every service wallet (prints balances; --send-gas asks for a typed confirmation)
npm run fund
npm run fund -- --send-gas 0.2
# 4. mainnet (asks you to type "deploy to mainnet")
npm run deploy -- --network mainnet --legacy
# 5. verify on Blockscout (repeat for MandateRegistry / SpendVerifier / Poseidon libraries)
.tools/bin/forge verify-contract --chain-id 177 --verifier blockscout --verifier-url https://hashkey.blockscout.com/api \
  <ESCROW_ADDRESS> src/SessionEscrow.sol:SessionEscrow --root ../contracts
# 6. expose the coordinator's /hsp/webhook over HTTPS and register that URL with HashKey;
#    register the HSP merchant public key (derive with merchantPublicPem() in packages/core)
# 7. start services (each reads backend/.env)
npx tsx services/coordinator/src/main.ts
npx tsx services/vault/src/main.ts
npx tsx services/sellers/src/main.ts
npx tsx services/buyer-agent/src/main.ts
# 8. real settlement run (spends real stablecoin)
npm run e2e -- --llm
```
