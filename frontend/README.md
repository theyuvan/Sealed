# Sealed frontend

Next.js (App Router) + Tailwind v4, styled after the Coinbase design system. It is the **owner's** UI for the Sealed backend, wired to the live services. Nothing on the app pages is simulated.

```
cd backend && npm run dev      # local stack: anvil, contracts, Vault, sellers, coordinator, buyer agent
cd frontend && npm install && npm run dev     # http://localhost:3000   (or: cd backend && npm run web)
```

Against the testnet stack instead (`backend/.env` filled in): `cd backend && npm start`, then the same `npm run dev` here. No frontend env file is needed: the route handlers read `backend/.env` (or `backend/.env.local` written by `npm run dev`) for the ports and the Vault admin token. Override anything with real environment variables (`VAULT_URL`, `BUYER_AGENT_URL`, `COORDINATOR_URL`, `SELLER_URLS`, `VAULT_ADMIN_TOKEN`).

## How it connects

The browser calls only this app's `/api/*` route handlers (`app/api`). They run on the server, hold the Vault **admin** token, and call the services (`lib/backend.ts` is `server-only`). The token never reaches the browser. Because the UI can seal and revoke the mandate, run it on localhost or behind authentication.

| Page | Backend |
|---|---|
| `/dashboard` | Vault `/mandate/*` (seal, rotate, revoke, masked status), `/meta` and `/proofs`; coordinator `/sessions`; sellers' agent cards |
| `/negotiate` | buyer agent `POST /run` (scripted driver) and `GET /runs/:id`, polled; the page renders the real tool transcript |
| `/receipts`, `/receipts/[id]` | coordinator `/sessions`, `/receipts/:id`; Vault `/proofs`, `/circuit/verify` |
| `/attacks` | `backend/data/adversary-report.json` (written by `npm run adversary`); attack descriptions are static |
| `/` | marketing page, illustrative numbers from `lib/mock.ts` |

The mandate values (remaining budget, per-deal cap) are masked by default and fetched only when the owner presses *Reveal*.

## The circuit in the UI

- The dashboard reads the built circuit (proof system, public signals, variables and constraint domain from the proving key's header, tree depths, key sizes) from the Vault, not from constants.
- Every accepted deal makes a Groth16 proof; the Vault verifies it locally, records it, and the chain verifies it again in `SessionEscrow.open`. The receipt page shows the 12 public signals by name, lets you re-verify the proof against the verification key, and shows that the same proof fails if one public signal (the amount) is changed.

Fonts: Coinbase fonts are proprietary, so DM Sans is used as a stand-in (`app/layout.tsx`).
