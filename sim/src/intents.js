// Optional: show what a drop costs in other assets via NEAR Intents (1Click API).
// NEAR Intents is mainnet-only, so DeadDrop only asks for *dry* quotes here
// (no deposit address, nothing is executed). Core payment stays native NEAR.
// If the quote endpoint fails, fall back to the indicative prices published by
// the same API's token list. Everything here is best-effort and never required.

const API = process.env.ONECLICK_API ?? "https://1click.chaindefuser.com/v0";
const WNEAR = "nep141:wrap.near";
const PAY_WITH = [
  { symbol: "USDC", chain: "eth" },
  { symbol: "ETH", chain: "eth" },
  { symbol: "BTC", chain: "btc" },
];

async function getJson(url, init) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

/**
 * @param {bigint} priceYocto price in yoctoNEAR
 * @returns {Promise<{source: string, quotes: {symbol: string, chain: string, amount: string}[]} | null>}
 */
export async function quotePrice(priceYocto) {
  if (process.env.DEADDROP_OFFLINE) return null;
  let tokens;
  try {
    tokens = await getJson(`${API}/tokens`);
  } catch {
    return null;
  }
  const wnear = tokens.find((t) => t.assetId === WNEAR);
  const nearAmount = Number(priceYocto) / 1e24;
  const out = [];
  let source = "1click-dry-quote";
  for (const want of PAY_WITH) {
    const t = tokens.find((x) => x.symbol === want.symbol && x.blockchain === want.chain);
    if (!t) continue;
    let amount;
    try {
      const q = await getJson(`${API}/quote`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(process.env.ONECLICK_JWT ? { authorization: `Bearer ${process.env.ONECLICK_JWT}` } : {}) },
        body: JSON.stringify({
          dry: true,
          swapType: "EXACT_OUTPUT",
          slippageTolerance: 100,
          originAsset: t.assetId,
          depositType: "ORIGIN_CHAIN",
          destinationAsset: WNEAR,
          amount: priceYocto.toString(),
          refundTo: "0x0000000000000000000000000000000000000000",
          refundType: "ORIGIN_CHAIN",
          recipient: "deaddrop.near",
          recipientType: "DESTINATION_CHAIN",
          deadline: new Date(Date.now() + 3600_000).toISOString(),
        }),
      });
      amount = q.quote.amountInFormatted;
    } catch {
      source = "1click-token-prices";
      amount = ((nearAmount * wnear.price) / t.price).toPrecision(4);
    }
    out.push({ symbol: want.symbol, chain: want.chain, amount: String(amount) });
  }
  return { source, quotes: out };
}
