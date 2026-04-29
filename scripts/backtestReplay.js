import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import {
  EXECUTION_MODEL_VERSION,
  simulateExecution,
  simulateIdealDecisionFill
} from "./executionSimulator.js";
import { createOrderLifecycleRecord } from "./orderLifecycle.js";
import { evaluateRiskDecision, buildRiskDecisionRef } from "./riskEngine.js";
import { buildTokenRiskScan, buildTokenRiskScanRef } from "./tokenRiskScanner.js";
import { buildMarketDataQuality, buildMarketDataQualityRef, summarizeMarketDataQuality } from "./marketDataQuality.js";
import { recordOperatorAction } from "./auditTrail.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const PORTFOLIO_FILE = path.join(ROOT, "portfolio.json");
const PIPELINE_LOG = path.join(ROOT, "logs", "pipeline.jsonl");
const BACKTEST_EVENT_LOG = path.join(ROOT, "logs", "backtest-events.jsonl");
const BACKTEST_REPORT_DIR = path.join(ROOT, "reports", "backtests");
const DEFAULT_INITIAL_CASH_USD = 100000;
const DEFAULT_FEE_BPS = 10;
const DEFAULT_SLIPPAGE_BPS = 50;
const ETH_SYMBOLS = new Set(["ETH", "WETH"]);
const WETH_ADDRESS = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";

function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function readJsonLines(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}

function pct(value) {
  return round(value * 100, 4);
}

function optionalMs(value) {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function cleanAddress(value) {
  return String(value || "").trim().toLowerCase();
}

function stableStringify(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function formatReportTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join("") + "-" + [pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds())].join("");
}

function isEthLike(record) {
  const symbol = String(record?.symbol || record?.token?.symbol || "").trim().toUpperCase();
  const address = cleanAddress(record?.contract_address || record?.address || record?.token?.contract_address);
  return ETH_SYMBOLS.has(symbol) || address === WETH_ADDRESS;
}

function extractPrice(record) {
  return toNum(
    record?.price,
    toNum(record?.current_price,
      toNum(record?.price_usd,
        toNum(record?.priceUSD,
          toNum(record?.market_data?.current_price,
            toNum(record?.market_data?.price_usd, NaN)))))
  );
}

function normalizeTrade(record) {
  const tsMs = optionalMs(record?.ts);
  if (tsMs == null) return null;
  const side = String(record?.side || "").toLowerCase();
  if (side !== "buy" && side !== "sell") return null;
  const symbol = String(record.symbol || "").trim();
  if (!symbol) return null;

  return {
    ...record,
    ts_ms: tsMs,
    side,
    symbol,
    contract_address: cleanAddress(record.contract_address),
    price: extractPrice(record),
    trade_id: record.trade_id || sha256(stableStringify(record)).slice(0, 32)
  };
}

function collectActionRecords(portfolio) {
  const actions = Array.isArray(portfolio.action_history) ? portfolio.action_history : [];
  const closed = Array.isArray(portfolio.closed_trades) ? portfolio.closed_trades : [];
  const seen = new Set();
  return [...actions, ...closed]
    .map(normalizeTrade)
    .filter(Boolean)
    .filter((trade) => {
      if (seen.has(trade.trade_id)) return false;
      seen.add(trade.trade_id);
      return true;
    })
    .sort((a, b) => a.ts_ms - b.ts_ms || String(a.trade_id).localeCompare(String(b.trade_id)));
}

function buildInputHash({ portfolio, trades, strategyVersion, seed, feeBps, slippageBps, executionModelVersion }) {
  return sha256(stableStringify({
    strategyVersion,
    seed,
    feeBps,
    slippageBps,
    executionModelVersion,
    portfolio_settings: portfolio.settings || {},
    trades: trades.map((trade) => ({
      ts: trade.ts,
      side: trade.side,
      symbol: trade.symbol,
      contract_address: trade.contract_address,
      reason: trade.reason,
      quantity: trade.quantity,
      price: trade.price,
      cost_usd: trade.cost_usd,
      proceeds_usd: trade.proceeds_usd,
      fraction: trade.fraction,
      trade_lifecycle: trade.trade_lifecycle,
      trade_id: trade.trade_id,
      paper_trade_ticket: trade.paper_trade_ticket || null
    }))
  }));
}

function isFillAccepted(fill) {
  return fill?.decision === "filled" || fill?.decision === "partially_filled";
}

function executionForTrade(trade, options, overrides = {}) {
  const fillFn = options.idealExecution ? simulateIdealDecisionFill : simulateExecution;
  return fillFn({ ...trade, ...overrides }, {
    seed: options.seed,
    feeBps: options.feeBps,
    slippageBps: options.slippageBps,
    modelVersion: options.executionModelVersion || EXECUTION_MODEL_VERSION
  });
}

function scaleExecutionFill(fill, grossNotionalUsd) {
  const gross = Math.max(0, Math.min(toNum(fill.filled_notional_usd, 0), grossNotionalUsd));
  if (!(gross > 0) || gross === toNum(fill.filled_notional_usd, 0)) return fill;
  const requested = Math.max(toNum(fill.requested_notional_usd, gross), gross);
  const feeUsd = gross * toNum(fill.fee_bps, 0) / 10000;
  const quantity = toNum(fill.fill_price, 0) > 0 ? gross / fill.fill_price : 0;
  const slippageUsd = Math.abs(quantity * (toNum(fill.fill_price, 0) - toNum(fill.decision_price, 0)));
  return {
    ...fill,
    decision: gross >= requested ? "filled" : "partially_filled",
    filled_notional_usd: round(gross, 2),
    quantity,
    fee_usd: round(feeUsd, 2),
    slippage_usd: round(slippageUsd, 2),
    fill_ratio: round(gross / requested, 6),
    rejection_ratio: round(1 - gross / requested, 6)
  };
}

function markPortfolio(state, priceMap) {
  let marketValue = 0;
  let costBasis = 0;
  for (const pos of Object.values(state.positions)) {
    const priceKey = pos.contract_address || pos.symbol;
    const mark = toNum(priceMap.get(priceKey), toNum(priceMap.get(pos.symbol), pos.avg_entry_price));
    pos.current_price = mark;
    pos.market_value_usd = pos.quantity * mark;
    marketValue += pos.market_value_usd;
    costBasis += pos.cost_basis_usd;
  }
  return {
    cash_usd: state.cash_usd,
    market_value_usd: marketValue,
    cost_basis_usd: costBasis,
    equity_usd: state.cash_usd + marketValue,
    unrealized_pnl_usd: marketValue - costBasis
  };
}

