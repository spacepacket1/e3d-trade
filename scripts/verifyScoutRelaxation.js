import assert from "assert/strict";
import fs from "fs";
import { SCOUT_FLOW_ONLY_PER_CYCLE_LIMIT } from "./evidencePackets.js";

const originalAppendFileSync = fs.appendFileSync;
fs.appendFileSync = () => {};

const DAY_MS = 24 * 60 * 60 * 1000;

const {
  SETTINGS_DEFAULTS,
  buildScoutEvidenceShortlist,
  evaluateBuyActions,
  evaluateRotationActions,
  filterScoutCandidatesForDesk,
  filterScoutCandidatesAgainstPortfolio,
  openPosition,
  rankApprovedCandidates,
  resolveScoutEvidenceRefMinimum,
  resolveScoutMaxCandidates
} = await import("../pipeline.js");

function buildEntry(overrides = {}) {
  return {
    packet_summary: {
      flow_only: false,
      evidence_ids: ["evi-1", "evi-2", "evi-3"],
      ...(overrides.packet_summary || {})
    },
    scout_input: {
      flow: {
        flow_signal: null,
        ...(overrides.scout_input?.flow || {})
      },
      liquidity_data: {
        liquidity_usd: null,
        ...(overrides.scout_input?.liquidity_data || {})
      },
      market_data: {
        market_cap_usd: null,
        ...(overrides.scout_input?.market_data || {})
      },
      ...(overrides.scout_input || {})
    }
  };
}

function buildPortfolio(overrides = {}) {
  return {
    cash_usd: overrides.cash_usd ?? 20000,
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
      max_open_positions: 5,
      max_thesis_positions: 5,
      max_buys_per_cycle: 3,
      ...(overrides.settings || {})
    }
  };
}

function buildCandidate(overrides = {}) {
  const symbol = overrides.symbol ?? "ASTRO";
  const address = overrides.address ?? `0x${symbol.toLowerCase()}`;
  const price = overrides.price ?? 1;
  const targets = overrides.targets || {
    target_1: Number((price * 1.2).toFixed(4)),
    target_2: Number((price * 1.4).toFixed(4)),
    target_3: Number((price * 1.6).toFixed(4))
  };
  return {
    source_agent: "scout",
    token: {
      symbol,
      name: overrides.name ?? `${symbol} Token`,
      chain: "ethereum",
      contract_address: address,
      category: overrides.category ?? "infra"
    },
    market_data: {
      current_price: price,
      change_24h_pct: overrides.change_24h_pct ?? 4,
      change_30m_pct: overrides.change_30m_pct ?? 1,
      volume_24h_usd: overrides.volume_24h_usd ?? 300000,
      market_cap_usd: overrides.market_cap_usd ?? 12000000,
      price_source: "e3d",
      price_timestamp: overrides.price_timestamp ?? "2026-10-01T16:00:00.000Z"
    },
    liquidity_data: {
      liquidity_usd: overrides.liquidity_usd ?? 800000,
      liquidity_source: "e3d",
      liquidity_timestamp: overrides.liquidity_timestamp ?? "2026-10-01T16:00:00.000Z"
    },
    execution_data: {
      estimated_slippage_bps: overrides.estimated_slippage_bps ?? 15,
      quote_source: "e3d",
      quote_timestamp: overrides.quote_timestamp ?? "2026-10-01T16:00:00.000Z"
    },
    setup_type: overrides.setup_type ?? null,
    source: overrides.source ?? "scout",
    conviction_score: overrides.conviction_score ?? 70,
    evidence_warnings: structuredClone(overrides.evidence_warnings ?? []),
    evidence_summary: structuredClone(overrides.evidence_summary ?? null),
    targets,
    invalidation_price: overrides.invalidation_price ?? Number((price * 0.8).toFixed(4)),
    _score: overrides._score ?? 120,
    _risk: overrides._risk ?? { approved_size_pct: overrides.approved_size_pct ?? 10 }
  };
}

function buildHeldPosition(symbol, address, overrides = {}) {
  const quantity = overrides.quantity ?? 200;
  const currentPrice = overrides.current_price ?? 1;
  const avgEntry = overrides.avg_entry_price ?? 1;
  const costBasis = overrides.cost_basis_usd ?? avgEntry * quantity;
  return {
    symbol,
    contract_address: address,
    category: overrides.category ?? "infra",
    sleeve: overrides.sleeve ?? "thesis",
    quantity,
    avg_entry_price: avgEntry,
    cost_basis_usd: costBasis,
    current_price: currentPrice,
    market_value_usd: overrides.market_value_usd ?? quantity * currentPrice,
    peak_price: overrides.peak_price ?? currentPrice,
    trough_price: overrides.trough_price ?? currentPrice,
    stop_price: overrides.stop_price ?? 0.8,
    targets: structuredClone(overrides.targets ?? {
      target_1: 1.2,
      target_2: 1.4,
      target_3: 1.6
    }),
    partials_taken: structuredClone(overrides.partials_taken ?? {
      target_1: false,
      target_2: false,
      target_3: false
    }),
    score: overrides.score ?? 35,
    fraud_risk: overrides.fraud_risk ?? 0,
    liquidity_usd: overrides.liquidity_usd ?? 800000,
    liquidity_quality: overrides.liquidity_quality ?? 90,
    strategy_version: "test",
    opened_at: overrides.opened_at ?? "2026-10-01T12:00:00.000Z",
    last_updated_at: overrides.last_updated_at ?? "2026-10-01T12:00:00.000Z",
    last_market_snapshot: structuredClone(overrides.last_market_snapshot ?? {
      market_data: { current_price: currentPrice, market_cap_usd: 12000000, volume_24h_usd: 300000 },
      liquidity_data: { liquidity_usd: overrides.liquidity_usd ?? 800000 },
      execution_data: { estimated_slippage_bps: 15 }
    })
  };
}

