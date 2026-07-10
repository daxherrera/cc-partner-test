# cc-partner-test — Privy/SIWS cross-auth harness

Next.js reference integration showing partners how to authenticate against CollectorCrypt and redeem NFTs. Two independent auth tracks live side by side. Not a production app — a working example.

## Stack
Next.js 14 (App Router), React 18, TypeScript 5.5, `@privy-io/react-auth`, `@solana/web3.js` + `@solana/kit`, Helius DAS.

## Two auth tracks (partners pick ONE)
- **`/` (Privy)** — `app/page.tsx`; Privy identity token; Privy setup in `app/providers.tsx`.
- **`/siws` (native SIWS)** — `app/siws/page.tsx`; native `window.solana` Sign-In-With-Solana, nonce → verify → access token.

Both call the CC backend with a **Bearer token** via a local `callCC()` helper (`app/page.tsx` / `app/siws/page.tsx`).

## Where things live
| Task | Location |
|------|----------|
| Add a page / API route | `app/<route>/page.tsx` or `app/api/<route>/route.ts` |
| Privy auth UI + identity token | `app/page.tsx`; provider config `app/providers.tsx` |
| Native SIWS flow | `app/siws/page.tsx` (window.solana nonce→verify→token) |
| Call CC backend | `callCC()` in each page (Bearer = Privy identity token or SIWS access token; base `apiUrl` per env) |
| Fetch CC NFTs (Helius DAS) | `app/helius.ts` `fetchCcAssets()`; **proxied** through `app/api/helius/route.ts` |
| Redeem: prepare → sign → submit | `signAndSubmitRedemption()` in each page (atomic burn + payment tx) |
| Env config | `.env.example` |

## Conventions / gotchas
- Browser env vars use `NEXT_PUBLIC_*` (Privy app id, CC API URL, Solana network, Helius key). **`HELIUS_API_KEY` is server-only.**
- Helius DAS **must** go through `app/api/helius/route.ts` — it allowlists `searchAssets` + `getTokenAccountsByOwner` to prevent quota drain.
- CC collections are hardcoded Metaplex + Core constants in `app/helius.ts` (`CC_COLLECTIONS`), used to filter `searchAssets`.
- Shipping address requires **full ISO-3166 country/state names**, not 2-char codes (CC checkout rendering).
- `next.config.mjs` suppresses Privy v3 peer-dep warnings and `@farcaster/mini-app-solana`.
- Layout exports `dynamic` to skip static prerender — placeholder Privy app id breaks build-time init.
- UI (`Section`/`Row`/`Button`) is inlined per page; no shared component lib, no external state (just `useState`).
