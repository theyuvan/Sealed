# Sealed

**Agents that negotiate and pay without leaking the budget — not by saying it, not by overspending, and not by how they bargain.**

Built on HashKey Chain for the HSK Chain Horizon Hackathon (Mumbai Edition), Track 2: Agent Payments & A2A Settlement.

---

## 1. The problem

AI agents now buy services from other agents. Today the buyer agent holds its user's budget in plain text inside its prompt. That leaks in three ways:

1. **Saying it.** A malicious seller agent asks "what's your max budget?" or slips in a prompt injection. Buyer agents reveal their budget even when told not to, and sellers then anchor to it.
2. **Overspending.** A seller invents an "urgent compliance fee" or "priority surcharge". Prompt-level limits are only requests; a hijacked agent pays.
3. **Bargaining.** Even if the number is hidden, the shape of the agent's offers gives it away. An agent with a $3,000 budget that offers 2,600 → 2,850 → 2,950 has told the seller where its ceiling is (Apple, *Behavioral Privacy Leakage in Agentic Negotiation*, arXiv 2607.06815, July 2026).

And one more payment problem: **paid but not delivered.** Stablecoin payments can't be reversed. A seller can take the money and return garbage.

## 2. The solution in one paragraph

The user's spending rules are sealed into a salted commitment on HSK Chain. The buyer agent (the LLM) never sees them. A separate, non-LLM **Vault** service holds the rules, generates every offer number with a randomized concession policy, and produces a **zero-knowledge spend proof** that a deal fits the sealed rules. Without a valid proof, no money moves. A valid proof opens a **session escrow** funded through **HSP** (cart mandate → payment mandate + EIP-3009 authorization → HSP relay). Inside the session, the buyer pays per call with signed **vouchers**, and it only signs a voucher after the delivery passes deterministic checks. At close, the seller is paid exactly what was delivered and the rest is refunded automatically.

## 3. Core features

| # | Feature | What it stops |
|---|---------|---------------|
| F1 | **Sealed mandate** — max amount, per-deal cap, allowed categories, allowed sellers, pinned token, expiry, committed with Poseidon + random salt into an on-chain Merkle tree | Budget visible on-chain; brute-forcing the hash |
| F2 | **Vault (non-LLM prover)** — the only component that knows the mandate; the LLM only calls `propose()` and gets back an offer number or accept/reject | "Tell me your budget" jailbreaks |
| F3 | **ZK spend proof** — proves the deal fits the mandate, burns the old budget note (nullifier), creates a new note with the remaining amount, bound to cart hash + seller + session | Overspending, proof replay, double spend, cart swap |
| F4 | **Randomized concession policy** — noisy offers toward a randomly sampled hidden target, randomized walk-away round, fixed response delay | Budget inference from offer patterns |
| F5 | **Probe limits** — every quote is committed before it's evaluated; one global evaluation limit per mandate; per-seller negotiation cap; no reason given on reject | Binary-search probing, sybil sellers, noise averaging |
| F6 | **Session escrow over HSP** — one proof opens a session; HSP funds the escrow; cap = negotiated price only, never the budget | Escrow amount leaking the budget |
| F7 | **Vouchers = pay on delivery** — buyer signs a cumulative EIP-712 voucher only after each delivery passes deterministic checks; seller can claim only the latest voucher | Paid-but-not-delivered, seller overcharging calls |
| F8 | **Pinned token** — the exact stablecoin contract is part of the sealed mandate and checked by the circuit and the escrow | Lookalike "USDC" contracts on HSK |
| F9 | **Receipts + auditor ciphertext** — every settlement emits a receipt linking nullifier, HSP order id and deliverable hash; mandate details encrypted to an auditor key at seal time | Unauditable private payments |

Honest scope note: F4 **reduces** behavioral leakage, it does not eliminate it. The accepted price always reveals a lower bound on the budget, the same as any card payment.

## 4. Architecture

