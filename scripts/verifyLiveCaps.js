import assert from "assert";
import { LIVE_CAPS, checkBuy, checkSell, isLiveHalted, shouldTripBreaker } from "./liveCaps.js";

const ok = {
  halted: false,
  notionalUsd: 50,
  dailyBuyUsd: 0,
  walletValueUsd: 200,
  estimatedGasUsd: 3,
  ethBalanceUsd: 200,
};

assert.deepEqual(checkBuy(ok), { allowed: true, reasons: [] }, "within-cap buy should pass");
assert(checkBuy({ ...ok, notionalUsd: 101 }).reasons.includes("cap_exceeded_per_trade"), "per-trade cap");
assert(checkBuy({ ...ok, dailyBuyUsd: 260, notionalUsd: 50 }).reasons.includes("cap_exceeded_per_day"), "daily cap");
assert(checkBuy({ ...ok, walletValueUsd: 980, notionalUsd: 50 }).reasons.includes("hot_wallet_ceiling"), "wallet ceiling");
assert(checkBuy({ ...ok, estimatedGasUsd: 5.01 }).reasons.includes("gas_cap_exceeded"), "gas cap");
assert(checkBuy({ ...ok, ethBalanceUsd: 52, estimatedGasUsd: 3 }).reasons.includes("gas_reserve_breached"), "gas reserve");
assert(checkBuy({ ...ok, halted: true }).reasons.includes("halted"), "halt blocks buys");
assert(checkBuy({ ...ok, notionalUsd: 0 }).reasons.includes("invalid_notional"), "zero notional rejected");

const multi = checkBuy({ ...ok, notionalUsd: 101, estimatedGasUsd: 6, halted: true });
assert.deepEqual(multi.reasons.sort(), ["cap_exceeded_per_trade", "gas_cap_exceeded", "halted"], "all failing reasons reported");

assert.deepEqual(checkSell({ halted: false }), { allowed: true, reasons: [] }, "sells pass when not halted");
assert.deepEqual(checkSell({ halted: true }).reasons, ["halted"], "halt blocks sells too");

assert.equal(isLiveHalted({ LIVE_TRADING_HALT: "1" }), true, "halt env 1");
assert.equal(isLiveHalted({ LIVE_TRADING_HALT: "true" }), true, "halt env true");
assert.equal(isLiveHalted({}), false, "unset halt is off");
assert.equal(isLiveHalted({ LIVE_TRADING_HALT: "0" }), false, "halt env 0 is off");

assert.equal(shouldTripBreaker(LIVE_CAPS.circuit_breaker_consecutive_failures - 1), false, "below breaker limit");
assert.equal(shouldTripBreaker(LIVE_CAPS.circuit_breaker_consecutive_failures), true, "breaker trips at limit");

console.log("PASS: live caps");
