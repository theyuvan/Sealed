# Sealed: task list

Deadline: **Nov 1, 21:30 IST**. How to run everything: [backend/RUNNING.md](backend/RUNNING.md).

Three sections: **Done** (built and tested), **To do next** (can start now; owner in brackets), **Left** (blocked on HashKey, needs approval, or after the hackathon).

---

## Done

### Repository and tooling
- [x] Layout: `circuits/`, `contracts/`, `backend/` (all Node code, dependencies and config)
- [x] Foundry 1.8.6 and Circom 2.2.3 in `backend/.tools/bin` (`npm run tools`)
- [x] Local stack in one command (`npm run dev` + `npm run e2e:local`)
- [x] Testnet stack (`npm start` + `npm run e2e`)
- [x] 25 commits pushed to `github.com/theyuvan/Sealed` (`main`)

### Circuits (`circuits/`)
- [x] `spend.circom` (~19k constraints). It proves that:
  - the note is in the registry tree, and its nullifier and revocation tag are correct
  - the amount is within the per-deal cap and the remaining budget
  - the category and seller are in the allow-lists, and the token is the pinned one
  - the mandate hasn't expired, and the new note is correct
  - the cart, session and session key are bound to the proof
- [x] Setup script: PSE Perpetual Powers of Tau (phase 1) plus a hackathon phase 2, exports `SpendVerifier.sol`
- [x] 12 tests: valid spend, over per-deal cap, over remaining budget, seller not allowed, wrong category, wrong token, expired, reused or forged nullifier, revoked or forged tag, wrong root, public-signal binding