```
                         ┌────────────────────────── USER SIDE ──────────────────────────┐
  User ── seals ───────► │  Vault (non-LLM)                     Buyer agent (LLM)        │
  mandate                │  - mandate + note secrets            - talks to sellers (A2A) │
                         │  - offer policy (F4)    ◄─propose()─ - never sees the mandate │
                         │  - probe limits (F5)    ─ offer ──►  - calls services, checks │
                         │  - proof generation (F3)               deliveries (F7)        │
                         │  - voucher signing key                                        │
                         └───────┬───────────────────────────────────────┬───────────────┘
                                 │ proof                                  │ x402 / A2A
                                 ▼                                        ▼
  ┌──────────── HSK CHAIN (mainnet 177) ────────────┐       ┌──────── SELLER AGENTS ────────┐
  │ MandateRegistry  (commitment tree, nullifiers,  │       │ honest-1, honest-2, rogue     │
  │                   revocation, auditor events)   │       │ - x402 paid endpoints         │
  │ SpendVerifier    (Groth16, generated)           │       │ - HSP merchants (cart mandate)│
  │ SessionEscrow    (open / fund / close / refund) │       │ - deliver service, claim      │
  └──────────▲───────────────────────▲──────────────┘       │   latest voucher              │
             │ markFunded / close    │ EIP-3009 transfer    └──────────────┬────────────────┘
             │                       │ (relayed by HSP)                    │ create order
  ┌──────────┴───────────────┐   ┌───┴──────────────────────────┐          │
  │ Settlement coordinator   │◄──┤ HSP (HashKey Merchant API)    │◄─────────┘
  │ - HSP client + webhooks  │   │ cart mandate, payment mandate,│
  │ - chain watcher          │   │ relay, signed webhooks        │
  └──────────────────────────┘   └───────────────────────────────┘
```

### End-to-end flow

1. **Seal.** User sets rules in the Vault. Vault computes `commitment = Poseidon(rules, salt, ownerSecret)`, encrypts rules to the auditor key, calls `MandateRegistry.seal(commitment, auditorCiphertext)`.
2. **Discover.** Buyer agent finds seller agents (agent cards / x402 endpoints) and requests quotes.
3. **Negotiate.** Every seller quote is committed (hashed) and sent to the Vault. Vault answers with accept, or with its next counter-offer from the randomized policy. The LLM relays numbers; it never sees the budget or how close an offer is.
4. **Prove.** On accept, Vault generates the spend proof bound to `{cartHash, seller, sessionId, token, amount}`.
5. **Open.** `SessionEscrow.open(proof, publicSignals)` verifies the proof, spends the nullifier, inserts the new budget note, and creates a session with `cap = amount`.
6. **Fund via HSP.** Seller (merchant) creates an HSP order with an AP2 cart mandate paying `amount` to the escrow. Buyer reads the cart back, checks it matches exactly, signs an EIP-3009 `transferWithAuthorization` with `nonce = sessionId`, wraps it in an HSP payment mandate, submits. HSP relays the transfer and sends a signed webhook. Coordinator verifies webhook + on-chain transfer, calls `markFunded`.
7. **Use.** Buyer calls the seller's service per call. After each delivery passes checks, the Vault signs a cumulative voucher `(sessionId, cumulativeAmount, callCount, deliveryHashChain)`.
8. **Close.** Seller calls `close` with the latest voucher → paid that amount. Unused cap is refunded to the buyer. If the seller goes silent, after `deadline` anyone can close with the last voucher (or zero). A receipt event is emitted.

## 5. Repository layout