function buildShortlistData() {
  return {
    tokenUniverse: [{
      address: "0xastro",
      symbol: "ASTRO",
      name: "Astro",
      price_usd: 1.15,
      change_24h: 6,
      change_30m: 1.5,
      volume_24h_usd: 420000,
      market_cap_usd: 15000000,
      liquidity_usd: 900000,
      flow_signal: "accumulation",
      buy_sell_ratio_1h: 4.5,
      price_change_1h_pct: 1.2
    }],
    stories: {
      STAGING: [{
        id: "story-astro-staging",
        story_type: "STAGING",
        title: "Fresh staging sequence",
        score: 82,
        meta: {
          primary: { address: "0xastro" }
        }
      }]
    },
    e3dCandidates: [],
    e3dTheses: [],
    e3dWatchlist: [],
    e3dActions: [],
    cgDetailMap: new Map(),
    avoidAddresses: new Set(),
    disqualifierTypes: new Set(["WASH_TRADE", "LOOP", "LIQUIDITY_DRAIN", "SPREAD_WIDENING", "EXCHANGE_FLOW", "SECURITY_RISK", "RUG_LIQUIDITY_PULL", "TREASURY_DISTRIBUTION"]),
    lateSignalTypes: new Set(["MOVER", "SURGE"]),
    secondaryTypes: new Set(),
    buySignalTypes: new Set(["STAGING", "CLUSTER", "FUNNEL", "NEW_WALLETS", "ACCUMULATION", "SMART_MONEY", "SMART_MONEY_LEADER", "STEALTH_ACCUMULATION", "THESIS", "BREAKOUT_CONFIRMED", "FLOW", "HOTLINKS", "DISCOVERY", "WHALE"])
  };
}

function buildFlowOnlyShortlistData() {
  return {
    tokenUniverse: [
      {
        address: "0xalfa",
        symbol: "ALFA",
        name: "Alfa",
        price_usd: 2.1,
        change_24h: 8.5,
        change_30m: 1.2,
        volume_24h_usd: 180000,
        market_cap_usd: 9800000,
        liquidity_usd: 260000,
        flow_signal: "accumulation",
        buy_sell_ratio_1h: null,
        price_change_1h_pct: 0.9
      },
      {
        address: "0xbravo",
        symbol: "BRAVO",
        name: "Bravo",
        price_usd: 1.4,
        change_24h: 7.8,
        change_30m: 1.1,
        volume_24h_usd: 170000,
        market_cap_usd: 9100000,
        liquidity_usd: 255000,
        flow_signal: "accumulation",
        buy_sell_ratio_1h: null,
        price_change_1h_pct: 0.7
      }
    ],
    stories: {
      MOVER: [
        {
          id: "story-alfa-mover",
          story_type: "MOVER",
          title: "Late mover continuation",
          score: 74,
          meta: {
            primary: { address: "0xalfa" }
          }
        }
      ],
      SURGE: [
        {
          id: "story-bravo-surge",
          story_type: "SURGE",
          title: "Late surge continuation",
          score: 72,
          meta: {
            primary: { address: "0xbravo" }
          }
        }
      ]
    },
    e3dCandidates: [],
    e3dTheses: [],
    e3dWatchlist: [],
    e3dActions: [],
    cgDetailMap: new Map(),
    avoidAddresses: new Set(),
    disqualifierTypes: new Set(["WASH_TRADE", "LOOP", "LIQUIDITY_DRAIN", "SPREAD_WIDENING", "EXCHANGE_FLOW", "SECURITY_RISK", "RUG_LIQUIDITY_PULL", "TREASURY_DISTRIBUTION"]),
    lateSignalTypes: new Set(["MOVER", "SURGE"]),
    secondaryTypes: new Set(),
    buySignalTypes: new Set(["STAGING", "CLUSTER", "FUNNEL", "NEW_WALLETS", "ACCUMULATION", "SMART_MONEY", "SMART_MONEY_LEADER", "STEALTH_ACCUMULATION", "THESIS", "BREAKOUT_CONFIRMED", "FLOW", "HOTLINKS", "DISCOVERY", "WHALE"])
  };
}

function approxEqual(actual, expected, epsilon = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `expected ${actual} to be within ${epsilon} of ${expected}`);
}

