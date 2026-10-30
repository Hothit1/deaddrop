// End-to-end test on a local sandbox: deploys the real wasm, runs the whole
// story and checks privacy and money invariants.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Sandbox, DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY } from "near-sandbox";
import { Chain } from "../src/chain.js";
import { runScenario } from "../src/scenario.js";
import { encryptFile, decryptFile, newIdentity, seal, open } from "../src/crypto.js";

let sandbox, run;

before(async () => {
  process.env.DEADDROP_OFFLINE = "1"; // tests never depend on the Intents API
  sandbox = await Sandbox.start({});
  const chain = new Chain(sandbox.rpcUrl);
  run = await runScenario({ chain, master: chain.account(DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY), deliveryTimeoutSec: 8, checkinSec: 10, log: () => {} });
});

after(async () => {
  await sandbox?.tearDown();
});

test("crypto: sealed key opens only for its recipient", () => {
  const { key, ciphertext } = encryptFile(Buffer.from("secret"));
  const alice = newIdentity();
  const bob = newIdentity();
  const sealed = seal(key, alice.publicKey);
  assert.equal(decryptFile(ciphertext, open(sealed, alice)).toString(), "secret");
  assert.throws(() => open(sealed, bob));
});

test("every paying buyer decrypted the exact file", () => {
  assert.equal(run.checks.decrypted.length, 3);
  for (const d of run.checks.decrypted) assert.ok(d.ok, `${d.account} drop ${d.dropId}`);
});

test("a stranger with someone else's sealed key cannot decrypt", () => {
  assert.equal(run.checks.strangerBlocked, true);
});

test("escrow: refund only after the delivery window, for the full price", () => {
  assert.equal(run.checks.earlyRefundBlocked, true);
  const pitch = run.drops[1];
  assert.equal(run.checks.refunded, pitch.price);
  const lee = pitch.access.find((a) => a.account === run.people.lee);
  assert.equal(lee.status, "Refunded");
  // lee only paid gas
  assert.ok(BigInt(run.checks.leeNetCost) < 10n ** 22n, "lee net cost should be gas only");
});

test("seller is paid exactly for delivered purchases", () => {
  const expected = run.drops.reduce(
    (s, d) => s + d.access.filter((a) => a.status === "Delivered").reduce((t, a) => t + BigInt(a.paid), 0n),
    0n,
  );
  assert.equal(BigInt(run.checks.studioRevenue), expected);
  assert.equal(expected, BigInt(run.drops[0].price) * 2n + BigInt(run.drops[1].price));
  assert.ok(BigInt(run.checks.studioDelta) > expected - 10n ** 22n);
});

test("dead-man switch: blocked after check-in, then releases to the heir", () => {
  assert.equal(run.checks.earlyReleaseBlocked, true);
  const archive = run.drops[2];
  assert.equal(archive.released, true);
  const heir = archive.access.find((a) => a.account === run.people.heir);
  assert.equal(heir.status, "Delivered");
  assert.equal(heir.paid, "0");
  assert.equal(run.checks.heirOk, true);
});