```
sealed/
├── circuits/                  Circom spend circuit
│   ├── spend.circom
│   ├── lib/merkle.circom
│   ├── build/                 verification key, spend.wasm, final zkey (large intermediates are not committed)
│   ├── scripts/setup.mjs      Powers of Tau + Groth16 setup + export verifier
│   └── test/spend.test.ts
├── contracts/                 Foundry project
│   ├── src/
│   │   ├── MandateRegistry.sol
│   │   ├── SessionEscrow.sol
│   │   ├── SpendVerifier.sol      (generated by snarkjs)
│   │   ├── lib/PoseidonT2.sol, PoseidonT3.sol
│   │   └── dev/DevEIP3009Token.sol  (local and dev only; real HSP settles its own USDC)
│   ├── test/                  unit, fuzz, invariant, real-proof tests
│   ├── script/Deploy.s.sol
│   ├── deployments/{133,177}.json
│   └── lib/                   forge-std, openzeppelin (git submodules)
├── backend/                   all Node code (npm workspaces)
│   ├── packages/
│   │   ├── core/              shared TS: poseidon, notes, merkle mirror, EIP-712, offer policy,
│   │   │                      HSP wire types, client, crypto, supported-token registry, cart validation
│   │   └── prover/            witness building and Groth16 proving
│   ├── services/
│   │   ├── vault/             mandate, offer policy, probe limits, prover, voucher signer
│   │   ├── buyer-agent/       LLM agent (tools only, no budget access) and a scripted driver
│   │   ├── sellers/           honest-1, honest-2, rogue (attack scripts)
│   │   ├── coordinator/       HSP orders, webhook handler, polling, chain checks, markFunded
│   │   ├── hsp-standin/       "HSP local stand-in" for development only
│   │   └── adversary/         budget-inference evaluator, report and demo chart
│   ├── scripts/               dev, start, deploy, fund, e2e, hsp-check, auditor-decrypt
│   └── tests/                 harness and e2e (happy path and the six attacks)
├── README.md
└── Task.md
```

Stack: Solidity 0.8.24 + Foundry, Circom 2 + snarkjs (Groth16, BN254), TypeScript + Node 22, Fastify, viem, circomlibjs, a plain tool-calling loop for the buyer agent (Gemini by default, Claude optional), SQLite for service state.

## 6. Network config

| | Mainnet | Testnet |
|---|---|---|
| Chain ID | 177 | 133 |
| RPC | `https://mainnet.hsk.xyz` | `https://testnet.hsk.xyz` |
| Explorer | `https://hashkey.blockscout.com` | `https://testnet-explorer.hsk.xyz` |
| Gas token | HSK (18 decimals) | HSK (faucet: `https://hsk.xyz/faucet`) |

HSK Chain is an OP Stack L2 and EVM-equivalent; standard Foundry deploys work (use `--legacy` if EIP-1559 estimation fails).