function applyBuy(state, trade, options) {
  const price = toNum(trade.price, 0);
  const notional = toNum(trade.cost_usd || trade.paper_trade_ticket?.allocation_usd, 0);
  if (!(price > 0) || !(notional > 0) || state.cash_usd < notional) {
    return { decision: "rejected", reason: "invalid_buy_or_insufficient_cash" };
  }

  let execution = executionForTrade(trade, options, {
    side: "buy",
    decision_price: price,
    notional_usd: notional
  });
  if (!isFillAccepted(execution)) return { ...execution, reason: execution.rejection_reason || "execution_rejected" };

  const feeRate = toNum(execution.fee_bps, 0) / 10000;
  const affordableGross = feeRate >= 0 ? state.cash_usd / (1 + feeRate) : state.cash_usd;
  execution = scaleExecutionFill(execution, affordableGross);

  const fillPrice = toNum(execution.fill_price, price);
  const grossNotional = toNum(execution.filled_notional_usd, 0);
  const feeUsd = toNum(execution.fee_usd, 0);
  const slippageUsd = toNum(execution.slippage_usd, 0);
  const totalCashUsed = grossNotional + feeUsd;
  const quantity = toNum(execution.quantity, fillPrice > 0 ? grossNotional / fillPrice : 0);
  const key = trade.contract_address || trade.symbol;
  const existing = state.positions[key];

  if (!(quantity > 0) || !(grossNotional > 0) || state.cash_usd < totalCashUsed - 1e-8) {
    return { ...execution, decision: "rejected", reason: "zero_affordable_fill" };
  }

  state.cash_usd -= totalCashUsed;
  state.turnover_usd += grossNotional;
  state.fee_drag_usd += feeUsd;
  state.slippage_drag_usd += slippageUsd;

  if (existing) {
    const totalQty = existing.quantity + quantity;
    existing.cost_basis_usd += grossNotional + feeUsd;
    existing.quantity = totalQty;
    existing.avg_entry_price = totalQty > 0 ? existing.cost_basis_usd / totalQty : fillPrice;
    existing.current_price = fillPrice;
    existing.market_value_usd = totalQty * fillPrice;
    existing.last_updated_at = trade.ts;
  } else {
    state.positions[key] = {
      symbol: trade.symbol,
      contract_address: trade.contract_address || null,
      category: trade.category || "unknown",
      quantity,
      avg_entry_price: (grossNotional + feeUsd) / quantity,
      cost_basis_usd: grossNotional + feeUsd,
      current_price: fillPrice,
      market_value_usd: quantity * fillPrice,
      opened_at: trade.ts,
      last_updated_at: trade.ts,
      strategy_version: options.strategyVersion
    };
  }

  state.action_history.push({
    ts: trade.ts,
    trade_id: trade.trade_id,
    side: "buy",
    symbol: trade.symbol,
    contract_address: trade.contract_address || null,
    category: trade.category || "unknown",
    cost_usd: grossNotional,
    quantity,
    price: fillPrice,
    reason: trade.reason || "replay_buy",
    trade_lifecycle: "open"
  });

  return {
    decision: execution.decision,
    side: "buy",
    gross_notional_usd: grossNotional,
    effective_notional_usd: grossNotional,
    fee_usd: feeUsd,
    slippage_usd: slippageUsd,
    quantity,
    fill_price: fillPrice,
    execution
  };
}

function applySell(state, trade, options) {
  const key = trade.contract_address || trade.symbol;
  const posKey = state.positions[key]
    ? key
    : Object.entries(state.positions).find(([, item]) => item.symbol === trade.symbol)?.[0];
  const pos = posKey ? state.positions[posKey] : null;
  const price = toNum(trade.price, 0);
  if (!pos || !(price > 0)) return { decision: "rejected", reason: "missing_position_or_invalid_price" };

  const fraction = trade.trade_lifecycle === "close"
    ? 1
    : Math.max(0, Math.min(1, toNum(trade.fraction, 0) || (toNum(trade.quantity, 0) / Math.max(pos.quantity, 1e-12))));
  const quantity = Math.min(pos.quantity, pos.quantity * fraction);
  if (!(quantity > 0)) return { decision: "rejected", reason: "zero_sell_quantity" };

  const execution = executionForTrade(trade, options, {
    side: "sell",
    decision_price: price,
    notional_usd: quantity * price,
    quantity
  });
  if (!isFillAccepted(execution)) return { ...execution, reason: execution.rejection_reason || "execution_rejected" };

  const filledQuantity = Math.min(pos.quantity, toNum(execution.quantity, quantity));
  if (!(filledQuantity > 0)) return { ...execution, decision: "rejected", reason: "zero_sell_fill" };

  const fillPrice = toNum(execution.fill_price, price);
  const grossProceeds = filledQuantity * fillPrice;
  const feeUsd = toNum(execution.fee_usd, grossProceeds * options.feeBps / 10000);
  const slippageUsd = toNum(execution.slippage_usd, 0);
  const netProceeds = Math.max(0, grossProceeds - feeUsd);
  const costPortion = pos.cost_basis_usd * (filledQuantity / pos.quantity);
  const pnl = netProceeds - costPortion;

  state.cash_usd += netProceeds;
  state.realized_pnl_usd += pnl;
  state.turnover_usd += grossProceeds;
  state.fee_drag_usd += feeUsd;
  state.slippage_drag_usd += slippageUsd;
  const closedTrade = {
    ts: trade.ts,
    trade_id: trade.trade_id,
    side: "sell",
    symbol: pos.symbol,
    contract_address: pos.contract_address,
    category: pos.category || "unknown",
    reason: trade.reason || "replay_sell",
    quantity: filledQuantity,
    price: fillPrice,
    decision_price: price,
    gross_proceeds_usd: grossProceeds,
    net_proceeds_usd: netProceeds,
    cost_portion_usd: costPortion,
    pnl_usd: pnl,
    trade_lifecycle: filledQuantity >= pos.quantity - 1e-12 ? "close" : "partial_sell",
    source_trade_id: trade.trade_id,
    simulated_execution: execution
  };
  state.closed_trades.push(closedTrade);
  state.action_history.push({
    ts: trade.ts,
    trade_id: trade.trade_id,
    side: "sell",
    symbol: pos.symbol,
    contract_address: pos.contract_address,
    category: pos.category || "unknown",
    proceeds_usd: netProceeds,
    gross_proceeds_usd: grossProceeds,
    quantity: filledQuantity,
    price: fillPrice,
    reason: trade.reason || "replay_sell",
    trade_lifecycle: closedTrade.trade_lifecycle,
    pnl_usd: pnl
  });

  pos.quantity -= filledQuantity;
  pos.cost_basis_usd -= costPortion;
  pos.current_price = fillPrice;
  pos.market_value_usd = pos.quantity * fillPrice;
  pos.last_updated_at = trade.ts;

  if (pos.quantity <= 1e-12 || pos.market_value_usd < 1) {
    delete state.positions[posKey];
  }

  return {
    decision: execution.decision,
    side: "sell",
    gross_notional_usd: grossProceeds,
    net_proceeds_usd: netProceeds,
    cost_portion_usd: costPortion,
    realized_pnl_usd: pnl,
    fee_usd: feeUsd,
    slippage_usd: slippageUsd,
    quantity: filledQuantity,
    fill_price: fillPrice,
    execution
  };
}

