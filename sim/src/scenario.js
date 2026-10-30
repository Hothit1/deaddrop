// End-to-end DeadDrop story with fictional people and synthetic files:
//  1. A studio encrypts three files and lists them as drops (one with a dead-man switch).
//  2. Buyers pay into escrow; the keeper seals the content key to each buyer; buyers decrypt.
//  3. A stranger with the ciphertext and a sealed key that is not theirs cannot decrypt.
//  4. The keeper goes offline; a buyer waits out the delivery window and takes a refund.
//  5. The studio stops checking in; anyone fires the switch; the heir receives the key.
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { call, near } from "./chain.js";
import { encryptFile, decryptFile, newIdentity, open, sha256 } from "./crypto.js";
import { Keeper } from "./keeper.js";
import { quotePrice } from "./intents.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const WASM = resolve(ROOT, "contract/target/near/deaddrop.wasm");

const FILES = [
  {
    title: "Studio prompt pack — 40 product-photo prompts",
    description: "Lighting setups, lens notes and negative prompts for e-commerce shots.",
    price: 0.5,
    body: Array.from({ length: 40 }, (_, i) => `#${i + 1} soft window light, 85mm, seamless paper backdrop, product hero shot, variation ${i + 1}`).join("\n"),
  },
  {
    title: "Pitch deck template (12 slides, Markdown)",
    description: "Problem, solution, market, traction, team, ask — with speaker notes.",
    price: 0.8,
    body: ["Problem", "Solution", "Why now", "Market", "Product", "Traction", "Business model", "Competition", "Team", "Roadmap", "Financials", "Ask"].map((s, i) => `## ${i + 1}. ${s}\n- speaker note: keep it under 40 seconds`).join("\n\n"),
  },
  {
    title: "Field notes archive (dead-man switch)",
    description: "Released to a named heir if the author stops checking in.",
    price: 2,
    body: "Field notes, 2026. If you are reading this, the author has not checked in. The archive index follows.\n" + "entry ".repeat(200),
    deadman: true,
  },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUntilNs(chain, contractId, deadlineNs, log, why) {
  const ms = Number((BigInt(deadlineNs) - BigInt(Date.now()) * 1_000_000n) / 1_000_000n) + 3000;
  if (ms > 0) {
    log(`  …waiting ${Math.ceil(ms / 1000)}s (${why})`);
    await sleep(ms);
  }
}

/** Buyer side: download, verify hash, open sealed key, decrypt. */
async function fetchAndDecrypt(chain, contractId, drop, accountId, identity) {
  const acc = await chain.view(contractId, "get_access", { drop_id: drop.id, account: accountId });
  const ciphertext = await readFile(resolve(ROOT, "web", drop.cipher_uri));
  if (sha256(ciphertext) !== drop.content_hash) throw new Error("ciphertext hash mismatch");
  return decryptFile(ciphertext, open(acc.sealed_key, identity));
}

export async function runScenario({ chain, master, network = "sandbox", deliveryTimeoutSec = 15, checkinSec = 20, log = console.log }) {
  const tag = Date.now().toString(36);
  const events = [];
  const ev = (step, text, extra = {}) => {
    events.push({ step, text, at: new Date().toISOString(), ...extra });
    log(`  ${text}`);
  };

  log("▶ Deploying DeadDrop contract");
  const contract = await chain.createSubAccount(master, `deaddrop-${tag}`, 3);
  await chain.deploy(contract.account, WASM);
  const contractId = contract.accountId;

  const mk = (name, bal) => chain.createSubAccount(master, `${name}-${tag}`, bal);
  const studio = await mk("studio", 0.5);
  const keeperAcc = await mk("keeper", 0.5);
  const kai = await mk("kai", 2);
  const rio = await mk("rio", 2);
  const lee = await mk("lee", 1.5);
  const heir = await mk("heir", 0.3);
  const eve = await mk("eve", 0.3);
  const ids = Object.fromEntries([kai, rio, lee, heir, eve].map((a) => [a.accountId, newIdentity()]));
  const keeper = new Keeper({ account: keeperAcc.account, contractId, chain, log });
  const studioStart = await chain.balance(studio.accountId);

  log("▶ Studio encrypts files and lists drops");
  // Ciphertexts are served next to the dashboard; only testnet ones are committed.
  const filesRel = network === "testnet" ? "data/files" : `data/${network}/files`;
  await mkdir(resolve(ROOT, "web", filesRel), { recursive: true });
  const drops = [];
  for (const f of FILES) {
    const plain = Buffer.from(f.body);
    const { key, ciphertext, hash } = encryptFile(plain);
    await writeFile(resolve(ROOT, "web", filesRel, `${hash}.bin`), ciphertext);
    const { value: id, txHash } = await call(studio.account, contractId, "create_drop", {
      title: f.title,
      description: f.description,
      price: near(f.price).toString(),
      content_hash: hash,
      cipher_uri: `${filesRel}/${hash}.bin`,
      keeper: keeperAcc.accountId,
      delivery_timeout_sec: String(deliveryTimeoutSec),
      ...(f.deadman ? { beneficiary: heir.accountId, beneficiary_pubkey: ids[heir.accountId].publicKey, checkin_interval_sec: String(checkinSec) } : {}),
    });
    keeper.holdKey(id, key);
    drops.push({ id, plainHash: sha256(plain), bytes: ciphertext.length });
    ev("list", `listed drop ${id}: ${f.title} (${f.price} NEAR)`, { txHash });
  }
  const dropView = async (id) => chain.view(contractId, "get_drop", { drop_id: id });

  log("▶ Pay-with-anything prices via NEAR Intents (dry quotes, optional)");
  const intents = {};
  for (const d of drops) {
    const q = await quotePrice(BigInt((await dropView(d.id)).price));
    if (q) intents[d.id] = q;
  }
  ev("intents", Object.keys(intents).length ? `quoted ${Object.keys(intents).length} drops (${Object.values(intents)[0].source})` : "intents quotes skipped (offline)");

  log("▶ Buyers pay into escrow");
  const buy = async (who, dropId) => {
    const d = await dropView(dropId);
    const { txHash } = await call(who.account, contractId, "buy", { drop_id: dropId, pubkey: ids[who.accountId].publicKey }, { deposit: BigInt(d.price) });
    ev("buy", `${who.accountId.split("-")[0]} paid ${Number(BigInt(d.price) / 10n ** 21n) / 1000} NEAR into escrow for drop ${dropId}`, { txHash });
  };
  await buy(kai, drops[0].id);
  await buy(rio, drops[0].id);
  await buy(rio, drops[1].id);

  log("▶ Keeper delivers sealed keys; escrow releases to the studio");
  await keeper.poll();
  const decrypted = [];
  for (const [who, d] of [[kai, drops[0]], [rio, drops[0]], [rio, drops[1]]]) {
    const plain = await fetchAndDecrypt(chain, contractId, await dropView(d.id), who.accountId, ids[who.accountId]);
    const ok = sha256(plain) === d.plainHash;
    decrypted.push({ account: who.accountId, dropId: d.id, ok });
    ev("decrypt", `${who.accountId.split("-")[0]} decrypted drop ${d.id}: ${ok ? "OK" : "FAILED"} (${plain.length} bytes)`);
  }

  log("▶ A stranger copies kai's sealed key and the ciphertext");
  let strangerBlocked = false;
  try {
    await fetchAndDecrypt(chain, contractId, await dropView(drops[0].id), kai.accountId, ids[eve.accountId]);
  } catch {
    strangerBlocked = true;
  }
  ev("stranger", `eve could not decrypt with kai's sealed key: ${strangerBlocked ? "blocked" : "LEAKED"}`);

  log("▶ Keeper goes offline; lee buys and waits out the delivery window");
  keeper.paused = true;
  const leeBefore = await chain.balance(lee.accountId);
  await buy(lee, drops[1].id);
  const leeAccess = await chain.view(contractId, "get_access", { drop_id: drops[1].id, account: lee.accountId });
  let earlyRefundBlocked = false;
  try {
    await call(lee.account, contractId, "claim_refund", { drop_id: drops[1].id });
  } catch {
    earlyRefundBlocked = true;
  }
  ev("refund", `early refund attempt rejected: ${earlyRefundBlocked}`);
  await waitUntilNs(chain, contractId, BigInt(leeAccess.created_ns) + BigInt(deliveryTimeoutSec) * 1_000_000_000n, log, "delivery window");
  const { value: refunded, txHash: refundTx } = await call(lee.account, contractId, "claim_refund", { drop_id: drops[1].id });
  const leeAfter = await chain.balance(lee.accountId);
  ev("refund", `lee refunded ${Number(BigInt(refunded) / 10n ** 21n) / 1000} NEAR from escrow`, { txHash: refundTx });
  keeper.paused = false;

  log("▶ Dead-man switch");
  const dm = drops[2];
  await call(studio.account, contractId, "check_in", { drop_id: dm.id });
  let earlyReleaseBlocked = false;
  try {
    await call(eve.account, contractId, "trigger_release", { drop_id: dm.id });
  } catch {
    earlyReleaseBlocked = true;
  }
  ev("deadman", `studio checked in; early trigger rejected: ${earlyReleaseBlocked}`);
  const dmv = await dropView(dm.id);
  await waitUntilNs(chain, contractId, BigInt(dmv.last_checkin_ns) + BigInt(checkinSec) * 1_000_000_000n, log, "studio goes silent");
  const { txHash: releaseTx } = await call(eve.account, contractId, "trigger_release", { drop_id: dm.id });
  ev("deadman", `studio missed its check-in; eve (anyone) triggered the release`, { txHash: releaseTx });
  await keeper.poll();
  const heirPlain = await fetchAndDecrypt(chain, contractId, await dropView(dm.id), heir.accountId, ids[heir.accountId]);
  const heirOk = sha256(heirPlain) === dm.plainHash;
  ev("deadman", `heir decrypted the archive: ${heirOk ? "OK" : "FAILED"}`);

  const finalDrops = [];
  for (const d of drops) finalDrops.push({ ...(await dropView(d.id)), access: await chain.view(contractId, "get_drop_access", { drop_id: d.id }), bytes: d.bytes, intents: intents[d.id] ?? null });
  const studioDelta = (await chain.balance(studio.accountId)) - studioStart;

  return {
    network,
    generatedAt: new Date().toISOString(),
    synthetic: true,
    contractId,
    keeper: keeperAcc.accountId,
    studio: studio.accountId,
    people: { kai: kai.accountId, rio: rio.accountId, lee: lee.accountId, heir: heir.accountId, eve: eve.accountId },
    drops: finalDrops.map((d) => ({ ...d, access: d.access.map(({ sealed_key, ...rest }) => ({ ...rest, sealed: Boolean(sealed_key) })) })),
    checks: {
      decrypted,
      strangerBlocked,
      earlyRefundBlocked,
      refunded,
      leeNetCost: (leeBefore - leeAfter).toString(),
      earlyReleaseBlocked,
      heirOk,
      studioRevenue: finalDrops.reduce((s, d) => s + BigInt(d.revenue), 0n).toString(),
      studioDelta: studioDelta.toString(),
    },
    deliveries: keeper.deliveries,
    events,
  };
}

export async function saveRun(result, file) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(result, null, 2));
}
