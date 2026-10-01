import assert from "assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { externalizeTradeEvidence, resolveTradeEvidence } from "./tradeEvidence.js";
import { summarizeExecutionSnapshot, projectPersistedTradeOrderRiskRefs } from "../server.js";
import { normalizePaperTrades } from "./reconciliationAccounting.js";
import { buildActionIndex, buildDecisionRows, buildEventIndex, buildTradeAttributionRows } from "./signalAttribution.js";
import { reviewTrade } from "./tradeReviewer.js";
import { collectActionRecords } from "./backtestReplay.js";
import { createOrderLifecycleRecord } from "./orderLifecycle.js";
import { collectOrderRecords } from "./operationsMonitor.js";
import { buildHarvestEvidencePacket } from "./evidencePackets.js";

function makeTempSidecarPath(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    dir,
    sidecarPath: path.join(dir, "trade-evidence.jsonl")
  };
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function cleanup(dirs) {
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function makeExecution(overrides = {}) {
  return {
    decision: "filled",
    fill_price: 1.105,
    decision_price: 1.1,
    quantity: 400,
    requested_quantity: 400,
    requested_notional_usd: 440,
    filled_notional_usd: 440,
    fill_ratio: 1,
    fee_bps: 10,
    slippage_bps: 20,
    fee_usd: 0.44,
    slippage_usd: 0.88,
    liquidity_bucket: "deep",
    liquidity_execution_control: {
      control_id: "lec-1",
      warnings: ["slippage_near_limit"]
    },
    ...overrides
  };
}

function makeLifecycle(orderId, execution, overrides = {}) {
  return {
    order_id: orderId,
    current_state: "filled",
    strategy_version: "paper-v2",
    risk_decision_id: "risk-1",
    evidence_refs: [`${orderId}:evidence`],
    evidence_summary: {
      evidence_packet_id: `ep-${orderId}`,
      quality_score: 87,
      refs_used: [`${orderId}:evidence`],
      highlights: [{ label: "momentum_breakout", source_type: "story" }]
    },
    state_history: [
      { ts: "2026-01-01T10:00:00.000Z", state: "planned", reason: "created" },
      { ts: "2026-01-01T10:00:05.000Z", state: "filled", reason: "simulated_fill" }
    ],
    simulated_execution: execution,
    ...overrides
  };
}

function makeTokenRiskScan(overrides = {}) {
  return {
    token_risk_scan_id: "trs-1",
    decision: "warn",
    blockers: ["ownership_unknown"],
    warnings: ["holder_concentration"],
    evaluated_at: "2026-01-01T09:58:00.000Z",
    market_metadata: {
      liquidity_quality: "high",
      fraud_risk: "low"
    },
    holder_contract_metadata: {
      holder_count: 1200,
      top_holder_pct: 12,
      holder_concentration_pct: 24,
      verified_contract: true,
      ownership_renounced: true,
      proxy_contract: false
    },
    ...overrides
  };
}

function createEmbeddedScenario() {
  const nestedTicketRiskScan = makeTokenRiskScan({
    token_risk_scan_id: "nested-trs-1",
    decision: "pass",
    blockers: [],
    warnings: []
  });
  const buyExecution = makeExecution();
  const sellExecution = makeExecution({
    side: "sell",
    fill_price: 1.375,
    decision_price: 1.37,
    quantity: 400,
    requested_quantity: 400,
    requested_notional_usd: 550,
    filled_notional_usd: 550,
    fee_usd: 0.55,
    slippage_usd: 1.1,
    liquidity_bucket: "mid"
  });
  const buyTrade = {
    trade_id: "buy-trade-1",
    position_id: "position-1",
    candidate_id: "0xabc",
    ts: "2026-01-01T10:00:00.000Z",
    opened_at: "2026-01-01T10:00:00.000Z",
    side: "buy",
    symbol: "ABC",
    contract_address: "0xabc",
    category: "meme",
    quantity: 400,
    price: 1.1,
    cost_usd: 440,
    reason: "entry_breakout",
    trade_lifecycle: "open",
    liquidity_usd: 250000,
    paper_trade_ticket: {
      allocation_usd: 440,
      setup_type: "momentum_breakout",
      approved_size_pct: 0.25,
      source_agent: "scout",
      executor_decision: "reduce",
      risk_decision_ref: { risk_decision_id: "risk-1" },
      token_risk_scan: nestedTicketRiskScan
    },
    order_lifecycle: makeLifecycle("ord-buy-1", buyExecution),
    token_risk_scan: makeTokenRiskScan(),
    simulated_execution: buyExecution
  };
  const sellTrade = {
    trade_id: "sell-trade-1",
    position_id: "position-1",
    candidate_id: "0xabc",
    ts: "2026-01-02T12:00:00.000Z",
    opened_at: "2026-01-01T10:00:00.000Z",
    side: "sell",
    symbol: "ABC",
    contract_address: "0xabc",
    category: "meme",
    quantity: 400,
    price: 1.375,
    proceeds_usd: 549.45,
    gross_proceeds_usd: 550,
    cost_portion_usd: 440,
    pnl_usd: 109.45,
    reason: "target_hit:plan",
    trade_lifecycle: "close",
    liquidity_usd: 250000,
    market_regime: "risk_on",
    paper_trade_ticket: {
      allocation_usd: 440,
      setup_type: "momentum_breakout",
      approved_size_pct: 0.25,
      source_agent: "scout",
      token_risk_scan: nestedTicketRiskScan
    },
    order_lifecycle: makeLifecycle("ord-sell-1", sellExecution),
    token_risk_scan: makeTokenRiskScan({
      token_risk_scan_id: "trs-sell-1",
      blockers: ["honeypot_warning"],
      warnings: ["holder_concentration", "ownership_unknown"]
    }),
    simulated_execution: sellExecution
  };
  const sellAction = {
    trade_id: "sell-trade-1",
    position_id: "position-1",
    candidate_id: "0xabc",
    ts: "2026-01-02T12:00:00.000Z",
    side: "sell",
    symbol: "ABC",
    contract_address: "0xabc",
    category: "meme",
    quantity: 400,
    price: 1.375,
    proceeds_usd: 549.45,
    gross_proceeds_usd: 550,
    pnl_usd: 109.45,
    reason: "target_hit:plan",
    trade_lifecycle: "close",
    order_lifecycle: makeLifecycle("ord-sell-1", sellExecution),
    token_risk_scan: makeTokenRiskScan({
      token_risk_scan_id: "trs-sell-1",
      blockers: ["honeypot_warning"],
      warnings: ["holder_concentration", "ownership_unknown"]
    }),
    simulated_execution: sellExecution
  };
  const portfolio = {
    action_history: [buyTrade, sellAction],
    closed_trades: [sellTrade]
  };
  const reviewEvents = [
    {
      event_id: "risk-evt-1",
      event_type: "risk_decision",
      ts: "2026-01-01T09:59:40.000Z",
      candidate_id: "0xabc",
      position_id: "position-1",
      payload: {
        risk_review: {
          decision: "paper_trade",
          reason_codes: ["passed_checks"],
          approved_size_pct: 0.25
        },
        proposal: {
          setup_type: "momentum_breakout",
          liquidity_data: { liquidity_usd: 250000 }
        }
      }
    },
    {
      event_id: "executor-evt-1",
      event_type: "executor_decision",
      ts: "2026-01-01T09:59:50.000Z",
      candidate_id: "0xabc",
      position_id: "position-1",
      payload: {
        decision: "reduce"
      }
    }
  ];
  const attributionEvents = [
    {
      event_id: "cand-1",
      event_type: "candidate",
      pipeline_run_id: "run-1",
      cycle_id: "cycle-1",
      candidate_id: "0xabc",
      ts: "2026-01-01T09:59:00.000Z",
      actor: "scout",
      payload: {
        setup_type: "momentum_breakout",
        token: {
          symbol: "ABC",
          contract_address: "0xabc",
          category: "meme"
        },
        liquidity_data: {
          liquidity_usd: 250000
        }
      }
    },
    {
      event_id: "risk-1",
      event_type: "risk_decision",
      pipeline_run_id: "run-1",
      cycle_id: "cycle-1",
      candidate_id: "0xabc",
      ts: "2026-01-01T09:59:10.000Z",
      payload: {
        decision: "paper_trade",
        handoff_to_executor: true,
        risk_review: {
          decision: "paper_trade",
          approved_size_pct: 0.25,
          reason_codes: ["passed_checks"]
        },
        proposal: {
          setup_type: "momentum_breakout",
          source_agent: "scout",
          liquidity_data: {
            liquidity_usd: 250000
          }
        }
      }
    },
    {
      event_id: "exec-1",
      event_type: "executor_decision",
      pipeline_run_id: "run-1",
      cycle_id: "cycle-1",
      candidate_id: "0xabc",
      ts: "2026-01-01T09:59:20.000Z",
      payload: {
        decision: "filled"
      }
    }
  ];
  return {
    buyTrade,
    sellTrade,
    sellAction,
    portfolio,
    reviewEvents,
    attributionEvents
  };
}

function createSidecarScenario(baseScenario, sidecarPath) {
  const buyTrade = deepClone(baseScenario.buyTrade);
  const sellTrade = deepClone(baseScenario.sellTrade);
  const sellAction = deepClone(baseScenario.sellAction);
  externalizeTradeEvidence(buyTrade, { sidecarPath });
  externalizeTradeEvidence(sellTrade, { sidecarPath });
  externalizeTradeEvidence(sellAction, { sidecarPath });
  return {
    buyTrade,
    sellTrade,
    sellAction,
    portfolio: {
      action_history: [buyTrade, sellAction],
      closed_trades: [sellTrade]
    }
  };
}

function comparableReplayInput(trade) {
  return {
    trade_id: trade.trade_id || null,
    position_id: trade.position_id || null,
    side: trade.side || null,
    symbol: trade.symbol || null,
    contract_address: trade.contract_address || null,
    price: trade.price ?? null,
    quantity: trade.quantity ?? null,
    reason: trade.reason || null,
    trade_lifecycle: trade.trade_lifecycle || null,
    paper_trade_ticket: trade.paper_trade_ticket || null,
    ts_ms: trade.ts_ms ?? null
  };
}

function stripEvidenceRef(value) {
  if (Array.isArray(value)) return value.map(stripEvidenceRef);
  if (!value || typeof value !== "object") return value;
  const next = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "evidence_ref") continue;
    next[key] = stripEvidenceRef(entry);
  }
  return next;
}