function nextMarkPrice(trades, index, trade) {
  const key = trade.contract_address || trade.symbol;
  for (let i = index + 1; i < trades.length; i++) {
    const candidate = trades[i];
    if ((candidate.contract_address || candidate.symbol) === key || candidate.symbol === trade.symbol) {
      const price = toNum(candidate.price, 0);
      if (price > 0) return price;
    }
  }
  return null;
}

function replayTrades(trades, options) {
  const state = {
    cash_usd: options.initialCashUsd,
    positions: {},
    closed_trades: [],
    action_history: [],
    realized_pnl_usd: 0,
    turnover_usd: 0,
    fee_drag_usd: 0,
    slippage_drag_usd: 0
  };
  const priceMap = new Map();
  const events = [];
  const equityCurve = [];
  let peakEquity = options.initialCashUsd;

  equityCurve.push({ ts: trades[0]?.ts || options.generatedAt, equity_usd: options.initialCashUsd, drawdown_pct: 0 });

  for (let i = 0; i < trades.length; i++) {
    const trade = trades[i];
    if (trade.price > 0) {
      priceMap.set(trade.contract_address || trade.symbol, trade.price);
      priceMap.set(trade.symbol, trade.price);
    }

    const enrichedTrade = {
      ...trade,
      final_mark_price: nextMarkPrice(trades, i, trade)
    };
    const marketDataQuality = buildMarketDataQuality(enrichedTrade, { evaluated_at: trade.ts });
    const marketDataQualityRef = buildMarketDataQualityRef(marketDataQuality, { context: "backtest_replay" });
    const riskDecision = evaluateRiskDecision({
      mode: "research",
      enforcement_mode: "audit_only",
      evaluated_at: trade.ts,
      portfolio: state,
      intent: {
        side: trade.side,
        symbol: trade.symbol,
        contract_address: trade.contract_address || null,
        category: trade.category || null,
        strategy_version: trade.strategy_version || options.strategyVersion,
        setup_type: trade.paper_trade_ticket?.setup_type || null,
        requested_notional_usd: toNum(trade.cost_usd, toNum(trade.proceeds_usd, toNum(trade.paper_trade_ticket?.allocation_usd, 0))),
        requested_quantity: toNum(trade.quantity, 0),
        liquidity_usd: toNum(marketDataQuality.normalized?.liquidity_usd, 0),
        spread_bps: toNum(marketDataQuality.normalized?.spread_bps, 0),
        slippage_bps: toNum(marketDataQuality.normalized?.slippage_bps, 0),
        market_regime: "research",
        source_trade_id: trade.trade_id,
        market_data_quality_id: marketDataQuality.data_quality_id,
        market_data_quality_blockers: marketDataQuality.blockers,
        market_data_quality_warnings: marketDataQuality.warnings
      },
      analytics: {
        evaluated_at: trade.ts,
        market_regime: "research",
        day_start_equity_usd: equityCurve.find((point) => String(point.ts || "").slice(0, 10) === String(trade.ts || "").slice(0, 10))?.equity_usd || options.initialCashUsd
      }
    });
    const riskDecisionRef = buildRiskDecisionRef(riskDecision, { pipeline_run_id: options.runId || null });
    const fill = trade.side === "buy" ? applyBuy(state, enrichedTrade, options) : applySell(state, enrichedTrade, options);
    const mark = markPortfolio(state, priceMap);
    peakEquity = Math.max(peakEquity, mark.equity_usd);
    const drawdownPct = peakEquity > 0 ? (peakEquity - mark.equity_usd) / peakEquity : 0;
    equityCurve.push({ ts: trade.ts, equity_usd: mark.equity_usd, drawdown_pct: drawdownPct });
    const order = createOrderLifecycleRecord({
      mode: "research",
      strategyVersion: options.strategyVersion,
      trade: enrichedTrade,
      execution: fill.execution || (fill.model_version ? fill : null),
      source_trade_id: trade.trade_id,
      planned_at: trade.ts,
      portfolio_mutation_ref: {
        type: "replay_portfolio",
        replay_event_index: i,
        portfolio_json_mutated: false
      },
      signal_snapshot_ref: trade.signal_snapshot_ref || null,
      risk_decision_ref: trade.risk_decision_ref || trade.paper_trade_ticket?.risk_decision_ref || riskDecisionRef,
      sizing_decision_ref: trade.sizing_decision_ref || trade.paper_trade_ticket?.position_sizing || null,
      context: {
        replay_run_id: options.runId || null,
        seed: options.seed,
        execution_model_version: options.executionModelVersion || EXECUTION_MODEL_VERSION,
        data_quality_id: marketDataQuality.data_quality_id
      }
    });
    const tokenRiskScan = buildTokenRiskScan({
      evaluated_at: trade.ts,
      mode: "research",
      side: trade.side,
      symbol: trade.symbol,
      contract_address: trade.contract_address || null,
      category: trade.category || null,
      candidate_id: trade.candidate_id || null,
      position_id: trade.position_id || null,
      trade_id: null,
      source_trade_id: trade.trade_id,
      order_id: order.order_id,
      risk_decision_id: riskDecision.risk_decision_id,
      risk_decision_ref: riskDecisionRef,
      signal_snapshot_ref: trade.signal_snapshot_ref || null,
      token: {
        symbol: trade.symbol,
        contract_address: trade.contract_address || null,
        category: trade.category || null,
        current_price: trade.price,
        liquidity_usd: toNum(trade.paper_trade_ticket?.liquidity_usd, toNum(trade.last_market_snapshot?.liquidity_data?.liquidity_usd, 0)),
        liquidity_quality: trade.paper_trade_ticket?.token_risk_scan?.market_metadata?.liquidity_quality ?? trade.last_market_snapshot?.liquidity_quality ?? null,
        fraud_risk: trade.paper_trade_ticket?.token_risk_scan?.market_metadata?.fraud_risk ?? trade.last_market_snapshot?.fraud_risk ?? null,
        spread_bps: toNum(trade.paper_trade_ticket?.spread_bps, toNum(trade.last_market_snapshot?.execution_data?.spread_bps, 0)),
        slippage_bps: toNum(trade.paper_trade_ticket?.max_slippage_bps, toNum(trade.last_market_snapshot?.execution_data?.estimated_slippage_bps, 0)),
        holder_count: trade.paper_trade_ticket?.token_risk_scan?.holder_contract_metadata?.holder_count ?? null,
        top_holder_pct: trade.paper_trade_ticket?.token_risk_scan?.holder_contract_metadata?.top_holder_pct ?? null,
        holder_concentration_pct: trade.paper_trade_ticket?.token_risk_scan?.holder_contract_metadata?.holder_concentration_pct ?? null,
        verified_contract: trade.paper_trade_ticket?.token_risk_scan?.holder_contract_metadata?.verified_contract ?? null,
        ownership_renounced: trade.paper_trade_ticket?.token_risk_scan?.holder_contract_metadata?.ownership_renounced ?? null,
        proxy_contract: trade.paper_trade_ticket?.token_risk_scan?.holder_contract_metadata?.proxy_contract ?? null
      },
      market_data: trade.last_market_snapshot?.market_data || null,
      liquidity_data: trade.last_market_snapshot?.liquidity_data || null,
      execution_data: trade.last_market_snapshot?.execution_data || null
    });
    order.context = {
      ...(order.context || {}),
      token_risk_scan_id: tokenRiskScan.token_risk_scan_id,
      data_quality_id: marketDataQuality.data_quality_id
    };
    order.market_data_quality_ref = marketDataQualityRef;
    order.token_risk_scan_ref = buildTokenRiskScanRef(tokenRiskScan, { report_id: options.runId || null });
    fill.order_id = order.order_id;
    if (fill.execution) {
      fill.execution.order_id = order.order_id;
      if (fill.execution.liquidity_execution_control) {
        fill.execution.liquidity_execution_control.order_id = order.order_id;
      }
    }
    events.push({
      ts: trade.ts,
      order_id: order.order_id,
      source_trade_id: trade.trade_id,
      symbol: trade.symbol,
      contract_address: trade.contract_address || null,
      side: trade.side,
      reason: trade.reason || null,
      replay_decision: fill.decision,
      risk_decision: riskDecision,
      risk_decision_ref: riskDecisionRef,
      data_quality_id: marketDataQuality.data_quality_id,
      market_data_quality_ref: marketDataQualityRef,
      market_data_quality: marketDataQuality,
      token_risk_scan_id: tokenRiskScan.token_risk_scan_id,
      token_risk_scan_ref: buildTokenRiskScanRef(tokenRiskScan, { report_id: options.runId || null }),
      token_risk_scan: tokenRiskScan,
      execution_control_id: fill.execution?.execution_control_id || fill.execution?.liquidity_execution_control?.control_id || null,
      quote_id: fill.execution?.quote_id || fill.execution?.liquidity_execution_control?.quote_id || null,
      liquidity_execution_control: fill.execution?.liquidity_execution_control || null,
      order,
      simulated_execution: fill.execution || (fill.model_version ? fill : null),
      fill,
      portfolio_snapshot: {
        cash_usd: mark.cash_usd,
        equity_usd: mark.equity_usd,
        open_positions: Object.keys(state.positions).length
      }
    });
  }

  const finalMark = markPortfolio(state, priceMap);
  return { state, events, equityCurve, finalMark };
}

