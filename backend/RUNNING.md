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

## TODO(HSP-DOCS): fill from the official HSP manual

All of these are config values; defaults are in `backend/packages/core/src/hsp.ts`, `hsp-crypto.ts`, `hsp-client.ts`, `hsp-payer.ts` and `backend/.env.example`. The defaults were taken from public HSK hackathon integrations, not from HashKey.

1. **Base URLs.** Merchant API base (`HSP_BASE_URL`, QA and production) and payer/checkout base (`HSP_PAYER_BASE_URL`).
2. **Paths.** Create order, payment status query, cart lookup by flow id, pay-mandate (`HSP_PATH_*`).
3. **Request signing.**
   - Header names: `X-App-Key`, `X-Timestamp`, `X-Nonce`, `X-Signature`.
   - HMAC message layout: `METHOD\nPATH\nQUERY\nsha256(body)\nts\nnonce`.
   - How the body is canonicalized.
4. **Response envelope.** Assumed `{code: 0, msg, data}`.
5. **`merchant_authorization` JWT.** ES256K; claims `iss`, `sub`, `aud=HashkeyMerchant`, `iat`, `exp`, `jti`, `cart_hash`; `cart_hash` = sha256 hex of canonical JSON.
6. **Cart mandate fields.** `supported_methods` value, x402 `data` fields, network names for 133 and 177 (`HSP_NETWORK_NAME`), coin symbol (`HSP_COIN`), id formats.
7. **Payment mandate and x402 payload.** Layout, the `payment_details_id` format, and `accepted.network = eip155:<id>`.
8. **`user_authorization` JWT.** Assumed HS256 keyed with the payer address, with `transaction_data` = [cart hash, payment hash].
9. **Webhooks.**
   - Signature header name and the `t=…,v1=…` format.
   - Which secret signs it (`HSP_WEBHOOK_SECRET` vs the app secret).
   - The event-id field used for dedupe (`HSP_WEBHOOK_EVENT_ID_FIELD`).
   - The body shape.
10. **Payment status.** Status values (`HSP_SUCCESS_STATUSES`, `HSP_FAILED_STATUSES`) and record fields (`cart_mandate_id`, `payment_request_id`, `flow_id`, `tx_signature`). Also whether `flow_id` is returned directly or has to be parsed from `payment_url`.

## Also unverified (README §14 and chain facts)

- **The stablecoin.** Which one HSP settles on mainnet, and its address (`PINNED_TOKEN`; no address was invented). Also needed:
  - Confirm it implements `transferWithAuthorization` and `authorizationState`.
  - Confirm it emits `AuthorizationUsed`; the coordinator requires that event.
  - Note its EIP-712 domain `name` and `version`; they're read on chain.
- **HSP's transfer call.** Whether HSP relays `transferWithAuthorization`, as assumed. If it uses `receiveWithAuthorization`, the payee must be the caller, which breaks escrow-as-payee.
- **Escrow as payee.** Whether an HSP order's `pay_to` can be a contract (the escrow).
- **Testnet and payer identity.** Whether HSP supports testnet 133, and whether it needs payer identity beyond the paying wallet.
- **RPC limits.** HSK's `eth_getLogs` range limit (`LOGS_CHUNK`, default 5,000) and whether `--legacy` gas is needed.
- **Live Claude agent.** Not exercised here (no API key in this environment).

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
