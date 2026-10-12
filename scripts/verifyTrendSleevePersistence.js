import assert from "node:assert/strict";

const { advanceTrendSleevePersistence, SETTINGS_DEFAULTS } = await import("../pipeline.js");

assert.equal(SETTINGS_DEFAULTS.trend_sleeve_persistence_cycles, 3);

// Flat book, regime flips on: needs 3 consecutive risk_on cycles to enter.
let stats = {};
let step = advanceTrendSleevePersistence(stats, "risk_on", 3, false);
assert.deepEqual([step.confirmed, step.streak, step.changed], ["off", 1, false]);
stats = { trend_sleeve_persistence: { confirmed: step.confirmed, streak: step.streak } };
step = advanceTrendSleevePersistence(stats, "risk_on", 3, false);
assert.deepEqual([step.confirmed, step.streak, step.changed], ["off", 2, false]);
stats = { trend_sleeve_persistence: { confirmed: step.confirmed, streak: step.streak } };
step = advanceTrendSleevePersistence(stats, "risk_on", 3, false);
assert.deepEqual([step.confirmed, step.streak, step.changed], ["on", 0, true]);

// A one-cycle blip back to neutral resets the streak and does not exit.
stats = { trend_sleeve_persistence: { confirmed: "on", streak: 0 } };
step = advanceTrendSleevePersistence(stats, "neutral", 3, true);
assert.deepEqual([step.confirmed, step.streak, step.changed], ["on", 1, false]);
stats = { trend_sleeve_persistence: { confirmed: step.confirmed, streak: step.streak } };
step = advanceTrendSleevePersistence(stats, "risk_on", 3, true);
assert.deepEqual([step.confirmed, step.streak, step.changed], ["on", 0, false]);

// Three consecutive non-risk_on cycles exit.
stats = { trend_sleeve_persistence: { confirmed: "on", streak: 2 } };
step = advanceTrendSleevePersistence(stats, "risk_off", 3, true);
assert.deepEqual([step.confirmed, step.streak, step.changed], ["off", 0, true]);

// Missing state seeds from whether a sleeve position is already held.
assert.equal(advanceTrendSleevePersistence({}, "risk_on", 3, true).confirmed, "on");
assert.equal(advanceTrendSleevePersistence({}, "neutral", 3, false).confirmed, "off");

// persistenceCycles = 1 reproduces the old immediate behavior; invalid values clamp to it.
assert.equal(advanceTrendSleevePersistence({}, "risk_on", 1, false).confirmed, "on");
assert.equal(advanceTrendSleevePersistence({}, "risk_on", 0, false).confirmed, "on");

console.log("verifyTrendSleevePersistence: ok");