function average(values) {
  const nums = values.filter((value) => Number.isFinite(value));
  if (!nums.length) return null;
  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

function stddev(values) {
  const avg = average(values);
  if (avg == null) return null;
  const variance = average(values.map((value) => (value - avg) ** 2));
  return variance == null ? null : Math.sqrt(variance);
}

function buildMetrics(replay, initialCashUsd, startMs, endMs) {
  const closed = replay.state.closed_trades;
  const wins = closed.filter((trade) => trade.pnl_usd > 0);
  const losses = closed.filter((trade) => trade.pnl_usd < 0);
  const grossProfit = wins.reduce((sum, trade) => sum + trade.pnl_usd, 0);
  const grossLoss = losses.reduce((sum, trade) => sum + trade.pnl_usd, 0);
  const finalEquity = replay.finalMark.equity_usd;
  const totalReturn = initialCashUsd > 0 ? (finalEquity - initialCashUsd) / initialCashUsd : 0;
  const days = startMs != null && endMs != null ? Math.max(0, (endMs - startMs) / 86400000) : 0;
  const returns = replay.equityCurve.slice(1).map((point, index) => {
    const prev = replay.equityCurve[index]?.equity_usd;
    return prev > 0 ? (point.equity_usd - prev) / prev : 0;
  });
  const downside = returns.filter((value) => value < 0);
  const avgReturn = average(returns) ?? 0;
  const returnStddev = stddev(returns);
  const downsideStddev = stddev(downside);
  const avgEquity = average(replay.equityCurve.map((point) => point.equity_usd)) || initialCashUsd;

  return {
    initial_equity_usd: round(initialCashUsd),
    final_equity_usd: round(finalEquity),
    total_return_pct: pct(totalReturn),
    cagr_pct: days >= 1 ? pct((finalEquity / initialCashUsd) ** (365 / days) - 1) : null,
    realized_pnl_usd: round(replay.state.realized_pnl_usd),
    unrealized_pnl_usd: round(replay.finalMark.unrealized_pnl_usd),
    gross_profit_usd: round(grossProfit),
    gross_loss_usd: round(grossLoss),
    profit_factor: grossLoss < 0 ? round(grossProfit / Math.abs(grossLoss), 4) : (grossProfit > 0 ? null : 0),
    max_drawdown_pct: pct(Math.max(0, ...replay.equityCurve.map((point) => point.drawdown_pct || 0))),
    win_rate_pct: closed.length ? pct(wins.length / closed.length) : 0,
    closed_trade_count: closed.length,
    average_win_usd: round(average(wins.map((trade) => trade.pnl_usd)) ?? 0),
    average_loss_usd: round(average(losses.map((trade) => trade.pnl_usd)) ?? 0),
    turnover_usd: round(replay.state.turnover_usd),
    turnover_ratio: avgEquity > 0 ? round(replay.state.turnover_usd / avgEquity, 4) : 0,
    fee_drag_usd: round(replay.state.fee_drag_usd),
    slippage_drag_usd: round(replay.state.slippage_drag_usd),
    fee_slippage_drag_usd: round(replay.state.fee_drag_usd + replay.state.slippage_drag_usd),
    sharpe_like: returnStddev && returnStddev > 0 ? round(avgReturn / returnStddev, 4) : null,
    sortino_like: downsideStddev && downsideStddev > 0 ? round(avgReturn / downsideStddev, 4) : null
  };
}

function buildExecutionQuality(events) {
  const executions = events
    .map((event) => event.simulated_execution || event.fill?.execution || null)
    .filter(Boolean);
  const accepted = executions.filter(isFillAccepted);
  const rejected = executions.filter((execution) => execution.decision === "rejected");
  const avg = (key) => round(average(accepted.map((execution) => toNum(execution[key], NaN))) ?? 0, 4);
  const sum = (key) => round(executions.reduce((total, execution) => total + toNum(execution[key], 0), 0), 2);
  const byToken = new Map();

  for (const event of events) {
    const execution = event.simulated_execution || event.fill?.execution || null;
    if (!execution) continue;
    const key = event.symbol || "unknown";
    const group = byToken.get(key) || {
      symbol: key,
      decision_count: 0,
      accepted_count: 0,
      rejected_count: 0,
      requested_notional_usd: 0,
      filled_notional_usd: 0,
      fee_usd: 0,
      slippage_usd: 0,
      slippage_bps_values: [],
      fill_ratio_values: []
    };
    group.decision_count += 1;
    if (isFillAccepted(execution)) group.accepted_count += 1;
    if (execution.decision === "rejected") group.rejected_count += 1;
    group.requested_notional_usd += toNum(execution.requested_notional_usd, 0);
    group.filled_notional_usd += toNum(execution.filled_notional_usd, 0);
    group.fee_usd += toNum(execution.fee_usd, 0);
    group.slippage_usd += toNum(execution.slippage_usd, 0);
    if (Number.isFinite(toNum(execution.slippage_bps, NaN))) group.slippage_bps_values.push(toNum(execution.slippage_bps, 0));
    if (Number.isFinite(toNum(execution.fill_ratio, NaN))) group.fill_ratio_values.push(toNum(execution.fill_ratio, 0));
    byToken.set(key, group);
  }

  return {
    model_version: executions[0]?.model_version || EXECUTION_MODEL_VERSION,
    decision_count: executions.length,
    accepted_count: accepted.length,
    filled_count: accepted.filter((execution) => execution.decision === "filled").length,
    partial_fill_count: accepted.filter((execution) => execution.decision === "partially_filled").length,
    rejected_count: rejected.length,
    fill_ratio: executions.length ? round(accepted.reduce((total, execution) => total + toNum(execution.fill_ratio, 0), 0) / executions.length, 6) : 0,
    rejection_ratio: executions.length ? round(rejected.length / executions.length, 6) : 0,
    average_slippage_bps: avg("slippage_bps"),
    average_fee_bps: avg("fee_bps"),
    average_price_degradation_bps: avg("price_degradation_bps"),
    average_price_improvement_bps: avg("price_improvement_bps"),
    average_time_to_fill_ms: round(average(accepted.map((execution) => toNum(execution.time_to_fill_ms, NaN))) ?? 0, 2),
    average_post_fill_adverse_movement_bps: round(average(accepted.map((execution) => toNum(execution.post_fill_adverse_movement_bps, NaN))) ?? 0, 4),
    requested_notional_usd: sum("requested_notional_usd"),
    filled_notional_usd: sum("filled_notional_usd"),
    fee_usd: sum("fee_usd"),
    slippage_usd: sum("slippage_usd"),
    by_token: [...byToken.values()]
      .map((group) => ({
        symbol: group.symbol,
        decision_count: group.decision_count,
        accepted_count: group.accepted_count,
        rejected_count: group.rejected_count,
        fill_ratio: group.decision_count ? round(group.fill_ratio_values.reduce((a, b) => a + b, 0) / group.decision_count, 6) : 0,
        rejection_ratio: group.decision_count ? round(group.rejected_count / group.decision_count, 6) : 0,
        requested_notional_usd: round(group.requested_notional_usd),
        filled_notional_usd: round(group.filled_notional_usd),
        fee_usd: round(group.fee_usd),
        slippage_usd: round(group.slippage_usd),
        average_slippage_bps: round(average(group.slippage_bps_values) ?? 0, 4)
      }))
      .sort((a, b) => b.requested_notional_usd - a.requested_notional_usd)
  };
}

function buildExecutionControlSummary(events) {
  const controls = events
    .map((event) => event.liquidity_execution_control || event.simulated_execution?.liquidity_execution_control || event.fill?.execution?.liquidity_execution_control || null)
    .filter(Boolean);
  const countBy = (key) => controls.reduce((acc, control) => {
    const value = String(control?.[key] || "unknown");
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
  const warningCounts = new Map();
  for (const control of controls) {
    for (const warning of control.warnings || []) {
      warningCounts.set(warning, (warningCounts.get(warning) || 0) + 1);
    }
  }

  return {
    model_version: controls[0]?.model_version || null,
    control_count: controls.length,
    quote_count: new Set(controls.map((control) => control.quote_id).filter(Boolean)).size,
    by_route_feasibility: countBy("route_feasibility"),
    by_quote_quality: countBy("quote_quality"),
    by_liquidity_depth_bucket: countBy("liquidity_depth_bucket"),
    gas_usd: round(controls.reduce((sum, control) => sum + toNum(control.gas?.estimated_gas_usd, 0), 0), 2),
    average_gas_bps: round(average(controls.map((control) => toNum(control.gas?.estimated_gas_bps, NaN))) ?? 0, 4),
    average_mev_risk_bps: round(average(controls.map((control) => toNum(control.mev?.mev_risk_bps, NaN))) ?? 0, 4),
    top_warnings: [...warningCounts.entries()]
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code))
      .slice(0, 10)
  };
}

function buildMarketDataQualitySummary(events) {
  return summarizeMarketDataQuality(events.map((event) => event.market_data_quality || event.simulated_execution?.market_data_quality || null));
}

function buildTokenRiskSummary(events) {
  const scans = events
    .map((event) => event.token_risk_scan || null)
    .filter(Boolean);
  const counts = { pass: 0, warn: 0, block: 0 };
  const warningCounts = new Map();
  const blockerCounts = new Map();

  for (const scan of scans) {
    if (counts[scan.decision] != null) counts[scan.decision] += 1;
    for (const code of scan.warnings || []) warningCounts.set(code, (warningCounts.get(code) || 0) + 1);
    for (const code of scan.blockers || []) blockerCounts.set(code, (blockerCounts.get(code) || 0) + 1);
  }

  const rank = (map) => [...map.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));

  return {
    scanner_version: scans[0]?.scanner_version || null,
    scan_count: scans.length,
    pass_count: counts.pass,
    warn_count: counts.warn,
    block_count: counts.block,
    top_warnings: rank(warningCounts).slice(0, 10),
    top_blockers: rank(blockerCounts).slice(0, 10)
  };
}

