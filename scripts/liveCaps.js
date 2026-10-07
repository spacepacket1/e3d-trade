export const LIVE_CAPS = Object.freeze({
  hot_wallet_ceiling_usd: 1000,
  max_buy_usd: 100,
  max_daily_buy_usd: 300,
  gas_reserve_usd: 50,
  max_gas_cost_per_buy_usd: 5,
  circuit_breaker_consecutive_failures: 3,
});

export function isLiveHalted(env = process.env) {
  return ["1", "true"].includes(String(env.LIVE_TRADING_HALT || "").trim().toLowerCase());
}

export function checkBuy(input, caps = LIVE_CAPS) {
  const reasons = [];
  if (input.halted) reasons.push("halted");
  if (!(input.notionalUsd > 0)) reasons.push("invalid_notional");
  if (input.notionalUsd > caps.max_buy_usd) reasons.push("cap_exceeded_per_trade");
  if (input.dailyBuyUsd + input.notionalUsd > caps.max_daily_buy_usd) reasons.push("cap_exceeded_per_day");
  if (input.walletValueUsd + input.notionalUsd > caps.hot_wallet_ceiling_usd) reasons.push("hot_wallet_ceiling");
  if (input.estimatedGasUsd > caps.max_gas_cost_per_buy_usd) reasons.push("gas_cap_exceeded");
  if (input.ethBalanceUsd - input.estimatedGasUsd < caps.gas_reserve_usd) reasons.push("gas_reserve_breached");
  return { allowed: reasons.length === 0, reasons };
}

export function checkSell(input) {
  const reasons = input.halted ? ["halted"] : [];
  return { allowed: reasons.length === 0, reasons };
}

export function shouldTripBreaker(consecutiveFailures, caps = LIVE_CAPS) {
  return consecutiveFailures >= caps.circuit_breaker_consecutive_failures;
}
