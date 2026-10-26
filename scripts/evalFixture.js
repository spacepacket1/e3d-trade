// Synthetic, fully offline data for the evaluation scripts and their verify checks.
// Builds candidate-snapshot records, settings-ledger records, trade events and
// cycle_start ids for a made-up market. Nothing here reads or writes files.
//
// edge=false: the "system" picks uniformly from each cycle's gated universe (no skill).
// edge=true:  a subset of tokens has positive drift and the system picks them.
import { buildMarketIndex, simulateEntry } from "./baselineCompare.js";
import { CANDIDATE_SNAPSHOT_SCHEMA_VERSION } from "./candidateSnapshots.js";
import { EVAL_SETTINGS_DEFAULTS, resolveExitRules } from "./evalCostModel.js";
import { WETH_ADDRESS } from "./evalData.js";
import { createRng, randInt } from "./evalStats.js";
import { buildSettingsLedgerRecord, computeSettingsHash } from "./settingsHash.js";

function normal(rng) {
  const u = Math.max(1e-12, rng());
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function buildEvalFixture(options = {}) {
  const {
    edge = false,
    seed = "fixture",
    days = 60,
    tokenCount = 30,
    driftTokens = 8,
    drift = 0.008,
    sigma = 0.03,
    gatedPerCycle = 8,
    shortlistedPerCycle = 4,
    tradeProb = 0.55,
    cycleHours = 6,
    start = "2026-01-01T00:00:00.000Z",
    missingCycleStarts = 3
  } = options;
  const rng = createRng(`${seed}:${edge ? "edge" : "null"}`);
  const startMs = Date.parse(start);
  const cycleCount = Math.floor((days * 24) / cycleHours);
  const tokens = Array.from({ length: tokenCount }, (_, i) => ({
    address: `0x${(i + 1).toString(16).padStart(40, "0")}`,
    symbol: `TK${i + 1}`,
    mu: edge && i < driftTokens ? drift : 0,
    liquidity: 2_000_000
  }));
  const prices = tokens.map(() => [1]);
  const eth = [3000];
  for (let c = 1; c < cycleCount; c += 1) {
    tokens.forEach((token, i) => prices[i].push(prices[i][c - 1] * Math.exp(token.mu + sigma * normal(rng))));
    eth.push(eth[c - 1] * Math.exp(0.02 * normal(rng)));
  }

  const settingsA = { ...EVAL_SETTINGS_DEFAULTS, paper_mode: true, min_liquidity_usd: 100000 };
  const settingsB = { ...settingsA, default_stop_distance_pct: 0.25 };
  const hashA = computeSettingsHash(settingsA);
  const hashB = computeSettingsHash(settingsB);
  const switchCycle = Math.floor(cycleCount / 2);
  const settingsLedgerRecords = [
    buildSettingsLedgerRecord(settingsA, new Date(startMs).toISOString()),
    buildSettingsLedgerRecord(settingsB, new Date(startMs + switchCycle * cycleHours * 3600e3).toISOString())
  ];

  const snapshotRecords = [];
  const cycleStarts = [];
  const universes = [];
  for (let c = 0; c < cycleCount; c += 1) {
    const ts = new Date(startMs + c * cycleHours * 3600e3).toISOString();
    const cycleId = `fixture-cycle-${c}`;
    const settingsHash = c < switchCycle ? hashA : hashB;
    cycleStarts.push({ cycle_id: cycleId, ts });
    const order = tokens.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i -= 1) {
      const j = randInt(rng, i + 1);
      [order[i], order[j]] = [order[j], order[i]];
    }
    const gated = order.slice(0, gatedPerCycle);
    const shortlisted = order.slice(gatedPerCycle, gatedPerCycle + shortlistedPerCycle);
    universes.push({ c, ts, cycleId, settingsHash, gated });
    const base = { schema_version: CANDIDATE_SNAPSHOT_SCHEMA_VERSION, ts, cycle_id: cycleId, pipeline_run_id: "fixture-run", cycle_index: c, regime: "neutral", settings_hash: settingsHash };
    snapshotRecords.push({ ...base, record_type: "cycle", eth_price_usd: eth[c], candidate_count: gated.length + shortlisted.length, universe_captured: true });
    const stageFor = (k) => (k === 0 ? "approved" : k < 4 ? "gate_rejected" : "risk_vetoed");
    gated.forEach((i, k) => snapshotRecords.push({
      ...base, record_type: "candidate", token_address: tokens[i].address, symbol: tokens[i].symbol, stage: stageFor(k),
      reason_codes: [], price_usd: prices[i][c], liquidity_usd: tokens[i].liquidity, market_cap_usd: 5e7, volume_24h_usd: 1e6,
      slippage_bps: null, fraud_risk: 10, confidence: 70, evidence_count: 3
    }));
    shortlisted.forEach((i) => snapshotRecords.push({
      ...base, record_type: "candidate", token_address: tokens[i].address, symbol: tokens[i].symbol, stage: "shortlisted",
      reason_codes: [], price_usd: prices[i][c], liquidity_usd: tokens[i].liquidity
    }));
    snapshotRecords.push({ ...base, record_type: "price_marks", marks: tokens.map((t, i) => [t.address, prices[i][c], t.liquidity]) });
  }
  for (let k = 0; k < missingCycleStarts; k += 1) {
    cycleStarts.push({ cycle_id: `fixture-missing-${k}`, ts: new Date(startMs + (k + 0.5) * cycleHours * 3600e3).toISOString() });
  }

  const market = buildMarketIndex(snapshotRecords);
  const tradeEvents = [];
  const endMs = startMs + (cycleCount - 1) * cycleHours * 3600e3;
  for (const u of universes) {
    if (rng() >= tradeProb) continue;
    let pick;
    if (edge) {
      const drifting = u.gated.filter((i) => i < driftTokens);
      if (!drifting.length) continue;
      pick = drifting[randInt(rng, drifting.length)];
    } else {
      pick = u.gated[randInt(rng, u.gated.length)];
    }
    const holdMs = (2 + randInt(rng, 4)) * 24 * 3600e3;
    const entryMs = Date.parse(u.ts);
    if (entryMs + holdMs > endMs) continue;
    const token = tokens[pick];
    const sim = simulateEntry({
      points: market.series.get(token.address), entryMs, entryPrice: prices[pick][u.c], entryLiquidity: token.liquidity,
      entrySlippage: null, holdMs, rules: resolveExitRules(u.c < switchCycle ? settingsA : settingsB), toleranceMs: 12 * 3600e3
    });
    if (!sim) continue;
    const positionId = `fixture-pos-${u.c}`;
    const cost = 1000;
    // Mark the picked candidate as bought in the snapshot.
    const rec = snapshotRecords.find((r) => r.record_type === "candidate" && r.cycle_id === u.cycleId && r.token_address === token.address);
    if (rec) rec.stage = "bought";
    tradeEvents.push({ ts: u.ts, cycle_id: u.cycleId, side: "buy", symbol: token.symbol, contract_address: token.address, position_id: positionId,
      trade_id: `${positionId}-buy`, trade_lifecycle: "open", cash_debit_usd: cost, cost_portion_usd: null, pnl_usd: null, price: prices[pick][u.c], settings_hash: u.settingsHash });
    tradeEvents.push({ ts: new Date(entryMs + holdMs).toISOString(), cycle_id: null, side: "sell", symbol: token.symbol, contract_address: token.address, position_id: positionId,
      trade_id: `${positionId}-sell`, trade_lifecycle: "close", cash_debit_usd: null, cost_portion_usd: cost, pnl_usd: sim.net_return * cost, price: null, settings_hash: u.settingsHash });
  }
  return { snapshotRecords, settingsLedgerRecords, tradeEvents, cycleStarts, hashes: [hashA, hashB], wethAddress: WETH_ADDRESS };
}
