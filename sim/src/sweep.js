// Return leftover test NEAR from accounts created by testnet demo runs:
// `npm run sweep` deletes every account listed in sim/.keys/*.jsonl with the
// master account as beneficiary.
import { readdir, readFile, rename } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Chain } from "./chain.js";

const dir = resolve(dirname(fileURLToPath(import.meta.url)), "../.keys");
const master = process.env.DEADDROP_MASTER;
if (!master) throw new Error("Set DEADDROP_MASTER=<your-account>.testnet");
const chain = new Chain(process.env.NEAR_RPC ?? "https://test.rpc.fastnear.com,https://rpc.testnet.near.org");

for (const f of (await readdir(dir).catch(() => [])).filter((f) => f.endsWith(".jsonl"))) {
  const lines = (await readFile(resolve(dir, f), "utf8")).trim().split("\n").filter(Boolean);
  for (const { accountId, privateKey } of lines.map((l) => JSON.parse(l)).reverse()) {
    // Keep the contract alive: the dashboard and explorer links point at it.
    if (accountId.startsWith("deaddrop-") && !process.env.SWEEP_CONTRACT) continue;
    try {
      await chain.account(accountId, privateKey).deleteAccount(master);
      console.log(`swept ${accountId}`);
    } catch (e) {
      console.log(`skip ${accountId}: ${e.message.split("\n")[0]}`);
    }
  }
  await rename(resolve(dir, f), resolve(dir, f + ".swept"));
}
