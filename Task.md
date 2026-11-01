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
- [x] HSP aligned with HashKey's official docs and SDKs (signing, ES256K cart JWT, cart rules, statuses, webhooks, token table, cart-by-flow route). What is verified and what is open: [backend/RUNNING.md](backend/RUNNING.md)
- [x] `packages/core/src/hsp-registry.ts`: HSP's supported tokens per chain, a cart validator for the gateway's rules (checked before every order), and a startup guard: the coordinator refuses real HSP with an unsupported token
- [x] Coordinator hardening: refuses to fund when HSP's `pay_amount` differs from the session cap (fees), webhook dedupe per status, a fresh `payment_request_id` on retries
- [x] `npm run hsp:check`: HSP readiness (merchant key, pinned token, sample cart, webhook URL, and one read-only signed request once credentials exist); prints the public key to register
- [x] HSP merchant key pair generated in `backend/.hsp/` (gitignored)
- [x] `services/hsp-standin`: "HSP local stand-in" for development (`HSP_LOCAL_STANDIN=1`, refused on mainnet). It now mirrors the real gateway: decimal amounts, included/safe/finalized statuses, `10004` on a reused `payment_request_id`
- [x] `services/sellers`: honest-1, honest-2, rogue; signed quotes, x402-style delivery with pre-committed hashes, voucher claims, live chain data
- [x] `services/buyer-agent`: tool loop for **Gemini** (default) or Claude, plus a scripted driver. Every delivery is checked deterministically before any voucher is signed. Runs execute in the background.
- [x] MCP server for the buyer tools (`npm run buyer:mcp`, stdio): the same seven tools and schemas as the LLM agent, no mandate access, schema-checked arguments, serialized calls, spending tools flagged destructive. Tested in memory with a full purchase and over a real stdio process. Setup in [backend/RUNNING.md](backend/RUNNING.md)
- [x] `services/adversary`: budget-inference error is 0.0% for a budget-in-prompt baseline vs 9.1% for Sealed; `npx tsx services/adversary/src/main.ts` also writes the demo chart `backend/data/adversary-chart.svg`
- [x] Tests: core 25, services 48 (plus 1 live-LLM test that needs quota), e2e 9. The e2e tests cover the happy path plus all 6 rogue attacks (injection, urgent fee, probing, trajectory inference, cart swap, proof replay); every attack fails.

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
- [ ] **[You]** Send HashKey the registration message (organization Sealed, public key from `npm run hsp:check`, QA chain 133 USDC) and ask the open questions in RUNNING.md. Everything under "Blocked on HashKey" depends on it.
- [ ] **[You]** Rotate the Gemini API key (it was shared in chat) and put the new one in `backend/.env`
- [ ] **[You]** Gemini quota for the demo: enable billing on the Google project, or switch `GEMINI_MODEL` daily. The free tier allows 20 requests per day per model, and one purchase takes 13–15.
- [ ] **[You]** Top up testnet gas: send 0.2–0.5 HSK to the deployer `0xf2d92EDc27C5b13aCCdfAA673032F89DcF6C71B1`. The Vault wallet is the lowest, at 0.0028 HSK.
- [ ] **[Me]** Spread the gas to the service wallets (`npm run fund -- --send-gas 0.02`)
- [ ] **[Me]** Run the 2 live-LLM tests with Gemini when the quota allows
- [ ] **[You / me]** Set `DATA_ASSETS` to real tokenized-asset contracts on HSK, so the sellers' data describes real assets
- [ ] **[You]** Frontend (outside this backend work)

---

## Left

### Dropped: real HSP and the official USDC (decision 2026-11-01)
The demo runs on the HSP local stand-in with our own dUSDC (see the 2026-11-01 note below), so everything in this block is no longer planned. Kept for reference.

