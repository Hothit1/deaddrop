// The keeper holds content keys off chain. It polls the contract for pending
// access requests (paid purchases or dead-man grants) and posts the content
// key sealed to each requester's x25519 public key. The keeper is a trusted
// component chosen by the seller; the contract protects buyers from a keeper
// that never delivers (escrow + refund), not from a keeper that leaks keys.
import { call } from "./chain.js";
import { seal } from "./crypto.js";

export class Keeper {
  constructor({ account, contractId, chain, log = () => {} }) {
    Object.assign(this, { account, contractId, chain, log });
    this.id = account.accountId;
    this.keys = new Map(); // dropId -> content key (Buffer)
    this.deliveries = [];
    this.paused = false; // demo switch: simulate an offline keeper
  }

  holdKey(dropId, key) {
    this.keys.set(String(dropId), key);
  }

  /** One polling pass; returns how many keys were delivered. */
  async poll() {
    if (this.paused) return 0;
    const pending = await this.chain.view(this.contractId, "list_pending", { keeper: this.id });
    let n = 0;
    for (const a of pending) {
      const key = this.keys.get(String(a.drop_id));
      if (!key) continue;
      const sealed = seal(key, a.pubkey);
      const { txHash } = await call(this.account, this.contractId, "deliver_key", { drop_id: a.drop_id, account: a.account, sealed_key: sealed });
      this.deliveries.push({ dropId: a.drop_id, account: a.account, paid: a.paid, txHash });
      this.log(`  keeper: sealed key for drop ${a.drop_id} → ${a.account}`);
      n++;
    }
    return n;
  }
}
