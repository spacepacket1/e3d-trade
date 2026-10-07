const ZEROX_QUOTE_URL = "https://api.0x.org/swap/allowance-holder/quote";

export function normalizeZeroxQuote(raw) {
  if (!raw || (raw.code && !raw.transaction)) {
    throw new Error(`0x quote failed: ${raw?.code ?? ""} ${raw?.message ?? "no response body"}`.trim());
  }
  const tx = raw.transaction || {};
  const allowance = raw.issues?.allowance || null;
  return {
    buy_amount_wei: String(raw.buyAmount ?? "0"),
    min_buy_amount_wei: String(raw.minBuyAmount ?? "0"),
    liquidity_available: raw.liquidityAvailable === true,
    needs_approval: Boolean(allowance),
    approval_target: raw.allowanceTarget ?? allowance?.spender ?? null,
    balance_short: Boolean(raw.issues?.balance),
    transaction: { to: tx.to ?? null, data: tx.data ?? null, value: String(tx.value ?? "0"), gas: String(tx.gas ?? "0"), gas_price: String(tx.gasPrice ?? "0") },
    network_fee_wei: String(raw.totalNetworkFee ?? "0"),
    zerox_fee: raw.fees?.zeroExFee ? { amount: String(raw.fees.zeroExFee.amount), token: raw.fees.zeroExFee.token, type: raw.fees.zeroExFee.type } : null,
  };
}

export async function fetchZeroxQuote({ sellToken, buyToken, sellAmountWei, taker, chainId = 1, apiKey, fetchImpl = fetch }) {
  if (!apiKey) throw new Error("ZEROX_API_KEY is not set");
  const params = new URLSearchParams({ chainId: String(chainId), sellToken, buyToken, sellAmount: String(sellAmountWei), taker });
  const res = await fetchImpl(`${ZEROX_QUOTE_URL}?${params}`, { headers: { "0x-api-key": apiKey, "0x-version": "v2" } });
  const body = await res.json().catch(() => null);
  if (!res.ok && !body) throw new Error(`0x quote HTTP ${res.status}`);
  return normalizeZeroxQuote(body);
}