function compareMetrics(beforeCosts, afterCosts) {
  return {
    before_execution_costs: beforeCosts,
    after_execution_costs: afterCosts,
    cost_impact: {
      final_equity_delta_usd: round(afterCosts.final_equity_usd - beforeCosts.final_equity_usd),
      total_return_delta_pct: round(afterCosts.total_return_pct - beforeCosts.total_return_pct, 4),
      realized_pnl_delta_usd: round(afterCosts.realized_pnl_usd - beforeCosts.realized_pnl_usd),
      fee_drag_usd: afterCosts.fee_drag_usd,
      slippage_drag_usd: afterCosts.slippage_drag_usd,
      fee_slippage_drag_usd: afterCosts.fee_slippage_drag_usd
    }
  };
}

function buildExposure(replay) {
  const byToken = Object.values(replay.state.positions)
    .map((pos) => ({
      symbol: pos.symbol,
      contract_address: pos.contract_address,
      category: pos.category || "unknown",
      market_value_usd: round(pos.market_value_usd),
      unrealized_pnl_usd: round(pos.market_value_usd - pos.cost_basis_usd),
      strategy_version: pos.strategy_version
    }))
    .sort((a, b) => b.market_value_usd - a.market_value_usd);

  const categoryMap = new Map();
  for (const item of byToken) {
    const key = item.category || "unknown";
    categoryMap.set(key, (categoryMap.get(key) || 0) + item.market_value_usd);
  }

  return {
    by_token: byToken,
    by_category: [...categoryMap.entries()]
      .map(([category, marketValue]) => ({ category, market_value_usd: round(marketValue) }))
      .sort((a, b) => b.market_value_usd - a.market_value_usd),
    by_signal: [],
    by_strategy_version: byToken.length
      ? [{ strategy_version: byToken[0].strategy_version, market_value_usd: round(byToken.reduce((sum, item) => sum + item.market_value_usd, 0)) }]
      : []
  };
}

