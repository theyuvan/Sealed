# Sealed — Private Spending Authority for AI Agents on HashKey Chain

> **The first agent payment system where the budget, the spending rules, and the bargaining strategy never enter the AI's context — while every payment is still enforced on-chain by a zero-knowledge proof, funded through HSP, and released only on verified delivery.**

Built for the **HSK Chain Horizon Hackathon (Mumbai Edition) — Track 2: Agent Payments & A2A Settlement**.

---

## The Problem in One Sentence

AI agents that buy things for you must be told your budget, and anything that knows your budget — a prompt, a log, an offer pattern — can leak it, be tricked into overspending it, or be probed until it gives it away.

---

## Why This Matters — Market Context

| Signal | Figure | Source |
|---|---|---|
| Agent-led commerce by 2030 | **$3–5T** of global retail spend could be redirected to agents (McKinsey, Oct 2025). Estimates vary widely, from ~$144B (eMarketer, 2029) to ~$1.5T (Juniper, 2030) | [Forkast](https://forkast.news/the-0-0001-problem-agent-stablecoin-volume-vs-trillion-dollar-forecasts/) |
| Freysa agent, Nov 2024 | **~$47,000** (13.19 ETH) released after **482** attempts to talk an agent out of its one rule | [The Decoder](https://the-decoder.com/hacker-wins-47000-by-tricking-ai-chatbot-with-smart-prompting/), [OECD.AI](https://oecd.ai/en/incidents/2024-11-29-2e31) |
| AIXBT agent, Mar 2025 | **~55 ETH (≈ $100,000)** moved after attackers reached the operator dashboard and queued transfer prompts | [Cointelegraph](https://cointelegraph.com/news/hacker-breaches-ai-crypto-bot-aixbt-steals-55-eth), [The Block](https://www.theblock.co/post/346911/ai-crypto-bot-aixbt-lost-eth-hack-unauthorized-dashboard-access) |
| Budget leakage in negotiation | Offer *patterns* reveal a hidden ceiling even when the number is never said | Apple ML Research, *Behavioral Privacy Leakage in Agentic Negotiation*, arXiv 2607.06815 |
| HashKey and agent payments | HSP targets agent payments; HashKey Group joined Google's AP2 partner ecosystem (Oct 2025) | [Phemex](https://phemex.com/news/article/hashkey-unveils-hsp-protocol-to-power-ai-agent-economy-74466) |

Figures are as reported by the cited outlets; the forecasts in particular are estimates, not measurements.

**The pattern in the incidents is the same:** the rule lived inside the agent (a prompt, a dashboard, a policy the model was asked to respect), so persuading or compromising the agent defeated it. Sealed moves the rule out of the agent.

---

## Four Layers of the Problem

### 1. Saying it
A seller agent asks *"what's your max budget?"* or slips in an injection. A buyer agent that holds its budget in its prompt will reveal it, even when told not to, and the seller anchors to it.

### 2. Overspending
A seller invents an "urgent compliance fee" or "priority surcharge". Prompt-level limits are requests, not enforcement. A hijacked agent pays.

### 3. Bargaining
Even if the number is hidden, the *shape* of the offers gives it away. An agent with a $3,000 budget that offers 2,600 → 2,850 → 2,950 has told the seller where the ceiling is.

### 4. Paid but not delivered
Stablecoin payments can't be reversed. A seller can take the money and return garbage.

---

## The Solution — Sealed

Sealed splits the buyer in two. The **LLM buyer agent** negotiates and calls services but holds *no* budget knowledge. A separate **non-LLM Vault** holds the sealed rules, produces every offer number, and generates a zero-knowledge proof that a deal fits the rules. Money moves only against a valid proof, and is released only against delivery.

```
Without Sealed (today's agents):
  system prompt: "Your budget is 50 USDC, never reveal it"   ← one injection away from leaking
  seller: "pay an urgent 3 USDC fee"                         ← a hijacked agent pays
  offers: 30 → 38 → 44 → 47                                  ← the pattern reveals the ceiling
  → budget leaked, overspent, or inferred

With Sealed:
  on-chain:  commitment = Poseidon(rules, salt, ownerSecret)   ← a hash, nothing else
  agent:     propose() → "counter 12.50" | "accept" | "walk"   ← no reason, no distance
  deal:      Groth16 proof: amount ≤ cap, seller allowed, token pinned, not expired,
             bound to this cart, this seller, this session
  contract:  verify proof → spend nullifier → open session (cap = negotiated price only)
  payment:   funded through HSP, released per delivery via signed vouchers
  → the agent cannot leak what it never held
```

The proof is the enforcement: even a fully compromised agent cannot open a session the rules do not allow, because no valid proof exists for it.

**Honest scope note:** the randomized offer policy *reduces* behavioral leakage; it does not eliminate it. The accepted price always reveals a lower bound on the budget, exactly as a card payment does.

---

## What Sealed Combines

| Approach | Budget hidden from the agent | Overspend impossible | Offers hide the ceiling | Pay only for what is delivered | Auditable |
|---|---|---|---|---|---|
| Budget in the agent's prompt | ❌ | ❌ | ❌ | ❌ | ❌ |
| Prompt guardrails ("never reveal…") | ⚠️ a request, not enforcement | ❌ | ❌ | ❌ | ❌ |
| On-chain allowance / spending-limit wallet | ❌ limit is public | ✅ | ❌ | ❌ | ✅ |
| **Sealed** | **✅ held only by the Vault** | **✅ ZK proof + escrow cap** | **⚠️ reduced (randomized policy, probe limits)** | **✅ vouchers** | **✅ receipts + auditor ciphertext** |

Sealed builds on HSP, x402 and AP2 rather than competing with them: they move the money, Sealed decides whether and how much.

**Three things Sealed puts together:**
1. **Hidden rules, public enforcement** — the rules are private, yet the chain verifies every spend against them.
2. **A negotiator that is not an LLM** — offers come from a randomized concession policy with hard probe limits, so there is no reasoning to jailbreak.
3. **Pay-on-delivery over HSP** — one proof opens a session, HSP funds the escrow, and the seller is paid only for deliveries that passed deterministic checks.

---

## Technical Architecture

### System Overview

```
┌────────────────────────────── USER SIDE ─────────────────────────────────┐
│  Next.js owner dashboard  ── server-side route handlers hold the Vault    │
│                              admin token; the browser never sees it       │
│                                                                           │
│  Vault (non-LLM, :7001)                    Buyer agent (LLM, :7002)       │
│  - sealed mandate + note secrets           - discovers sellers, quotes    │
│  - randomized offer policy        ◄─propose()─  - never sees the mandate  │
│  - probe limits                   ── offer ──►  - checks deliveries       │
│  - Groth16 prover                          - same tools also over MCP     │
│  - voucher signing key                                                    │
└─────────────┬──────────────────────────────────────────┬──────────────────┘
              │ spend proof                              │ x402 / A2A
              ▼                                          ▼
┌──────────── HSK CHAIN ───────────────────┐   ┌──────── SELLER AGENTS ───────┐
│ MandateRegistry                          │   │ honest-1, honest-2, rogue    │
│  ├ Poseidon Merkle tree (depth 20)       │   │ - x402 paid endpoints        │
│  ├ nullifier set, revocation tags        │   │ - create HSP order           │
│  └ auditor ciphertext events             │   │ - claim latest voucher       │
│ SpendVerifier   (Groth16, generated)     │   └──────────────┬───────────────┘
│ SessionEscrow                            │                  │ create order
│  ├ open(proof) → session, cap = price    │                  ▼
│  ├ markFunded / markFundedByTransfer     │   ┌──────────────────────────────┐
│  └ close(voucher) → pay seller + refund  │◄──┤ HSP  (EIP-3009 relay)        │
└─────────────▲────────────────────────────┘   │ cart mandate → payment       │
              │ markFunded                     │ mandate → relayed transfer   │
┌─────────────┴────────────┐                   └──────────────────────────────┘
│ Settlement coordinator   │  HSP client, webhooks / polling, chain checks
└──────────────────────────┘
```

### Where each piece runs

| Component | Knows the mandate? | Role |
|---|---|---|
| Vault | **Yes** | Seals rules, decides offers, proves spends, signs vouchers |
| Buyer agent (LLM) | **No** | Relays numbers; its token is refused (403) on every mandate route |
| Seller agents | No | Quote, deliver, request payment |
| Coordinator | No | Confirms HSP funding against the chain, calls `markFunded` |
| Contracts | Only the **commitment** | Verify proofs, hold escrow, release against vouchers |

---

## How the Cryptography and Protocols Are Used

### 1. Sealed mandate = a Poseidon commitment in an on-chain Merkle tree

```
rules      = { maxRemaining, perDealCap, categoriesRoot, sellersRoot, token, expiry, mandateId }
commitment = Poseidon(maxRemaining, perDealCap, categoriesRoot, sellersRoot, token,
                      expiry, mandateId, salt, ownerPubKey)
nullifier  = Poseidon(commitment, ownerSecret)
revTag     = Poseidon(revKey),   revKey = Poseidon(mandateId, ownerSecret)
```

`MandateRegistry.seal(commitment, auditorCiphertext)` inserts the commitment into an incremental Poseidon tree (depth 20). The rules themselves are encrypted to an **auditor key** at seal time, so a regulator or the owner can decrypt them later (`scripts/auditor-decrypt.ts`) without them ever being public.

### 2. Groth16 spend proof (circom / snarkjs, BN254)

Each deal produces a proof that, without revealing the rules:

- the caller knows a note in the tree under a known `root`;
- `amount ≤ perDealCap` and `amount ≤ maxRemaining`;
- `category` and `seller` are in the sealed allow-lists (Merkle membership);
- `token` equals the pinned token, and `now < expiry`;
- the old note is **burned** (`nullifier`) and a **new note** with `maxRemaining − amount` is created (`newCommitment`);
- the deal is bound to `cartHash`, `seller`, `sessionId`, and the session voucher key.

### 3. Nullifiers kill replay and double spend

`SessionEscrow.open` calls `MandateRegistry.consume(nullifier, newCommitment)`. A nullifier can be consumed once, so a copied proof is useless, and the session id (`keccak(chainid, escrow, nullifier, buyer, seller, deadline)`) binds the proof to the buyer so it cannot be front-run from the mempool.

### 4. Session escrow funded through HSP (EIP-3009)

```solidity
struct Session {
    address buyer;     // payer of the EIP-3009 authorization
    address seller;
    address token;     // must equal the pinned token
    uint128 cap;       // the negotiated price only, never the budget
    uint128 funded;
    uint64  deadline;
    bytes32 cartHash;
    bytes32 hspOrderId;
    Status  status;    // Opened, Funded, Closed, Refunded
}
```

The escrow cap is the *price*, not the budget, so the escrow amount cannot leak the budget. `markFunded` (or `markFundedByTransfer` for HSP's hosted route) is called by the coordinator only after the chain shows the matching transfer.

### 5. EIP-712 vouchers = pay on delivery

```solidity
struct Voucher { bytes32 sessionId; uint128 cumulativeAmount; uint32 callCount; bytes32 deliveryHashChain; }
```

After each delivery passes the deterministic checks (schema match, delivery hash matches the one the seller committed to, latency), the Vault signs the next **cumulative** voucher. The seller can claim only the latest one. `close` pays the seller `cumulativeAmount` and refunds `funded − cumulativeAmount` to the buyer.

### 6. A non-LLM Vault with a randomized offer policy

With `θ = min(maxRemaining, perDealCap)`, per negotiation the Vault samples a hidden target `T ~ Uniform[θ·(1−α), θ]`, a random concession curve (linear / concave / convex), and a random walk-away round, then offers `clip(T · s(t) + Laplace(0, b), floor, T)` after a fixed delay. It returns only `accept`, `counter <number>`, or `walk`: **no reason, no distance.**

### 7. Probe limits

Every seller quote must be signed and committed (`keccak(quote, nonce)`) before it is evaluated. A global evaluation budget (default 40 per mandate), a per-seller negotiation cap (default 3), and a cooldown (30 s) stop binary-search probing, sybil sellers, and noise averaging. When limits are hit, the mandate rotates under a new id.

### 8. One tool surface, two clients

The buyer's seven tools (`discover_sellers`, `request_quote`, `propose`, `open_session`, `call_service`, `check_delivery`, `close_session`) are served to the built-in LLM agent (Gemini by default, Claude optional) **and** over MCP (`npm run buyer:mcp`), so any MCP client can be the buyer. Neither gets the mandate: the tool list has no way to read, set, reveal, or revoke it.

---

## Full Flow — Sequence Diagrams

### Seal a Mandate

```mermaid
sequenceDiagram
    actor Owner
    participant Dash as Dashboard
    participant Vault
    participant Reg as MandateRegistry

    Owner->>Dash: Set max budget, per-deal cap, categories, sellers, expiry
    Dash->>Vault: POST /mandate/seal (admin token, server-side)
    Vault->>Vault: salt, ownerSecret, note secrets
    Vault->>Vault: commitment = Poseidon(rules, salt, ownerPubKey)
    Vault->>Vault: encrypt rules to auditor key
    Vault->>Reg: seal(commitment, auditorCiphertext)
    Reg-->>Vault: Sealed(commitment, leafIndex)
    Vault-->>Dash: commitment only, values masked
    Dash-->>Owner: Sealed. Only a hash is on-chain.
```

### Negotiate, Prove, Open, Fund

```mermaid
sequenceDiagram
    participant Agent as Buyer agent (LLM)
    participant Seller
    participant Vault
    participant Escrow as SessionEscrow
    participant HSP
    participant Coord as Coordinator

    Agent->>Seller: request_quote (x402)
    Seller-->>Agent: signed quote + commitment
    Agent->>Vault: propose(quote commitment)
    Vault->>Vault: probe limits, randomized policy
    Vault-->>Agent: accept | counter n | walk (no reason)
    Agent->>Vault: proof/spend (negotiationId, cart)
    Vault->>Vault: recompute cartHash, build witness
    Vault->>Vault: Groth16 prove (about 1.5 s)
    Vault-->>Agent: proof + 12 public signals
    Agent->>Escrow: open(proof, publicSignals, buyer, seller, deadline)
    Escrow->>Escrow: verify proof, root known, nullifier unspent, not revoked
    Escrow->>Escrow: token pinned, cart and seller match, consume nullifier
    Escrow-->>Agent: SessionOpened (cap = price)
    Seller->>HSP: create order (cart mandate, payee = escrow)
    Agent->>HSP: payment mandate + EIP-3009 authorization
    HSP->>Escrow: relayed token transfer
    Coord->>HSP: confirm payment status
    Coord->>Coord: check the transfer on chain
    Coord->>Escrow: markFunded
```

### Deliver and Close

```mermaid
sequenceDiagram
    participant Agent as Buyer agent
    participant Seller
    participant Vault
    participant Escrow as SessionEscrow

    loop each call
        Agent->>Seller: call_service (session id)
        Seller-->>Agent: delivery + committed hash
        Agent->>Agent: deterministic check (schema, hash, latency)
        Agent->>Vault: voucher/sign (only if the check passed)
        Vault-->>Agent: cumulative EIP-712 voucher
        Agent->>Seller: voucher
    end
    Seller->>Escrow: close(latest voucher)
    Escrow->>Escrow: pay cumulativeAmount to seller
    Escrow->>Escrow: refund funded minus paid to buyer
    Escrow-->>Seller: Receipt(nullifier, hspOrderId, paid, refunded, deliveryHashChain)
```

---

## ZK Circuit — Spend Proof

Located in `circuits/spend.circom`.

**Public signals (12):**

| # | Name | Description |
|---|---|---|
| 0 | `root` | Merkle root the old note is proven under |
| 1 | `nullifier` | Burns the old note; prevents replay and double spend |
| 2 | `newCommitment` | The note carrying the remaining budget |
| 3 | `revTag` | Revocation tag; escrow rejects revoked mandates |
| 4 | `amount` | The negotiated price (the only amount revealed) |
| 5 | `category` | Product category of the deal |
| 6 | `seller` | The seller, proven to be on the sealed allow-list |
| 7 | `token` | Must equal the pinned token |
| 8 | `cartHash` | Binds the proof to this exact cart (defeats cart swap) |
| 9 | `sessionId` | Binds the proof to this session |
| 10 | `now` | Proof time; the escrow requires it within 300 s of the block |
| 11 | `sessionKeyHash` | The session voucher key |

**Circuit facts (read from the built circuit, shown live on the dashboard):** Groth16 on BN254 · 9,097 variables · constraint domain ≤ 2^14 · mandate tree depth 20 · allow-list depth 4 (up to 16 categories and 16 sellers) · proving key 6.2 MB.

The trusted setup is a **hackathon setup, not a ceremony**: phase 1 is the PSE Perpetual Powers of Tau, phase 2 is one random contribution plus a beacon.

### Why the six rogue-seller attacks fail

| # | Attack | What stops it |
|---|---|---|
| 1 | "What's your budget?" + prompt injection | The buyer LLM never holds the mandate; its agent token gets 403 on every mandate route |
| 2 | Urgent fee / surcharge added to the cart | The Vault recomputes `cartHash` from the cart; the proof binds `cartHash` and `amount`; a different cart has no valid proof |
| 3 | Binary-search probing with many quotes | Quotes must be signed and committed; global evaluation cap, per-seller cap, cooldown; no reason on reject |
| 4 | Trajectory inference from offers | Randomized target, curve, walk-away round, and noise; fixed response delay |
| 5 | Cart swap after the proof | `cartHash`, `seller`, and `amount` are public signals checked in `open()` |
| 6 | Proof replay | The nullifier is consumed on first use; the session id binds buyer, seller, and deadline |

Each attack is an end-to-end test in `backend/tests/e2e/attacks.test.ts`.

---

## Measured Results

| Measurement | Result | Where it comes from |
|---|---|---|
| Spend-proof generation | **1.3–1.9 s** per proof | Dashboard, 4 sessions on testnet |
| `SessionEscrow.open` (proof verified on chain) | **≈ 1.31M gas, ≈ 0.0013 HSK** | One testnet transaction on the block explorer |
| Demo session | 12.00 escrowed, 2 calls, **4.80 paid, 7.20 refunded** | Receipt of a live testnet run |

**Budget-inference error** (mean absolute % error of an adversary's estimate of the budget ceiling; higher is better for the buyer), 1,000 simulated negotiations against a seller that never concedes:

| Adversary | Baseline (budget in prompt) | Sealed |
|---|---|---|
| Algorithm-aware | 0.0% (recovers the budget exactly) | **9.1%** |
| Generic trend estimator | 5.0% | **14.1%** |

Sealed reduces behavioral leakage; it does not eliminate it. Regenerate with `npx tsx services/adversary/src/main.ts --runs 2000` (`--live` scores the Vault's recorded traces). The result is simulated, and the dashboard says so.

---

## Frontend — Owner Dashboard

Next.js 16, React 19, Tailwind v4, Motion. Server-side route handlers hold the Vault admin token and call the Vault, buyer agent, coordinator, and sellers, so **the browser never sees a token.**

| Page | What it shows |
|---|---|
| **Dashboard** | Service health, sealed commitment, masked budget with an owner-only reveal, probe limits, rotate / revoke, deployed contracts (explorer links), circuit facts, every spend proof |
| **Negotiate** | A real run on the live stack, step by step: signed quote, Vault decision, proof verified on chain, paid calls, close. A decision trail lists each round |
| **Receipts** | Sessions with funding and settlement status. Each receipt shows paid / refunded / escrowed, every transaction as an explorer link, the 12 public signals, and **Verify proof** / **Try with amount + 1** (the tampered proof is rejected) |
| **Attacks** | The six attacks, and the budget-inference chart from the adversary report |

**Connect wallet** (nav bar) is **read-only**: it shows the connected address and its HSK and dUSDC balances, and offers to switch or add chain 133. Signing for seal and spend stays in the Vault by design, so a browser wallet never holds the budget.

Set `EXPLORER_URL` to override the explorer base URL for the links.

---

## Deployed Contracts — HSK Testnet (chain 133)

Source of truth: [`contracts/deployments/133.json`](contracts/deployments/133.json).

| Contract | Address |
|---|---|
| MandateRegistry | [`0x64cF379bB7cA5231711877cEE34D69971928Ad38`](https://testnet-explorer.hskchain.net/address/0x64cF379bB7cA5231711877cEE34D69971928Ad38) |
| SessionEscrow | [`0x4e721e056B76f40CC2d9531E58d57a774e771C17`](https://testnet-explorer.hskchain.net/address/0x4e721e056B76f40CC2d9531E58d57a774e771C17) |
| SpendVerifier | [`0x82582D4689BC21Fb7C9E227905ba3ed945b77CF9`](https://testnet-explorer.hskchain.net/address/0x82582D4689BC21Fb7C9E227905ba3ed945b77CF9) |
| Pinned token (dUSDC, "Sealed Dev USD", 6 decimals) | [`0x45228277b06e657bC6b047BfD5B313b2c7C32020`](https://testnet-explorer.hskchain.net/address/0x45228277b06e657bC6b047BfD5B313b2c7C32020) |
| Coordinator wallet | [`0xb15e66eBcD7e60E15B5098B72B34aa4CFc0e3608`](https://testnet-explorer.hskchain.net/address/0xb15e66eBcD7e60E15B5098B72B34aa4CFc0e3608) |

### Network

| | Mainnet | Testnet |
|---|---|---|
| Chain ID | 177 | **133** |
| RPC | `https://mainnet.hsk.xyz` | `https://testnet.hsk.xyz` |
| Explorer | `https://hashkey.blockscout.com` | `https://testnet-explorer.hskchain.net` |
| Gas token | HSK | HSK (faucet: `https://hsk.xyz/faucet`) |

HSK Chain is an OP Stack L2 and EVM-equivalent; standard Foundry deploys work (add `--legacy` if EIP-1559 estimation fails).

---

## Scope — What Is Real and What Is Simplified

| Real | Simplified (labelled in the UI) |
|---|---|
| Groth16 spend proofs verified on chain by `SpendVerifier` on HSK testnet | **Stablecoin is our own `dUSDC`** (a mintable EIP-3009 dev token), not the official USDC |
| `MandateRegistry` and `SessionEscrow`: nullifiers, escrow, receipts, refunds | **HSP is a local stand-in** (`HSP_LOCAL_STANDIN=1`) for the demo path. The real HSP client and HashKey's hosted-MCP route are implemented but were **not run end to end** against real HSP |
| EIP-3009 funding authorization signed by the buyer wallet and settled on chain | Groth16 setup is a hackathon setup, not a ceremony |
| Deterministic delivery checks gate every voucher | Unused session cap is refunded to the wallet, not re-credited to the sealed budget |
| LLM buyer (Gemini) and a scripted buyer both complete real purchases | Auditor ciphertext is not proven inside the circuit |
| The six attacks run as end-to-end tests | Behavioral privacy is reduced, not eliminated. Testnet only; not audited |

The HSP stand-in is development-only and refuses to run on chain 177. Wire details for the real HSP route, what was verified against HashKey's docs and what is still open, are in [`backend/RUNNING.md`](backend/RUNNING.md).

---

## Repository Structure

```
Sealed/
├── circuits/                   Circom spend circuit
│   ├── spend.circom
│   ├── lib/merkle.circom
│   ├── build/                  verification key, spend.wasm, final zkey
│   ├── scripts/setup.mjs       Powers of Tau + Groth16 setup + export verifier
│   └── test/spend.test.ts
│
├── contracts/                  Foundry project
│   ├── src/
│   │   ├── MandateRegistry.sol     commitment tree, nullifiers, revocation
│   │   ├── SessionEscrow.sol       open / fund / close / refund, vouchers
│   │   ├── SpendVerifier.sol       generated by snarkjs, do not hand-edit
│   │   ├── lib/                    Poseidon (T2, T3)
│   │   └── dev/DevEIP3009Token.sol dUSDC, development only
│   ├── test/                   unit, fuzz, invariant, real-proof tests
│   ├── script/Deploy.s.sol
│   └── deployments/{133,177}.json
│
├── backend/                    all Node code (npm workspaces)
│   ├── packages/
│   │   ├── core/               poseidon, notes, merkle mirror, EIP-712, offer policy,
│   │   │                       HSP wire types + client, supported-token registry
│   │   └── prover/             witness building and Groth16 proving
│   ├── services/
│   │   ├── vault/              mandate, offer policy, probe limits, prover, voucher signer
│   │   ├── buyer-agent/        LLM agent (tools only) + scripted driver + MCP server
│   │   ├── sellers/            honest-1, honest-2, rogue (attack scripts)
│   │   ├── coordinator/        HSP orders, webhook / polling, chain checks, markFunded
│   │   ├── hsp-standin/        "HSP local stand-in", development only
│   │   └── adversary/          budget-inference evaluator and report
│   ├── scripts/                dev, start, deploy, fund, e2e, demo, hsp-check, auditor-decrypt
│   ├── tests/                  harness + e2e (happy path and the six attacks)
│   └── RUNNING.md              running, testing, HSP wire details
│
├── frontend/                   Next.js owner dashboard
│   ├── app/                    dashboard, negotiate, receipts, attacks
│   │   └── api/                server-side route handlers (the only place the admin token lives)
│   ├── components/             Nav, WalletButton, Logo, motion components
│   └── lib/                    backend client, formatting
│
├── docs/DESIGN.md              the original design spec
├── HANDOFF.md                  status and handoff notes
├── Task.md                     checklist
└── README.md
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Smart contracts | Solidity 0.8.24, Foundry, OpenZeppelin |
| ZK | Circom 2, snarkjs (Groth16, BN254), Poseidon, circomlibjs |
| Backend | TypeScript, Node 22, Fastify, viem, zod, SQLite |
| Buyer agent | Plain tool-calling loop (Gemini default, Claude optional), MCP server |
| Payments | HSP (cart mandate → payment mandate → relayed EIP-3009), EIP-712 vouchers |
| Frontend | Next.js 16, React 19, Tailwind v4, Motion |
| Chain | HashKey Chain (OP Stack L2), testnet 133 |

---

## Local Setup

### Prerequisites

- Node.js 22+ (older than 22.13 needs `NODE_OPTIONS=--experimental-sqlite`)
- Git with submodules: `git clone --recurse-submodules https://github.com/theyuvan/Sealed`
- Foundry and Circom are downloaded for you by `npm run tools`

### Install

```bash
cd backend && npm install
cd ../frontend && npm install
```

### Run everything locally (one command)

```bash
cd backend
npm run dev          # anvil + deploy + fund + HSP stand-in + all services (uses throwaway keys in .env.local)
npm run e2e:local    # second terminal: seal → negotiate → prove → open → fund → vouchers → close → receipt
npm run web          # dashboard at http://localhost:3000
```

### Run against HSK testnet

```bash
cd backend
cp .env.example .env       # then fill in keys; never commit .env
npm run fund               # wallet balances (--send-gas / --mint-dev to top up)
npm start                  # services against the chain in .env
npm run e2e                # scripted buyer, in a second terminal
npm run web                # dashboard
```

`.env` holds the chain config, the deployed contract addresses, one private key per service wallet, the Vault admin and agent tokens, and the LLM key. Names and comments are in `backend/.env.example`. Mint the dev stablecoin to the buyer with `npm run fund -- --mint-dev <base units>`.

### Terminal demo

`npm run demo` (add `-- --fast` to skip pauses) plays the narrated flow against the running services: seal, show the agent token refused on mandate routes, print the adversary chart, run an honest purchase, then print the receipt and re-verify the spend proof (valid, and rejected with the amount changed).

---

## End-to-End Test Flow (in the UI)

1. **Dashboard** — confirm `vault up`, `coordinator up`, `3 sellers`, `chain 133`. The commitment is a hash; budget and cap show `••••••`.
2. **Reveal values** (owner view) — the remaining budget and per-deal cap appear. The buyer agent's token is refused on this route.
3. **Negotiate → Start** — watch the transcript: signed quote, Vault decision, `Spend proof verified on chain, session opened and funded through HSP`, paid calls, `Session closed. Receipt emitted.`
4. **Receipt** — paid / refunded / escrowed. Click a transaction hash to open it on the block explorer.
5. **Spend proof** — read the 12 public signals (none reveals the mandate). **Verify proof** → valid. **Try with amount + 1** → rejected.
6. **Attacks** — the six rogue-seller attacks and the budget-inference chart.

---

## Tests

```bash
cd backend
npm test            # core, circuits, contracts (forge), services, e2e
npm run test:e2e    # the happy path and the six rogue-seller attacks
```

| Suite | What it covers |
|---|---|
| core | Poseidon vs circomlib, Merkle mirror, notes, quotes, HSP crypto, ECIES, offer policy |
| circuits | Valid spend; over per-deal cap; over remaining budget; seller not allowed; wrong category; wrong token; expired; reused or forged nullifier; revoked or forged tag; wrong root; public-signal binding |
| contracts | Unit and fuzz tests; real-proof tests with the generated verifier; invariants |
| services | Vault (real proofs on anvil), coordinator, sellers, buyer agent, adversary |
| e2e | Happy path; one group per rogue attack; all attacks fail |

**Contract invariants:** a nullifier is consumed once · no session opens without a valid proof against a known root · `paid + refunded == funded` for every closed session · `paid ≤ cap` and `cap` equals the proven amount · escrow balance covers all open funded sessions · revoked mandates cannot open sessions · only the pinned token can fund a session.

Suite sizes and the list of intentional departures from the original spec are in [`backend/RUNNING.md`](backend/RUNNING.md).

---

## Repository Notes

- `circuits/build/` holds the verification key, `spend.wasm`, and the final zkey that the Vault needs to prove; large setup intermediates are not committed.
- `contracts/lib/` are git submodules (forge-std, OpenZeppelin): clone with `--recurse-submodules`.
- `backend/.env`, `.env.local`, and the SQLite state files are gitignored. **Never commit private keys.**
- `SpendVerifier.sol` is generated: after `npm run circuits:setup`, redeploy the verifier and escrow and update the addresses.

---

## Open Items

- Run the real HSP route end to end: needs HashKey to allowlist the machine's egress IP and the official testnet token (the current demo uses `dUSDC` and the local stand-in).
- Confirm with HashKey: whether an HSP order's payee may be a contract (the escrow), and whether HSP charges a fee that would change the transfer amount.
- Mainnet deployment, a proper trusted-setup ceremony, and a contract audit.
- Re-credit unused session cap to the sealed budget; prove the auditor ciphertext in the circuit.

---

## References and Acknowledgements

- Apple ML Research, *Behavioral Privacy Leakage in Agentic Negotiation* (arXiv 2607.06815)
- Georgetown KGI, *The Automated but Risky Game* (buyer agents revealing budgets)
- AP2: Agent Payments Protocol (intent, cart, and payment mandates) · x402
- [HashKey Merchant (HSP) docs](https://hashkey-merchant.github.io/) and [SDKs](https://github.com/hashkey-merchant/sdks)
- [iden3](https://iden3.io/) circom, snarkjs, circomlib · [OpenZeppelin](https://openzeppelin.com/) · [Foundry](https://getfoundry.sh/) · [Wevm](https://wevm.dev/) viem
- Incident sources: [The Decoder](https://the-decoder.com/hacker-wins-47000-by-tricking-ai-chatbot-with-smart-prompting/) (Freysa), [Cointelegraph](https://cointelegraph.com/news/hacker-breaches-ai-crypto-bot-aixbt-steals-55-eth) (AIXBT)
