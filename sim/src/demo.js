// `npm run demo`            → local sandbox, no keys needed
// `npm run demo -- testnet` → testnet, needs a funded account (see README)
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { Chain, toNear } from "./chain.js";
import { runScenario, saveRun } from "./scenario.js";

const here = dirname(fileURLToPath(import.meta.url));
const network = process.argv[2] ?? "sandbox";
export const TESTNET_RPC = "https://test.rpc.fastnear.com,https://rpc.testnet.near.org";

async function main() {
  let chain, master, sandbox;
  if (network === "sandbox") {
    const { Sandbox, DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY } = await import("near-sandbox");
    console.log("▶ Starting local NEAR sandbox");
    sandbox = await Sandbox.start({});
    chain = new Chain(sandbox.rpcUrl);
    master = chain.account(DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY);
  } else if (network === "testnet") {
    const id = process.env.DEADDROP_MASTER;
    if (!id) throw new Error("Set DEADDROP_MASTER=<your-account>.testnet (key read from ~/.near-credentials/testnet/)");
    const key = process.env.DEADDROP_MASTER_KEY ?? JSON.parse(await readFile(resolve(homedir(), `.near-credentials/testnet/${id}.json`), "utf8")).private_key;
    // Keys of every account this run creates are appended here as they are made, so leftover test NEAR can be swept.
    chain = new Chain(process.env.NEAR_RPC ?? TESTNET_RPC, { keyLog: resolve(here, `../.keys/testnet-${Date.now()}.jsonl`) });
    master = chain.account(id, key);
  } else throw new Error(`Unknown network ${network}`);

  try {
    const result = await runScenario({
      chain,
      master,
      network,
      deliveryTimeoutSec: network === "testnet" ? 60 : 15,
      checkinSec: network === "testnet" ? 60 : 20,
    });
    const file = resolve(here, `../../web/data/run-${network}.json`);
    await saveRun(result, file);
    const c = result.checks;
    console.log("\n=== Results (fictional people, synthetic files) ===");
    console.log(`buyers decrypted:        ${c.decrypted.filter((d) => d.ok).length}/${c.decrypted.length}`);
    console.log(`stranger blocked:        ${c.strangerBlocked}`);
    console.log(`refund after timeout:    ${toNear(c.refunded)} NEAR (early refund blocked: ${c.earlyRefundBlocked})`);
    console.log(`dead-man release → heir: ${c.heirOk} (early trigger blocked: ${c.earlyReleaseBlocked})`);
    console.log(`studio revenue:          ${toNear(c.studioRevenue)} NEAR`);
    console.log(`\nSaved ${file}`);
    console.log(`Open the dashboard: npm run web  →  http://localhost:8080/?run=${network}`);
  } finally {
    if (sandbox) await sandbox.tearDown();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