### Contracts (`contracts/`)
- [x] `MandateRegistry`: Poseidon Merkle tree (depth 20, root history), nullifier set, revocation, auditor ciphertext events
- [x] `SessionEscrow`: open with proof, mark funded after the HSP transfer, close with vouchers, close after deadline, refunds, receipts
- [x] Generated `SpendVerifier`, Poseidon libraries, dev EIP-3009 token, `Deploy.s.sol` for chains 133, 177 and local
- [x] 52 tests: unit, fuzz (512 runs), real Groth16 proofs, 6 invariants (paid + refunded = funded, paid ≤ cap, escrow solvent, nullifier used once, no session without a valid proof, revoked mandates and lookalike tokens can't open)

### Backend (`backend/`)
- [x] `packages/core`:
  - notes, Merkle tree, EIP-712 vouchers, signed quotes
  - randomized offer policy, auditor encryption
  - HSP wire format, signing and client
  - chain config; batched, retrying RPC calls; lag-tolerant reads
- [x] `packages/prover`: witness building, Groth16 proving, verifier calldata
- [x] `services/vault`: seal, revoke and rotate; offer policy; probe limits; spend proofs; voucher signing; admin and agent tokens kept separate; step logs
- [x] `services/coordinator`: HSP orders, webhook signature checks, polling, on-chain transfer check, `markFunded`, receipts
- [x] `services/hsp-standin`: "HSP local stand-in" for development (`HSP_LOCAL_STANDIN=1`, refused on mainnet)
- [x] `services/sellers`: honest-1, honest-2, rogue; signed quotes, x402-style delivery with pre-committed hashes, voucher claims, live chain data
- [x] `services/buyer-agent`: tool loop for **Gemini** (default) or Claude, plus a scripted driver. Every delivery is checked deterministically before any voucher is signed. Runs execute in the background.
- [x] `services/adversary`: budget-inference error is 0.0% for a budget-in-prompt baseline vs 9.2% for Sealed
- [x] Tests: core 19, services 41, e2e 9. The e2e tests cover the happy path plus all 6 rogue attacks (injection, urgent fee, probing, trajectory inference, cart swap, proof replay); every attack fails.

### HSK testnet (chain 133)
- [x] Contracts deployed (`contracts/deployments/133.json`):
  - MandateRegistry `0xccD0A380F5261CF5a2742faC1B29587e990039dd`
  - SessionEscrow `0xcDb67c0dFfAd967Fe6F5983536D88AdE7b1cbbbc`
  - SpendVerifier `0xCfC5D18E76586f042AADe43395c7bD337e2fC542`
  - Dev stablecoin `0xDFB2c880143a0e858167a5df177E29dfc94E6AB4`
- [x] 8 service wallets in `backend/.env` (gitignored), funded with testnet gas; the buyer holds dev USD
- [x] Full purchase with the scripted buyer: 3 of 5 calls paid, the rest refunded, receipt with explorer links
- [x] Full purchase with the Gemini agent (`gemini-3.1-flash-lite`); the budget never appeared in its context
- [x] Testnet issues fixed: stale nonces, RPC rate limits, lagging load-balanced nodes, empty `.env` values, long-running agent calls

---

## To do next

### This week, before the deadline
- [ ] **[You]** Ask HashKey for HSP merchant credentials and the HSP manual. Everything under "Blocked on HashKey" below depends on it.
- [ ] **[You]** Rotate the Gemini API key (it was shared in chat) and put the new one in `backend/.env`
- [ ] **[You]** Gemini quota for the demo: enable billing on the Google project, or switch `GEMINI_MODEL` daily. The free tier allows 20 requests per day per model, and one purchase takes 13–15.
- [ ] **[You]** Top up testnet gas: send 0.2–0.5 HSK to the deployer `0xf2d92EDc27C5b13aCCdfAA673032F89DcF6C71B1`. The Vault wallet is the lowest, at 0.0028 HSK.
- [ ] **[Me]** Spread the gas to the service wallets (`npm run fund -- --send-gas 0.02`)
- [ ] **[Me]** Run the 2 live-LLM tests with Gemini when the quota allows
- [ ] **[Me]** Update README §5 (repository layout) to the `circuits/` / `contracts/` / `backend/` structure
- [ ] **[Me]** Budget-inference chart for the demo from `services/adversary`
- [ ] **[You / me]** Set `DATA_ASSETS` to real tokenized-asset contracts on HSK, so the sellers' data describes real assets
- [ ] **[You]** Frontend (outside this backend work)
- [ ] **[You]** Demo recording (README §13)

---

## Left

### Blocked on HashKey (HSP)
- [ ] HSP merchant credentials: app key, app secret, webhook secret; register the merchant public key
- [ ] Fill the 10 `TODO(HSP-DOCS)` values from the HSP manual (base URLs, endpoint paths, signing headers and layout, response envelope, JWT claims, cart and payment mandate fields, webhook format, status values). The full list is in `backend/RUNNING.md`.
- [ ] Confirm with HashKey (README §14):
  - [ ] which stablecoin HSP settles, and its address on testnet and mainnet
  - [ ] that the token supports EIP-3009 and emits `AuthorizationUsed`
  - [ ] that HSP relays `transferWithAuthorization` (`receiveWithAuthorization` would break the escrow as payee)
  - [ ] that an order's `pay_to` can be a contract (the escrow)
  - [ ] whether HSP supports testnet 133, and whether it needs payer identity beyond the paying wallet
- [ ] Set `PINNED_TOKEN`, then redeploy the escrow with that token allowed
- [ ] Switch off the stand-in (`HSP_LOCAL_STANDIN=0`) and run the testnet purchase against real HSP
- [ ] Host the coordinator's `/hsp/webhook` over HTTPS and register the URL with HashKey

### Needs your approval (spends real funds)
- [ ] Mainnet deploy (`npm run deploy -- --network mainnet`), then verify the contracts on Blockscout
- [ ] One real mainnet settlement: proof → HSP funding → calls → close → receipt
- [ ] Before mainnet: fill `backend/.env` for chain 177 (real keys, distinct Vault tokens, auditor key) and check the RPC's log-range limit (`LOGS_CHUNK`)

### After the hackathon (hardening)
- [ ] Encrypt the Vault's SQLite database at rest (mandate secrets are stored in plain text locally)
- [ ] Production trusted-setup ceremony (phase 2 is currently a single-party hackathon setup)
- [ ] Separate HSP merchant accounts per seller (today the coordinator creates orders for all sellers)
- [ ] Stretch / v2 (README): re-credit unused session cap to the sealed budget; prove the auditor ciphertext inside the circuit
