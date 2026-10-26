# Sealed backend — task list

- [x] Repo layout: `circuits/`, `contracts/`, `backend/` (all Node code, deps and config); run commands from `backend/` — see `backend/RUNNING.md`
- [x] Toolchain: Foundry 1.8.6 + Circom 2.2.3 in `backend/.tools/bin` (`npm run tools`)
- [x] `backend/packages/core` — Poseidon, note format, Merkle mirror, EIP-712, quotes, HSP wire/crypto/client, chain config, ECIES, offer policy — tests passing
- [x] `circuits/` — spend.circom (~19k constraints), setup script (PSE ppot phase 1 + hackathon phase 2), verifier export, 12 tests (`circuits/test`, prover in `backend/packages/prover`)
- [x] `contracts/` — MandateRegistry, SessionEscrow, SpendVerifier, Poseidon libs, Deploy.s.sol, 52 tests (unit, fuzz, real-proof, invariants)
- [x] `backend/services/vault` — 15 tests against anvil with real proofs
- [x] `backend/services/coordinator` (+ HSP local stand-in) — 8 tests (webhooks, polling, chain checks, receipts)
- [x] `backend/services/sellers` (honest-1, honest-2, rogue) — 8 tests
- [x] `backend/services/buyer-agent` — Claude tool loop + scripted driver, 5 tests (+1 live LLM, skipped without key)
- [x] `backend/services/adversary` — 5 tests; baseline 0.0% vs Sealed 9.2% inference error (algorithm-aware adversary)
- [x] `backend/scripts/` dev, deploy, fund, e2e, install-tools, auditor-decrypt; e2e tests: happy path + 6 rogue attacks (all fail)
- [ ] Fill TODO(HSP-DOCS) items from the HSP manual (see backend/RUNNING.md)
- [ ] Testnet deploy + real HSP run; mainnet deploy (needs approval)
