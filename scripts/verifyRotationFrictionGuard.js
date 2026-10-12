import assert from "node:assert/strict";
import fs from "node:fs";

const trackedWriteMethods = [
  "appendFileSync",
  "writeFileSync",
  "mkdirSync",
  "copyFileSync",
  "renameSync",
  "rmSync",
  "unlinkSync",
  "truncateSync"
];
// The simulated risk check reads the live training-events log for the
// day-start equity baseline; hide it so fixtures stay hermetic.
const originalStatSync = fs.statSync;
fs.statSync = (target, ...rest) => {
  if (String(target).endsWith("training-events.jsonl")) {
    throw Object.assign(new Error("ENOENT (hidden by verifyRotationFrictionGuard)"), { code: "ENOENT" });
  }
  return originalStatSync(target, ...rest);
};
const originalWriteMethods = new Map();
const writeCalls = [];

for (const method of trackedWriteMethods) {
  originalWriteMethods.set(method, fs[method]);
  fs[method] = (...args) => {
    writeCalls.push({ method, args });
    return undefined;
  };
}

const {
  SETTINGS_DEFAULTS,
  buildPaperFillExecution,
  executeRotation,
  evaluateRotationActions,
  evaluateRotationBuyFeasibility,
  evaluateRotationGuard,
  evaluateSellActions,
  resolveRotationAllocationUsd
} = await import("../pipeline.js");

const importWriteCount = writeCalls.length;