**Stablecoin:** pin the exact USDC contract HSP lists for the chain (HSP's own `coin` value is `USDC`). Do not trust token symbols on HSK: contracts that report `symbol() == "USDC"` but aren't the real token exist, so the address is what counts.

| Chain | HSP network name | USDC contract (EIP-3009, 6 decimals) | On-chain name |
|---|---|---|---|
| 177 mainnet | `hashkey` | `0x054ed45810DbBAb8B27668922D110669c9D88D0a` | "Bridged USDC" (`USDC.e`), version 2 |
| 133 testnet | `hashkey-testnet` | `0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6` | "USD Coin", version 2 |

USDT on HSK settles with Permit2, not EIP-3009, so the escrow cannot use it. Source: HashKey Merchant docs (onboarding) and `hashkey-merchant/sdks`; both addresses were read on chain. The coordinator refuses to start against real HSP with any other token, and `npm run hsp:check` reports the same.

## 7. Smart contracts

### 7.1 `MandateRegistry.sol`

Holds the commitment tree and nullifier set.

```solidity
// Incremental Poseidon Merkle tree, depth 20, with a ring buffer of recent roots
function seal(uint256 commitment, bytes calldata auditorCiphertext) external returns (uint256 leafIndex);
function revoke(uint256 commitment, bytes calldata ownerSig) external; // marks root-path revoked via revokedCommitment mapping
function isKnownRoot(uint256 root) external view returns (bool);
function isSpent(uint256 nullifier) external view returns (bool);

// called only by SessionEscrow
function consume(uint256 nullifier, uint256 newCommitment) external onlyEscrow returns (uint256 leafIndex);

event Sealed(uint256 indexed commitment, uint256 leafIndex, bytes auditorCiphertext);
event Consumed(uint256 indexed nullifier, uint256 newCommitment, uint256 leafIndex);
event Revoked(uint256 indexed revocationTag);
```

Revocation without linking: the owner publishes `revocationTag = Poseidon(ownerSecret, salt, 2)`; the circuit outputs the same tag as a public signal and the escrow rejects revoked tags. Every note derived from a mandate carries the same `mandateId`-derived tag, so revoking kills the whole chain of notes.

### 7.2 `SpendVerifier.sol`

Generated by `snarkjs zkey export solidityverifier`. Do not hand-edit.

### 7.3 `SessionEscrow.sol`

```solidity
struct Session {
    address buyer;        // buyer agent wallet (payer of EIP-3009)
    address seller;
    address token;
    uint128 cap;          // negotiated price only
    uint128 funded;
    uint64  deadline;
    bytes32 cartHash;
    bytes32 hspOrderId;
    Status  status;       // Opened, Funded, Closed, Refunded
}

function open(
    uint256[2] calldata a, uint256[2][2] calldata b, uint256[2] calldata c,
    uint256[] calldata pubSignals,      // see circuit public signals
    address buyer, address seller, uint64 deadline
) external returns (bytes32 sessionId);

function markFunded(bytes32 sessionId, bytes32 hspOrderId) external onlyCoordinator;
// checks: IERC3009(token).authorizationState(buyer, sessionId) == true,
//         escrow token balance >= sum(funded) + cap

function close(bytes32 sessionId, Voucher calldata v, bytes calldata buyerSig) external;
function closeAfterDeadline(bytes32 sessionId, Voucher calldata v, bytes calldata buyerSig) external; // v may be empty

struct Voucher { bytes32 sessionId; uint128 cumulativeAmount; uint32 callCount; bytes32 deliveryHashChain; }

event SessionOpened(bytes32 indexed sessionId, uint256 nullifier, address seller, uint128 cap, bytes32 cartHash);
event SessionFunded(bytes32 indexed sessionId, bytes32 hspOrderId);
event Receipt(bytes32 indexed sessionId, uint256 nullifier, bytes32 hspOrderId,
              uint128 paid, uint128 refunded, bytes32 deliveryHashChain);
```

Checks in `open`:
- `verifier.verifyProof(...)` is true
- `registry.isKnownRoot(root)`, `!registry.isSpent(nullifier)`, revocation tag not revoked
- `token == pinnedToken` (public signal) and token is on the escrow allowlist
- `|nowPublic − block.timestamp| <= 300` seconds
- `sessionId == keccak(chainid, escrow, nullifier)` and `cartHash`, `seller`, `amount` match the public signals
- then `registry.consume(nullifier, newCommitment)`

Checks in `close`: voucher signed (EIP-712) by the session key bound in the proof; `cumulativeAmount <= cap`; pays seller `cumulativeAmount`, refunds `funded − cumulativeAmount` to buyer; status → Closed. Reentrancy guard, CEI pattern.

Unused cap is refunded to the buyer wallet but **not** re-added to the sealed budget (conservative; re-crediting is a stretch goal).

### Contract invariants (test all with Foundry, fuzz + invariant tests)

- A nullifier can be consumed once.
- No session opens without a valid proof against a known root.
- `paid + refunded == funded` for every closed session.
- `paid <= cap` always; `cap` equals the proven amount.
- Escrow balance ≥ sum of open funded sessions.
- Revoked mandates can't open sessions.
- Only the pinned token can fund a session.

## 8. Circuit: `spend.circom`

### Note format

```
rules      = { maxRemaining, perDealCap, categoriesRoot, sellersRoot, token, expiry, mandateId }
commitment = Poseidon(maxRemaining, perDealCap, categoriesRoot, sellersRoot, token, expiry, mandateId, salt, ownerPubKey)
nullifier  = Poseidon(commitment, ownerSecret)
revTag     = Poseidon(mandateId, ownerSecret)
```

### Private inputs
`maxRemaining, perDealCap, categoriesRoot, sellersRoot, expiry, mandateId, salt, ownerSecret, newSalt, merklePath[20], merkleIndex, categoryPath[k], sellerPath[k], sessionKeyPub`

### Public signals
`root, nullifier, newCommitment, revTag, amount, category, seller, token, cartHash, sessionId, now, sessionKeyHash`

### Constraints
1. `ownerPubKey` derived from `ownerSecret`; commitment recomputed and proven in the tree under `root`.
2. `nullifier`, `revTag` computed correctly.
3. `amount <= perDealCap` and `amount <= maxRemaining` (64-bit range checks with `Num2Bits`, then `LessEqThan`).
4. `category` ∈ `categoriesRoot`, `seller` ∈ `sellersRoot` (Merkle membership).
5. `token` equals the committed token.
6. `now < expiry`.
7. `newCommitment = Poseidon(maxRemaining − amount, …same rules…, newSalt, ownerPubKey)`.
8. `cartHash`, `sessionId`, `sessionKeyHash` are bound as public signals (square them into a dummy constraint so they can't be malleated).

Target: under ~60k constraints; proving in a few seconds with snarkjs in Node. Use a Powers of Tau file of adequate size (2^16 or 2^17). Groth16 phase-2 contribution with at least one random contribution; document it as a hackathon setup, not a production ceremony.

## 9. Backend services

All services: Fastify, TypeScript, zod validation, structured logs per session (who called whom, every tx hash), SQLite.

### 9.1 Vault (`services/vault`, port 7001) — the only thing that knows the budget

Runs on the user's side. Never exposed to sellers. The buyer LLM can only reach these endpoints:

| Endpoint | Purpose |
|---|---|
| `POST /mandate/seal` | create rules, salt, secrets; build commitment; encrypt to auditor key; send `seal` tx |
| `POST /negotiation/start` `{seller, category}` | starts a negotiation; samples hidden target; checks per-seller cap |
| `POST /negotiation/propose` `{negotiationId, sellerQuote, quoteCommitment}` | returns `{decision: accept|counter|walk, offer?}` after a fixed delay. No reasons, no distances |
| `POST /proof/spend` `{negotiationId, cartHash, sessionKeyPub}` | builds witness, generates Groth16 proof, returns calldata |
| `POST /voucher/sign` `{sessionId, deliveryHash, price}` | signs next cumulative voucher (called only after delivery checks pass) |
| `POST /mandate/revoke` | publishes the revocation tag |

#### Offer policy (F4)
Per negotiation, with `θ = min(maxRemaining, perDealCap)`:
- Sample hidden target `T ~ Uniform[θ·(1−α), θ]` (α ≈ 0.25), fresh per negotiation.
- Sample walk-away round `R ~ Uniform{Rmin..Rmax}`.
- Offer at round t: `o_t = clip(T · s(t) + Laplace(0, b), floor, T)` where `s(t)` is a concession curve chosen at random from a small family (linear / concave / convex) per negotiation.
- Accept a seller quote `q` iff `q ≤ T` (randomized boundary, not θ).
- Every response waits a fixed delay (e.g. 1500 ms ± 0).
- The LLM receives only `decision` and `offer`.

#### Probe limits (F5)
- A seller quote must arrive with `quoteCommitment = keccak(quote, sellerNonce)`, signed by the seller; Vault rejects unsigned/uncommitted quotes.
- Global evaluation budget per mandate (e.g. 40 evaluations total), per-seller negotiation cap (e.g. 3 per mandate), cool-down between negotiations with the same seller.
- When limits are hit, the mandate should be rotated (new note under a new `mandateId`).

### 9.2 Buyer agent (`services/buyer-agent`, port 7002)

LLM with tools only: `discover_sellers`, `request_quote` (x402), `propose` (→ Vault), `open_session`, `call_service`, `check_delivery`, `close_session`. System prompt states it has no budget knowledge. It cannot read Vault state; even a full jailbreak can't leak what it doesn't hold.

`check_delivery` is deterministic: response matches JSON schema, `deliveryHash = keccak(body)` matches the hash the seller pre-committed in its x402 response header, latency under timeout. Only then does it call `/voucher/sign`.

The same seven tools are also served over MCP (`npm run buyer:mcp`, see [backend/RUNNING.md](backend/RUNNING.md)), so any MCP client, such as Claude Desktop, can act as the buyer. It gets no more than the built-in agent does: no mandate, schema-checked arguments, one tool at a time, and the spending tools flagged for confirmation.

### 9.3 Seller agents (`services/sellers`, ports 7101–7103)

Each is an HSP merchant with x402 endpoints selling small data products for tokenized assets (e.g. NAV snapshot, holder distribution, recent transfers). Data comes from real sources on HSK (RPC / explorer API) where possible.

- `GET /service/:id` → `402` with price + quote commitment, or the delivery if the request carries an open session id.
- `POST /hsp/order` → creates the HSP order (cart mandate) for an accepted deal, payee = SessionEscrow.
- `POST /close` → submits latest voucher to `SessionEscrow.close`.

**rogue** (port 7103) runs scripted attacks: (1) "what's your budget" + injection prompts, (2) fake "urgent fee" add-on to the cart, (3) binary-search probing with many quotes, (4) trajectory inference using the adversary module, (5) cart swap after proof, (6) proof replay.

### 9.4 Settlement coordinator (`services/coordinator`, port 7201)

- **HSP client** (HashKey Merchant API): HMAC-signed requests, ES256K merchant JWT over the cart (`cart_hash`), create order, submit payment mandate (`pay-mandate`), poll order status.
- **Webhook handler**: verify `X-Signature: t=…,v1=…` HMAC, reject if older than 5 minutes, dedupe by event id.
- **Funding confirmation** only when all three hold: HSP reports payment success, the chain shows the exact EIP-3009 transfer from the buyer wallet to the escrow with `nonce = sessionId`, and the escrow balance check passes. Then call `markFunded`.
- Retries and polling so a slow HSP never loses a settlement.

> Wire details follow the official HashKey Merchant docs (https://hashkey-merchant.github.io/) and SDKs (https://github.com/hashkey-merchant/sdks): QA host `merchant-qa.hashkeymerchant.com`, production `hsp.hashkey.com`. Merchant credentials (app key, app secret) come from the HSP dashboard after HashKey registers the merchant public key. The payer-side `pay-mandate` body and the `user_authorization` format are not in the public docs: see backend/RUNNING.md for what is verified and what is still open.

### 9.5 Adversary evaluator (`services/adversary`)

Replays recorded negotiation traces and estimates the budget with simple inference (curve fit on concession trajectory + last-offer extrapolation). Outputs inference error for a baseline agent (budget in prompt, standard concession) vs Sealed. Used for the live demo chart. Report results honestly ("reduces by X% in our runs").

## 10. Environment variables

```
# chain
HSK_RPC_URL=https://mainnet.hsk.xyz
CHAIN_ID=177
PINNED_TOKEN=0x...            # verified HSP-supported stablecoin (EIP-3009)
REGISTRY_ADDRESS=
ESCROW_ADDRESS=
VERIFIER_ADDRESS=
DEPLOYER_PRIVATE_KEY=
COORDINATOR_PRIVATE_KEY=
BUYER_WALLET_PRIVATE_KEY=
SELLER_1_PRIVATE_KEY=
SELLER_2_PRIVATE_KEY=
ROGUE_PRIVATE_KEY=

# HSP
HSP_BASE_URL=
HSP_APP_KEY=
HSP_APP_SECRET=
HSP_MERCHANT_PRIVATE_KEY=      # ES256K, public key registered with HashKey
HSP_WEBHOOK_SECRET=

# vault
AUDITOR_PUBLIC_KEY=
VAULT_GLOBAL_PROBE_LIMIT=40
VAULT_PER_SELLER_NEGOTIATIONS=3
VAULT_RESPONSE_DELAY_MS=1500

# llm
LLM_API_KEY=
```

## 11. Real vs simplified

| Real | Simplified (labelled in the UI) |
|---|---|
| ZK proofs verified on HSK mainnet | Groth16 trusted setup is a hackathon setup, not a ceremony |
| HSP orders, payment mandates, relayed EIP-3009 transfers, signed webhooks | Unused session cap is refunded to the wallet, not re-credited to the sealed budget |
| Escrow, nullifiers, receipts on-chain | Auditor ciphertext is not proven inside the circuit (v2) |
| Deterministic delivery checks gate every voucher | Behavioral privacy is reduced, not eliminated |

If HSP merchant credentials are delayed, a local stand-in for the HSP endpoints may be used **only for development** and must be labelled "HSP local stand-in" everywhere. The submission must run against real HSP.

## 12. Build plan (deadline: Nov 1, 21:30 IST)

| Day | Work |
|---|---|
| Oct 26 | Repo scaffold, chain config, `packages/core` (Poseidon, note format, EIP-712 types). Request HSP credentials. Get mainnet HSK for gas. |
| Oct 27 | `spend.circom` + setup script + generated verifier; circuit tests (valid, over-budget, wrong seller, expired, replay). |
| Oct 28 | `MandateRegistry` + `SessionEscrow` + Foundry tests (fuzz + invariants). Deploy to testnet. |
| Oct 29 | Vault (policy, limits, prover, voucher signer) + coordinator HSP client + webhook handler. |
| Oct 30 | Sellers (honest + rogue), buyer agent, full e2e on testnet. |
| Oct 31 | Mainnet deploy, real HSP settlement on mainnet, adversary evaluator, demo recording. |
| Nov 1 | Buffer, README polish, submission before 21:30 IST. |

## 13. Demo script (3 minutes)

1. **0:00** User seals a mandate: "max 50 USDC, data products only, these 3 sellers, expires Friday". Show only a hash on-chain.
2. **0:30** Rogue seller attacks: asks for the budget → agent can't answer. Adds an urgent fee → proof fails, nothing moves. Probes with quotes → limit hit, mandate rotates.
3. **1:30** Chart: budget-inference error, baseline agent vs Sealed (from the adversary evaluator).
4. **2:00** Honest seller: deal accepted → proof → session opens on mainnet → HSP funds escrow → 5 paid calls with vouchers → close → seller paid, rest refunded.
5. **2:40** Click the receipt: nullifier, HSP order id, delivery hash chain, explorer links.

## 14. Open questions to confirm with HashKey

- Exact HSP Merchant API endpoints, auth headers and JWT fields; mainnet base URL.
- Which stablecoin(s) HSP settles on mainnet, and confirmation of EIP-3009 support.
- Whether an HSP order's payee can be a contract (the escrow).
- Whether HSP requires payer identity beyond the paying wallet.

## References

- Apple ML Research, *Behavioral Privacy Leakage in Agentic Negotiation* — arXiv 2607.06815
- Georgetown KGI, *The Automated but Risky Game* (buyer agents revealing budgets)
- AP2 — Agent Payments Protocol (intent / cart / payment mandates)
- HashKey Merchant (HSP) documentation and SDKs — https://hashkey-merchant.github.io/ , https://github.com/hashkey-merchant/sdks