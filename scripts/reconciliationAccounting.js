import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

export const RECONCILIATION_ACCOUNTING_SCHEMA_VERSION = "1.0";
export const RECONCILIATION_POLICY_VERSION = "paper-replay-reconciliation-v1";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const PORTFOLIO_FILE = path.join(ROOT, "portfolio.json");
const REPORTS_DIR = path.join(ROOT, "reports");
const BACKTEST_REPORTS_DIR = path.join(REPORTS_DIR, "backtests");
const RECONCILIATION_REPORTS_DIR = path.join(REPORTS_DIR, "reconciliation");
const TAX_EXPORTS_DIR = path.join(RECONCILIATION_REPORTS_DIR, "tax-lots");
const EPSILON_USD = 0.05;
const EPSILON_QTY = 1e-8;

function readJsonFile(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round(value, digits = 8) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}

function roundUsd(value) {
  return round(value, 2);
}

function optionalMs(value) {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function cleanText(value, fallback = null) {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function cleanAddress(value) {
  return cleanText(value)?.toLowerCase() || null;
}

function cleanSide(value) {
  return String(value || "").trim().toLowerCase() === "sell" ? "sell" : "buy";
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
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function latestBacktestReport() {
  try {
    return fs.readdirSync(BACKTEST_REPORTS_DIR)
      .filter((name) => /^backtest-\d{8}-\d{6}\.json$/.test(name))
      .map((name) => path.join(BACKTEST_REPORTS_DIR, name))
      .map((filePath) => ({ filePath, report: readJsonFile(filePath) }))
      .filter(({ report }) => report?.report_type === "backtest_replay")
      .sort((a, b) => String(b.report.generated_at || "").localeCompare(String(a.report.generated_at || "")))[0] || null;
  } catch {
    return null;
  }
}

function tradeKey(trade = {}) {
  return cleanText(trade.trade_id)
    || cleanText(trade.source_trade_id)
    || sha256(stableStringify({
      ts: trade.ts || null,
      side: trade.side || null,
      symbol: trade.symbol || null,
      contract_address: trade.contract_address || null,
      quantity: trade.quantity ?? null,
      price: trade.price ?? null
    })).slice(0, 24);
}

function assetKey(record = {}) {
  return cleanAddress(record.contract_address || record.token?.contract_address)
    || cleanText(record.symbol || record.token?.symbol, "unknown").toUpperCase();
}

function positionValue(position = {}) {
  return toNum(position.market_value_usd, toNum(position.current_value_usd, toNum(position.quantity, 0) * toNum(position.current_price, 0)));
}

function normalizePaperTrades(portfolio = {}) {
  const closedById = new Map((Array.isArray(portfolio.closed_trades) ? portfolio.closed_trades : [])
    .map((trade) => [tradeKey(trade), trade]));
  const seen = new Set();
  return [
    ...(Array.isArray(portfolio.action_history) ? portfolio.action_history : []),
    ...(Array.isArray(portfolio.closed_trades) ? portfolio.closed_trades : [])
  ]
    .filter((trade) => trade && typeof trade === "object")
    .map((trade) => {
      const key = tradeKey(trade);
      const merged = { ...(closedById.get(key) || {}), ...trade };
      const side = cleanSide(merged.side);
      const price = toNum(merged.price, 0);
      const quantity = toNum(merged.quantity, price > 0 ? toNum(merged.cost_usd || merged.proceeds_usd || merged.gross_proceeds_usd, 0) / price : 0);
      const gross = side === "sell"
        ? toNum(merged.gross_proceeds_usd, toNum(merged.proceeds_usd, quantity * price))
        : toNum(merged.cost_usd, quantity * price);
      const fee = toNum(merged.fee_usd, toNum(merged.simulated_execution?.fee_usd, 0));
      const net = side === "sell"
        ? toNum(merged.net_proceeds_usd, toNum(merged.proceeds_usd, gross - fee))
        : gross + fee;
      return {
        ...merged,
        record_key: key,
        ts_ms: optionalMs(merged.ts),
        side,
        symbol: cleanText(merged.symbol, "unknown"),
        contract_address: cleanAddress(merged.contract_address),
        quantity,
        price,
        gross_notional_usd: gross,
        fee_usd: fee,
        cash_delta_usd: side === "buy" ? -net : net,
        order_id: cleanText(merged.order_id || merged.order_lifecycle?.order_id),
        order_ids: Array.isArray(merged.order_ids) ? merged.order_ids.filter(Boolean) : (merged.order_id ? [merged.order_id] : []),
        simulated_execution: merged.simulated_execution || null,
        order_lifecycle: merged.order_lifecycle || null,
        pnl_usd: merged.pnl_usd == null ? null : toNum(merged.pnl_usd, 0),
        cost_portion_usd: merged.cost_portion_usd == null ? null : toNum(merged.cost_portion_usd, 0)
      };
    })
    .filter((trade) => {
      if (!trade.ts_ms || (trade.side !== "buy" && trade.side !== "sell")) return false;
      if (seen.has(trade.record_key)) return false;
      seen.add(trade.record_key);
      return true;
    })
    .sort((a, b) => a.ts_ms - b.ts_ms || a.record_key.localeCompare(b.record_key));
}

function normalizeReplayEvents(backtest = null) {
  return (Array.isArray(backtest?.replay?.simulated_fills) ? backtest.replay.simulated_fills : [])
    .map((event, index) => {
      const fill = event.fill || {};
      const execution = event.simulated_execution || fill.execution || {};
      const side = cleanSide(event.side || fill.side || execution.side);
      const price = toNum(fill.fill_price, toNum(execution.fill_price, toNum(event.price, 0)));
      const quantity = toNum(fill.quantity, toNum(execution.quantity, 0));
      const gross = toNum(fill.gross_notional_usd, toNum(fill.effective_notional_usd, toNum(execution.filled_notional_usd, quantity * price)));
      const fee = toNum(fill.fee_usd, toNum(execution.fee_usd, 0));
      const net = side === "sell"
        ? toNum(fill.net_proceeds_usd, gross - fee)
        : gross + fee;
      return {
        record_key: event.source_trade_id || event.order_id || `replay_event_${index}`,
        source_trade_id: event.source_trade_id || null,
        trade_id: event.trade_id || null,
        ts: event.ts || null,
        ts_ms: optionalMs(event.ts),
        side,
        symbol: cleanText(event.symbol, "unknown"),
        contract_address: cleanAddress(event.contract_address),
        quantity,
        price,
        gross_notional_usd: gross,
        fee_usd: fee,
        cash_delta_usd: side === "buy" ? -net : net,
        realized_pnl_usd: fill.realized_pnl_usd == null ? null : toNum(fill.realized_pnl_usd, 0),
        cost_portion_usd: fill.cost_portion_usd == null ? null : toNum(fill.cost_portion_usd, 0),
        replay_decision: event.replay_decision || fill.decision || execution.decision || null,
        order_id: event.order_id || event.order?.order_id || null,
        order: event.order || null,
        simulated_execution: execution || null
      };
    })
    .filter((event) => event.ts_ms && (event.replay_decision === "filled" || event.replay_decision === "partially_filled"))
    .sort((a, b) => a.ts_ms - b.ts_ms || a.record_key.localeCompare(b.record_key));
}

function collectOrders({ paperTrades = [], backtest = null }) {
  const orders = [];
  for (const trade of paperTrades) {
    if (trade.order_lifecycle?.order_id) orders.push({ source: "paper", trade_id: trade.record_key, ...trade.order_lifecycle });
  }
  for (const order of Array.isArray(backtest?.replay?.orders) ? backtest.replay.orders : []) {
    if (order?.order_id) orders.push({ source: "replay", ...order });
  }
  return orders.sort((a, b) => String(a.order_id).localeCompare(String(b.order_id)));
}

function addIssue(issues, scope, code, severity, detail, context = {}) {
  issues.push({
    issue_id: `recissue_${sha256(stableStringify({ scope, code, detail, context })).slice(0, 16)}`,
    scope,
    code,
    severity,
    detail,
    context
  });
}

function consumeLots(lots, sell, source, issues) {
  let remaining = sell.quantity;
  const disposals = [];
  const key = assetKey(sell);
  const lotQueue = lots.get(key) || [];

  while (remaining > EPSILON_QTY && lotQueue.length) {
    const lot = lotQueue[0];
    const qty = Math.min(remaining, lot.remaining_quantity);
    const ratio = lot.remaining_quantity > 0 ? qty / lot.remaining_quantity : 0;
    const costBasis = lot.remaining_cost_basis_usd * ratio;
    const proceeds = sell.gross_notional_usd * (qty / Math.max(sell.quantity, EPSILON_QTY));
    const fee = sell.fee_usd * (qty / Math.max(sell.quantity, EPSILON_QTY));
    const netProceeds = proceeds - fee;
    const gainLoss = netProceeds - costBasis;

    disposals.push({
      source,
      event_type: "trade",
      tax_lot_id: lot.tax_lot_id,
      source_trade_id: sell.record_key,
      order_id: sell.order_id || null,
      symbol: sell.symbol,
      contract_address: sell.contract_address,
      acquired_at: lot.acquired_at,
      disposed_at: sell.ts,
      quantity: round(qty),
      proceeds_usd: roundUsd(proceeds),
      cost_basis_usd: roundUsd(costBasis),
      fee_usd: roundUsd(fee),
      realized_gain_loss_usd: roundUsd(gainLoss),
      accounting_method: "FIFO"
    });

    lot.remaining_quantity = round(lot.remaining_quantity - qty);
    lot.remaining_cost_basis_usd = roundUsd(lot.remaining_cost_basis_usd - costBasis);
    remaining = round(remaining - qty);
    if (lot.remaining_quantity <= EPSILON_QTY) lotQueue.shift();
  }

  if (remaining > EPSILON_QTY) {
    addIssue(issues, source, "sell_without_fifo_lot", "critical", `${sell.symbol} sell quantity exceeds FIFO lots.`, {
      trade_id: sell.record_key,
      symbol: sell.symbol,
      remaining_quantity: round(remaining)
    });
  }

  lots.set(key, lotQueue);
  return disposals;
}

function buildFifoLedger(records, source, issues) {
  const lots = new Map();
  const acquisitions = [];
  const disposals = [];

  for (const record of records) {
    const key = assetKey(record);
    if (record.side === "buy") {
      const costBasis = record.gross_notional_usd + record.fee_usd;
      const lot = {
        source,
        event_type: "trade",
        tax_lot_id: `lot_${sha256(stableStringify({
          source,
          trade_id: record.record_key,
          order_id: record.order_id || null,
          symbol: record.symbol,
          contract_address: record.contract_address,
          ts: record.ts,
          quantity: record.quantity,
          cost_basis_usd: costBasis
        })).slice(0, 24)}`,
        source_trade_id: record.record_key,
        order_id: record.order_id || null,
        symbol: record.symbol,
        contract_address: record.contract_address,
        acquired_at: record.ts,
        quantity: round(record.quantity),
        cost_basis_usd: roundUsd(costBasis),
        fee_usd: roundUsd(record.fee_usd),
        remaining_quantity: round(record.quantity),
        remaining_cost_basis_usd: roundUsd(costBasis),
        accounting_method: "FIFO"
      };
      const queue = lots.get(key) || [];
      queue.push(lot);
      lots.set(key, queue);
      acquisitions.push(lot);
    } else {
      disposals.push(...consumeLots(lots, record, source, issues));
    }
  }

  const openLots = [...lots.values()].flat().filter((lot) => lot.remaining_quantity > EPSILON_QTY);
  return { acquisitions, disposals, open_lots: openLots };
}

function reconcilePaper(portfolio, trades, orders, taxLots) {
  const issues = [];
  const initialCashUsd = toNum(portfolio?.settings?.initial_cash_usd, 100000);
  const expectedCashUsd = roundUsd(initialCashUsd + trades.reduce((sum, trade) => sum + trade.cash_delta_usd, 0));
  const actualCashUsd = roundUsd(toNum(portfolio.cash_usd, 0));
  const positionLedger = new Map();

  for (const trade of trades) {
    const key = assetKey(trade);
    const current = positionLedger.get(key) || {
      symbol: trade.symbol,
      contract_address: trade.contract_address,
      quantity: 0,
      cost_basis_usd: 0,
      last_price: trade.price
    };
    if (trade.side === "buy") {
      current.quantity += trade.quantity;
      current.cost_basis_usd += trade.gross_notional_usd + trade.fee_usd;
      current.last_price = trade.price;
    } else {
      const ratio = current.quantity > 0 ? Math.min(1, trade.quantity / current.quantity) : 0;
      const costPortion = trade.cost_portion_usd == null ? current.cost_basis_usd * ratio : trade.cost_portion_usd;
      current.quantity -= trade.quantity;
      current.cost_basis_usd -= costPortion;
      current.last_price = trade.price;
    }
    if (current.quantity <= EPSILON_QTY) {
      positionLedger.delete(key);
    } else {
      positionLedger.set(key, current);
    }
  }

  if (Math.abs(expectedCashUsd - actualCashUsd) > EPSILON_USD) {
    addIssue(issues, "paper", "cash_mismatch", "critical", "Paper cash does not match action-history ledger.", {
      expected_cash_usd: expectedCashUsd,
      actual_cash_usd: actualCashUsd,
      delta_usd: roundUsd(actualCashUsd - expectedCashUsd)
    });
  }

  for (const trade of trades) {
    if (!trade.order_id && !trade.order_ids.length) {
      addIssue(issues, "paper", "missing_order_link", "warning", "Paper trade is missing an order lifecycle link.", { trade_id: trade.record_key, symbol: trade.symbol, side: trade.side });
    }
    if (!trade.simulated_execution) {
      addIssue(issues, "paper", "missing_fill_link", "warning", "Paper trade is missing simulated fill metadata.", { trade_id: trade.record_key, symbol: trade.symbol, side: trade.side });
    }
    if (trade.side === "sell" && trade.pnl_usd != null) {
      const expected = taxLots.disposals
        .filter((lot) => lot.source_trade_id === trade.record_key)
        .reduce((sum, lot) => sum + lot.realized_gain_loss_usd, 0);
      if (Math.abs(roundUsd(expected) - roundUsd(trade.pnl_usd)) > EPSILON_USD) {
        addIssue(issues, "paper", "realized_pnl_mismatch", "critical", "Paper sell PnL does not match FIFO tax-lot PnL.", {
          trade_id: trade.record_key,
          expected_pnl_usd: roundUsd(expected),
          recorded_pnl_usd: roundUsd(trade.pnl_usd),
          delta_usd: roundUsd(trade.pnl_usd - expected)
        });
      }
    }
  }

  const orderIds = new Set(orders.filter((order) => order.source === "paper").map((order) => order.order_id));
  for (const trade of trades) {
    for (const orderId of trade.order_ids.length ? trade.order_ids : [trade.order_id].filter(Boolean)) {
      if (!orderIds.has(orderId)) {
        addIssue(issues, "paper", "missing_order_record", "warning", "Trade references an order ID with no embedded lifecycle record.", { trade_id: trade.record_key, order_id: orderId });
      }
    }
  }

  const expectedPositions = [...positionLedger.values()]
    .map((pos) => ({
      symbol: pos.symbol,
      contract_address: pos.contract_address,
      quantity: round(pos.quantity),
      cost_basis_usd: roundUsd(pos.cost_basis_usd),
      market_value_usd: roundUsd(pos.quantity * pos.last_price)
    }))
    .sort((a, b) => assetKey(a).localeCompare(assetKey(b)));
  const actualPositions = Object.values(portfolio.positions || {})
    .map((pos) => ({
      symbol: cleanText(pos.symbol, "unknown"),
      contract_address: cleanAddress(pos.contract_address),
      quantity: round(toNum(pos.quantity, 0)),
      cost_basis_usd: roundUsd(toNum(pos.cost_basis_usd, 0)),
      market_value_usd: roundUsd(positionValue(pos))
    }))
    .sort((a, b) => assetKey(a).localeCompare(assetKey(b)));
  const actualByKey = new Map(actualPositions.map((pos) => [assetKey(pos), pos]));
  const actionIds = new Set((Array.isArray(portfolio.action_history) ? portfolio.action_history : []).map((trade) => tradeKey(trade)));
  const closedIds = new Set((Array.isArray(portfolio.closed_trades) ? portfolio.closed_trades : []).map((trade) => tradeKey(trade)));

  for (const trade of Array.isArray(portfolio.closed_trades) ? portfolio.closed_trades : []) {
    const key = tradeKey(trade);
    if (!actionIds.has(key)) {
      addIssue(issues, "paper", "closed_trade_missing_action_history_link", "warning", "Closed trade is missing from action_history.", {
        trade_id: key,
        symbol: trade.symbol || null
      });
    }
  }
  for (const trade of Array.isArray(portfolio.action_history) ? portfolio.action_history : []) {
    const key = tradeKey(trade);
    if (cleanSide(trade.side) === "sell" && !closedIds.has(key)) {
      addIssue(issues, "paper", "sell_action_missing_closed_trade_link", "warning", "Sell action is missing from closed_trades.", {
        trade_id: key,
        symbol: trade.symbol || null
      });
    }
  }

  for (const expected of expectedPositions) {
    const actual = actualByKey.get(assetKey(expected));
    if (!actual) {
      addIssue(issues, "paper", "missing_portfolio_position", "critical", "Ledger position is missing from portfolio positions.", expected);
      continue;
    }
    if (Math.abs(expected.quantity - actual.quantity) > EPSILON_QTY) {
      addIssue(issues, "paper", "quantity_mismatch", "critical", "Portfolio quantity differs from action-history ledger.", { expected, actual });
    }
    if (Math.abs(expected.cost_basis_usd - actual.cost_basis_usd) > EPSILON_USD) {
      addIssue(issues, "paper", "cost_basis_mismatch", "critical", "Portfolio cost basis differs from action-history ledger.", { expected, actual });
    }
  }
  for (const actual of actualPositions) {
    if (!positionLedger.has(assetKey(actual))) {
      addIssue(issues, "paper", "unexpected_portfolio_position", "critical", "Portfolio position has no matching action-history ledger quantity.", actual);
    }
  }

  const recordedRealized = roundUsd(toNum(portfolio?.stats?.realized_pnl_usd, 0));
  const closedRealized = roundUsd((Array.isArray(portfolio.closed_trades) ? portfolio.closed_trades : []).reduce((sum, trade) => sum + toNum(trade.pnl_usd, 0), 0));
  if (Math.abs(recordedRealized - closedRealized) > EPSILON_USD) {
    addIssue(issues, "paper", "stats_realized_pnl_mismatch", "critical", "Portfolio stats realized PnL differs from closed_trades.", {
      stats_realized_pnl_usd: recordedRealized,
      closed_trades_realized_pnl_usd: closedRealized,
      delta_usd: roundUsd(recordedRealized - closedRealized)
    });
  }

  const actualUnrealized = roundUsd(actualPositions.reduce((sum, pos) => sum + pos.market_value_usd - pos.cost_basis_usd, 0));
  const statsUnrealized = roundUsd(toNum(portfolio?.stats?.unrealized_pnl_usd, actualUnrealized));
  if (Math.abs(actualUnrealized - statsUnrealized) > EPSILON_USD) {
    addIssue(issues, "paper", "unrealized_pnl_mismatch", "warning", "Portfolio stats unrealized PnL differs from position marks.", {
      expected_unrealized_pnl_usd: actualUnrealized,
      stats_unrealized_pnl_usd: statsUnrealized,
      delta_usd: roundUsd(statsUnrealized - actualUnrealized)
    });
  }

  return {
    source: "paper",
    status: issues.some((issue) => issue.severity === "critical") ? "mismatch" : "reconciled",
    trade_count: trades.length,
    order_count: orders.filter((order) => order.source === "paper").length,
    fill_count: trades.filter((trade) => trade.simulated_execution).length,
    cash: {
      initial_cash_usd: roundUsd(initialCashUsd),
      expected_cash_usd: expectedCashUsd,
      actual_cash_usd: actualCashUsd,
      delta_usd: roundUsd(actualCashUsd - expectedCashUsd)
    },
    positions: {
      expected: expectedPositions,
      actual: actualPositions
    },
    pnl: {
      closed_trades_realized_pnl_usd: closedRealized,
      stats_realized_pnl_usd: recordedRealized,
      stats_unrealized_pnl_usd: statsUnrealized,
      position_unrealized_pnl_usd: actualUnrealized
    },
    issues
  };
}

function reconcileReplay(backtest, events, orders, taxLots) {
  const issues = [];
  if (!backtest) {
    addIssue(issues, "replay", "missing_backtest_report", "warning", "No replay report was available for replay reconciliation.");
    return { source: "replay", status: "unavailable", trade_count: 0, order_count: 0, fill_count: 0, issues };
  }

  const initialCashUsd = toNum(backtest?.metrics?.initial_equity_usd, 100000);
  const expectedCashUsd = roundUsd(initialCashUsd + events.reduce((sum, event) => sum + event.cash_delta_usd, 0));
  const actualCashUsd = roundUsd(toNum(backtest?.replay?.final_portfolio?.cash_usd, expectedCashUsd));
  const realized = roundUsd(events.reduce((sum, event) => sum + toNum(event.realized_pnl_usd, 0), 0));
  const metricsRealized = roundUsd(toNum(backtest?.metrics?.realized_pnl_usd, realized));
  const orderIds = new Set(orders.filter((order) => order.source === "replay").map((order) => order.order_id));

  for (const event of events) {
    if (!event.order_id) {
      addIssue(issues, "replay", "missing_order_link", "warning", "Replay fill is missing an order link.", { source_trade_id: event.source_trade_id, symbol: event.symbol });
    } else if (!orderIds.has(event.order_id)) {
      addIssue(issues, "replay", "missing_order_record", "warning", "Replay fill references an order absent from replay orders.", { source_trade_id: event.source_trade_id, order_id: event.order_id });
    }
    if (!event.simulated_execution) {
      addIssue(issues, "replay", "missing_fill_link", "warning", "Replay event is missing simulated execution metadata.", { source_trade_id: event.source_trade_id, symbol: event.symbol });
    }
  }

  if (Math.abs(expectedCashUsd - actualCashUsd) > EPSILON_USD) {
    addIssue(issues, "replay", "cash_mismatch", "critical", "Replay cash does not match simulated fill ledger.", {
      expected_cash_usd: expectedCashUsd,
      reported_cash_usd: actualCashUsd,
      delta_usd: roundUsd(actualCashUsd - expectedCashUsd)
    });
  }
  if (Math.abs(realized - metricsRealized) > EPSILON_USD) {
    addIssue(issues, "replay", "realized_pnl_mismatch", "critical", "Replay metrics realized PnL does not match fill ledger.", {
      expected_realized_pnl_usd: realized,
      metrics_realized_pnl_usd: metricsRealized,
      delta_usd: roundUsd(metricsRealized - realized)
    });
  }

  const fifoRealized = roundUsd(taxLots.disposals.reduce((sum, lot) => sum + lot.realized_gain_loss_usd, 0));
  if (Math.abs(fifoRealized - metricsRealized) > EPSILON_USD) {
    addIssue(issues, "replay", "tax_lot_realized_pnl_mismatch", "critical", "Replay FIFO tax-lot PnL does not match replay metrics.", {
      tax_lot_realized_pnl_usd: fifoRealized,
      metrics_realized_pnl_usd: metricsRealized,
      delta_usd: roundUsd(metricsRealized - fifoRealized)
    });
  }

  return {
    source: "replay",
    status: issues.some((issue) => issue.severity === "critical") ? "mismatch" : "reconciled",
    backtest_report_id: backtest.report_id || null,
    trade_count: events.length,
    order_count: orders.filter((order) => order.source === "replay").length,
    fill_count: events.length,
    cash: {
      initial_cash_usd: roundUsd(initialCashUsd),
      expected_cash_usd: expectedCashUsd,
      reported_cash_usd: actualCashUsd,
      delta_usd: roundUsd(actualCashUsd - expectedCashUsd)
    },
    pnl: {
      fill_ledger_realized_pnl_usd: realized,
      metrics_realized_pnl_usd: metricsRealized,
      tax_lot_realized_pnl_usd: fifoRealized,
      metrics_unrealized_pnl_usd: roundUsd(toNum(backtest?.metrics?.unrealized_pnl_usd, 0))
    },
    issues
  };
}

function csvEscape(value) {
  if (value == null) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function taxLotsToCsv(records) {
  const columns = [
    "export_id",
    "source",
    "event_type",
    "tax_lot_id",
    "source_trade_id",
    "order_id",
    "symbol",
    "contract_address",
    "acquired_at",
    "disposed_at",
    "quantity",
    "proceeds_usd",
    "cost_basis_usd",
    "fee_usd",
    "realized_gain_loss_usd",
    "remaining_quantity",
    "remaining_cost_basis_usd",
    "accounting_method"
  ];
  return `${columns.join(",")}\n${records.map((record) => columns.map((column) => csvEscape(record[column])).join(",")).join("\n")}\n`;
}

function markdownReport(report) {
  const lines = [
    `# Reconciliation Accounting - ${report.report_id}`,
    "",
    `Generated: ${report.generated_at}`,
    `Policy: ${report.policy_version}`,
    `Overall status: ${report.status}`,
    `Live trading blocked: ${report.live_trading_blocked ? "yes" : "no"}`,
    "",
    "## Paper",
    "",
    `- Status: ${report.reconciliation.paper.status}`,
    `- Trades / orders / fills: ${report.reconciliation.paper.trade_count} / ${report.reconciliation.paper.order_count} / ${report.reconciliation.paper.fill_count}`,
    `- Cash delta: $${report.reconciliation.paper.cash?.delta_usd ?? 0}`,
    `- Issues: ${report.reconciliation.paper.issues.length}`,
    "",
    "## Replay",
    "",
    `- Status: ${report.reconciliation.replay.status}`,
    `- Trades / orders / fills: ${report.reconciliation.replay.trade_count} / ${report.reconciliation.replay.order_count} / ${report.reconciliation.replay.fill_count}`,
    `- Cash delta: $${report.reconciliation.replay.cash?.delta_usd ?? 0}`,
    `- Issues: ${report.reconciliation.replay.issues.length}`,
    "",
    "## Tax-Lot Export",
    "",
    `- Export ID: ${report.tax_lot_export.export_id}`,
    `- Accounting method: ${report.tax_lot_export.accounting_method}`,
    `- Records: ${report.tax_lot_export.record_count}`,
    `- CSV: ${report.tax_lot_export.csv_file}`,
    `- JSON: ${report.tax_lot_export.json_file}`,
    "",
    "## Critical Issues",
    "",
    ...(report.issues.filter((issue) => issue.severity === "critical").length
      ? report.issues.filter((issue) => issue.severity === "critical").map((issue) => `- ${issue.scope}/${issue.code}: ${issue.detail}`)
      : ["- none"])
  ];
  return `${lines.join("\n")}\n`;
}

function parseArgs(argv) {
  const get = (name, fallback = null) => argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
  return {
    generatedAt: get("generated-at", null),
    portfolioFile: get("portfolio-file", null),
    backtestReport: get("backtest-report", null),
    writeReport: !argv.includes("--no-write"),
    assertClean: argv.includes("--assert-clean")
  };
}

export function generateReconciliationAccountingReport(options = {}) {
  const portfolioPath = options.portfolioFile ? path.resolve(ROOT, options.portfolioFile) : PORTFOLIO_FILE;
  const portfolioRaw = fs.existsSync(portfolioPath) ? fs.readFileSync(portfolioPath, "utf8") : "";
  const portfolio = readJsonFile(portfolioPath, {});
  const explicitBacktest = options.backtestReport
    ? { filePath: path.resolve(ROOT, options.backtestReport), report: readJsonFile(path.resolve(ROOT, options.backtestReport)) }
    : null;
  const backtestSource = explicitBacktest?.report ? explicitBacktest : latestBacktestReport();
  const backtest = backtestSource?.report || null;
  const paperTrades = normalizePaperTrades(portfolio);
  const replayEvents = normalizeReplayEvents(backtest);
  const orders = collectOrders({ paperTrades, backtest });
  const paperTaxIssues = [];
  const replayTaxIssues = [];
  const paperTaxLots = buildFifoLedger(paperTrades, "paper", paperTaxIssues);
  const replayTaxLots = buildFifoLedger(replayEvents, "replay", replayTaxIssues);
  const paper = reconcilePaper(portfolio, paperTrades, orders, paperTaxLots);
  const replay = reconcileReplay(backtest, replayEvents, orders, replayTaxLots);
  paper.issues.push(...paperTaxIssues);
  replay.issues.push(...replayTaxIssues);
  paper.status = paper.issues.some((issue) => issue.severity === "critical") ? "mismatch" : "reconciled";
  replay.status = replay.issues.some((issue) => issue.severity === "critical") ? "mismatch" : replay.status;

  const latestSourceTs = [
    ...paperTrades.map((trade) => trade.ts),
    ...replayEvents.map((event) => event.ts),
    backtest?.generated_at,
    portfolio?.stats?.last_updated_at
  ].filter(Boolean).sort().at(-1);
  const generatedAt = options.generatedAt || latestSourceTs || new Date(0).toISOString();
  const allIssues = [...paper.issues, ...replay.issues].sort((a, b) => a.issue_id.localeCompare(b.issue_id));
  const status = allIssues.some((issue) => issue.severity === "critical") ? "mismatch" : "reconciled";
  const inputHash = sha256(stableStringify({
    policy_version: RECONCILIATION_POLICY_VERSION,
    portfolio_sha256: sha256(portfolioRaw),
    backtest_report_id: backtest?.report_id || null,
    backtest_input_hash: backtest?.input_hash || null,
    backtest_output_hash: backtest?.determinism?.output_hash || null
  }));
  const reportId = `recon_${inputHash.slice(0, 24)}`;
  const taxRecordsBase = [
    ...paperTaxLots.acquisitions.map((lot) => ({ ...lot, event_type: "acquisition", disposed_at: null, proceeds_usd: null, realized_gain_loss_usd: null })),
    ...paperTaxLots.disposals,
    ...paperTaxLots.open_lots.map((lot) => ({ ...lot, event_type: "open_lot", disposed_at: null, proceeds_usd: null, realized_gain_loss_usd: null })),
    ...replayTaxLots.acquisitions.map((lot) => ({ ...lot, event_type: "acquisition", disposed_at: null, proceeds_usd: null, realized_gain_loss_usd: null })),
    ...replayTaxLots.disposals,
    ...replayTaxLots.open_lots.map((lot) => ({ ...lot, event_type: "open_lot", disposed_at: null, proceeds_usd: null, realized_gain_loss_usd: null }))
  ].sort((a, b) => stableStringify(a).localeCompare(stableStringify(b)));
  const exportId = `taxexp_${sha256(stableStringify({
    input_hash: inputHash,
    accounting_method: "FIFO",
    records: taxRecordsBase
  })).slice(0, 24)}`;
  const taxRecords = taxRecordsBase.map((record) => ({ export_id: exportId, ...record }));
  const timestamp = formatReportTimestamp(new Date(optionalMs(generatedAt) || 0));
  const reportFile = `reports/reconciliation/reconciliation-${timestamp}.json`;
  const markdownFile = `reports/reconciliation/reconciliation-${timestamp}.md`;
  const taxJsonFile = `reports/reconciliation/tax-lots/tax-lots-${exportId}.json`;
  const taxCsvFile = `reports/reconciliation/tax-lots/tax-lots-${exportId}.csv`;
  const report = {
    report_id: reportId,
    report_type: "reconciliation_accounting",
    schema_version: RECONCILIATION_ACCOUNTING_SCHEMA_VERSION,
    policy_version: RECONCILIATION_POLICY_VERSION,
    generated_at: generatedAt,
    status,
    live_trading_enabled: false,
    live_submission_enabled: false,
    live_trading_blocked: status !== "reconciled",
    live_trading_blockers: status !== "reconciled" ? ["reconciliation_mismatch"] : [],
    input_hash: inputHash,
    report_file: reportFile,
    markdown_file: markdownFile,
    data_sources: {
      portfolio_json: path.relative(ROOT, portfolioPath),
      backtest_report: backtestSource?.filePath ? path.relative(ROOT, backtestSource.filePath) : null,
      scope: "paper_and_replay_only"
    },
    assumptions: {
      accounting_method: "FIFO",
      external_exchange_balances: "not_connected_phase_12_paper_replay_only",
      external_wallet_balances: "not_connected_phase_12_paper_replay_only",
      live_reconciliation: "disabled",
      portfolio_mutation: "disabled"
    },
    reconciliation: { paper, replay },
    issues: allIssues,
    tax_lot_export: {
      export_id: exportId,
      export_id_basis: "sha256(input_hash,accounting_method,tax_records)",
      accounting_method: "FIFO",
      record_count: taxRecords.length,
      realized_record_count: taxRecords.filter((record) => record.disposed_at).length,
      open_lot_record_count: taxRecords.filter((record) => !record.disposed_at).length,
      json_file: taxJsonFile,
      csv_file: taxCsvFile
    }
  };

  report.determinism = {
    deterministic_fields_hash: inputHash,
    output_hash: sha256(stableStringify({
      ...report,
      report_file: null,
      markdown_file: null,
      determinism: null
    })),
    note: "Reconciliation IDs and tax export IDs are deterministic for fixed portfolio and replay inputs."
  };

  if (options.writeReport !== false) {
    fs.mkdirSync(RECONCILIATION_REPORTS_DIR, { recursive: true });
    fs.mkdirSync(TAX_EXPORTS_DIR, { recursive: true });
    fs.writeFileSync(path.join(ROOT, reportFile), `${JSON.stringify(report, null, 2)}\n`);
    fs.writeFileSync(path.join(ROOT, markdownFile), markdownReport(report));
    fs.writeFileSync(path.join(ROOT, taxJsonFile), `${JSON.stringify({
      export_id: exportId,
      schema_version: RECONCILIATION_ACCOUNTING_SCHEMA_VERSION,
      accounting_method: "FIFO",
      source_scope: "paper_and_replay_only",
      input_hash: inputHash,
      records: taxRecords
    }, null, 2)}\n`);
    fs.writeFileSync(path.join(ROOT, taxCsvFile), taxLotsToCsv(taxRecords));
  }

  return report;
}

if (process.argv[1] === __filename) {
  const options = parseArgs(process.argv.slice(2));
  const report = generateReconciliationAccountingReport(options);
  const summary = {
    report_id: report.report_id,
    report_file: options.writeReport === false ? null : report.report_file,
    status: report.status,
    live_trading_blocked: report.live_trading_blocked,
    issue_count: report.issues.length,
    critical_issue_count: report.issues.filter((issue) => issue.severity === "critical").length,
    tax_lot_export_id: report.tax_lot_export.export_id,
    tax_lot_record_count: report.tax_lot_export.record_count
  };
  console.log(JSON.stringify(summary, null, 2));
  if (options.assertClean && report.status !== "reconciled") {
    process.exitCode = 1;
  }
}
