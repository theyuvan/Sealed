# Sealed: handoff (state on 2026-10-30)

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
| Testnet (chain 133) deployment with official USDC | Done: escrow `0xA6b35F222f6efbA4441c298858Dc68f5e7B53bef`, token `0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6` (`contracts/deployments/133.json`) |
| Frontend (`frontend/`, merged from `feat/frontend`) | Done and wired to the live backend: dashboard (seal/rotate/revoke), real negotiation runs, receipts with the spend proof (public signals, re-verify), attacks chart. Run: `npm run dev` then `npm run web` in `backend/` |

Tests: `cd backend && NODE_OPTIONS=--experimental-sqlite npm test` (Node 22.12 needs that flag for `node:sqlite`; Foundry is installed by `npm run tools`).

## What blocks the real run (only HashKey can unblock)

1. **IP allowlist.** `https://mcp-qa.hashkeymerchant.com/` is blocked (Cloudflare page) until HSP allowlists the machine's public egress IP. Run `npm run hsp:check` on the machine that will run the coordinator and buyer; it prints that IP. Send it to HSP. **Only that machine's network works**; another laptop or Wi-Fi needs its own IP added.
2. **Test USDC** (`0x8FE3...53c6`) in the buyer wallet `0x9F6F7aF9Ff3008773b777509609EB761e4e5cb5F` (about 100 is plenty: deal cap 10, total budget 50). It holds 0 now.
3. Answers to: is `gas_fee_advanced` true (no fee on top)? does the gateway relay a plain `transferWithAuthorization` to a contract `pay_to`?
4. HSK for gas (faucet `hskchain.net/faucet`, unverified link): Vault wallet is lowest (0.0028 HSK).

Team name for HSP is **`Sealed`** (`HSP_MERCHANT_NAME`), spelled identically at `create_order` and `query_payment`.

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

1. Send HSP the egress IP and the token/answers request above (draft in the chat history; ask them to allowlist several IPs if you may switch networks).
2. When confirmed: `npm run hsp:check` must show no failures (tool list with the real argument names, token vs `get_chain_config`).
3. `npm run fund` (balances), top up gas if needed, then `npm start` and `npm run e2e` for one real purchase. Expect to fix small things: the shapes of `get_chain_config`, `get_order` and `query_payment` results are parsed tolerantly but were never seen.
4. Rotate the Gemini key that was shared in chat; the free tier allows 20 requests a day per model and one purchase uses about 13 to 15, so use a funded key for the demo.
5. Run the two live-LLM tests when quota allows.
6. Run the frontend against the testnet stack (`npm start`, `npm run web`), set `DATA_ASSETS` to real tokenized-asset contracts, record the demo (README section 13).
7. Rehearse the recording with `npm run demo` (terminal) and the frontend (`npm run web`).
8. If HSP never allowlists in time: demo on the local stand-in and say so on screen; the submission is weaker without real HSP.

## Known limits (be honest about these in the submission)

- On the MCP route HSP picks the payment nonce, so the escrow cannot check which authorization paid. The coordinator alone vouches for the transfer (it checks the transaction HSP reports, that no other session used it, and the escrow balance check still applies).
- `user_authorization` on the old API route is an HS256 guess; it is unused on the MCP route.
- The trusted setup is a development one. The Vault database is not encrypted at rest. One merchant identity serves all sellers.
- The buyer MCP server was tested in memory and over stdio, not inside a real Claude Desktop.

More detail: `backend/RUNNING.md` (running, HSP wire details), `README.md` (design), `Task.md` (checklist).
