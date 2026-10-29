# Sealed frontend

Next.js (App Router) + Tailwind v4. Styled after the Coinbase design system (white and `#0052ff` blue, near-black cards, 16px/32px radii, pill buttons).

All data is **simulated** and lives in `lib/mock.ts`. To go live, replace the imports from `lib/mock` with calls to the Vault (7001), buyer agent (7002) and coordinator (7201); see `backend/services/*/src/server.ts`.

```
npm install
npm run dev     # http://localhost:3000
npm run build
```

Routes: `/` landing, `/dashboard` mandate and sessions, `/negotiate` simulated run, `/attacks` rogue-seller attacks and inference chart, `/receipts/[id]`.

Fonts: Coinbase fonts are proprietary, so DM Sans is used as a stand-in (`app/layout.tsx`).
