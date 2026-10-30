# Submission draft — DeadDrop

Form: https://nearhackathon.com/#apply (opens 2026-11-01 00:00 UTC, closes 2026-11-14 23:59 UTC)

| Field | Value |
|---|---|
| Project name | DeadDrop |
| Repository | https://github.com/Hothit1/deaddrop |
| Tracks | Privacy & Private AI (`privacy`), Real-World Money (`realworld`) |
| NEAR address (prize wallet) | `3df4eaf4f50df91beed095c00c1b2d8b9dfa89b92c8a4430b37aa23a55097e26` |
| Team size | 1 |
| Demo (hosted) | https://hothit1.github.io/deaddrop/ |
| X post | _paste link after posting_ |

## What did you build? (paste as is, ~1,000 characters)

DeadDrop lets anyone sell encrypted files on NEAR without trusting a platform with the file or the money. The seller encrypts a file (AES-256-GCM) and lists its hash and price. A buyer pays into escrow and registers an x25519 public key. The seller's keeper seals the content key to that public key and posts it on chain; only then does the contract pay the seller. If the key never arrives, the buyer reclaims the full price after the delivery window. A dead-man switch reuses the same machinery: if the owner stops checking in, anyone can trigger the release and the file opens for a named heir. Prices can be shown in USDC/ETH/BTC via NEAR Intents dry quotes. Everything runs with one command on a local sandbox (make test / make demo), with 12 contract tests and an end-to-end test proving buyers decrypt, strangers can't, refunds and the dead-man release work. Live run on NEAR testnet with a dashboard. Sister project: PinPay.

## X post (draft)

> Built DeadDrop at NEAR HACKATHON 🔐
> Sell encrypted files on @NEARProtocol: pay into escrow → key sealed to your public key → seller paid only on delivery. No key = refund. Plus a dead-man switch that opens a file for your heir if you go silent.
> Demo ▶️ [video]  Code: github.com/Hothit1/deaddrop

## Checklist (only you can do these)
1. Make the repo public: `gh repo edit Hothit1/deaddrop --visibility public --accept-visibility-change-consequences`
2. Enable Pages: repo Settings → Pages → Source: **GitHub Actions**, then re-run the `pages` workflow.
3. Post on X with the demo video (`docs/demo.mp4`).
4. Fill the form with the table above and the description.
