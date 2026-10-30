// Thin wrapper over near-api-js so the same code runs on a local sandbox or on testnet.
import { readFile, appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Account, FailoverRpcProvider, JsonRpcProvider, KeyPair, KeyPairSigner, nearToYocto } from "near-api-js";

export const TGAS = 1_000_000_000_000n;
export const near = (n) => BigInt(nearToYocto(String(n)));
export const toNear = (yocto) => Number(BigInt(yocto) / 10n ** 18n) / 1e6;

export class Chain {
  /**
   * @param {string} rpcUrls one URL or a comma-separated list (failover in order)
   * @param {object} [o]
   * @param {string} [o.keyLog] if set, every created account's key is appended here immediately (JSON lines)
   */
  constructor(rpcUrls, { keyLog } = {}) {
    const providers = rpcUrls.split(",").map((url) => new JsonRpcProvider({ url: url.trim() }, { retries: 6, backoff: 1.5, wait: 500 }));
    this.provider = providers.length === 1 ? providers[0] : new FailoverRpcProvider(providers);
    this.keyLog = keyLog;
  }

  account(accountId, privateKey) {
    const signer = privateKey ? KeyPairSigner.fromSecretKey(privateKey) : undefined;
    return new Account(accountId, this.provider, signer);
  }

  async view(contractId, method, args = {}) {
    return this.provider.callFunction({ contractId, method, args });
  }

  /** Create `<prefix>.<parent>` with a fresh key; returns { account, accountId, privateKey }. */
  async createSubAccount(parent, prefix, balanceNear) {
    const kp = KeyPair.fromRandom("ed25519");
    const accountId = `${prefix}.${parent.accountId}`;
    if (this.keyLog) {
      // Written before the account exists so a crash never strands funds.
      await mkdir(dirname(this.keyLog), { recursive: true });
      await appendFile(this.keyLog, JSON.stringify({ accountId, privateKey: kp.toString() }) + "\n", { mode: 0o600 });
    }
    await parent.createAccount({
      newAccountId: accountId,
      publicKey: kp.getPublicKey().toString(),
      nearToTransfer: near(balanceNear),
    });
    return { account: this.account(accountId, kp.toString()), accountId, privateKey: kp.toString() };
  }

  async deploy(account, wasmPath, initMethod = "new", initArgs = {}) {
    const code = await readFile(wasmPath);
    await account.deployContract(new Uint8Array(code));
    if (initMethod) {
      await account.callFunction({ contractId: account.accountId, methodName: initMethod, args: initArgs, gas: 30n * TGAS });
    }
  }

  async balance(accountId) {
    const state = await this.provider.viewAccount({ accountId });
    return BigInt(state.amount);
  }
}

/** Call a change method and return { value, txHash }. */
export async function call(account, contractId, methodName, args, { deposit = 0n, gas = 100n * TGAS } = {}) {
  const res = await account.callFunctionRaw({ contractId, methodName, args, deposit, gas });
  const b64 = res.status?.SuccessValue;
  const value = b64 ? JSON.parse(Buffer.from(b64, "base64").toString() || "null") : null;
  return { value, txHash: res.transaction?.hash ?? res.transaction_outcome?.id };
}