function collectEthPricesFromTrades(trades) {
  return trades
    .filter(isEthLike)
    .map((trade) => ({ ts: trade.ts, ts_ms: trade.ts_ms, price: trade.price, source: "portfolio_action_history" }))
    .filter((point) => point.price > 0);
}

function scanEthPrices(value, ts, out, depth = 0) {
  if (!value || depth > 8) return;
  if (Array.isArray(value)) {
    for (const item of value) scanEthPrices(item, ts, out, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  if (isEthLike(value)) {
    const price = extractPrice(value);
    if (price > 0) out.push({ ts, ts_ms: optionalMs(ts), price, source: "pipeline_jsonl" });
  }
  for (const child of Object.values(value)) scanEthPrices(child, ts, out, depth + 1);
}

function collectEthPrices(trades, pipelineEvents) {
  const points = collectEthPricesFromTrades(trades);
  for (const event of pipelineEvents) scanEthPrices(event?.data || event?.payload || event, event?.ts, points);
  const seen = new Set();
  return points
    .filter((point) => point.ts_ms != null && point.price > 0)
    .sort((a, b) => a.ts_ms - b.ts_ms || a.price - b.price)
    .filter((point) => {
      const key = `${point.ts_ms}:${point.price}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function buildBaselines(initialCashUsd, startMs, endMs, ethPrices) {
  const baselines = {
    cash: {
      available: true,
      initial_equity_usd: round(initialCashUsd),
      final_equity_usd: round(initialCashUsd),
      total_return_pct: 0,
      realized_pnl_usd: 0,
      unrealized_pnl_usd: 0,
      max_drawdown_pct: 0
    },
    buy_and_hold_eth: {
      available: false,
      reason: "No ETH/WETH price series found in available portfolio or log data."
    }
  };

  const inWindow = ethPrices.filter((point) => point.ts_ms >= startMs && point.ts_ms <= endMs);
  if (inWindow.length >= 2) {
    const first = inWindow[0];
    const last = inWindow[inWindow.length - 1];
    const quantity = initialCashUsd / first.price;
    const finalEquity = quantity * last.price;
    baselines.buy_and_hold_eth = {
      available: true,
      source: [...new Set(inWindow.map((point) => point.source))].join(","),
      first_price_usd: round(first.price, 8),
      last_price_usd: round(last.price, 8),
      initial_equity_usd: round(initialCashUsd),
      final_equity_usd: round(finalEquity),
      total_return_pct: pct((finalEquity - initialCashUsd) / initialCashUsd),
      realized_pnl_usd: 0,
      unrealized_pnl_usd: round(finalEquity - initialCashUsd),
      max_drawdown_pct: null
    };
  }

  return baselines;
}

function summarizeLivePaper(portfolio, initialCashUsd) {
  const equity = toNum(portfolio?.stats?.equity_usd, toNum(portfolio?.cash_usd, 0));
  return {
    available: equity > 0,
    initial_equity_usd: round(initialCashUsd),
    final_equity_usd: round(equity),
    total_return_pct: initialCashUsd > 0 ? pct((equity - initialCashUsd) / initialCashUsd) : 0,
    realized_pnl_usd: round(toNum(portfolio?.stats?.realized_pnl_usd, 0)),
    unrealized_pnl_usd: round(toNum(portfolio?.stats?.unrealized_pnl_usd, 0)),
    max_drawdown_pct: pct(toNum(portfolio?.stats?.max_drawdown_pct, 0))
  };
}

function markdownReport(report) {
  const m = report.metrics;
  const q = report.execution_quality || {};
  const c = report.execution_controls || {};
  const eth = report.baselines.buy_and_hold_eth;
  const lines = [
    `# Backtest Replay - ${report.report_id}`,
    "",
    `Generated: ${report.generated_at}`,
    `Strategy version: ${report.strategy_version}`,
    `Input hash: ${report.input_hash}`,
    "",
    "## Summary",
    "",
    `- Window: ${report.window.start_at} to ${report.window.end_at}`,
    `- Replayed decisions: ${report.replay.replayed_decision_count}`,
    `- Order records: ${report.replay.order_count}`,
    `- Filled decisions: ${report.replay.filled_decision_count}`,
    `- Initial equity: $${m.initial_equity_usd}`,
    `- Final equity: $${m.final_equity_usd}`,
    `- Total return: ${m.total_return_pct}%`,
    `- Before execution costs: ${report.performance.before_execution_costs.total_return_pct}% return, $${report.performance.before_execution_costs.final_equity_usd} final equity`,
    `- After execution costs: ${report.performance.after_execution_costs.total_return_pct}% return, $${report.performance.after_execution_costs.final_equity_usd} final equity`,
    `- Execution cost impact: $${report.performance.cost_impact.final_equity_delta_usd} final equity delta`,
    `- Realized PnL: $${m.realized_pnl_usd}`,
    `- Unrealized PnL: $${m.unrealized_pnl_usd}`,
    "",
    "## Risk And Trade Metrics",
    "",
    `- Profit factor: ${m.profit_factor ?? "n/a"}`,
    `- Max drawdown: ${m.max_drawdown_pct}%`,
    `- Win rate: ${m.win_rate_pct}%`,
    `- Average win / loss: $${m.average_win_usd} / $${m.average_loss_usd}`,
    `- Turnover: $${m.turnover_usd} (${m.turnover_ratio}x)`,
    `- Fee drag: $${m.fee_drag_usd}`,
    `- Slippage drag: $${m.slippage_drag_usd}`,
    `- Sharpe-like / Sortino-like: ${m.sharpe_like ?? "n/a"} / ${m.sortino_like ?? "n/a"}`,
    "",
    "## Execution Quality",
    "",
    `- Execution model: ${q.model_version || "n/a"}`,
    `- Fill ratio: ${q.fill_ratio ?? 0}`,
    `- Rejection ratio: ${q.rejection_ratio ?? 0}`,
    `- Partial fills: ${q.partial_fill_count ?? 0}`,
    `- Average slippage: ${q.average_slippage_bps ?? 0} bps`,
    `- Average fee: ${q.average_fee_bps ?? 0} bps`,
    `- Average time to fill: ${q.average_time_to_fill_ms ?? 0} ms`,
    "",
    "## Liquidity Execution Controls",
    "",
    `- Control model: ${c.model_version || "n/a"}`,
    `- Controls / quotes: ${c.control_count ?? 0} / ${c.quote_count ?? 0}`,
    `- Route feasibility: ${JSON.stringify(c.by_route_feasibility || {})}`,
    `- Quote quality: ${JSON.stringify(c.by_quote_quality || {})}`,
    `- Liquidity buckets: ${JSON.stringify(c.by_liquidity_depth_bucket || {})}`,
    `- Estimated gas: $${c.gas_usd ?? 0} (${c.average_gas_bps ?? 0} avg bps)`,
    `- Average MEV risk: ${c.average_mev_risk_bps ?? 0} bps`,
    "",
    "## Token Risk Scanner",
    "",
    `- Scanner version: ${report.token_risk_summary?.scanner_version || "n/a"}`,
    `- Scan count: ${report.token_risk_summary?.scan_count ?? 0}`,
    `- Pass / warn / block: ${report.token_risk_summary?.pass_count ?? 0} / ${report.token_risk_summary?.warn_count ?? 0} / ${report.token_risk_summary?.block_count ?? 0}`,
    "",
    "## Baselines",
    "",
    `- Cash: ${report.baselines.cash.total_return_pct}% return`,
    eth.available
      ? `- Buy-and-hold ETH: ${eth.total_return_pct}% return ($${eth.first_price_usd} to $${eth.last_price_usd})`
      : `- Buy-and-hold ETH: unavailable (${eth.reason})`,
    `- Current live paper strategy snapshot: ${report.baselines.current_live_paper_strategy.total_return_pct}% return`,
    "",
    "## Exposure",
    "",
    ...(report.exposure.by_token.length
      ? report.exposure.by_token.slice(0, 10).map((item) => `- ${item.symbol}: $${item.market_value_usd} (${item.category})`)
      : ["- no open replay exposure"]),
    "",
    "## Determinism",
    "",
    `- Seed: ${report.seed}`,
    `- Execution model version: ${report.execution_model_version}`,
    `- Output hash: ${report.determinism.output_hash}`,
    `- Portfolio mutation: ${report.safety.portfolio_json_mutated ? "FAILED" : "not detected"}`
  ];
  return `${lines.join("\n")}\n`;
}

function parseArgs(argv) {
  const get = (name, fallback = null) => argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
  return {
    strategyVersion: get("strategy-version", "paper-action-replay-v1"),
    seed: get("seed", "phase-1"),
    generatedAt: get("generated-at", null),
    feeBps: toNum(get("fee-bps", DEFAULT_FEE_BPS), DEFAULT_FEE_BPS),
    slippageBps: toNum(get("slippage-bps", DEFAULT_SLIPPAGE_BPS), DEFAULT_SLIPPAGE_BPS),
    executionModelVersion: get("execution-model-version", EXECUTION_MODEL_VERSION),
    appendEvent: !argv.includes("--no-append-event")
  };
}

export function runBacktestReplay(options = {}) {
  const portfolioBeforeRaw = fs.existsSync(PORTFOLIO_FILE) ? fs.readFileSync(PORTFOLIO_FILE, "utf8") : "";
  const portfolio = readJsonFile(options.portfolioFile || PORTFOLIO_FILE, {});
  const trades = collectActionRecords(portfolio);
  const initialCashUsd = toNum(portfolio?.settings?.initial_cash_usd, DEFAULT_INITIAL_CASH_USD);
  const startMs = trades[0]?.ts_ms ?? optionalMs(options.generatedAt) ?? Date.now();
  const endMs = trades[trades.length - 1]?.ts_ms ?? startMs;
  const generatedAt = options.generatedAt || (trades[trades.length - 1]?.ts || new Date(endMs).toISOString());
  const strategyVersion = options.strategyVersion || "paper-action-replay-v1";
  const seed = options.seed || "phase-1";
  const feeBps = toNum(options.feeBps, DEFAULT_FEE_BPS);
  const slippageBps = toNum(options.slippageBps, DEFAULT_SLIPPAGE_BPS);
  const executionModelVersion = options.executionModelVersion || EXECUTION_MODEL_VERSION;
  const inputHash = buildInputHash({ portfolio, trades, strategyVersion, seed, feeBps, slippageBps, executionModelVersion });
  const runId = `backtest-${inputHash.slice(0, 16)}`;
  const replay = replayTrades(trades, { initialCashUsd, strategyVersion, seed, feeBps, slippageBps, generatedAt, executionModelVersion, runId });
  const idealReplay = replayTrades(trades, { initialCashUsd, strategyVersion, seed, feeBps: 0, slippageBps: 0, generatedAt, idealExecution: true });
  const pipelineEvents = readJsonLines(options.pipelineLog || PIPELINE_LOG);
  const ethPrices = collectEthPrices(trades, pipelineEvents);
  const metrics = buildMetrics(replay, initialCashUsd, startMs, endMs);
  const idealMetrics = buildMetrics(idealReplay, initialCashUsd, startMs, endMs);
  const performance = compareMetrics(idealMetrics, metrics);
  const executionQuality = buildExecutionQuality(replay.events);
  const executionControls = buildExecutionControlSummary(replay.events);
  const marketDataQuality = buildMarketDataQualitySummary(replay.events);
  const tokenRiskSummary = buildTokenRiskSummary(replay.events);
  const baselines = buildBaselines(initialCashUsd, startMs, endMs, ethPrices);
  baselines.current_live_paper_strategy = summarizeLivePaper(portfolio, initialCashUsd);
  const exposure = buildExposure(replay);
  const reportTimestamp = formatReportTimestamp(new Date(optionalMs(generatedAt) || endMs));
  const reportFile = `reports/backtests/backtest-${reportTimestamp}.json`;
  const markdownFile = `reports/backtests/backtest-${reportTimestamp}.md`;
  const safety = {
    live_trading_enabled: false,
    portfolio_json_mutated: false,
    portfolio_json_sha256_before: sha256(portfolioBeforeRaw)
  };

  const report = {
    report_id: runId,
    report_type: "backtest_replay",
    schema_version: "1.0",
    generated_at: generatedAt,
    strategy_version: strategyVersion,
    seed,
    execution_model_version: executionModelVersion,
    input_hash: inputHash,
    report_file: reportFile,
    markdown_file: markdownFile,
    data_sources: {
      portfolio_json: "portfolio.json",
      pipeline_jsonl: "logs/pipeline.jsonl",
      action_history: "portfolio.json:action_history",
      closed_trades: "portfolio.json:closed_trades"
    },
    assumptions: {
      fill_model: "deterministic_execution_simulation",
      before_cost_fill_model: "decision_price_no_cost",
      execution_model_version: executionModelVersion,
      fee_bps: feeBps,
      slippage_bps: slippageBps,
      live_trading: "disabled",
      portfolio_mutation: "disabled"
    },
    window: {
      start_at: trades[0]?.ts || generatedAt,
      end_at: trades[trades.length - 1]?.ts || generatedAt,
      elapsed_days: round((endMs - startMs) / 86400000, 4)
    },
    replay: {
      replayed_decision_count: replay.events.length,
      filled_decision_count: replay.events.filter((event) => event.replay_decision === "filled").length,
      partial_fill_decision_count: replay.events.filter((event) => event.replay_decision === "partially_filled").length,
      rejected_decision_count: replay.events.filter((event) => event.replay_decision === "rejected").length,
      order_count: replay.events.length,
      orders: replay.events.map((event) => event.order),
      simulated_fills: replay.events,
      final_portfolio: {
        cash_usd: round(replay.finalMark.cash_usd),
        equity_usd: round(replay.finalMark.equity_usd),
        open_positions: Object.keys(replay.state.positions).length
      },
      equity_curve: replay.equityCurve.map((point) => ({
        ts: point.ts,
        equity_usd: round(point.equity_usd),
        drawdown_pct: pct(point.drawdown_pct || 0)
      }))
    },
    metrics,
    performance,
    execution_quality: executionQuality,
    execution_controls: executionControls,
    market_data_quality: marketDataQuality,
    token_risk_summary: tokenRiskSummary,
    baselines,
    exposure,
    safety
  };

  const outputHash = sha256(stableStringify({
    ...report,
    report_file: null,
    markdown_file: null,
    replay: {
      ...report.replay,
      simulated_fills: report.replay.simulated_fills.map((event) => ({
        ts: event.ts,
        order_id: event.order_id,
        source_trade_id: event.source_trade_id,
        symbol: event.symbol,
        contract_address: event.contract_address,
        side: event.side,
        replay_decision: event.replay_decision,
        token_risk_scan_id: event.token_risk_scan_id,
        token_risk_scan_ref: event.token_risk_scan_ref,
        token_risk_scan: event.token_risk_scan,
        execution_control_id: event.execution_control_id,
        quote_id: event.quote_id,
        liquidity_execution_control: event.liquidity_execution_control,
        order: event.order,
        simulated_execution: event.simulated_execution,
        fill: event.fill
      }))
    },
    determinism: null,
    safety: { ...report.safety, portfolio_json_sha256_after: null, portfolio_json_mutated: null }
  }));
  report.determinism = {
    deterministic_fields_hash: inputHash,
    output_hash: outputHash,
    note: "Metrics and simulated fills are deterministic for fixed inputs, strategy version, seed, execution model version, fee bps, and slippage bps."
  };

  fs.mkdirSync(BACKTEST_REPORT_DIR, { recursive: true });
  fs.writeFileSync(path.join(ROOT, reportFile), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(ROOT, markdownFile), markdownReport(report));

  const portfolioAfterRaw = fs.existsSync(PORTFOLIO_FILE) ? fs.readFileSync(PORTFOLIO_FILE, "utf8") : "";
  report.safety.portfolio_json_sha256_after = sha256(portfolioAfterRaw);
  report.safety.portfolio_json_mutated = report.safety.portfolio_json_sha256_before !== report.safety.portfolio_json_sha256_after;
  fs.writeFileSync(path.join(ROOT, reportFile), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(ROOT, markdownFile), markdownReport(report));

  if (options.appendEvent !== false) {
    fs.mkdirSync(path.dirname(BACKTEST_EVENT_LOG), { recursive: true });
    fs.appendFileSync(BACKTEST_EVENT_LOG, `${JSON.stringify({
      event_id: sha256(`${runId}:${generatedAt}`).slice(0, 32),
      schema_version: "1.0",
      ts: generatedAt,
      event_type: "backtest_replay",
      actor: "backtest_replay",
      strategy_version: strategyVersion,
      seed,
      report_id: report.report_id,
      report_file: report.report_file,
      metrics: {
        total_return_pct: report.metrics.total_return_pct,
        realized_pnl_usd: report.metrics.realized_pnl_usd,
        unrealized_pnl_usd: report.metrics.unrealized_pnl_usd,
        profit_factor: report.metrics.profit_factor,
        max_drawdown_pct: report.metrics.max_drawdown_pct,
        win_rate_pct: report.metrics.win_rate_pct
      },
      execution_quality: {
        model_version: report.execution_quality.model_version,
        fill_ratio: report.execution_quality.fill_ratio,
        rejection_ratio: report.execution_quality.rejection_ratio,
        average_slippage_bps: report.execution_quality.average_slippage_bps,
        average_fee_bps: report.execution_quality.average_fee_bps
      },
      safety: report.safety
    })}\n`);
    recordOperatorAction({
      action_type: "report_generation",
      ts: generatedAt,
      actor: options.actor || "backtest_replay",
      role: options.role || "viewer",
      reason: options.reason || "generated deterministic backtest replay report",
      resource: "backtest_report",
      new_state: {
        report_id: report.report_id,
        report_file: report.report_file,
        markdown_file: report.markdown_file,
        strategy_version: report.strategy_version
      },
      report_id: report.report_id,
      metadata: {
        portfolio_json_mutated: report.safety.portfolio_json_mutated,
        live_submission_enabled: false
      }
    });
  }

  return report;
}

if (process.argv[1] === __filename) {
  const report = runBacktestReplay(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify({
    report_id: report.report_id,
    report_file: report.report_file,
    markdown_file: report.markdown_file,
    total_return_pct: report.metrics.total_return_pct,
    realized_pnl_usd: report.metrics.realized_pnl_usd,
    unrealized_pnl_usd: report.metrics.unrealized_pnl_usd,
    profit_factor: report.metrics.profit_factor,
    max_drawdown_pct: report.metrics.max_drawdown_pct,
    win_rate_pct: report.metrics.win_rate_pct,
    before_cost_total_return_pct: report.performance.before_execution_costs.total_return_pct,
    after_cost_total_return_pct: report.performance.after_execution_costs.total_return_pct,
    execution_fill_ratio: report.execution_quality.fill_ratio,
    execution_rejection_ratio: report.execution_quality.rejection_ratio,
    portfolio_json_mutated: report.safety.portfolio_json_mutated
  }, null, 2));
}