function approxEqual(actual, expected, tolerance = 1e-9) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${actual} to be within ${tolerance} of ${expected}`
  );
}

function buildPortfolio(overrides = {}) {
  return {
    cash_usd: overrides.cash_usd ?? 5000,
    positions: structuredClone(overrides.positions ?? {}),
    closed_trades: structuredClone(overrides.closed_trades ?? []),
    action_history: structuredClone(overrides.action_history ?? []),
    cooldowns: structuredClone(overrides.cooldowns ?? {}),
    stats: structuredClone(overrides.stats ?? {}),
    settings: {
      ...SETTINGS_DEFAULTS,
      min_trade_usd: 50,
      category_cap_pct: 0.95,
      max_position_pct: 0.2,
      risk_per_trade_pct: 0.1,
      risk_engine: {
        max_position_size_pct: 1,
        max_token_exposure_pct: 1,
        max_category_exposure_pct: 1,
        max_strategy_exposure_pct: 1,
        max_open_positions: 999,
        max_daily_turnover_usd: 1_000_000_000,
        daily_realized_loss_limit_usd: 1_000_000_000,
        rolling_24h_loss_limit_usd: 1_000_000_000,
        strategy_loss_cluster_count: 999,
        strategy_loss_cluster_loss_limit_usd: 1_000_000_000,
        cooldown_after_stop_loss_hours: 0,
        token_repeated_loss_stop_count: 999,
        token_repeated_loss_cooldown_days: 0,
        market_risk_off_blocks_new_buys: false
      },
      ...(overrides.settings || {})
    }
  };
}

function buildCandidate(overrides = {}) {
  const symbol = overrides.symbol ?? "ASTRO";
  const address = overrides.address ?? `0x${symbol.toLowerCase()}`;
  const price = overrides.price ?? 1;
  return {
    token: {
      symbol,
      name: overrides.name ?? `${symbol} Token`,
      chain: "ethereum",
      contract_address: address,
      category: overrides.category ?? "infra"
    },
    market_data: {
      current_price: price,
      volume_24h_usd: overrides.volume_24h_usd ?? 300000,
      market_cap_usd: overrides.market_cap_usd ?? 12000000,
      price_timestamp: overrides.price_timestamp ?? "2026-10-01T16:00:00.000Z"
    },
    liquidity_data: {
      liquidity_usd: overrides.liquidity_usd ?? 800000,
      liquidity_timestamp: overrides.liquidity_timestamp ?? "2026-10-01T16:00:00.000Z"
    },
    execution_data: {
      estimated_slippage_bps: overrides.estimated_slippage_bps ?? 15,
      quote_timestamp: overrides.quote_timestamp ?? "2026-10-01T16:00:00.000Z"
    },
    setup_type: overrides.setup_type ?? null,
    source: overrides.source ?? "scout",
    conviction_score: overrides.conviction_score ?? 70,
    liquidity_quality: overrides.liquidity_quality ?? undefined,
    fraud_risk: overrides.fraud_risk ?? undefined,
    _score: overrides._score ?? 120,
    _risk: overrides._risk ?? { approved_size_pct: overrides.approved_size_pct ?? 10 }
  };
}

function buildHeldPosition(symbol, address, overrides = {}) {
  const quantity = overrides.quantity ?? 200;
  const currentPrice = overrides.current_price ?? 1;
  return {
    symbol,
    contract_address: address,
    category: overrides.category ?? "infra",
    sleeve: overrides.sleeve ?? "thesis",
    quantity,
    avg_entry_price: overrides.avg_entry_price ?? currentPrice,
    cost_basis_usd: overrides.cost_basis_usd ?? quantity * currentPrice,
    current_price: currentPrice,
    market_value_usd: overrides.market_value_usd ?? quantity * currentPrice,
    conviction_score: overrides.conviction_score ?? 70,
    liquidity_quality: overrides.liquidity_quality ?? 80,
    fraud_risk: overrides.fraud_risk ?? 15,
    setup_type: overrides.setup_type ?? "thesis",
    source: overrides.source ?? "scout",
    pnl_pct: overrides.pnl_pct ?? 0,
    liquidity_usd: overrides.liquidity_usd ?? 800000,
    opened_at: overrides.opened_at ?? "2026-10-01T16:00:00.000Z",
    last_market_snapshot: structuredClone(overrides.last_market_snapshot ?? {
      liquidity_data: { liquidity_usd: overrides.liquidity_usd ?? 800000 },
      execution_data: { estimated_slippage_bps: overrides.estimated_slippage_bps ?? 15 }
    })
  };
}

function buildRotationAction(overrides = {}) {
  return {
    from_symbol: overrides.from_symbol ?? "OLD",
    to_candidate: overrides.to_candidate ?? buildCandidate(),
    sell_fraction: overrides.sell_fraction ?? 1,
    reason: overrides.reason ?? "better_opportunity",
    position_sizing: overrides.position_sizing ?? null
  };
}

function hoursAgoIso(nowMs, hoursAgo) {
  return new Date(nowMs - (hoursAgo * 60 * 60 * 1000)).toISOString();
}

function assertNoAdditionalWrites() {
  assert.equal(
    writeCalls.length,
    importWriteCount,
    "rotation allocation helper should not write to the filesystem"
  );
}

try {
  const equityBasedPortfolio = buildPortfolio({
    cash_usd: 6000,
    stats: { equity_usd: 10000 },
    settings: { max_position_pct: 0.5, risk_per_trade_pct: 0.25 }
  });
  const equityBasedCandidate = buildCandidate({ approved_size_pct: 10 });
  const equityAllocation = resolveRotationAllocationUsd(
    equityBasedPortfolio,
    equityBasedCandidate,
    4000
  );
  approxEqual(equityAllocation, 1000);
  assertNoAdditionalWrites();

  const maxPositionPortfolio = buildPortfolio({
    cash_usd: 10000,
    stats: { equity_usd: 10000 },
    settings: { max_position_pct: 0.2, risk_per_trade_pct: 0.5 }
  });
  const maxPositionAllocation = resolveRotationAllocationUsd(
    maxPositionPortfolio,
    buildCandidate({ approved_size_pct: 50 }),
    5000
  );
  approxEqual(maxPositionAllocation, 2000);
  assertNoAdditionalWrites();

  const proceedsCappedPortfolio = buildPortfolio({
    cash_usd: 10000,
    stats: { equity_usd: 10000 },
    settings: { max_position_pct: 0.5, risk_per_trade_pct: 0.5 }
  });
  const proceedsAllocation = resolveRotationAllocationUsd(
    proceedsCappedPortfolio,
    buildCandidate({ approved_size_pct: 50 }),
    1200
  );
  approxEqual(proceedsAllocation, 1200);
  assertNoAdditionalWrites();

  const categoryHeadroomPortfolio = buildPortfolio({
    cash_usd: 10000,
    positions: {
      CORE: buildHeldPosition("CORE", "0xcore", {
        category: "infra",
        quantity: 3500,
        current_price: 1,
        market_value_usd: 3500,
        cost_basis_usd: 3500
      })
    },
    stats: { equity_usd: 10000 },
    settings: { category_cap_pct: 0.4, max_position_pct: 0.5, risk_per_trade_pct: 0.5 }
  });
  const categoryAllocation = resolveRotationAllocationUsd(
    categoryHeadroomPortfolio,
    buildCandidate({ category: "infra", approved_size_pct: 50 }),
    6000
  );
  approxEqual(categoryAllocation, 500);
  assertNoAdditionalWrites();

  const feeFitPortfolio = buildPortfolio({
    cash_usd: 1000,
    stats: { equity_usd: 10000 },
    settings: { max_position_pct: 0.5, risk_per_trade_pct: 0.5, fee_bps_per_side: 30 }
  });
  const feeFitCandidate = buildCandidate({ approved_size_pct: 50 });
  const feeFitAllocation = resolveRotationAllocationUsd(
    feeFitPortfolio,
    feeFitCandidate,
    5000
  );
  assert.ok(feeFitAllocation < feeFitPortfolio.cash_usd, "buy notional should be reduced below cash when fees apply");
  const feeFitExecution = buildPaperFillExecution({
    side: "buy",
    price: feeFitCandidate.market_data.current_price,
    quoted_price: feeFitCandidate.market_data.current_price,
    cost_usd: feeFitAllocation,
    liquidity_usd: feeFitCandidate.liquidity_data.liquidity_usd,
    execution_data: feeFitCandidate.execution_data,
    settings: feeFitPortfolio.settings
  });
  const feeFitDebit = feeFitExecution.filled_notional_usd + feeFitExecution.fee_usd;
  assert.ok(feeFitDebit <= feeFitPortfolio.cash_usd + 1e-9, "paper buy debit must fit post-sell cash");
  assert.ok(feeFitDebit > feeFitPortfolio.cash_usd - 1, "cash-fit reduction should stay tight");
  assertNoAdditionalWrites();

  const sizingCapPortfolio = buildPortfolio({
    cash_usd: 10000,
    stats: { equity_usd: 10000 },
    settings: { max_position_pct: 0.5, risk_per_trade_pct: 0.5 }
  });
  const sizingCapAllocation = resolveRotationAllocationUsd(
    sizingCapPortfolio,
    buildCandidate({ approved_size_pct: 50 }),
    8000,
    null,
    { max_allocation_usd: 750 }
  );
  approxEqual(sizingCapAllocation, 750);
  assertNoAdditionalWrites();

  const categoryBlockedPortfolio = buildPortfolio({
    cash_usd: 600,
    positions: {
      OLD: buildHeldPosition("OLD", "0xold", {
        category: "infra",
        quantity: 100,
        current_price: 1,
        market_value_usd: 100,
        cost_basis_usd: 100
      }),
      CORE: buildHeldPosition("CORE", "0xcore", {
        category: "infra",
        quantity: 300,
        current_price: 1,
        market_value_usd: 300,
        cost_basis_usd: 300
      })
    },
    settings: { category_cap_pct: 0.34, max_position_pct: 0.5, risk_per_trade_pct: 0.5 }
  });
  const categoryBlocked = evaluateRotationBuyFeasibility(
    categoryBlockedPortfolio,
    buildRotationAction({
      from_symbol: "OLD",
      sell_fraction: 0.5,
      to_candidate: buildCandidate({ category: "infra", approved_size_pct: 50 })
    })
  );
  assert.equal(categoryBlocked.feasible, false);
  assert(categoryBlocked.reason_codes.includes("category_exposure_cap_reached"));
  assertNoAdditionalWrites();

  const belowMinTradePortfolio = buildPortfolio({
    cash_usd: 0,
    positions: {
      OLD: buildHeldPosition("OLD", "0xold", {
        category: "infra",
        quantity: 40,
        current_price: 1,
        market_value_usd: 40,
        cost_basis_usd: 40
      })
    },
    settings: { min_trade_usd: 50, max_position_pct: 0.5, risk_per_trade_pct: 0.5 }
  });
  const belowMinTrade = evaluateRotationBuyFeasibility(
    belowMinTradePortfolio,
    buildRotationAction({
      from_symbol: "OLD",
      sell_fraction: 1,
      to_candidate: buildCandidate({ category: "defi", approved_size_pct: 50 })
    })
  );
  assert.equal(belowMinTrade.feasible, false);
  assert.deepEqual(belowMinTrade.reason_codes, ["below_min_trade_usd"]);
  assert(belowMinTrade.allocation_usd > 0 && belowMinTrade.allocation_usd < belowMinTradePortfolio.settings.min_trade_usd);
  assertNoAdditionalWrites();

  const invalidPricePortfolio = buildPortfolio({
    cash_usd: 0,
    positions: {
      OLD: buildHeldPosition("OLD", "0xold", {
        quantity: 200,
        current_price: 1,
        market_value_usd: 200,
        cost_basis_usd: 200
      })
    }
  });
  const invalidPrice = evaluateRotationBuyFeasibility(
    invalidPricePortfolio,
    buildRotationAction({
      from_symbol: "OLD",
      sell_fraction: 1,
      to_candidate: buildCandidate({ price: 0 })
    })
  );
  assert.equal(invalidPrice.feasible, false);
  assert.deepEqual(invalidPrice.reason_codes, ["missing_or_invalid_price"]);
  assert.equal(invalidPrice.allocation_usd, 0);
  assertNoAdditionalWrites();

  const slotBlockedPortfolio = buildPortfolio({
    cash_usd: 0,
    positions: {
      OLD: buildHeldPosition("OLD", "0xold", {
        category: "infra",
        quantity: 200,
        current_price: 1,
        market_value_usd: 200,
        cost_basis_usd: 200
      }),
      HOLD: buildHeldPosition("HOLD", "0xhold", {
        category: "defi",
        quantity: 200,
        current_price: 1,
        market_value_usd: 200,
        cost_basis_usd: 200
      })
    },
    settings: { max_open_positions: 2, max_position_pct: 0.5, risk_per_trade_pct: 0.5 }
  });
  const slotBlocked = evaluateRotationBuyFeasibility(
    slotBlockedPortfolio,
    buildRotationAction({
      from_symbol: "OLD",
      sell_fraction: 0.5,
      to_candidate: buildCandidate({ symbol: "NEW", address: "0xnew", category: "gaming", approved_size_pct: 50 })
    })
  );
  assert.equal(slotBlocked.feasible, false);
  assert(slotBlocked.reason_codes.includes("position_slot_unavailable"));
  assertNoAdditionalWrites();

  const fullCloseRotation = evaluateRotationBuyFeasibility(
    slotBlockedPortfolio,
    buildRotationAction({
      from_symbol: "OLD",
      sell_fraction: 1,
      to_candidate: buildCandidate({ symbol: "NEW", address: "0xnew", category: "gaming", approved_size_pct: 50 })
    })
  );
  assert.equal(fullCloseRotation.feasible, true);
  assert(!fullCloseRotation.reason_codes.includes("position_slot_unavailable"));
  assert(fullCloseRotation.allocation_usd >= slotBlockedPortfolio.settings.min_trade_usd);
  assertNoAdditionalWrites();

  const thesisCapPortfolio = buildPortfolio({
    cash_usd: 0,
    positions: {
      OLD: buildHeldPosition("OLD", "0xold", {
        category: "infra",
        sleeve: "thesis",
        quantity: 200,
        current_price: 1,
        market_value_usd: 200,
        cost_basis_usd: 200
      }),
      HOLD: buildHeldPosition("HOLD", "0xhold", {
        category: "defi",
        sleeve: "thesis",
        quantity: 200,
        current_price: 1,
        market_value_usd: 200,
        cost_basis_usd: 200
      }),
      TREND: buildHeldPosition("TREND", "0xtrend", {
        category: "macro",
        sleeve: "trend_overlay",
        quantity: 100,
        current_price: 1,
        market_value_usd: 100,
        cost_basis_usd: 100
      }),
      CASH: buildHeldPosition("CASH", "0xcash", {
        category: "cash",
        sleeve: "cash_equivalent",
        quantity: 100,
        current_price: 1,
        market_value_usd: 100,
        cost_basis_usd: 100
      })
    },
    settings: { max_thesis_positions: 2, max_open_positions: 5, max_position_pct: 0.5, risk_per_trade_pct: 0.5 }
  });
  const thesisCapBlocked = evaluateRotationBuyFeasibility(
    thesisCapPortfolio,
    buildRotationAction({
      from_symbol: "OLD",
      sell_fraction: 0.5,
      to_candidate: buildCandidate({ symbol: "NEXT", address: "0xnext", category: "gaming", approved_size_pct: 50 })
    })
  );
  assert.equal(thesisCapBlocked.feasible, false);
  assert(thesisCapBlocked.reason_codes.includes("thesis_cap_reached"));
  assert(!thesisCapBlocked.reason_codes.includes("position_slot_unavailable"));
  assertNoAdditionalWrites();

  const thesisCapFreed = evaluateRotationBuyFeasibility(
    thesisCapPortfolio,
    buildRotationAction({
      from_symbol: "OLD",
      sell_fraction: 1,
      to_candidate: buildCandidate({ symbol: "NEXT", address: "0xnext", category: "gaming", approved_size_pct: 50 })
    })
  );
  assert.equal(thesisCapFreed.feasible, true);
  assert(!thesisCapFreed.reason_codes.includes("thesis_cap_reached"));
  assertNoAdditionalWrites();

  const evaluationMs = Date.parse("2026-10-11T12:34:56.000Z");
  const rollingLossPortfolio = buildPortfolio({
    cash_usd: 0,
    positions: {
      OLD: buildHeldPosition("OLD", "0xold", {
        quantity: 100,
        current_price: 1,
        avg_entry_price: 1.5,
        market_value_usd: 100,
        cost_basis_usd: 150
      })
    },
    closed_trades: [{
      ts: "2026-10-11T11:45:00.000Z",
      side: "sell",
      symbol: "LEGACY",
      pnl_usd: -60,
      proceeds_usd: 60,
      gross_proceeds_usd: 60
    }],
    settings: {
      max_position_pct: 0.5,
      risk_per_trade_pct: 0.5,
      risk_engine: {
        max_position_size_pct: 1,
        max_token_exposure_pct: 1,
        max_category_exposure_pct: 1,
        max_strategy_exposure_pct: 1,
        max_open_positions: 999,
        max_daily_turnover_usd: 1_000_000_000,
        daily_realized_loss_limit_usd: 1_000_000_000,
        rolling_24h_loss_limit_usd: 100,
        strategy_loss_cluster_count: 999,
        cooldown_after_stop_loss_hours: 0,
        token_repeated_loss_stop_count: 999,
        market_risk_off_blocks_new_buys: false
      }
    }
  });
  const rollingLossBlocked = evaluateRotationBuyFeasibility(
    rollingLossPortfolio,
    buildRotationAction({
      from_symbol: "OLD",
      sell_fraction: 1,
      to_candidate: buildCandidate({ symbol: "SAFE", address: "0xsafe", category: "ai", approved_size_pct: 50 })
    }),
    null,
    null,
    evaluationMs
  );
  assert.equal(rollingLossBlocked.feasible, false);
  assert(rollingLossBlocked.reason_codes.includes("risk_decision_block"));
  assertNoAdditionalWrites();

  const turnoverBlockedPortfolio = buildPortfolio({
    cash_usd: 0,
    positions: {
      OLD: buildHeldPosition("OLD", "0xold", {
        quantity: 200,
        current_price: 1,
        market_value_usd: 200,
        cost_basis_usd: 200
      })
    },
    action_history: [{
      ts: "2026-10-11T09:00:00.000Z",
      side: "buy",
      symbol: "SEED",
      cost_usd: 50
    }],
    settings: {
      max_position_pct: 0.5,
      risk_per_trade_pct: 0.5,
      risk_engine: {
        max_position_size_pct: 1,
        max_token_exposure_pct: 1,
        max_category_exposure_pct: 1,
        max_strategy_exposure_pct: 1,
        max_open_positions: 999,
        max_daily_turnover_usd: 300,
        daily_realized_loss_limit_usd: 1_000_000_000,
        rolling_24h_loss_limit_usd: 1_000_000_000,
        strategy_loss_cluster_count: 999,
        cooldown_after_stop_loss_hours: 0,
        token_repeated_loss_stop_count: 999,
        market_risk_off_blocks_new_buys: false
      }
    }
  });
  const turnoverBlocked = evaluateRotationBuyFeasibility(
    turnoverBlockedPortfolio,
    buildRotationAction({
      from_symbol: "OLD",
      sell_fraction: 1,
      to_candidate: buildCandidate({ symbol: "FAST", address: "0xfast", category: "ai", approved_size_pct: 50 })
    }),
    null,
    null,
    evaluationMs
  );
  assert.equal(turnoverBlocked.feasible, false);
  assert(turnoverBlocked.reason_codes.includes("risk_decision_block"));
  assertNoAdditionalWrites();

  const identityConflictPortfolio = buildPortfolio({
    cash_usd: 0,
    positions: {
      OLD: buildHeldPosition("OLD", "0xold", {
        quantity: 200,
        current_price: 1,
        market_value_usd: 200,
        cost_basis_usd: 200
      }),
      HOLD: buildHeldPosition("HOLD", "0xhold", {
        quantity: 150,
        current_price: 1,
        market_value_usd: 150,
        cost_basis_usd: 150
      })
    }
  });
  const identityConflict = evaluateRotationBuyFeasibility(
    identityConflictPortfolio,
    buildRotationAction({
      from_symbol: "OLD",
      sell_fraction: 1,
      to_candidate: buildCandidate({ symbol: "HOLD", address: "0xhold", category: "infra", approved_size_pct: 50 })
    })
  );
  assert.equal(identityConflict.feasible, false);
  assert(identityConflict.reason_codes.includes("candidate_identity_conflict"));
  assertNoAdditionalWrites();

  const missingSellLeg = evaluateRotationBuyFeasibility(
    identityConflictPortfolio,
    buildRotationAction({
      from_symbol: "MISSING",
      sell_fraction: 1,
      to_candidate: buildCandidate({ symbol: "HOLD", address: "0xhold", category: "infra", approved_size_pct: 50 })
    })
  );
  assert.equal(missingSellLeg.feasible, false);
  assert(missingSellLeg.reason_codes.includes("sell_leg_unavailable"));
  assert(missingSellLeg.reason_codes.includes("candidate_identity_conflict"));
  assert(missingSellLeg.reason_codes.length > 0);
  assertNoAdditionalWrites();

  const immutablePortfolio = buildPortfolio({
    cash_usd: 100,
    positions: {
      OLD: buildHeldPosition("OLD", "0xold", {
        quantity: 200,
        current_price: 1,
        market_value_usd: 200,
        cost_basis_usd: 200
      })
    },
    settings: { max_position_pct: 0.5, risk_per_trade_pct: 0.5 }
  });
  const immutableSnapshot = structuredClone(immutablePortfolio);
  const immutableResult = evaluateRotationBuyFeasibility(
    immutablePortfolio,
    buildRotationAction({
      from_symbol: "OLD",
      sell_fraction: 1,
      to_candidate: buildCandidate({ symbol: "FRESH", address: "0xfresh", category: "ai", approved_size_pct: 50 })
    }),
    null,
    null,
    Date.parse("2026-10-11T12:34:56.000Z")
  );
  assert.equal(immutableResult.feasible, true);
  assert.deepEqual(immutablePortfolio, immutableSnapshot);
  assertNoAdditionalWrites();

  const blockedExecutionPortfolio = buildPortfolio({
    cash_usd: 0,
    positions: {
      OLD: buildHeldPosition("OLD", "0xold", {
        quantity: 200,
        current_price: 1,
        market_value_usd: 200,
        cost_basis_usd: 200
      })
    },
    settings: { max_position_pct: 0.5, risk_per_trade_pct: 0.5 }
  });
  const blockedExecutionSnapshot = structuredClone(blockedExecutionPortfolio);
  const blockedExecution = await executeRotation(
    blockedExecutionPortfolio,
    buildRotationAction({
      from_symbol: "OLD",
      sell_fraction: 1,
      to_candidate: buildCandidate({ symbol: "SMALL", address: "0xsmall", category: "ai", approved_size_pct: 50 }),
      position_sizing: { max_allocation_usd: 25 }
    }),
    { approved_size_pct: 50 }
  );
  assert.equal(blockedExecution, null);
  assert.deepEqual(blockedExecutionPortfolio, blockedExecutionSnapshot);
  assertNoAdditionalWrites();

  const guardNowMs = Date.parse("2026-10-12T00:00:00.000Z");
  const guardBuyFeasible = { feasible: true, reason_codes: [], allocation_usd: 500 };

  const minHoldBlocked = evaluateRotationGuard(
    buildHeldPosition("OLD", "0xold", { opened_at: hoursAgoIso(guardNowMs, 2) }),
    buildCandidate(),
    30,
    { ...SETTINGS_DEFAULTS, rotation_friction_guard_mode: "enforce" },
    guardNowMs,
    guardBuyFeasible
  );
  assert.equal(minHoldBlocked.mode, "enforce");
  assert.equal(minHoldBlocked.allow, false);
  assert.equal(minHoldBlocked.would_block, true);
  assert.deepEqual(minHoldBlocked.reason_codes, ["minimum_hold_not_met"]);
  assert.deepEqual(minHoldBlocked.diagnostic_reason_codes, []);
  approxEqual(minHoldBlocked.held_hours, 2);

  const frictionBlocked = evaluateRotationGuard(
    buildHeldPosition("OLD", "0xold", { opened_at: hoursAgoIso(guardNowMs, 60) }),
    buildCandidate(),
    18,
    { ...SETTINGS_DEFAULTS, rotation_friction_guard_mode: "enforce" },
    guardNowMs,
    guardBuyFeasible
  );
  assert.equal(frictionBlocked.allow, false);
  assert.equal(frictionBlocked.would_block, true);
  assert.deepEqual(frictionBlocked.reason_codes, ["friction_hurdle_not_cleared"]);
  assert.equal(frictionBlocked.age_hysteresis_bps, 12.5);
  assert.equal(frictionBlocked.required_edge_bps, 187.5);
  assert.equal(frictionBlocked.modeled_edge_bps, 180);

  const hurdleCleared = evaluateRotationGuard(
    buildHeldPosition("OLD", "0xold", { opened_at: hoursAgoIso(guardNowMs, 72) }),
    buildCandidate(),
    20,
    { ...SETTINGS_DEFAULTS, rotation_friction_guard_mode: "enforce" },
    guardNowMs,
    guardBuyFeasible
  );
  assert.equal(hurdleCleared.allow, true);
  assert.equal(hurdleCleared.would_block, false);
  assert.deepEqual(hurdleCleared.reason_codes, []);
  assert.equal(hurdleCleared.required_edge_bps, 190);

  const youngerIncumbent = evaluateRotationGuard(
    buildHeldPosition("OLD", "0xold", { opened_at: hoursAgoIso(guardNowMs, 36) }),
    buildCandidate(),
    50,
    { ...SETTINGS_DEFAULTS, rotation_friction_guard_mode: "enforce" },
    guardNowMs,
    guardBuyFeasible
  );
  const olderIncumbent = evaluateRotationGuard(
    buildHeldPosition("OLD", "0xold", { opened_at: hoursAgoIso(guardNowMs, 60) }),
    buildCandidate(),
    50,
    { ...SETTINGS_DEFAULTS, rotation_friction_guard_mode: "enforce" },
    guardNowMs,
    guardBuyFeasible
  );
  assert.equal(youngerIncumbent.age_hysteresis_bps, 7.5);
  assert.equal(olderIncumbent.age_hysteresis_bps, 12.5);
  assert.ok(olderIncumbent.required_edge_bps > youngerIncumbent.required_edge_bps);

  const cappedHysteresis = evaluateRotationGuard(
    buildHeldPosition("OLD", "0xold", { opened_at: hoursAgoIso(guardNowMs, 24 * 40) }),
    buildCandidate(),
    50,
    { ...SETTINGS_DEFAULTS, rotation_friction_guard_mode: "enforce" },
    guardNowMs,
    guardBuyFeasible
  );
  assert.equal(cappedHysteresis.age_hysteresis_bps, 50);
  assert.equal(cappedHysteresis.required_edge_bps, 225);

  const equalityPasses = evaluateRotationGuard(
    buildHeldPosition("OLD", "0xold", { opened_at: "not-a-date" }),
    buildCandidate(),
    17.49999996,
    { ...SETTINGS_DEFAULTS, rotation_friction_guard_mode: "enforce" },
    guardNowMs,
    guardBuyFeasible
  );
  assert.equal(equalityPasses.held_hours, null);
  assert.equal(equalityPasses.modeled_edge_bps, 175);
  assert.equal(equalityPasses.required_edge_bps, 175);
  assert.equal(equalityPasses.allow, true);
  assert.deepEqual(equalityPasses.reason_codes, []);
  assert.deepEqual(equalityPasses.diagnostic_reason_codes, ["opened_at_unavailable"]);

  const missingOpenedAt = evaluateRotationGuard(
    buildHeldPosition("OLD", "0xold", { opened_at: "" }),
    buildCandidate(),
    30,
    { ...SETTINGS_DEFAULTS, rotation_friction_guard_mode: "enforce" },
    guardNowMs,
    guardBuyFeasible
  );
  assert.equal(missingOpenedAt.held_hours, null);
  assert.deepEqual(missingOpenedAt.reason_codes, []);
  assert.deepEqual(missingOpenedAt.diagnostic_reason_codes, ["opened_at_unavailable"]);

  const unknownAgeFrictionBlocked = evaluateRotationGuard(
    buildHeldPosition("OLD", "0xold", { opened_at: "still-bad" }),
    buildCandidate(),
    17.49999994,
    { ...SETTINGS_DEFAULTS, rotation_friction_guard_mode: "enforce" },
    guardNowMs,
    guardBuyFeasible
  );
  assert.equal(unknownAgeFrictionBlocked.allow, false);
  assert.equal(unknownAgeFrictionBlocked.would_block, true);
  assert.deepEqual(unknownAgeFrictionBlocked.reason_codes, ["friction_hurdle_not_cleared"]);
  assert.deepEqual(unknownAgeFrictionBlocked.diagnostic_reason_codes, ["opened_at_unavailable"]);
  assert.equal(unknownAgeFrictionBlocked.age_hysteresis_bps, 0);
  assert.equal(unknownAgeFrictionBlocked.required_edge_bps, 175);
  assert.equal(unknownAgeFrictionBlocked.modeled_edge_bps, 174.999999);

  const normalizedMode = evaluateRotationGuard(
    buildHeldPosition("OLD", "0xold", { opened_at: hoursAgoIso(guardNowMs, 2) }),
    buildCandidate(),
    18,
    {
      rotation_friction_guard_mode: "not-real",
      rotation_min_hold_hours: -5,
      rotation_round_trip_cost_bps: -1,
      rotation_margin_bps: -1,
      rotation_score_edge_bps_per_point: -1,
      rotation_hysteresis_bps_per_day: -1,
      rotation_hysteresis_max_bps: -1
    },
    guardNowMs,
    guardBuyFeasible
  );
  assert.equal(normalizedMode.mode, "enforce");
  assert.equal(normalizedMode.allow, false);
  assert.equal(normalizedMode.would_block, true);
  assert.deepEqual(normalizedMode.reason_codes, ["minimum_hold_not_met"]);
  assert.deepEqual(normalizedMode.diagnostic_reason_codes, []);
  assert.equal(normalizedMode.round_trip_cost_bps, 125);
  assert.equal(normalizedMode.margin_bps, 50);
  assert.equal(normalizedMode.modeled_edge_bps, 180);

  const buyLegFallbackBlock = evaluateRotationGuard(
    buildHeldPosition("OLD", "0xold", { opened_at: hoursAgoIso(guardNowMs, 72) }),
    buildCandidate(),
    40,
    { ...SETTINGS_DEFAULTS, rotation_friction_guard_mode: "shadow" },
    guardNowMs,
    { feasible: false, reason_codes: [] }
  );
  assert.equal(buyLegFallbackBlock.allow, false);
  assert.equal(buyLegFallbackBlock.would_block, true);
  assert.deepEqual(buyLegFallbackBlock.reason_codes, ["buy_leg_infeasible"]);
  assert.deepEqual(buyLegFallbackBlock.diagnostic_reason_codes, []);

  const rotationNowMs = Date.parse("2026-10-12T00:00:00.000Z");
  const shadowPortfolio = buildPortfolio({
    positions: {
      OLD: buildHeldPosition("OLD", "0xold", {
        conviction_score: 65,
        liquidity_quality: 80,
        fraud_risk: 15,
        opened_at: hoursAgoIso(rotationNowMs, 72)
      })
    },
    settings: {
      rotation_threshold: 5,
      rotation_friction_guard_mode: "shadow"
    }
  });
  const shadowActions = evaluateRotationActions(shadowPortfolio, [
    buildCandidate({ symbol: "FRESH", address: "0xfresh", _score: 70 })
  ], rotationNowMs);
  assert.equal(shadowActions.length, 1);
  assert.equal(shadowActions[0].from_symbol, "OLD");
  assert.equal(shadowActions[0].to_candidate.token.symbol, "FRESH");
  assert.equal(shadowActions[0].rotation_guard.mode, "shadow");
  assert.equal(shadowActions[0].rotation_guard.allow, true);
  assert.equal(shadowActions[0].rotation_guard.would_block, true);
  assert.deepEqual(shadowActions[0].rotation_guard.reason_codes, []);
  assert.deepEqual(shadowActions[0].rotation_guard.diagnostic_reason_codes, ["friction_hurdle_not_cleared"]);
  assert.equal(shadowActions[0].rotation_guard.buy_feasibility.feasible, true);
  assertNoAdditionalWrites();

  const enforcePortfolio = buildPortfolio({
    positions: {
      YOUNG: buildHeldPosition("YOUNG", "0xyoung", {
        conviction_score: 62,
        liquidity_quality: 80,
        fraud_risk: 15,
        opened_at: hoursAgoIso(rotationNowMs, 2)
      }),
      MID: buildHeldPosition("MID", "0xmid", {
        conviction_score: 78,
        liquidity_quality: 80,
        fraud_risk: 15,
        opened_at: hoursAgoIso(rotationNowMs, 96)
      })
    },
    settings: {
      rotation_threshold: 5,
      max_rotations_per_cycle: 2,
      rotation_friction_guard_mode: "enforce"
    }
  });
  const enforceActions = evaluateRotationActions(enforcePortfolio, [
    buildCandidate({ symbol: "ALFA", address: "0xalfa", _score: 95 }),
    buildCandidate({ symbol: "BETA", address: "0xbeta", _score: 85 })
  ], rotationNowMs);
  assert.equal(enforceActions.length, 1);
  assert.equal(enforceActions[0].from_symbol, "MID");
  assert.equal(enforceActions[0].to_candidate.token.symbol, "BETA");
  assert.equal(enforceActions[0].rotation_guard.mode, "enforce");
  assert.equal(enforceActions[0].rotation_guard.allow, true);
  assert.equal(enforceActions[0].rotation_guard.would_block, false);
  assertNoAdditionalWrites();

  const offPortfolio = buildPortfolio({
    positions: {
      OLD: buildHeldPosition("OLD", "0xold", {
        conviction_score: 65,
        liquidity_quality: 80,
        fraud_risk: 15,
        opened_at: hoursAgoIso(rotationNowMs, 2)
      })
    },
    settings: {
      rotation_threshold: 5,
      rotation_friction_guard_mode: "off"
    }
  });
  const offActions = evaluateRotationActions(offPortfolio, [
    buildCandidate({ symbol: "FRESH", address: "0xfresh", _score: 80 })
  ], rotationNowMs);
  assert.equal(offActions.length, 1);
  assert.equal(offActions[0].rotation_guard.mode, "off");
  assert.equal(offActions[0].rotation_guard.allow, true);
  assert.equal(offActions[0].rotation_guard.would_block, true);
  assert.deepEqual(offActions[0].rotation_guard.reason_codes, []);
  assert.deepEqual(offActions[0].rotation_guard.diagnostic_reason_codes, ["minimum_hold_not_met"]);
  assertNoAdditionalWrites();

  for (const mode of ["off", "shadow", "enforce"]) {
    const infeasibleActions = evaluateRotationActions(buildPortfolio({
      positions: {
        OLD: buildHeldPosition("OLD", "0xold", {
          conviction_score: 65,
          liquidity_quality: 80,
          fraud_risk: 15,
          opened_at: hoursAgoIso(rotationNowMs, 96)
        })
      },
      settings: {
        rotation_threshold: 5,
        rotation_friction_guard_mode: mode
      }
    }), [
      buildCandidate({ symbol: `BAD-${mode}`, address: `0xbad${mode}`, _score: 80, price: 0 })
    ], rotationNowMs);
    assert.equal(infeasibleActions.length, 0);
    assertNoAdditionalWrites();
  }

  const cooldownPortfolio = buildPortfolio({
    positions: {
      OLD: buildHeldPosition("OLD", "0xold", {
        conviction_score: 65,
        liquidity_quality: 80,
        fraud_risk: 15,
        opened_at: hoursAgoIso(rotationNowMs, 96)
      })
    },
    cooldowns: {
      HOT: { until: "2026-12-01T00:00:00.000Z", reason: "rotation_out:better_opportunity" }
    },
    settings: {
      rotation_threshold: 5,
      rotation_friction_guard_mode: "off"
    }
  });
  const cooldownActions = evaluateRotationActions(cooldownPortfolio, [
    buildCandidate({ symbol: "HOT", address: "0xhot", _score: 95 }),
    buildCandidate({ symbol: "COOL", address: "0xcool", _score: 85 })
  ], rotationNowMs);
  assert.equal(cooldownActions.length, 1);
  assert.equal(cooldownActions[0].to_candidate.token.symbol, "COOL");
  assertNoAdditionalWrites();

  const sellActionsSource = evaluateSellActions.toString();
  assert.equal(sellActionsSource.includes("rotation_friction_guard_mode"), false);
  assert.equal(sellActionsSource.includes("rotation_min_hold_hours"), false);
  assert.equal(sellActionsSource.includes("rotation_round_trip_cost_bps"), false);
  assert.equal(sellActionsSource.includes("rotation_margin_bps"), false);
  assert.equal(sellActionsSource.includes("rotation_score_edge_bps_per_point"), false);
  assert.equal(sellActionsSource.includes("rotation_hysteresis_bps_per_day"), false);
  assert.equal(sellActionsSource.includes("rotation_hysteresis_max_bps"), false);

  const pipelineSource = fs.readFileSync(new URL("../pipeline.js", import.meta.url), "utf8");
  const rotationCycleSectionMatch = pipelineSource.match(
    /const rotationEvaluationNowMs = nowMs\(\);[\s\S]*?const sizedRotationActions = rotationActions/
  );
  assert(rotationCycleSectionMatch, "expected rotation cycle section with injected nowMs");
  const rotationCycleSection = rotationCycleSectionMatch[0];
  assert.match(
    rotationCycleSection,
    /evaluateRotationActions\(portfolio,\s*approved,\s*rotationEvaluationNowMs\)/
  );
  assert.match(
    rotationCycleSection,
    /for\s*\(const action of rotationActions\)\s*\{[\s\S]*?if\s*\(rotationGuard\?\.mode !== "shadow"\)\s*continue;[\s\S]*?log\("rotation_guard_shadow",\s*\{/
  );
  assert.doesNotMatch(
    rotationCycleSection,
    /rotation_guard_shadow[\s\S]*rotationGuard\?\.mode === "(?:off|enforce)"/
  );
  assert.match(
    rotationCycleSection,
    /const rotationEvaluatedAt = new Date\(rotationEvaluationNowMs\)\.toISOString\(\);[\s\S]*evaluated_at:\s*rotationEvaluatedAt/
  );
  assertNoAdditionalWrites();

  let pathologicalGuardResult = null;
  assert.doesNotThrow(() => {
    pathologicalGuardResult = evaluateRotationGuard(
      { opened_at: Symbol("opened-at") },
      buildCandidate(),
      Symbol("delta"),
      { rotation_friction_guard_mode: Symbol("mode") },
      Symbol("now"),
      { feasible: false, reason_codes: Symbol("codes") }
    );
  });
  assert.equal(pathologicalGuardResult.mode, "enforce");
  assert.equal(pathologicalGuardResult.allow, false);
  assert.equal(pathologicalGuardResult.would_block, true);
  assert.deepEqual(pathologicalGuardResult.reason_codes, ["friction_hurdle_not_cleared", "buy_leg_infeasible"]);

  console.log("verifyRotationFrictionGuard: ok");
} finally {
  for (const [method, original] of originalWriteMethods.entries()) {
    fs[method] = original;
  }
}
