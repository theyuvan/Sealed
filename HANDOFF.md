# Sealed: handoff (state on 2026-11-01)

Hackathon: HSK Chain Horizon, Track 2 (Agent Payments & A2A Settlement, HSP). Deadline **Nov 1, 21:30 IST**.
Repo: `theyuvan/Sealed` (private). Everything below is in `main`.

## What is finished

| Area | State |
|---|---|
| ZK spend circuit (Groth16), MandateRegistry, SessionEscrow, SpendVerifier | Done, tested (Foundry 37, circuits 12). Escrow has a new `markFundedByTransfer` |
| Vault (the user's mandate, never seen by the agent), probe limits, randomized offers | Done, tested |
| Sellers (honest x2, rogue), buyer agent (7 tools, scripted + LLM driver), buyer MCP server | Done, tested |
| Coordinator (settlement) | Done. Two HSP routes: **HSP Agentic Payment (MCP, default)** and the older signed Merchant API |
| HSP Agentic Payment client (`packages/core/src/hsp-mcp.ts`) | Done, tested against a stand-in that mimics the eight tools. **Never run against real HSP** |
| Adversary evaluator + chart | Done |
| Testnet (chain 133) deployment with our own dUSDC | Done: dev token `0x45228277b06e657bC6b047BfD5B313b2c7C32020` ("Sealed Dev USD", 6 decimals, EIP-3009, mintable by the deployer), registry `0x64cF379bB7cA5231711877cEE34D69971928Ad38`, escrow `0x4e721e056B76f40CC2d9531E58d57a774e771C17` (`contracts/deployments/133.json`). Full purchase run end to end on the HSP local stand-in, and the frontend walked through in a browser (dashboard, negotiate, receipt, proof verify and tamper, attacks). **The official USDC deployment was never run or tested and is dropped** |
| Frontend (`frontend/`, merged from `feat/frontend`) | Done and wired to the live backend: dashboard (seal/rotate/revoke), real negotiation runs, receipts with the spend proof (public signals, re-verify), attacks chart. Run: `npm run dev` then `npm run web` in `backend/` |

Tests: `cd backend && NODE_OPTIONS=--experimental-sqlite npm test` (Node 22.12 needs that flag for `node:sqlite`; Foundry is installed by `npm run tools`).

## Scope decision (2026-11-01): stand-in and dUSDC only

The demo runs on the **HSP local stand-in** with our own **dUSDC**. HSP does not settle that token, so real HSP is out of scope: the HSP IP allowlist, test USDC from HashKey, `HSP_BASE_URL` and the real-HSP purchase are no longer on the list. The MCP client for HSP Agentic Payment stays in the code, tested only against the stand-in, and was never run against real HSP. Say "HSP local stand-in" on screen everywhere (the UI already does).

Mint more dUSDC to the buyer: `cd backend && npm run fund -- --mint-dev <base units>` (6 decimals, so 1 dUSDC = 1000000). Balances: `npm run fund`.

Team name for HSP is **`Sealed`** (`HSP_MERCHANT_NAME`).

## Setting up on another machine

```bash
git clone https://github.com/theyuvan/Sealed && cd Sealed
git submodule update --init --recursive
cd backend && npm install && npm run tools      # downloads Foundry and Circom
cp .env.example .env                            # then fill the keys, see below
```

`.env` is never committed, so **private keys are not in the repo**. Either get the key values from the owner over a private channel, or generate new wallets and redeploy (`npm run deploy -- --network testnet`, needs about 0.013 HSK on the deployer). The keys: `DEPLOYER`, `COORDINATOR` (the address baked into the deployed escrow, so a different coordinator key means a redeploy), `VAULT`, `BUYER_WALLET`, `SELLER_1`, `SELLER_2`, `ROGUE`, plus `VAULT_ADMIN_TOKEN`, `VAULT_AGENT_TOKEN`, `AUDITOR_PUBLIC_KEY`, and `LLM_API_KEY` (Gemini by default) for the LLM buyer.

Without any of that, `npm run dev` runs the entire flow locally on anvil with throwaway keys and the HSP stand-in (clearly labelled, development only).

## What to do next, in order

1. `cd backend && npm start` (the stand-in is on with `HSP_LOCAL_STANDIN=1` and `PINNED_TOKEN` empty in `backend/.env`), then `cd frontend && npm run dev`. Generate the Attacks chart data once: `cd backend && npx tsx services/adversary/src/main.ts`.
2. Rotate the Gemini key that was shared in chat; the free tier allows 20 requests a day per model and one purchase uses about 13 to 15, so use a funded key for the LLM driver.
3. Run the two live-LLM tests when quota allows, and try Rotate and Revoke in the dashboard (not yet exercised in a browser).
4. Set `DATA_ASSETS` to real tokenized-asset contracts.

## Known limits (be honest about these in the submission)

- On the MCP route HSP picks the payment nonce, so the escrow cannot check which authorization paid. The coordinator alone vouches for the transfer (it checks the transaction HSP reports, that no other session used it, and the escrow balance check still applies).
- `user_authorization` on the old API route is an HS256 guess; it is unused on the MCP route.
- The trusted setup is a development one. The Vault database is not encrypted at rest. One merchant identity serves all sellers.
- The buyer MCP server was tested in memory and over stdio, not inside a real Claude Desktop.

More detail: `backend/RUNNING.md` (running, HSP wire details), `README.md` (design), `Task.md` (checklist).