function stripPacketCreatedAt(packet) {
  if (!packet || typeof packet !== "object") return packet;
  const { created_at, ...rest } = packet;
  return rest;
}

const tempDirs = [];

try {
  const embeddedFixture = makeTempSidecarPath("e3d-trade-evidence-embedded-");
  tempDirs.push(embeddedFixture.dir);
  assert.deepEqual(
    resolveTradeEvidence({
      order_lifecycle: { order_id: "ord-1", state: "filled" },
      token_risk_scan: { decision: "pass" },
      simulated_execution: { fill_price: 101.25 }
    }, { sidecarPath: embeddedFixture.sidecarPath }),
    {
      order_lifecycle: { order_id: "ord-1", state: "filled" },
      token_risk_scan: { decision: "pass" },
      simulated_execution: { fill_price: 101.25 }
    }
  );
  assert.deepEqual(
    resolveTradeEvidence({
      order_lifecycle: { order_id: "ord-partial" }
    }, { sidecarPath: embeddedFixture.sidecarPath }),
    {
      order_lifecycle: { order_id: "ord-partial" },
      token_risk_scan: null,
      simulated_execution: null
    }
  );

  const embeddedWinsTrade = {
    trade_id: "embedded-trade",
    evidence_ref: "other-trade",
    order_lifecycle: { order_id: "embedded-order" },
    token_risk_scan: undefined
  };
  const embeddedWinsOptions = {};
  Object.defineProperty(embeddedWinsOptions, "sidecarPath", {
    enumerable: true,
    get() {
      throw new Error("sidecar path should not be accessed for embedded evidence");
    }
  });
  assert.deepEqual(
    resolveTradeEvidence(embeddedWinsTrade, embeddedWinsOptions),
    {
      order_lifecycle: { order_id: "embedded-order" },
      token_risk_scan: null,
      simulated_execution: null
    }
  );

  const sidecarResolveFixture = makeTempSidecarPath("e3d-trade-evidence-sidecar-");
  tempDirs.push(sidecarResolveFixture.dir);
  fs.writeFileSync(sidecarResolveFixture.sidecarPath, [
    JSON.stringify({
      trade_id: "ref-trade-1",
      order_lifecycle: { order_id: "ord-ref-1" },
      token_risk_scan: { decision: "warn" },
      simulated_execution: { fill_price: 88 }
    })
  ].join("\n") + "\n", "utf8");
  assert.deepEqual(
    resolveTradeEvidence({
      trade_id: "different-trade-id",
      evidence_ref: "ref-trade-1"
    }, { sidecarPath: sidecarResolveFixture.sidecarPath }),
    {
      order_lifecycle: { order_id: "ord-ref-1" },
      token_risk_scan: { decision: "warn" },
      simulated_execution: { fill_price: 88 }
    }
  );

  const appendFixture = makeTempSidecarPath("e3d-trade-evidence-append-");
  tempDirs.push(appendFixture.dir);
  const appendCalls = [];
  const appendTrade = {
    trade_id: "append-trade-1",
    order_lifecycle: { order_id: "ord-append-1" }
  };
  externalizeTradeEvidence(appendTrade, {
    sidecarPath: appendFixture.sidecarPath,
    fileOps: {
      append(targetPath, line) {
        appendCalls.push({ kind: "append", targetPath, line });
      },
      fsync(targetPath) {
        appendCalls.push({ kind: "fsync", targetPath });
      }
    }
  });
  assert.equal(appendCalls.length, 2);
  assert.equal(appendCalls[0].kind, "append");
  assert.equal(appendCalls[1].kind, "fsync");
  assert.equal(appendTrade.evidence_ref, "append-trade-1");
  assert.equal(Object.prototype.hasOwnProperty.call(appendTrade, "order_lifecycle"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(appendTrade, "token_risk_scan"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(appendTrade, "simulated_execution"), false);

  const invalidOptions = {};
  Object.defineProperty(invalidOptions, "sidecarPath", {
    enumerable: true,
    get() {
      throw new Error("sidecar path should not be accessed when validation fails");
    }
  });
  assert.throws(() => externalizeTradeEvidence({ trade_id: "" }, invalidOptions), /trade_id/i);
  assert.throws(() => externalizeTradeEvidence({ trade_id: 12 }, invalidOptions), /trade_id/i);
  assert.deepEqual(
    resolveTradeEvidence({ evidence_ref: "missing-ref" }, { sidecarPath: appendFixture.sidecarPath }),
    {
      order_lifecycle: null,
      token_risk_scan: null,
      simulated_execution: null
    }
  );

  const phase2Fixture = makeTempSidecarPath("e3d-trade-evidence-phase2-");
  tempDirs.push(phase2Fixture.dir);
  const embeddedScenario = createEmbeddedScenario();
  const sidecarScenario = createSidecarScenario(embeddedScenario, phase2Fixture.sidecarPath);
  const sidecarOptions = { sidecarPath: phase2Fixture.sidecarPath };

  assert.equal(Object.prototype.hasOwnProperty.call(sidecarScenario.buyTrade, "order_lifecycle"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(sidecarScenario.buyTrade, "simulated_execution"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(sidecarScenario.sellTrade, "token_risk_scan"), false);

  assert.deepEqual(
    projectPersistedTradeOrderRiskRefs(sidecarScenario.sellTrade, sidecarOptions),
    projectPersistedTradeOrderRiskRefs(embeddedScenario.sellTrade)
  );
  assert.deepEqual(
    summarizeExecutionSnapshot([
      embeddedScenario.buyTrade,
      embeddedScenario.sellTrade
    ], null),
    summarizeExecutionSnapshot([
      sidecarScenario.buyTrade,
      sidecarScenario.sellTrade
    ], null, sidecarOptions)
  );

  const embeddedNormalizedTrades = normalizePaperTrades(embeddedScenario.portfolio);
  const sidecarNormalizedTrades = normalizePaperTrades(sidecarScenario.portfolio, sidecarOptions);
  assert.deepEqual(stripEvidenceRef(sidecarNormalizedTrades), stripEvidenceRef(embeddedNormalizedTrades));
  assert.equal(sidecarNormalizedTrades.filter((trade) => trade.simulated_execution).length, 2);
  assert.equal(sidecarNormalizedTrades.filter((trade) => trade.order_lifecycle?.order_id).length, 2);

  const attributionEventIndex = buildEventIndex(embeddedScenario.attributionEvents);
  assert.deepEqual(
    buildTradeAttributionRows(embeddedScenario.portfolio, attributionEventIndex, new Map()),
    buildTradeAttributionRows(sidecarScenario.portfolio, attributionEventIndex, new Map(), sidecarOptions)
  );

  const embeddedActionIndex = buildActionIndex(embeddedScenario.portfolio.action_history);
  const sidecarActionIndex = buildActionIndex(sidecarScenario.portfolio.action_history, sidecarOptions);
  assert.deepEqual(
    buildDecisionRows(attributionEventIndex, embeddedActionIndex),
    buildDecisionRows(attributionEventIndex, sidecarActionIndex, sidecarOptions)
  );

  assert.deepEqual(
    reviewTrade(embeddedScenario.sellTrade, embeddedScenario.reviewEvents, "2026-01-02T12:05:00.000Z"),
    reviewTrade(sidecarScenario.sellTrade, embeddedScenario.reviewEvents, "2026-01-02T12:05:00.000Z", sidecarOptions)
  );

  assert.deepEqual(
    collectOrderRecords(embeddedScenario.portfolio),
    collectOrderRecords(sidecarScenario.portfolio, sidecarOptions)
  );

  const embeddedHarvestPacket = buildHarvestEvidencePacket(embeddedScenario.sellTrade);
  const sidecarHarvestPacket = buildHarvestEvidencePacket(sidecarScenario.sellTrade, sidecarOptions);
  assert.deepEqual(stripPacketCreatedAt(sidecarHarvestPacket), stripPacketCreatedAt(embeddedHarvestPacket));
  assert(embeddedHarvestPacket.blockers.includes("token_risk:honeypot_warning"));
  assert(embeddedHarvestPacket.warnings.includes("token_risk:holder_concentration"));

  const embeddedLifecycle = createOrderLifecycleRecord({
    mode: "research",
    trade: embeddedScenario.buyTrade
  });
  const sidecarLifecycle = createOrderLifecycleRecord({
    mode: "research",
    trade: sidecarScenario.buyTrade,
    ...sidecarOptions
  });
  assert.deepEqual(sidecarLifecycle, embeddedLifecycle);

  const explicitExecution = makeExecution({
    fill_price: 1.21,
    decision_price: 1.2,
    fee_usd: 0.21,
    slippage_usd: 0.42,
    liquidity_bucket: "explicit"
  });
  const explicitInput = {
    mode: "research",
    trade: embeddedScenario.buyTrade,
    execution: explicitExecution
  };
  Object.defineProperty(explicitInput, "sidecarPath", {
    enumerable: true,
    get() {
      throw new Error("sidecar path should not be read when execution is explicit");
    }
  });
  const explicitLifecycle = createOrderLifecycleRecord(explicitInput);
  assert.equal(explicitLifecycle.simulated_execution.fill_price, explicitExecution.fill_price);
  assert.equal(explicitLifecycle.simulated_execution.liquidity_bucket, "explicit");

  const embeddedReplayInputs = collectActionRecords(embeddedScenario.portfolio).map(comparableReplayInput);
  const sidecarReplayInputs = collectActionRecords(sidecarScenario.portfolio, sidecarOptions).map(comparableReplayInput);
  assert.deepEqual(sidecarReplayInputs, embeddedReplayInputs);
  assert.equal(
    collectActionRecords(sidecarScenario.portfolio, sidecarOptions)[0].paper_trade_ticket?.token_risk_scan?.token_risk_scan_id,
    collectActionRecords(embeddedScenario.portfolio)[0].paper_trade_ticket?.token_risk_scan?.token_risk_scan_id
  );

  console.log(JSON.stringify({
    ok: true,
    checked: "trade_evidence_phase_1_and_2",
    consumers: [
      "server",
      "reconciliationAccounting",
      "signalAttribution",
      "tradeReviewer",
      "operationsMonitor",
      "evidencePackets",
      "orderLifecycle",
      "backtestReplay"
    ]
  }, null, 2));
} finally {
  cleanup(tempDirs);
}
