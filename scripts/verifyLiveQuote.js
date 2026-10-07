import assert from "assert";
import { normalizeZeroxQuote, fetchZeroxQuote } from "./liveQuote.js";

const fixture = {
  buyAmount: "26934939",
  minBuyAmount: "26665590",
  liquidityAvailable: true,
  allowanceTarget: "0x0000000000001ff3684f28c67538d4d072c22734",
  issues: {
    allowance: { actual: "0", spender: "0x0000000000001ff3684f28c67538d4d072c22734" },
    balance: { token: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", actual: "0", expected: "10000000000000000" },
  },
  transaction: { to: "0x666fedd4cdd4e890a5ad20e7b60975409435a64a", data: "0x2213bc0b", value: "0", gas: "284694", gasPrice: "412194594" },
  totalNetworkFee: "117349327744236",
  fees: { zeroExFee: { amount: "40463", token: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", type: "volume" } },
};

const q = normalizeZeroxQuote(fixture);
assert.equal(q.buy_amount_wei, "26934939");
assert.equal(q.min_buy_amount_wei, "26665590");
assert.equal(q.liquidity_available, true);
assert.equal(q.needs_approval, true, "zero allowance must flag an approval step");
assert.equal(q.approval_target, "0x0000000000001ff3684f28c67538d4d072c22734");
assert.equal(q.balance_short, true, "unfunded wallet must be flagged");
assert.equal(q.transaction.to, "0x666fedd4cdd4e890a5ad20e7b60975409435a64a");
assert.equal(q.transaction.gas, "284694");
assert.equal(q.zerox_fee.type, "volume");

const noIssues = normalizeZeroxQuote({ ...fixture, issues: {} });
assert.equal(noIssues.needs_approval, false, "no allowance issue means no approval step");
assert.equal(noIssues.balance_short, false);

assert.throws(() => normalizeZeroxQuote({ code: 100, message: "bad request" }), /0x quote failed/);
assert.throws(() => normalizeZeroxQuote(null), /0x quote failed/);

const calls = [];
const fakeFetch = async (url, opts) => {
  calls.push({ url, headers: opts.headers });
  return { ok: true, status: 200, json: async () => fixture };
};
const live = await fetchZeroxQuote({
  sellToken: "0xc02a", buyToken: "0xa0b8", sellAmountWei: 10n ** 16n, taker: "0xabc", apiKey: "test-key", fetchImpl: fakeFetch,
});
assert.equal(live.buy_amount_wei, "26934939");
assert(calls[0].url.startsWith("https://api.0x.org/swap/allowance-holder/quote?"), "endpoint");
assert(calls[0].url.includes("sellAmount=10000000000000000"), "sell amount in wei");
assert.equal(calls[0].headers["0x-api-key"], "test-key");
assert.equal(calls[0].headers["0x-version"], "v2");

await assert.rejects(
  fetchZeroxQuote({ sellToken: "0xc02a", buyToken: "0xa0b8", sellAmountWei: 1n, taker: "0xabc", apiKey: "", fetchImpl: fakeFetch }),
  /ZEROX_API_KEY is not set/
);

console.log("PASS: live quote");
