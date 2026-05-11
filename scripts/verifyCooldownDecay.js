import assert from "assert/strict";
import {
  SETTINGS_DEFAULTS,
  normalizePortfolioCooldowns,
  resolveCooldownHoursForExitReason,
  setCooldown
} from "../pipeline.js";

function approxHoursUntil(iso) {
  return (Date.parse(iso) - Date.now()) / (60 * 60 * 1000);
}

const defaultHours = SETTINGS_DEFAULTS.cooldown_hours_after_exit;

assert.equal(resolveCooldownHoursForExitReason("stop_loss", defaultHours), defaultHours);
assert.equal(resolveCooldownHoursForExitReason("fraud_risk_breach", defaultHours), defaultHours);
assert.equal(resolveCooldownHoursForExitReason("target_hit", defaultHours), defaultHours / 4);
assert.equal(resolveCooldownHoursForExitReason("target_1", defaultHours), defaultHours / 4);
assert.equal(resolveCooldownHoursForExitReason("rotation_out:better_opportunity", defaultHours), defaultHours / 4);
assert.equal(resolveCooldownHoursForExitReason("thesis_decay", defaultHours), defaultHours / 2);
assert.equal(resolveCooldownHoursForExitReason("unknown_reason", defaultHours), defaultHours / 2);

const portfolio = {
  settings: {
    cooldown_hours_after_exit: defaultHours
  },
  cooldowns: {}
};

setCooldown(portfolio, "ASTEROID", "target_hit");
assert.deepEqual(Object.keys(portfolio.cooldowns), ["ASTEROID"]);
assert.equal(portfolio.cooldowns.ASTEROID.reason, "target_hit");
assert(approxHoursUntil(portfolio.cooldowns.ASTEROID.until) > 2.9);
assert(approxHoursUntil(portfolio.cooldowns.ASTEROID.until) < 3.1);

setCooldown(portfolio, "LDO", "fraud_risk_breach");
assert.equal(portfolio.cooldowns.LDO.reason, "fraud_risk_breach");
assert(approxHoursUntil(portfolio.cooldowns.LDO.until) > 11.9);
assert(approxHoursUntil(portfolio.cooldowns.LDO.until) < 12.1);

const upgraded = normalizePortfolioCooldowns({
  LEGACY: "2026-05-01T12:00:00.000Z",
  MODERN: { until: "2026-05-01T15:00:00.000Z", reason: "target_hit" }
});

assert.deepEqual(upgraded, {
  LEGACY: { until: "2026-05-01T12:00:00.000Z", reason: "legacy" },
  MODERN: { until: "2026-05-01T15:00:00.000Z", reason: "target_hit" }
});

console.log("verifyCooldownDecay: ok");