try {
  assert.equal(SCOUT_FLOW_ONLY_PER_CYCLE_LIMIT, 1);
  assert.equal(SETTINGS_DEFAULTS.scout_max_candidates, 1);
  assert.equal(SETTINGS_DEFAULTS.flow_only_max_position_pct, 0.015);
  assert.equal(resolveScoutMaxCandidates(SETTINGS_DEFAULTS), 1);
  assert.equal(resolveScoutMaxCandidates({ scout_max_candidates: 8 }), 8);
  assert.equal(resolveScoutMaxCandidates({ scout_max_candidates: 0 }), 1);

  const syntheticShortlist = Array.from({ length: 8 }, (_, index) => ({ symbol: `TOK${index + 1}` }));
  assert.equal(syntheticShortlist.slice(0, resolveScoutMaxCandidates(SETTINGS_DEFAULTS)).length, 1);

  const highConfidenceFlowOnly = buildEntry({
    packet_summary: { flow_only: true },
    scout_input: {
      flow: { flow_signal: "strong_accumulation" },
      liquidity_data: { liquidity_usd: 500000 },
      market_data: { market_cap_usd: 5000000 }
    }
  });
  assert.equal(resolveScoutEvidenceRefMinimum(highConfidenceFlowOnly), 2);
  assert.equal(2 >= resolveScoutEvidenceRefMinimum(highConfidenceFlowOnly), true);

  const narrativeCandidate = buildEntry({
    packet_summary: { flow_only: false },
    scout_input: {
      flow: { flow_signal: "strong_accumulation" },
      liquidity_data: { liquidity_usd: 900000 },
      market_data: { market_cap_usd: 25000000 }
    }
  });
  assert.equal(resolveScoutEvidenceRefMinimum(narrativeCandidate), 3);
  assert.equal(2 >= resolveScoutEvidenceRefMinimum(narrativeCandidate), false);

  const underThresholdFlowOnly = buildEntry({
    packet_summary: { flow_only: true },
    scout_input: {
      flow: { flow_signal: "strong_accumulation" },
      liquidity_data: { liquidity_usd: 499999 },
      market_data: { market_cap_usd: 5000000 }
    }
  });
  assert.equal(resolveScoutEvidenceRefMinimum(underThresholdFlowOnly), 3);

  const basePortfolio = buildPortfolio({
    cash_usd: 25000,
    cooldowns: {
      OTHER: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString()
    },
    settings: {
      max_open_positions: 5,
      max_thesis_positions: 5,
      max_new_positions_per_day: 1
    }
  });
  const initialCandidate = buildCandidate({
    symbol: "ASTRO",
    address: "0xastro",
    price: 1,
    targets: { target_1: 1.2, target_2: 1.4, target_3: 1.6 },
    _score: 140
  });
  const initialTrade = openPosition(basePortfolio, initialCandidate, 1000, "new_position");
  assert.ok(initialTrade);
  assert.equal(Object.values(basePortfolio.cooldowns).some((entry) => entry?.reason === "pyramid_add"), false);

  const storedKeyBeforeAdd = Object.keys(basePortfolio.positions);
  assert.deepEqual(storedKeyBeforeAdd, ["ASTRO"]);
  const positionBeforeAdd = basePortfolio.positions.ASTRO;
  const preAddQuantity = positionBeforeAdd.quantity;
  const preAddCostBasis = positionBeforeAdd.cost_basis_usd;
  const preAddTarget1 = positionBeforeAdd.targets.target_1;

  positionBeforeAdd.partials_taken.target_1 = true;
  delete positionBeforeAdd.partials_taken.target_2;
  positionBeforeAdd.stop_price = 1.02;

  const addCandidate = buildCandidate({
    symbol: "astro",
    address: "0xastro",
    price: 1.1,
    invalidation_price: 0.88,
    targets: { target_1: 1.5, target_2: 1.8, target_3: 2.0 },
    _score: 160
  });

  const addStartMs = Date.now();
  const addTrade = openPosition(basePortfolio, addCandidate, 500, "pyramid_add");
  const addEndMs = Date.now();
  assert.ok(addTrade);
  assert.equal(Object.keys(basePortfolio.positions).length, 1);
  assert.deepEqual(Object.keys(basePortfolio.positions), ["ASTRO"]);

  const storedPosition = basePortfolio.positions.ASTRO;
  approxEqual(storedPosition.quantity, preAddQuantity + addTrade.quantity, 1e-12);
  approxEqual(storedPosition.cost_basis_usd, preAddCostBasis + addTrade.cash_debit_usd, 1e-9);
  approxEqual(
    storedPosition.avg_entry_price,
    (preAddCostBasis + addTrade.cash_debit_usd) / (preAddQuantity + addTrade.quantity),
    1e-12
  );
  assert.equal(storedPosition.stop_price, 1.02);
  assert.equal(storedPosition.targets.target_1, preAddTarget1);
  assert.equal(storedPosition.targets.target_2, 1.8);
  assert.equal(storedPosition.targets.target_3, 2);
  assert.equal(storedPosition.partials_taken.target_1, true);
  assert.equal(storedPosition.partials_taken.target_3, false);
  assert.equal(Object.prototype.hasOwnProperty.call(storedPosition.partials_taken, "target_2"), false);

  const astroCooldown = basePortfolio.cooldowns.ASTRO;
  assert.ok(astroCooldown);
  assert.equal(astroCooldown.reason, "pyramid_add");
  const astroUntilMs = Date.parse(astroCooldown.until);
  assert.ok(Number.isFinite(astroUntilMs));
  assert.ok(astroUntilMs >= addStartMs + DAY_MS - 5000);
  assert.ok(astroUntilMs <= addEndMs + DAY_MS + 5000);
  assert.deepEqual(basePortfolio.cooldowns.OTHER, {
    until: basePortfolio.cooldowns.OTHER.until,
    reason: "legacy"
  });

  const stateBeforeBlockedAdd = {
    cash_usd: basePortfolio.cash_usd,
    action_history_length: basePortfolio.action_history.length,
    position: structuredClone(basePortfolio.positions.ASTRO),
    cooldowns: structuredClone(basePortfolio.cooldowns)
  };
  const blockedAdd = openPosition(basePortfolio, buildCandidate({
    symbol: "ASTRO",
    address: "0xastro",
    price: 1.12,
    invalidation_price: 0.9,
    targets: { target_1: 1.4, target_2: 1.7, target_3: 2.1 }
  }), 400, "pyramid_add");
  assert.equal(blockedAdd, null);
  assert.equal(basePortfolio.cash_usd, stateBeforeBlockedAdd.cash_usd);
  assert.equal(basePortfolio.action_history.length, stateBeforeBlockedAdd.action_history_length);
  assert.deepEqual(basePortfolio.positions.ASTRO, stateBeforeBlockedAdd.position);
  assert.deepEqual(basePortfolio.cooldowns, stateBeforeBlockedAdd.cooldowns);

  const trendOverlayPortfolio = buildPortfolio({
    cash_usd: 25000,
    positions: {
      WETH: buildHeldPosition("WETH", "0xweth", { sleeve: "trend_overlay" })
    }
  });
  const trendOverlayAdd = openPosition(trendOverlayPortfolio, buildCandidate({
    symbol: "WETH",
    address: "0xweth",
    price: 1.05
  }), 500, "trend_overlay_topup", { sleeve: "trend_overlay" });
  assert.ok(trendOverlayAdd, "a trend-overlay top-up on an existing position must still succeed");
  assert.equal(trendOverlayPortfolio.cooldowns.WETH, undefined, "a trend-overlay top-up must not create a pyramid_add cooldown that would block the next top-up");
  const secondTrendOverlayAdd = openPosition(trendOverlayPortfolio, buildCandidate({
    symbol: "WETH",
    address: "0xweth",
    price: 1.06
  }), 500, "trend_overlay_topup", { sleeve: "trend_overlay" });
  assert.ok(secondTrendOverlayAdd, "a second trend-overlay top-up in the same cycle must not be blocked by an add cooldown");

  const conflictPortfolio = buildPortfolio({
    cash_usd: 25000,
    positions: {
      NOVA: buildHeldPosition("NOVA", "0xnova-original")
    }
  });
  const conflictStateBefore = {
    cash_usd: conflictPortfolio.cash_usd,
    positions: structuredClone(conflictPortfolio.positions),
    action_history_length: conflictPortfolio.action_history.length
  };
  const conflictingAdd = openPosition(conflictPortfolio, buildCandidate({
    symbol: "NOVA",
    address: "0xnova-different",
    price: 2
  }), 500, "pyramid_add");
  assert.equal(conflictingAdd, null, "a same-symbol, different-contract-address candidate must be rejected, not merged into the existing position");
  assert.equal(conflictPortfolio.cash_usd, conflictStateBefore.cash_usd);
  assert.deepEqual(conflictPortfolio.positions, conflictStateBefore.positions);
  assert.equal(conflictPortfolio.action_history.length, conflictStateBefore.action_history_length);
  assert.equal(Object.keys(conflictPortfolio.positions).length, 1, "a rejected conflicting add must not create a second, overwriting position under the same symbol key");

  const headroomPortfolio = buildPortfolio({
    cash_usd: 50000,
    positions: {
      ASTRO: buildHeldPosition("ASTRO", "0xastro", {
        quantity: 900,
        current_price: 1,
        avg_entry_price: 1,
        cost_basis_usd: 900,
        market_value_usd: 900
      })
    },
    settings: { max_position_pct: 0.1, max_buys_per_cycle: 3, min_trade_usd: 10 }
  });
  const headroomEquity = 10000;
  headroomPortfolio.stats = { equity_usd: headroomEquity };
  const headroomActions = evaluateBuyActions(headroomPortfolio, [
    buildCandidate({ symbol: "astro", address: "0xastro", _score: 150, approved_size_pct: 50 })
  ]);
  assert.equal(headroomActions.length, 1);
  assert.equal(headroomActions[0].reason, "pyramid_add");
  assert.ok(
    headroomActions[0].allocation_usd <= headroomEquity * 0.1 - 900 + 1e-6,
    `add allocation (${headroomActions[0].allocation_usd}) must be capped at the remaining room under max_position_pct, not a fresh full-size allocation`
  );

  const renamedTickerPortfolio = buildPortfolio({
    cash_usd: 50000,
    positions: {
      OLDNAME: buildHeldPosition("OLDNAME", "0xrenamed", { quantity: 100, market_value_usd: 100 })
    },
    settings: { max_open_positions: 1, max_thesis_positions: 1, max_new_positions_per_day: 0, max_buys_per_cycle: 3 }
  });
  renamedTickerPortfolio.stats = { equity_usd: 20000 };
  const renamedTickerActions = evaluateBuyActions(renamedTickerPortfolio, [
    buildCandidate({ symbol: "NEWNAME", address: "0xrenamed", _score: 170, approved_size_pct: 5 })
  ]);
  assert.equal(renamedTickerActions.length, 1, "a same-address, renamed-ticker candidate must be recognized as an add even though the book and thesis caps are full");
  assert.equal(renamedTickerActions[0].reason, "pyramid_add");

  const collisionBuyPortfolio = buildPortfolio({
    cash_usd: 50000,
    positions: {
      NOVA: buildHeldPosition("NOVA", "0xnova-original")
    },
    settings: { max_open_positions: 5, max_thesis_positions: 5, max_new_positions_per_day: 5, max_buys_per_cycle: 3 }
  });
  collisionBuyPortfolio.stats = { equity_usd: 20000 };
  const collisionBuyActions = evaluateBuyActions(collisionBuyPortfolio, [
    buildCandidate({ symbol: "NOVA", address: "0xnova-different", _score: 170, approved_size_pct: 5 })
  ]);
  assert.equal(collisionBuyActions.length, 0, "a symbol-colliding, different-address candidate must be skipped entirely rather than consuming a buy slot for a trade execution will reject");

  const originalAppendCapture = fs.appendFileSync;
  const deskLogs = [];
  fs.appendFileSync = (filePath, contents) => {
    deskLogs.push({ filePath, contents: String(contents) });
  };
  try {
    const deskCanonicalCandidate = buildCandidate({
      symbol: "FLOWA",
      address: "0xflowa",
      setup_type: "flow_only_breakout",
      liquidity_usd: 300000,
      change_24h_pct: 10,
      evidence_warnings: [],
      evidence_summary: { warnings: ["flow_only_candidate"] }
    });
    const deskNonCanonicalCandidate = buildCandidate({
      symbol: "FLOWB",
      address: "0xflowb",
      setup_type: "flow_only_breakout",
      liquidity_usd: 300000,
      change_24h_pct: 10
    });
    const deskKept = filterScoutCandidatesForDesk(
      [deskCanonicalCandidate, deskNonCanonicalCandidate],
      buildPortfolio({ settings: { scout_max_candidates: 5 } })
    );
    assert.deepEqual(deskKept.map((candidate) => candidate.token.symbol), ["FLOWA"]);
    const parsedDeskLogs = deskLogs.map((entry) => JSON.parse(entry.contents.trim()));
    assert.equal(
      parsedDeskLogs.some((entry) =>
        entry.stage === "scout_desk_filter"
        && entry.data?.symbol === "FLOWB"
        && entry.data?.reason === "flow_only_disabled"
      ),
      true,
      "non-canonical flow-only labels must remain filtered with the flow_only_disabled reason"
    );
  } finally {
    fs.appendFileSync = originalAppendCapture;
  }

  const renamedTickerRotationPortfolio = buildPortfolio({
    cash_usd: 25000,
    positions: {
      OLDNAME: buildHeldPosition("OLDNAME", "0xrenamed", { score: 5 })
    }
  });
  const renamedTickerRotationResult = evaluateRotationActions(renamedTickerRotationPortfolio, [
    buildCandidate({ symbol: "NEWNAME", address: "0xrenamed", _score: 500 })
  ]);
  assert.equal(renamedTickerRotationResult.length, 0, "a same-address, renamed-ticker candidate must not be offered as a rotation target for the position it already is");

  const renamedTickerCooldownPortfolio = buildPortfolio({
    cash_usd: 25000,
    positions: {
      OLDNAME: buildHeldPosition("OLDNAME", "0xrenamed", { quantity: 100, market_value_usd: 100 })
    },
    cooldowns: {
      OLDNAME: { until: new Date(Date.now() + DAY_MS).toISOString(), reason: "pyramid_add" }
    },
    settings: { max_buys_per_cycle: 1, max_open_positions: 5, max_thesis_positions: 5, max_new_positions_per_day: 5 }
  });
  renamedTickerCooldownPortfolio.stats = { equity_usd: 20000 };
  const renamedTickerCooldownActions = evaluateBuyActions(renamedTickerCooldownPortfolio, [
    buildCandidate({ symbol: "NEWNAME", address: "0xrenamed", _score: 170, approved_size_pct: 5 }),
    buildCandidate({ symbol: "NOVA", address: "0xnova", _score: 150, approved_size_pct: 5 })
  ]);
  assert.equal(
    renamedTickerCooldownActions.some((action) => action.candidate.token.symbol === "NEWNAME"),
    false,
    "a renamed-ticker candidate whose address-resolved position is still in cooldown must not consume the only buy slot"
  );
  assert.equal(
    renamedTickerCooldownActions.some((action) => action.candidate.token.symbol === "NOVA"),
    true,
    "the cooling renamed-ticker candidate must not crowd out an otherwise-eligible unrelated candidate under a tight max_buys_per_cycle"
  );

  const cooldownRanked = rankApprovedCandidates([
    buildCandidate({ symbol: "ASTRO", address: "0xastro", _score: 200 }),
    buildCandidate({ symbol: "NOVA", address: "0xnova", _score: 180 })
  ], basePortfolio);
  assert.deepEqual(cooldownRanked.map((candidate) => candidate.token.symbol), ["NOVA"]);

  const rankablePortfolio = buildPortfolio({
    cash_usd: 24000,
    positions: {
      ASTRO: structuredClone(basePortfolio.positions.ASTRO)
    },
    cooldowns: {
      OTHER: { until: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(), reason: "legacy" }
    }
  });
  const heldRanked = rankApprovedCandidates([
    buildCandidate({ symbol: "astro", address: "0xastro", _score: 210 })
  ], rankablePortfolio);
  assert.equal(heldRanked.length, 1);
  assert.equal(heldRanked[0].token.symbol, "astro");

  const rotationPortfolio = buildPortfolio({
    cash_usd: 25000,
    positions: {
      ASTRO: buildHeldPosition("ASTRO", "0xastro", {
        quantity: 150,
        current_price: 1.1,
        avg_entry_price: 1.05,
        cost_basis_usd: 157.5,
        market_value_usd: 165,
        score: 20
      })
    },
    settings: {
      rotation_threshold: 0,
      max_rotations_per_cycle: 1
    }
  });
  const rotationActions = evaluateRotationActions(rotationPortfolio, [
    buildCandidate({ symbol: "astro", address: "0xastro", _score: 1000 }),
    buildCandidate({ symbol: "NOVA", address: "0xnova", _score: 900, category: "ai" })
  ]);
  assert.equal(rotationActions.length, 1);
  assert.equal(rotationActions[0].to_candidate.token.symbol, "NOVA");

  const buyPortfolio = buildPortfolio({
    cash_usd: 30000,
    positions: {
      ASTRO: buildHeldPosition("ASTRO", "0xastro", {
        quantity: 100,
        current_price: 1.1,
        avg_entry_price: 1,
        cost_basis_usd: 100,
        market_value_usd: 110
      })
    },
    action_history: [{
      ts: new Date().toISOString(),
      side: "buy",
      reason: "new_position:paper_trade"
    }],
    settings: {
      max_open_positions: 1,
      max_thesis_positions: 1,
      max_new_positions_per_day: 1,
      max_buys_per_cycle: 2
    }
  });
  const buyActions = evaluateBuyActions(buyPortfolio, [
    buildCandidate({ symbol: "NOVA", address: "0xnova", _score: 300, category: "ai" }),
    buildCandidate({ symbol: "astro", address: "0xastro", _score: 250 })
  ]);
  assert.equal(buyActions.length, 1);
  assert.equal(buyActions[0].candidate.token.symbol, "astro");
  assert.equal(buyActions[0].reason, "pyramid_add");

  const flowOnlyCapPortfolio = buildPortfolio({
    cash_usd: 50000,
    settings: { max_buys_per_cycle: 5, min_trade_usd: 50 }
  });
  flowOnlyCapPortfolio.stats = { equity_usd: 10000 };
  const flowOnlyCappedActions = evaluateBuyActions(flowOnlyCapPortfolio, [
    buildCandidate({
      symbol: "FLOWCAP",
      address: "0xflowcap",
      approved_size_pct: 10,
      evidence_warnings: ["flow_only_candidate"]
    })
  ]);
  assert.equal(flowOnlyCappedActions.length, 1);
  approxEqual(flowOnlyCappedActions[0].allocation_usd, 150, 1e-9);
  assert.equal(flowOnlyCappedActions[0].reason, "new_position");

  const flowOnlyBelowCapPortfolio = buildPortfolio({
    cash_usd: 50000,
    settings: { max_buys_per_cycle: 5, min_trade_usd: 50 }
  });
  flowOnlyBelowCapPortfolio.stats = { equity_usd: 10000 };
  const flowOnlyBelowCapActions = evaluateBuyActions(flowOnlyBelowCapPortfolio, [
    buildCandidate({
      symbol: "FLOWSMALL",
      address: "0xflowsmall",
      approved_size_pct: 1,
      evidence_warnings: ["flow_only_candidate"]
    })
  ]);
  assert.equal(flowOnlyBelowCapActions.length, 1);
  approxEqual(flowOnlyBelowCapActions[0].allocation_usd, 100, 1e-9);

  const nonFlowOnlyPortfolio = buildPortfolio({
    cash_usd: 50000,
    settings: { max_buys_per_cycle: 5, min_trade_usd: 50 }
  });
  nonFlowOnlyPortfolio.stats = { equity_usd: 10000 };
  const nonFlowOnlyActions = evaluateBuyActions(nonFlowOnlyPortfolio, [
    buildCandidate({
      symbol: "PLAIN",
      address: "0xplain",
      approved_size_pct: 10
    })
  ]);
  assert.equal(nonFlowOnlyActions.length, 1);
  approxEqual(nonFlowOnlyActions[0].allocation_usd, 1000, 1e-9);

  const summaryOnlyFlowOnlyPortfolio = buildPortfolio({
    cash_usd: 50000,
    settings: { max_buys_per_cycle: 5, min_trade_usd: 50 }
  });
  summaryOnlyFlowOnlyPortfolio.stats = { equity_usd: 10000 };
  const summaryOnlyFlowOnlyActions = evaluateBuyActions(summaryOnlyFlowOnlyPortfolio, [
    buildCandidate({
      symbol: "FLOWSUM",
      address: "0xflowsum",
      approved_size_pct: 10,
      evidence_warnings: [],
      evidence_summary: { warnings: ["flow_only_candidate"] }
    })
  ]);
  assert.equal(summaryOnlyFlowOnlyActions.length, 1);
  approxEqual(summaryOnlyFlowOnlyActions[0].allocation_usd, 150, 1e-9);

  const cashCappedFlowOnlyPortfolio = buildPortfolio({
    cash_usd: 120,
    settings: { max_buys_per_cycle: 5, min_trade_usd: 50 }
  });
  cashCappedFlowOnlyPortfolio.stats = { equity_usd: 10000 };
  const cashCappedFlowOnlyActions = evaluateBuyActions(cashCappedFlowOnlyPortfolio, [
    buildCandidate({
      symbol: "FLOWCASH",
      address: "0xflowcash",
      approved_size_pct: 10,
      evidence_warnings: ["flow_only_candidate"]
    })
  ]);
  assert.equal(cashCappedFlowOnlyActions.length, 1);
  approxEqual(cashCappedFlowOnlyActions[0].allocation_usd, 120, 1e-9);

  const flowOnlyAddPortfolio = buildPortfolio({
    cash_usd: 50000,
    positions: {
      FLOWADD: buildHeldPosition("FLOWADD", "0xflowadd", {
        quantity: 1000,
        current_price: 1,
        avg_entry_price: 1,
        cost_basis_usd: 1000,
        market_value_usd: 1000
      })
    },
    settings: { max_position_pct: 0.2, max_buys_per_cycle: 5, min_trade_usd: 50 }
  });
  flowOnlyAddPortfolio.stats = { equity_usd: 10000 };
  const flowOnlyAddActions = evaluateBuyActions(flowOnlyAddPortfolio, [
    buildCandidate({
      symbol: "flowadd",
      address: "0xflowadd",
      approved_size_pct: 50,
      evidence_warnings: ["flow_only_candidate"]
    })
  ]);
  assert.equal(flowOnlyAddActions.length, 1);
  assert.equal(flowOnlyAddActions[0].reason, "pyramid_add");
  approxEqual(flowOnlyAddActions[0].allocation_usd, 1000, 1e-9);
  assert.ok(flowOnlyAddActions[0].allocation_usd > flowOnlyAddPortfolio.stats.equity_usd * SETTINGS_DEFAULTS.flow_only_max_position_pct);

  const failedAddPortfolio = buildPortfolio({
    cash_usd: 15000,
    positions: {
      ASTRO: buildHeldPosition("ASTRO", "0xastro")
    },
    cooldowns: {}
  });
  const failedAdd = openPosition(failedAddPortfolio, buildCandidate({
    symbol: "ASTRO",
    address: "0xastro",
    price: 0
  }), 200, "pyramid_add");
  assert.equal(failedAdd, null);
  assert.equal(Object.values(failedAddPortfolio.cooldowns).some((entry) => entry?.reason === "pyramid_add"), false);

  const newPositionPortfolio = buildPortfolio({
    cash_usd: 15000,
    positions: {
      ASTRO: buildHeldPosition("ASTRO", "0xastro")
    },
    cooldowns: {
      OTHER: { until: new Date(Date.now() + 60 * 60 * 1000).toISOString(), reason: "legacy" }
    }
  });
  const betaTrade = openPosition(newPositionPortfolio, buildCandidate({
    symbol: "BETA",
    address: "0xbeta",
    price: 2,
    _score: 180,
    category: "ai"
  }), 400, "new_position");
  assert.ok(betaTrade);
  assert.equal(newPositionPortfolio.cooldowns.BETA, undefined);
  assert.equal(Object.values(newPositionPortfolio.cooldowns).some((entry) => entry?.reason === "pyramid_add"), false);

  const shortlistPortfolio = buildPortfolio({
    cash_usd: 18000,
    positions: {
      ASTRO: buildHeldPosition("ASTRO", "0xastro", {
        quantity: 120,
        current_price: 1.15,
        avg_entry_price: 1.05,
        cost_basis_usd: 126,
        market_value_usd: 138
      })
    }
  });
  const shortlistData = buildShortlistData();
  const shortlistResult = buildScoutEvidenceShortlist(shortlistData, shortlistPortfolio, {
    createdAt: "2026-10-01T16:00:00.000Z",
    heldAddresses: new Set(["0xastro"]),
    heldSymbols: new Set(["astro"]),
    disqualifiedAddresses: new Set()
  });
  assert.equal(shortlistResult.shortlist.some((entry) => entry.symbol === "ASTRO"), true);

  const coolingShortlistPortfolio = buildPortfolio({
    cash_usd: 18000,
    positions: {
      ASTRO: buildHeldPosition("ASTRO", "0xastro")
    },
    cooldowns: {
      astro: { until: new Date(Date.now() + DAY_MS).toISOString(), reason: "pyramid_add" }
    }
  });
  const coolingShortlistResult = buildScoutEvidenceShortlist(shortlistData, coolingShortlistPortfolio, {
    createdAt: "2026-10-01T16:00:00.000Z",
    heldAddresses: new Set(["0xastro"]),
    heldSymbols: new Set(["astro"]),
    disqualifiedAddresses: new Set()
  });
  assert.equal(coolingShortlistResult.entries.length, 0);
  assert.equal(coolingShortlistResult.shortlist.length, 0);
  assert.equal(coolingShortlistResult.blocked.length, 0);

  const unheldCoolingShortlistPortfolio = buildPortfolio({
    cash_usd: 18000,
    positions: {},
    cooldowns: {
      astro: { until: new Date(Date.now() + DAY_MS).toISOString(), reason: "post_sell" }
    }
  });
  const unheldCoolingShortlistResult = buildScoutEvidenceShortlist(shortlistData, unheldCoolingShortlistPortfolio, {
    createdAt: "2026-10-01T16:00:00.000Z",
    heldAddresses: new Set(),
    heldSymbols: new Set(),
    disqualifiedAddresses: new Set()
  });
  assert.equal(unheldCoolingShortlistResult.shortlist.some((entry) => entry.symbol === "ASTRO"), true, "a non-held symbol in a post-sell cooldown must remain researchable in the shortlist");

  const disqualifiedShortlistResult = buildScoutEvidenceShortlist(shortlistData, shortlistPortfolio, {
    createdAt: "2026-10-01T16:00:00.000Z",
    heldAddresses: new Set(["0xastro"]),
    heldSymbols: new Set(["astro"]),
    disqualifiedAddresses: new Set(["0xastro"])
  });
  assert.equal(disqualifiedShortlistResult.entries.length, 0);
  assert.equal(disqualifiedShortlistResult.shortlist.length, 0);
  assert.equal(disqualifiedShortlistResult.blocked.length, 0);

  const originalEvidenceShortlistLimit = process.env.SCOUT_EVIDENCE_SHORTLIST_LIMIT;
  process.env.SCOUT_EVIDENCE_SHORTLIST_LIMIT = "2";
  try {
    const flowOnlyShortlistResult = buildScoutEvidenceShortlist(buildFlowOnlyShortlistData(), buildPortfolio({
      cash_usd: 18000,
      positions: {}
    }), {
      createdAt: "2026-10-01T16:00:00.000Z",
      heldAddresses: new Set(),
      heldSymbols: new Set(),
      disqualifiedAddresses: new Set()
    });

    assert.equal(flowOnlyShortlistResult.shortlist_limit, 2);
    assert.equal(flowOnlyShortlistResult.entries.length, 2);
    assert.equal(flowOnlyShortlistResult.entries.every((entry) =>
      entry.ranking.eligibility.flow_only
      && entry.ranking.eligibility.flow_only_passes
      && entry.ranking.eligibility.eligible
      && entry.packet.warnings.includes("flow_only_candidate")
    ), true, "both shortlist fixtures should remain canonically flow-only and otherwise eligible");
    assert.deepEqual(flowOnlyShortlistResult.shortlist.map((entry) => entry.symbol), ["ALFA"]);
    assert.equal(flowOnlyShortlistResult.blocked.length, 1);
    assert.equal(flowOnlyShortlistResult.blocked[0].symbol, "BRAVO");
    assert.deepEqual(flowOnlyShortlistResult.blocked[0].reasons, ["flow_only_cap_exceeded"]);
  } finally {
    if (originalEvidenceShortlistLimit === undefined) delete process.env.SCOUT_EVIDENCE_SHORTLIST_LIMIT;
    else process.env.SCOUT_EVIDENCE_SHORTLIST_LIMIT = originalEvidenceShortlistLimit;
  }

  const heldCandidate = buildCandidate({ symbol: "astro", address: "0xastro", _score: 210 });
  const unheldCandidate = buildCandidate({ symbol: "NOVA", address: "0xnova", _score: 190, category: "ai" });
  const filteredNoCooldown = filterScoutCandidatesAgainstPortfolio([heldCandidate, unheldCandidate], shortlistPortfolio);
  assert.deepEqual(filteredNoCooldown.map((candidate) => candidate.token.symbol).sort(), ["NOVA", "astro"]);
  const filteredWithCooldown = filterScoutCandidatesAgainstPortfolio([heldCandidate, unheldCandidate], coolingShortlistPortfolio);
  assert.deepEqual(filteredWithCooldown.map((candidate) => candidate.token.symbol), ["NOVA"]);

  console.log("verifyScoutRelaxation: ok");
} finally {
  fs.appendFileSync = originalAppendFileSync;
}
