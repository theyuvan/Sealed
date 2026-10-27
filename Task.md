# Sealed: task list

Deadline: **Nov 1, 21:30 IST**. How to run everything: [backend/RUNNING.md](backend/RUNNING.md).

## Done

### Repository and tooling
- [x] Layout: `circuits/`, `contracts/`, `backend/` (all Node code, dependencies and config)
- [x] Foundry 1.8.6 and Circom 2.2.3, downloaded into `backend/.tools/bin` with `npm run tools`
- [x] One-command local stack (`npm run dev`) and full-flow script (`npm run e2e`), both run end to end

### Circuits (`circuits/`)
- [x] `spend.circom`, about 19k constraints. Proves: the note is in the registry tree, nullifier and revocation tag are correct, amount ≤ per-deal cap and ≤ remaining budget, category and seller are in the allow-lists, token is the pinned one, mandate not expired, new note is correct, cart, session and session key are bound
- [x] Setup script: PSE Perpetual Powers of Tau (phase 1) plus a hackathon phase 2, exports `SpendVerifier.sol`
- [x] 12 tests: valid spend, over per-deal cap, over remaining budget, seller not allowed, wrong category, wrong token, expired, reused or forged nullifier, revoked or forged tag, wrong root, public-signal binding

### Contracts (`contracts/`)
- [x] `MandateRegistry`: Poseidon Merkle tree (depth 20, root history), nullifier set, revocation, auditor ciphertext events
- [x] `SessionEscrow`: open with proof, mark funded after the HSP transfer, close with vouchers, close after deadline, refunds, receipts
- [x] Generated `SpendVerifier`, Poseidon libraries, dev EIP-3009 token (local only), `Deploy.s.sol` for chains 133, 177 and local
- [x] 52 tests: unit, fuzz (512 runs), real Groth16 proofs, 6 invariants (paid + refunded = funded, paid ≤ cap, escrow solvent, nullifier used once, no session without a valid proof, revoked mandates and lookalike tokens can't open)

### Backend (`backend/`)
- [x] `packages/core`: notes, Merkle tree, EIP-712 vouchers, signed quotes, offer policy, auditor encryption, chain config, HSP wire format, signing and client
- [x] `packages/prover`: witness building, Groth16 proving, verifier calldata
- [x] `services/vault`: seal, revoke, rotate; randomized offer policy; probe limits; spend proofs; voucher signing; admin and agent tokens kept separate (15 tests)
- [x] `services/coordinator`: creates HSP orders, checks webhook signatures, polls HSP, checks the transfer on chain, calls `markFunded`, serves receipts (8 tests)
- [x] `services/hsp-standin`: "HSP local stand-in" for development; switched on with `HSP_LOCAL_STANDIN=1`, refused on mainnet
- [x] `services/sellers`: honest-1, honest-2, rogue; signed quotes, x402-style delivery with pre-committed hashes, voucher claims, live chain data (8 tests)
- [x] `services/buyer-agent`: Claude tool loop (`claude-opus-5-5`) plus a scripted driver; deterministic delivery checks before any voucher (5 tests)
- [x] `services/adversary`: budget-inference error is 0.0% for a budget-in-prompt baseline vs 9.2% for Sealed (5 tests)
- [x] E2E tests: happy path, plus all 6 rogue attacks (injection, urgent fee, probing, trajectory inference, cart swap, proof replay), all of which fail
- [x] Scripts: `dev`, `deploy` (asks before mainnet), `fund`, `e2e`, `install-tools`, `export-abis`, `auditor-decrypt`

### HSK testnet (chain 133), deployed and run end to end
- [x] Contracts deployed (addresses in `contracts/deployments/133.json`):
  - MandateRegistry `0xccD0A380F5261CF5a2742faC1B29587e990039dd`
  - SessionEscrow `0xcDb67c0dFfAd967Fe6F5983536D88AdE7b1cbbbc`
  - SpendVerifier `0xCfC5D18E76586f042AADe43395c7bD337e2fC542`
  - Dev stablecoin `0xDFB2c880143a0e858167a5df177E29dfc94E6AB4` (no `PINNED_TOKEN` yet)
- [x] 8 service wallets generated into `backend/.env`, funded with testnet gas; buyer holds 1,000 dev USD
- [x] Full purchase on testnet with the scripted buyer: 3 of 5 calls paid, rest refunded, receipt with explorer links
- [x] Full purchase on testnet with the **Gemini** buyer agent (`gemini-3.1-flash-lite`); the budget never appeared in its context
- [x] Fixes found on testnet: stale RPC nonces, RPC rate limits (batched + retrying transport), lagging load-balanced RPC nodes, empty `.env` values, async agent runs
- [ ] Payments still go through the HSP local stand-in (real HSP needs HashKey credentials)

### LLM
- [x] Buyer agent supports Gemini (default, `LLM_PROVIDER=gemini`) and Claude
- [ ] Gemini free tier allows 20 requests/day per model (one purchase ≈ 13–15 requests): enable billing or rotate models for the demo
- [ ] Rotate the Gemini API key (it was shared in chat); keep it only in `backend/.env`

### Git
- [x] 15 commits pushed to `github.com/theyuvan/Sealed` (`main`)
- [ ] Commit today's changes (Gemini agent, testnet deployment, RPC fixes, docs)

## Left

### Blocked on HashKey (HSP)
- [ ] Get HSP merchant credentials: app key, app secret, register the merchant public key, webhook secret
- [ ] Fill every `TODO(HSP-DOCS)` value from the official HSP manual. The full list of 10 items is in `backend/RUNNING.md`: base URLs, endpoint paths, signing headers and message layout, response envelope, JWT claims, cart and payment mandate fields, webhook format, status values
- [ ] Confirm with HashKey (README §14):
  - [ ] Which stablecoin HSP settles on mainnet, and its address
  - [ ] That this token supports EIP-3009 and emits `AuthorizationUsed`
  - [ ] Whether HSP relays `transferWithAuthorization` (`receiveWithAuthorization` would break the escrow as payee)
  - [ ] Whether an order's `pay_to` can be a contract (the escrow)
  - [ ] Whether HSP supports testnet 133, and whether it needs payer identity beyond the paying wallet
- [ ] Set `PINNED_TOKEN` to the verified stablecoin address

### Deploy and run for real
- [ ] Fill `backend/.env` from `backend/.env.example` (real keys, distinct vault tokens, auditor key)
- [x] Testnet deploy and gas funding (see above)
- [ ] Testnet run against real HSP (needs HSP credentials)
- [x] HSK testnet RPC: EIP-1559 works (no `--legacy` needed); it rate-limits bursts (Cloudflare 1015) and is load-balanced, both now handled
- [ ] Check the RPC log-range limit on mainnet (`LOGS_CHUNK`)
- [ ] Host the coordinator's `/hsp/webhook` over HTTPS and register the URL with HashKey
- [ ] Mainnet deploy, then verify the contracts on Blockscout (needs approval: spends real HSK)
- [ ] One real mainnet settlement: proof → HSP funding → calls → close → receipt (spends real stablecoin)

### Agent and demo
- [ ] Run the 2 live-LLM tests with Gemini when the daily quota allows (`GEMINI_API_KEY=... npm run test:services`)
- [ ] Set `DATA_ASSETS` to real tokenized-asset contracts so the sellers' data products describe real assets
- [ ] Frontend (not part of this backend work)
- [ ] Demo recording (README §13) and a budget-inference chart from `services/adversary`
- [ ] Update README §5 (repository layout) to the new `circuits/` / `contracts/` / `backend/` structure

### Hardening (after the hackathon, or if time allows)
- [ ] Encrypt the Vault's SQLite database at rest (mandate secrets are stored in plain text locally)
- [ ] Production trusted-setup ceremony; phase 2 is currently a single-party hackathon setup
- [ ] Separate HSP merchant accounts per seller (today the coordinator creates orders for all sellers)
- [ ] Stretch / v2 (README): re-credit unused session cap to the sealed budget; prove the auditor ciphertext inside the circuit