### Blocked on HashKey (HSP)
- [ ] HSP merchant credentials: app key, app secret, webhook secret; register the merchant public key
- [ ] Open HSP details only HashKey can answer: the `pay-mandate` request body, the `user_authorization` format (AP2 SD-JWT-VC vs our HS256 guess), and fee handling. Everything else from the old `TODO(HSP-DOCS)` list is now verified (see RUNNING.md).
- [ ] After the HSP invite: create the app in the dashboard, set `HSP_BASE_URL`, `HSP_APP_KEY`, `HSP_APP_SECRET`, `HSP_MERCHANT_PRIVATE_KEY` and `HSP_WEBHOOK_PUBLIC_URL`, then run `npm run hsp:check` until it has no failures
- [ ] Confirm with HashKey (README §14):
  - [x] which stablecoin HSP settles: USDC (testnet `0x8FE3…53c6`, mainnet `0x054e…8D0a`)
  - [x] the token answers `authorizationState` on chain (both USDC contracts). Still to see: that `AuthorizationUsed` is emitted on a real relay
  - [ ] that HSP relays `transferWithAuthorization` (`receiveWithAuthorization` would break the escrow as payee)
  - [ ] that an order's `pay_to` can be a contract (the escrow)
  - [x] HSP supports testnet 133 (QA host, USDC and USDT). Still open: whether it needs payer identity beyond the paying wallet
- [ ] Redeploy the escrow on 133 with the official USDC: `PINNED_TOKEN=0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6 TOKEN_DECIMALS=6 HSP_COIN=USDC`, then `npm run deploy -- --network testnet`. Needs deployer gas and test USDC for the buyer wallet (ask HashKey for a faucet)
- [ ] Switch off the stand-in (`HSP_LOCAL_STANDIN=0`) and run the testnet purchase against real HSP
- [ ] Host the coordinator's `/hsp/webhook` over HTTPS and register the URL with HashKey


### After the hackathon (hardening)
- [ ] Encrypt the Vault's SQLite database at rest (mandate secrets are stored in plain text locally)
- [ ] Production trusted-setup ceremony (phase 2 is currently a single-party hackathon setup)
- [ ] Separate HSP merchant accounts per seller (today the coordinator creates orders for all sellers)
- [ ] Stretch / v2 (README): re-credit unused session cap to the sealed budget; prove the auditor ciphertext inside the circuit

## 2026-10-30: HashKey's hackathon guide (HSP Agentic Payment)

Done in code (all tests against the stand-in; nothing run against real HSP yet): MCP client for the eight tools (`packages/core/src/hsp-mcp.ts`), coordinator and buyer on that route (default when `HSP_LOCAL_STANDIN=0`), `SessionEscrow.markFundedByTransfer` (HSP picks the EIP-3009 nonce), MCP stand-in, `npm run hsp:check` for the new route. No App Key/Secret, merchant key or webhook tunnel is needed any more.

Needs you: send HSP this machine's public egress IP for the QA allowlist (guide step 1; `curl https://api.ipify.org` from the machine that runs the coordinator and buyer); get test USDC (`0x8FE3...53c6`) for the buyer wallet; confirm the team's `HSP_MERCHANT_NAME`. Then redeploy the escrow on 133 with the official USDC (new contract function), `npm run hsp:check`, one real purchase.

## 2026-10-30: frontend merged and connected

`feat/frontend` merged into main. The app now talks to the live services through server-side route handlers (Vault admin token stays on the server): seal/rotate/revoke the mandate, run a real negotiation, list sessions, open receipts with the spend proof's 12 public signals, re-verify a proof (and see it fail when one signal changes), read the circuit's facts from the built artifacts. Backend additions: Vault `/meta`, `/proofs`, `/circuit/verify` (admin), coordinator `/sessions`; the Vault now records every proof. Checked end to end on the local stack (seal -> negotiate -> fund via the stand-in -> close -> receipt). Not yet checked: the same against testnet with real HSP, a browser-level UI test, and the LLM-driven run from the UI.

## 2026-11-01: dUSDC on testnet, stand-in only

Redeployed on testnet 133 with our own mintable dUSDC (`0x4522…2020`), 100 minted to the buyer, gas spread to the service wallets. One full purchase ran on the stand-in, and the frontend was walked through in a browser. Fixed: the dashboard's Reveal button never showed the values. The official USDC deployment was never run or tested and is dropped.

Still to do: rotate the Gemini key; run the two live-LLM tests; try Rotate and Revoke in the browser; set `DATA_ASSETS`.
