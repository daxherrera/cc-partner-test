# CC Partner Test

Reference Next.js app showing how a partner integrates their
Privy-authenticated users with the CollectorCrypt API.

## What this demonstrates

A partner app authenticates its own users with its own Privy app, then sends
the resulting **Privy identity token** as a `Bearer` header to CollectorCrypt.
CC verifies the token against the partner app's public JWKS, finds (or
creates) a CC user row keyed on the wallet from the token's
`linked_accounts`, and authorizes the user against CC's user-self API.

No app secrets are exchanged. No cross-app linking is required for API auth.

## Auth flow at a glance

```
[Partner user]
    │ logs in with partner Privy (email / Google / wallet)
    ▼
[Partner frontend]
    │ getIdentityToken()  →  signed JWT with linked_accounts
    │ Authorization: Bearer <identityToken>
    ▼
[CC backend]
    │ verify signature via https://auth.privy.io/api/v1/apps/{partnerAppId}/jwks.json
    │ check `aud` is registered in CC's PartnerApp table
    │ extract Solana wallet + email from `linked_accounts`
    │ findOrCreateByPrivy(privyDid, wallet, email, partnerAppId)
    ▼
[CC user row]  ←─ stamps originPartnerAppId on first sight
```

## Setup

```bash
npm install
cp .env.example .env.local
# edit .env.local — set NEXT_PUBLIC_PARTNER_PRIVY_APP_ID + NEXT_PUBLIC_CC_API_URL
npm run dev
```

Open `http://localhost:3000` (or your tunnel URL).

### Required Privy dashboard settings on the partner app

1. **Settings → Authentication → Return user data in an identity token**
   must be **on**. Without it, the identity token doesn't carry
   `linked_accounts`, and CC can't read the wallet.
2. **Settings → Domains → Allowed Origins** — add the URL the user reaches
   the partner app at (e.g. `http://localhost:3000`,
   `https://your-app.com`). Without this, the Privy SDK refuses to
   initialize.

### Env vars

- `NEXT_PUBLIC_PARTNER_PRIVY_APP_ID` — your Privy app ID. CC must register
  this in its `PartnerApp` table before your tokens are accepted.
- `NEXT_PUBLIC_CC_API_URL` — CC backend URL. Typically
  `https://staging-api.collectorcrypt.com` for integration testing, or the
  prod URL when you're live.

## Deploying

Privy's SDK refuses Public-Suffix-List domains for cookie reasons (so
`*.ngrok-free.dev`, `*.vercel.app` etc. won't work). Use a domain you
control, or a reserved ngrok domain like `yourname.ngrok.app`.

1. Deploy (Vercel, your platform of choice, or any Node host).
2. Set `NEXT_PUBLIC_PARTNER_PRIVY_APP_ID` and `NEXT_PUBLIC_CC_API_URL` env
   vars.
3. Add the deploy URL to your Privy app's **Allowed Origins**.
4. Coordinate with CollectorCrypt to add the deploy URL to CC's CORS
   allowlist (this happens alongside your `PartnerApp` registration; CC's
   `PartnerApp` table has an `allowedOrigins` field that's consulted at
   request time).

## What the page does

- **Section 1 — Partner Privy session**: DID, email, and Solana wallet
  sourced from your Privy app.
- **Section 2 — Identity token**: raw token + decoded claims. Useful to
  inspect what's being sent to CC.
- **Section 3 — Connect to CollectorCrypt**: `GET /users/info` with the
  identity token as Bearer. On 200, CC has registered (or found) the user.
- **Section 4 — User-self API**: example calls partner-originated users can
  make — profile, cards, shipping addresses, outbound shipments, plus
  example mutations (update bio, add a shipping address). Admin / shipper /
  vault routes are deliberately blocked for partner users by CC's backend.

## Onboarding with CollectorCrypt

Send CC the following:

1. Your Privy app ID (`NEXT_PUBLIC_PARTNER_PRIVY_APP_ID`)
2. The origins your users will hit CC from (e.g.
   `https://app.your-domain.com`) — used for CORS
3. A short name for the integration (shown in CC admin tooling)

CC creates a `PartnerApp` row from that. As soon as it's `enabled: true`,
your identity tokens verify and your origins pass CORS — no CC code deploy
required.
