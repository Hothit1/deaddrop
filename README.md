# DeadDrop

**Sell encrypted files on NEAR, with escrowed key delivery and a dead-man switch.** A seller lists an encrypted file. A buyer pays into escrow and registers a public key; the seller's keeper seals the decryption key to that key and posts it on chain, and only then does the escrow pay the seller. If the key never comes, the buyer takes the money back. Optionally the owner names an heir: if the owner stops checking in, anyone can trigger the release and the file opens for the heir.

Built at **NEAR HACKATHON** (2026-11-01 → 2026-11-14 UTC).

- Tracks: Privacy & Private AI (`privacy`), Real-World Money (`realworld`)
- Prize wallet (NEAR mainnet implicit account): `3df4eaf4f50df91beed095c00c1b2d8b9dfa89b92c8a4430b37aa23a55097e26`
- Sister project (independent, same author, per rule Q-015): **PinPay**, https://github.com/Hothit1/pinpay
- Live dashboard (testnet run): https://hothit1.github.io/deaddrop/

> People and files in the demo are fictional. Encryption, escrow, refunds and releases are real: real AES-256-GCM / x25519 cryptography and real contract calls on a local sandbox or NEAR testnet.

## Why

Selling digital goods (prompt packs, templates, datasets, research) usually means trusting a platform with both the file and the money. DeadDrop keeps the file encrypted everywhere, keeps the money in a contract, and makes the two meet atomically: **no key, no payment; no payment, no key.** The same machinery gives you a dead-man switch: a file that opens for someone you choose if you go silent.

## How it works

```
 seller ──create_drop(hash, price, keeper, [heir, check-in])──▶ ┌────────────┐
 buyer  ──buy(drop, x25519 pubkey) + NEAR──────────────────────▶ │  DeadDrop  │  escrow
 keeper ──deliver_key(drop, buyer, sealed_key)─────────────────▶ │  contract  │ ──▶ NEAR to seller
 buyer  ──claim_refund(drop)  (only after the delivery window)─▶ │            │ ──▶ refund to buyer
 anyone ──trigger_release(drop) (owner missed check-in)───────▶ └────────────┘ ──▶ heir gets access
```

| Piece | Path | What it does |
|---|---|---|
| Contract | `contract/src/lib.rs` | Drops, escrowed purchases, key delivery, refunds after timeout, seller check-in, dead-man release. `EVENT_JSON` logs. |
| Crypto | `sim/src/crypto.js` | Files: AES-256-GCM with a random content key. Key delivery: sealed-box style (ephemeral x25519 ECDH → HKDF-SHA256 → AES-GCM). Only `node:crypto`. |
| Keeper | `sim/src/keeper.js` | Watches `list_pending`, seals the content key to each buyer's/heir's public key and calls `deliver_key`. |
| Intents | `sim/src/intents.js` | Optional "pay with anything" price estimates (USDC, ETH, BTC) from the NEAR Intents 1Click API, dry quotes only. |
| Scenario | `sim/src/scenario.js` | Full story with fictional people: two buyers, a stranger, a buyer whose keeper is offline, and an heir. |
| Dashboard | `web/index.html` | Static page: what the run proved, every drop with buyers and statuses, timeline with explorer links. |

### Contract rules (enforced on chain)
- `buy` needs the exact price; the money stays in the contract until `deliver_key`.
- Only the drop's keeper can deliver, once per buyer; delivery pays the seller.
- `claim_refund` works only for undelivered purchases and only after `delivery_timeout_sec`.
- `check_in` resets the switch; `trigger_release` works only after `checkin_interval_sec` of silence and gives the heir free access.
- The content hash (sha256 of the ciphertext) is on chain, so a buyer can verify the file they downloaded.

### Trust model (honest limits)
- The **keeper** holds content keys off chain and is trusted to deliver; the contract makes non-delivery cost the seller (refunds), but cannot force a key out. Next steps: run the keeper in a TEE with attestation, or derive keys with NEAR MPC / Chain Signatures so no single server holds them.
- Sealed keys are public on chain, but useless without the recipient's private key (tested).
- **NEAR Intents is mainnet-only.** The demo shows dry-quote price estimates for paying in other assets; the actual payment in the demo is native NEAR. A mainnet build would route the buyer's deposit through a 1Click deposit address into `buy`.

## Run it

Requirements: Rust (the pinned toolchain in `contract/rust-toolchain.toml` installs automatically via rustup), [`cargo-near`](https://github.com/near/cargo-near), Node.js ≥ 20. No keys or accounts: the local demo starts its own NEAR sandbox.

```bash
make test        # contract unit tests + build wasm + end-to-end test on a local sandbox
make demo        # full story on a local sandbox, writes web/data/run-sandbox.json
make web         # dashboard at http://localhost:8080/?run=sandbox
```

On testnet (needs a funded testnet account whose key is in `~/.near-credentials/testnet/`):

```bash
DEADDROP_MASTER=<you>.testnet make demo-testnet
DEADDROP_MASTER=<you>.testnet npm --prefix sim run sweep   # return leftover test NEAR
```

Example output (local sandbox):

```
=== Results (fictional people, synthetic files) ===
buyers decrypted:        3/3
stranger blocked:        true
refund after timeout:    0.8 NEAR (early refund blocked: true)
dead-man release → heir: true (early trigger blocked: true)
studio revenue:          1.8 NEAR
```

## Tests

- `contract/`: 12 unit tests (escrow, exact price, keeper-only delivery, double delivery, refund timing, check-in, release timing, heir access…).
- `sim/test/e2e.test.js`: deploys the real wasm to a local sandbox and checks that paying buyers decrypt the exact file, a stranger with a copied sealed key cannot, refunds only work after the window and return the full price, the seller is paid exactly for delivered purchases, and the dead-man switch is blocked after a check-in and then releases to the heir. Runs offline (`DEADDROP_OFFLINE=1` skips the Intents API).
- CI runs both on every push (`.github/workflows/ci.yml`).

## Third-party code
`near-sdk` (Rust), `near-api-js`, `near-sandbox`, NEAR Intents 1Click API (optional, read-only). Everything else uses Node's built-in `crypto`.

## License
MIT
