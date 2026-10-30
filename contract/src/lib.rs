//! DeadDrop — paid encrypted files with escrowed key delivery and a dead-man switch.
//!
//! A seller publishes a drop: the hash and location of an encrypted file, a
//! price and a keeper account that holds the content key off chain. A buyer
//! pays and registers an x25519 public key; the payment stays in escrow until
//! the keeper posts the content key sealed to that public key. If the keeper
//! does not deliver in time, the buyer takes the money back.
//!
//! Optionally the seller names a beneficiary and a check-in interval. If the
//! seller stops checking in, anyone can trigger the release and the keeper must
//! deliver the key to the beneficiary for free.

use near_sdk::json_types::{U128, U64};
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{env, near, require, AccountId, NearToken, PanicOnDefault, Promise};

pub type DropId = u64;

const MAX_TEXT: usize = 280;
const SEC: u64 = 1_000_000_000;

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Drop {
    pub id: U64,
    pub seller: AccountId,
    /// Account that holds the content key and delivers sealed copies.
    pub keeper: AccountId,
    pub title: String,
    pub description: String,
    /// yoctoNEAR per purchase.
    pub price: U128,
    /// sha256 (hex) of the ciphertext, so buyers can verify what they downloaded.
    pub content_hash: String,
    /// Where the ciphertext can be downloaded.
    pub cipher_uri: String,
    /// Seconds the keeper has to deliver before the buyer can claim a refund.
    pub delivery_timeout_sec: U64,
    pub beneficiary: Option<AccountId>,
    /// x25519 public key (base64) of the beneficiary.
    pub beneficiary_pubkey: Option<String>,
    /// Dead-man switch interval; 0 = disabled.
    pub checkin_interval_sec: U64,
    pub last_checkin_ns: U64,
    pub released: bool,
    pub sales: U64,
    pub revenue: U128,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub enum Status {
    Pending,
    Delivered,
    Refunded,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Access {
    pub drop_id: U64,
    pub account: AccountId,
    /// x25519 public key (base64) the content key must be sealed to.
    pub pubkey: String,
    /// yoctoNEAR held in escrow (0 for a dead-man release grant).
    pub paid: U128,
    pub created_ns: U64,
    pub status: Status,
    /// Content key sealed to `pubkey` (base64), set by the keeper.
    pub sealed_key: Option<String>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct DeadDrop {
    drops: IterableMap<DropId, Drop>,
    /// "<drop_id>:<account>" -> access
    access: IterableMap<String, Access>,
    pending: IterableMap<String, ()>,
    by_drop: LookupMap<DropId, Vec<AccountId>>,
    next_drop: DropId,
}

fn key(drop_id: u64, account: &AccountId) -> String {
    format!("{drop_id}:{account}")
}

fn valid_pubkey(pk: &str) -> bool {
    // base64 of 32 bytes = 44 chars ending in '='
    pk.len() == 44 && pk.ends_with('=') && pk[..43].chars().all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '/')
}

fn event(name: &str, data: String) {
    env::log_str(&format!(
        "EVENT_JSON:{{\"standard\":\"deaddrop\",\"version\":\"1.0.0\",\"event\":\"{name}\",\"data\":{data}}}"
    ));
}

#[near]
impl DeadDrop {
    #[init]
    pub fn new() -> Self {
        Self {
            drops: IterableMap::new(b"d"),
            access: IterableMap::new(b"a"),
            pending: IterableMap::new(b"q"),
            by_drop: LookupMap::new(b"b"),
            next_drop: 0,
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_drop(
        &mut self,
        title: String,
        description: String,
        price: U128,
        content_hash: String,
        cipher_uri: String,
        keeper: Option<AccountId>,
        delivery_timeout_sec: Option<U64>,
        beneficiary: Option<AccountId>,
        beneficiary_pubkey: Option<String>,
        checkin_interval_sec: Option<U64>,
    ) -> U64 {
        require!(!title.is_empty() && title.len() <= MAX_TEXT, "Bad title");
        require!(description.len() <= MAX_TEXT * 4, "Description too long");
        require!(
            content_hash.len() == 64 && content_hash.chars().all(|c| c.is_ascii_hexdigit()),
            "content_hash must be 64 hex chars"
        );
        require!(!cipher_uri.is_empty() && cipher_uri.len() <= MAX_TEXT, "Bad cipher_uri");
        let interval = checkin_interval_sec.map(|v| v.0).unwrap_or(0);
        require!(
            beneficiary.is_some() == beneficiary_pubkey.is_some() && (interval > 0) == beneficiary.is_some(),
            "Dead-man switch needs beneficiary, beneficiary_pubkey and checkin_interval_sec together"
        );
        if let Some(pk) = &beneficiary_pubkey {
            require!(valid_pubkey(pk), "beneficiary_pubkey must be a base64 x25519 key");
        }
        let seller = env::predecessor_account_id();
        let id = self.next_drop;
        self.next_drop += 1;
        let drop = Drop {
            id: U64(id),
            keeper: keeper.unwrap_or_else(|| seller.clone()),
            seller,
            title,
            description,
            price,
            content_hash,
            cipher_uri,
            delivery_timeout_sec: delivery_timeout_sec.unwrap_or(U64(3600)),
            beneficiary,
            beneficiary_pubkey,
            checkin_interval_sec: U64(interval),
            last_checkin_ns: U64(env::block_timestamp()),
            released: false,
            sales: U64(0),
            revenue: U128(0),
        };
        event("drop_created", format!("{{\"id\":{id},\"seller\":\"{}\"}}", drop.seller));
        self.drops.insert(id, drop);
        U64(id)
    }

    /// Pay the exact price into escrow and register the key to seal to.
    #[payable]
    pub fn buy(&mut self, drop_id: U64, pubkey: String) {
        let buyer = env::predecessor_account_id();
        let drop = self.drops.get(&drop_id.0).expect("No such drop").clone();
        require!(!drop.released, "Drop already released");
        require!(buyer != drop.seller, "Seller cannot buy own drop");
        require!(env::attached_deposit().as_yoctonear() == drop.price.0, "Attach exactly the price");
        require!(valid_pubkey(&pubkey), "pubkey must be a base64 x25519 key");
        let k = key(drop_id.0, &buyer);
        if let Some(a) = self.access.get(&k) {
            require!(a.status == Status::Refunded, "Already purchased");
        }
        self.add_access(drop_id.0, buyer.clone(), pubkey, drop.price);
        event("purchase", format!("{{\"drop\":{},\"buyer\":\"{buyer}\",\"paid\":\"{}\"}}", drop_id.0, drop.price.0));
    }

    /// Keeper posts the sealed content key; escrow goes to the seller.
    pub fn deliver_key(&mut self, drop_id: U64, account: AccountId, sealed_key: String) {
        let drop = self.drops.get(&drop_id.0).expect("No such drop").clone();
        require!(env::predecessor_account_id() == drop.keeper, "Only the keeper");
        require!(!sealed_key.is_empty() && sealed_key.len() <= 512, "Bad sealed_key");
        let k = key(drop_id.0, &account);
        let mut a = self.access.get(&k).cloned().expect("No access request");
        require!(a.status == Status::Pending, "Not pending");
        a.status = Status::Delivered;
        a.sealed_key = Some(sealed_key);
        let paid = a.paid.0;
        self.access.insert(k.clone(), a);
        self.pending.remove(&k);
        if paid > 0 {
            let d = self.drops.get_mut(&drop_id.0).unwrap();
            d.sales = U64(d.sales.0 + 1);
            d.revenue = U128(d.revenue.0 + paid);
            Promise::new(drop.seller).transfer(NearToken::from_yoctonear(paid));
        }
        event("key_delivered", format!("{{\"drop\":{},\"account\":\"{account}\",\"paid\":\"{paid}\"}}", drop_id.0));
    }

    /// Buyer takes the escrow back if the keeper missed the delivery deadline.
    pub fn claim_refund(&mut self, drop_id: U64) -> U128 {
        let buyer = env::predecessor_account_id();
        let drop = self.drops.get(&drop_id.0).expect("No such drop");
        let k = key(drop_id.0, &buyer);
        let mut a = self.access.get(&k).cloned().expect("No purchase");
        require!(a.status == Status::Pending && a.paid.0 > 0, "Nothing to refund");
        require!(
            env::block_timestamp() >= a.created_ns.0 + drop.delivery_timeout_sec.0 * SEC,
            "Keeper still has time to deliver"
        );
        a.status = Status::Refunded;
        let paid = a.paid.0;
        self.access.insert(k.clone(), a);
        self.pending.remove(&k);
        event("refund", format!("{{\"drop\":{},\"buyer\":\"{buyer}\",\"amount\":\"{paid}\"}}", drop_id.0));
        Promise::new(buyer).transfer(NearToken::from_yoctonear(paid));
        U128(paid)
    }

    /// Seller proves liveness, pushing the dead-man deadline forward.
    pub fn check_in(&mut self, drop_id: U64) {
        let d = self.drops.get_mut(&drop_id.0).expect("No such drop");
        require!(env::predecessor_account_id() == d.seller, "Only the seller");
        require!(!d.released, "Already released");
        d.last_checkin_ns = U64(env::block_timestamp());
    }

    /// Anyone can fire the dead-man switch once the seller has gone silent.
    pub fn trigger_release(&mut self, drop_id: U64) {
        let d = self.drops.get(&drop_id.0).expect("No such drop").clone();
        require!(d.checkin_interval_sec.0 > 0, "No dead-man switch on this drop");
        require!(!d.released, "Already released");
        require!(
            env::block_timestamp() >= d.last_checkin_ns.0 + d.checkin_interval_sec.0 * SEC,
            "Seller checked in recently"
        );
        self.drops.get_mut(&drop_id.0).unwrap().released = true;
        let beneficiary = d.beneficiary.unwrap();
        self.add_access(drop_id.0, beneficiary.clone(), d.beneficiary_pubkey.unwrap(), U128(0));
        event("released", format!("{{\"drop\":{},\"beneficiary\":\"{beneficiary}\"}}", drop_id.0));
    }

    fn add_access(&mut self, drop_id: u64, account: AccountId, pubkey: String, paid: U128) {
        let k = key(drop_id, &account);
        let first = self.access.get(&k).is_none();
        self.access.insert(
            k.clone(),
            Access {
                drop_id: U64(drop_id),
                account: account.clone(),
                pubkey,
                paid,
                created_ns: U64(env::block_timestamp()),
                status: Status::Pending,
                sealed_key: None,
            },
        );
        self.pending.insert(k, ());
        if first {
            let list = self.by_drop.entry(drop_id).or_default();
            list.push(account);
        }
    }

    // ---------- views ----------

    pub fn get_drop(&self, drop_id: U64) -> Option<Drop> {
        self.drops.get(&drop_id.0).cloned()
    }

    pub fn list_drops(&self, from_index: Option<U64>, limit: Option<U64>) -> Vec<Drop> {
        let from = from_index.map(|v| v.0).unwrap_or(0) as usize;
        let limit = limit.map(|v| v.0).unwrap_or(50) as usize;
        self.drops.values().skip(from).take(limit).cloned().collect()
    }

    pub fn get_access(&self, drop_id: U64, account: AccountId) -> Option<Access> {
        self.access.get(&key(drop_id.0, &account)).cloned()
    }

    pub fn get_drop_access(&self, drop_id: U64) -> Vec<Access> {
        self.by_drop
            .get(&drop_id.0)
            .map(|l| l.iter().filter_map(|a| self.access.get(&key(drop_id.0, a)).cloned()).collect())
            .unwrap_or_default()
    }

    /// Requests waiting for a keeper (optionally only this keeper's drops).
    pub fn list_pending(&self, keeper: Option<AccountId>) -> Vec<Access> {
        self.pending
            .keys()
            .filter_map(|k| self.access.get(k).cloned())
            .filter(|a| keeper.as_ref().is_none_or(|kp| self.drops.get(&a.drop_id.0).map(|d| &d.keeper == kp).unwrap_or(false)))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;

    const PRICE: u128 = 500_000_000_000_000_000_000_000; // 0.5 NEAR
    const HASH: &str = "ab00000000000000000000000000000000000000000000000000000000000000";
    const PK: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

    // accounts: 0 seller, 1 keeper, 2 buyer, 3 beneficiary, 4 stranger
    fn ctx(who: usize, deposit: u128, ts_sec: u64) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(accounts(who))
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .block_timestamp(ts_sec * SEC)
            .build());
    }

    fn setup(deadman: bool) -> DeadDrop {
        ctx(0, 0, 0);
        let mut c = DeadDrop::new();
        c.create_drop(
            "Prompt pack".into(),
            "50 prompts".into(),
            U128(PRICE),
            HASH.into(),
            "ipfs://x".into(),
            Some(accounts(1)),
            Some(U64(600)),
            deadman.then(|| accounts(3)),
            deadman.then(|| PK.to_string()),
            deadman.then_some(U64(1000)),
        );
        c
    }

    #[test]
    fn buy_then_deliver_pays_seller() {
        let mut c = setup(false);
        ctx(2, PRICE, 10);
        c.buy(U64(0), PK.into());
        assert_eq!(c.list_pending(Some(accounts(1))).len(), 1);
        ctx(1, 0, 20);
        c.deliver_key(U64(0), accounts(2), "sealed".into());
        let a = c.get_access(U64(0), accounts(2)).unwrap();
        assert_eq!(a.status, Status::Delivered);
        assert_eq!(a.sealed_key.as_deref(), Some("sealed"));
        let d = c.get_drop(U64(0)).unwrap();
        assert_eq!(d.sales.0, 1);
        assert_eq!(d.revenue.0, PRICE);
        assert!(c.list_pending(None).is_empty());
    }

    #[test]
    #[should_panic(expected = "Attach exactly the price")]
    fn wrong_price_rejected() {
        let mut c = setup(false);
        ctx(2, PRICE - 1, 10);
        c.buy(U64(0), PK.into());
    }

    #[test]
    #[should_panic(expected = "Already purchased")]
    fn no_double_buy() {
        let mut c = setup(false);
        ctx(2, PRICE, 10);
        c.buy(U64(0), PK.into());
        c.buy(U64(0), PK.into());
    }

    #[test]
    #[should_panic(expected = "Only the keeper")]
    fn only_keeper_delivers() {
        let mut c = setup(false);
        ctx(2, PRICE, 10);
        c.buy(U64(0), PK.into());
        ctx(4, 0, 20);
        c.deliver_key(U64(0), accounts(2), "x".into());
    }

    #[test]
    #[should_panic(expected = "Keeper still has time")]
    fn no_early_refund() {
        let mut c = setup(false);
        ctx(2, PRICE, 10);
        c.buy(U64(0), PK.into());
        ctx(2, 0, 100);
        c.claim_refund(U64(0));
    }

    #[test]
    fn refund_after_timeout_then_rebuy() {
        let mut c = setup(false);
        ctx(2, PRICE, 10);
        c.buy(U64(0), PK.into());
        ctx(2, 0, 700);
        assert_eq!(c.claim_refund(U64(0)).0, PRICE);
        assert_eq!(c.get_access(U64(0), accounts(2)).unwrap().status, Status::Refunded);
        assert!(c.list_pending(None).is_empty());
        ctx(2, PRICE, 800);
        c.buy(U64(0), PK.into());
        assert_eq!(c.get_drop_access(U64(0)).len(), 1);
    }

    #[test]
    #[should_panic(expected = "Not pending")]
    fn no_delivery_after_refund() {
        let mut c = setup(false);
        ctx(2, PRICE, 10);
        c.buy(U64(0), PK.into());
        ctx(2, 0, 700);
        c.claim_refund(U64(0));
        ctx(1, 0, 710);
        c.deliver_key(U64(0), accounts(2), "x".into());
    }

    #[test]
    #[should_panic(expected = "Seller checked in recently")]
    fn checkin_postpones_release() {
        let mut c = setup(true);
        ctx(0, 0, 900);
        c.check_in(U64(0));
        ctx(4, 0, 1500);
        c.trigger_release(U64(0));
    }

    #[test]
    fn deadman_release_grants_beneficiary() {
        let mut c = setup(true);
        ctx(4, 0, 1001);
        c.trigger_release(U64(0));
        let d = c.get_drop(U64(0)).unwrap();
        assert!(d.released);
        let a = c.get_access(U64(0), accounts(3)).unwrap();
        assert_eq!(a.status, Status::Pending);
        assert_eq!(a.paid.0, 0);
        ctx(1, 0, 1010);
        c.deliver_key(U64(0), accounts(3), "sealed".into());
        assert_eq!(c.get_drop(U64(0)).unwrap().sales.0, 0);
    }

    #[test]
    #[should_panic(expected = "Drop already released")]
    fn no_sales_after_release() {
        let mut c = setup(true);
        ctx(4, 0, 1001);
        c.trigger_release(U64(0));
        ctx(2, PRICE, 1002);
        c.buy(U64(0), PK.into());
    }

    #[test]
    #[should_panic(expected = "No dead-man switch")]
    fn no_release_without_switch() {
        let mut c = setup(false);
        ctx(4, 0, 99999);
        c.trigger_release(U64(0));
    }

    #[test]
    #[should_panic(expected = "Dead-man switch needs")]
    fn partial_switch_config_rejected() {
        ctx(0, 0, 0);
        let mut c = DeadDrop::new();
        c.create_drop("t".into(), "".into(), U128(1), HASH.into(), "u".into(), None, None, Some(accounts(3)), None, Some(U64(5)));
    }
}
