#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// cron invokes this script through the /Users/mini/e3d-agent-trading-floor symlink using its
// absolute path. __filename is realpath-resolved by the module loader, so a naive string compare
// against process.argv[1] (the symlinked path) never matches and runProfitTakeCalibration() never runs.
function isDirectlyInvoked() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === __filename;
  } catch {
    return path.resolve(process.argv[1]) === __filename;
  }
}

const ROOT = path.join(__dirname, "..");
const DEFAULT_PORTFOLIO_PATH = path.join(ROOT, "portfolio.json");
const DEFAULT_LEDGER_PATH = path.join(ROOT, "logs", "profit-take-calibration.jsonl");
const DEFAULT_REPORTS_DIR = path.join(ROOT, "reports", "profit-take-calibration");
const H24_MS = 86400000;
const H48_MS = 172800000;
const REPORT_TYPE = "profit_take_calibration";
const COHORTS = ["stop_loss", "target_hit", "manual_action"];

export function classifyExitCohort(reason) {
  if (reason === "stop_loss") return "stop_loss";
  if (reason === "target_1" || reason === "target_2" || reason === "target_3") return "target_hit";
  if (typeof reason === "string" && reason.startsWith("manual_operator")) return "manual_action";
  return null;
}

function warn(message) {
  console.error(`profitTakeCalibration: ${message}`);
}

// Number(null) === 0, Number("") === 0, and Number(false) === 0 all pass
// Number.isFinite(), so a missing/blank trade field would otherwise be silently
// accepted as a real zero instead of being rejected. Guard against those before
// coercing.
function toFiniteNumber(value) {
  if (value === null || value === undefined || typeof value === "boolean") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function toPositiveNumber(value) {
  const number = toFiniteNumber(value);
  return number !== null && number > 0 ? number : null;
}

function normalizeTrade(trade, index, recordedAt) {
  const exitReason = typeof trade?.reason === "string" ? trade.reason : "";
  const exitCohort = classifyExitCohort(exitReason);
  if (!exitCohort) {
    warn(`skipping closed_trades[${index}]: unsupported reason`);
    return null;
  }

  const tradeId = typeof trade?.trade_id === "string" ? trade.trade_id.trim() : "";
  if (!tradeId) {
    warn(`skipping closed_trades[${index}]: missing trade_id`);
    return null;
  }

  const contractAddress = typeof trade?.contract_address === "string" ? trade.contract_address.trim() : "";
  if (!contractAddress) {
    warn(`skipping trade ${tradeId}: missing contract_address`);
    return null;
  }

  const exitTsMs = new Date(trade?.ts).getTime();
  if (!Number.isFinite(exitTsMs)) {
    warn(`skipping trade ${tradeId}: invalid ts`);
    return null;
  }

  const quantity = toPositiveNumber(trade?.quantity);
  if (quantity == null) {
    warn(`skipping trade ${tradeId}: invalid quantity`);
    return null;
  }

  const pnlUsd = toFiniteNumber(trade?.pnl_usd);
  if (pnlUsd == null) {
    warn(`skipping trade ${tradeId}: invalid pnl_usd`);
    return null;
  }

  const costBasisUsd = toFiniteNumber(trade?.cost_basis_usd) ?? toFiniteNumber(trade?.cost_portion_usd);
  if (costBasisUsd == null) {
    warn(`skipping trade ${tradeId}: invalid cost basis`);
    return null;
  }

  const exitPrice = toPositiveNumber(trade?.fill_price) ?? toPositiveNumber(trade?.price);
  if (exitPrice == null) {
    warn(`skipping trade ${tradeId}: invalid exit price`);
    return null;
  }

  return {
    trade_id: tradeId,
    symbol: typeof trade?.symbol === "string" ? trade.symbol : "",
    contract_address: contractAddress,
    exit_reason: exitReason,
    exit_cohort: exitCohort,
    exit_ts: new Date(exitTsMs).toISOString(),
    exit_price: exitPrice,
    quantity,
    pnl_usd: pnlUsd,
    cost_basis_usd: costBasisUsd,
    hold_price_24h: null,
    hold_price_48h: null,
    beat_hold_24h: null,
    beat_hold_48h: null,
    recorded_at: recordedAt
  };
}

// The minimum shape applyHoldPrice()/normalizeTrade() always produce. Used to reject a
// syntactically valid but incomplete ledger row before it can overwrite real history.
function isValidSnapshotShape(snapshot) {
  if (!Number.isFinite(new Date(snapshot?.exit_ts).getTime())) return false;
  if (toPositiveNumber(snapshot?.quantity) == null) return false;
  if (toFiniteNumber(snapshot?.pnl_usd) == null) return false;
  if (toFiniteNumber(snapshot?.cost_basis_usd) == null) return false;
  if (toPositiveNumber(snapshot?.exit_price) == null) return false;
  return true;
}

function loadPortfolio(portfolioPath) {
  const raw = fs.readFileSync(portfolioPath, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("profitTakeCalibration: portfolio must be a JSON object");
  }
  return parsed;
}

function loadLedgerSnapshots(ledgerPath) {
  const snapshots = new Map();
  if (!fs.existsSync(ledgerPath)) {
    return snapshots;
  }

  const raw = fs.readFileSync(ledgerPath, "utf8");
  const lines = raw.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line) continue;

    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      warn(`ignoring malformed ledger line ${index + 1}`);
      continue;
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      warn(`ignoring non-object ledger line ${index + 1}`);
      continue;
    }

    const tradeId = typeof parsed.trade_id === "string" ? parsed.trade_id.trim() : "";
    if (!tradeId) continue;

    // A syntactically valid JSON object with just a trade_id (truncated write, hand edit,
    // concatenated partial line) must not be accepted as the latest state for that trade --
    // it would silently erase a prior, fully-populated snapshot's hold prices and flags.
    if (!isValidSnapshotShape(parsed)) {
      warn(`ignoring incomplete ledger snapshot for trade ${tradeId} on line ${index + 1}`);
      continue;
    }

    snapshots.set(tradeId, parsed);
  }

  return snapshots;
}

function getEligibleHorizons(snapshot, nowMs) {
  const exitTsMs = new Date(snapshot.exit_ts).getTime();
  if (!Number.isFinite(exitTsMs)) return [];
  const elapsed = nowMs - exitTsMs;
  const horizons = [];
  if (snapshot.hold_price_24h == null && elapsed >= H24_MS) horizons.push("24h");
  if (snapshot.hold_price_48h == null && elapsed >= H48_MS) horizons.push("48h");
  return horizons;
}

// One observed price is written onto every horizon that is already due, in the same
// ledger line -- including when a trade is first discovered past more than one
// horizon at once (downtime, backlog ingestion).
function resolveEligibleHorizons(snapshot, eligibleHorizons, observedPrice, recordedAt) {
  let next = snapshot;
  for (const horizon of eligibleHorizons) {
    next = applyHoldPrice(next, horizon, observedPrice, recordedAt);
  }
  return next;
}

function applyHoldPrice(snapshot, horizonKey, holdPrice, recordedAt) {
  const counterfactualHoldPnlUsd = snapshot.quantity * holdPrice - snapshot.cost_basis_usd;
  const beatHold = snapshot.pnl_usd > counterfactualHoldPnlUsd;
  return {
    trade_id: snapshot.trade_id,
    symbol: snapshot.symbol,
    contract_address: snapshot.contract_address,
    exit_reason: snapshot.exit_reason,
    exit_cohort: snapshot.exit_cohort,
    exit_ts: snapshot.exit_ts,
    exit_price: snapshot.exit_price,
    quantity: snapshot.quantity,
    pnl_usd: snapshot.pnl_usd,
    cost_basis_usd: snapshot.cost_basis_usd,
    hold_price_24h: horizonKey === "24h" ? holdPrice : snapshot.hold_price_24h,
    hold_price_48h: horizonKey === "48h" ? holdPrice : snapshot.hold_price_48h,
    beat_hold_24h: horizonKey === "24h" ? beatHold : snapshot.beat_hold_24h,
    beat_hold_48h: horizonKey === "48h" ? beatHold : snapshot.beat_hold_48h,
    recorded_at: recordedAt
  };
}

function snapshotEqualsIgnoringRecordedAt(left, right) {
  if (!left || !right) return false;
  const leftComparable = { ...left };
  const rightComparable = { ...right };
  delete leftComparable.recorded_at;
  delete rightComparable.recorded_at;
  return JSON.stringify(leftComparable) === JSON.stringify(rightComparable);
}

function average(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function buildEmptyHorizonSummary() {
  return {
    evaluated_count: 0,
    beat_hold_count: 0,
    beat_hold_rate_pct: null,
    average_delta_usd: null,
    median_delta_usd: null
  };
}

function buildEmptyCohortSummary() {
  return {
    trade_count: 0,
    with_both_count: 0,
    h24: buildEmptyHorizonSummary(),
    h48: buildEmptyHorizonSummary()
  };
}

function buildReport(currentSnapshots, reportId, generatedAt) {
  const snapshots = [...currentSnapshots.values()];
  const report = {
    report_type: REPORT_TYPE,
    report_id: reportId,
    generated_at: generatedAt,
    trade_count: snapshots.length,
    with_24h_count: snapshots.filter((snapshot) => snapshot.hold_price_24h != null).length,
    with_48h_count: snapshots.filter((snapshot) => snapshot.hold_price_48h != null).length,
    with_both_count: snapshots.filter((snapshot) => snapshot.hold_price_24h != null && snapshot.hold_price_48h != null).length,
    cohorts: {
      stop_loss: buildEmptyCohortSummary(),
      target_hit: buildEmptyCohortSummary(),
      manual_action: buildEmptyCohortSummary()
    }
  };

  for (const cohort of COHORTS) {
    const cohortSnapshots = snapshots.filter((snapshot) => snapshot.exit_cohort === cohort);
    const cohortSummary = report.cohorts[cohort];
    cohortSummary.trade_count = cohortSnapshots.length;
    cohortSummary.with_both_count = cohortSnapshots.filter((snapshot) => snapshot.hold_price_24h != null && snapshot.hold_price_48h != null).length;

    for (const [label, holdKey, beatKey] of [
      ["h24", "hold_price_24h", "beat_hold_24h"],
      ["h48", "hold_price_48h", "beat_hold_48h"]
    ]) {
      const evaluated = cohortSnapshots.filter((snapshot) => snapshot[holdKey] != null);
      const deltas = evaluated.map((snapshot) => snapshot.pnl_usd - (snapshot.quantity * snapshot[holdKey] - snapshot.cost_basis_usd));
      const beatHoldCount = evaluated.filter((snapshot) => snapshot[beatKey] === true).length;
      cohortSummary[label] = {
        evaluated_count: evaluated.length,
        beat_hold_count: beatHoldCount,
        beat_hold_rate_pct: evaluated.length ? beatHoldCount / evaluated.length * 100 : null,
        average_delta_usd: evaluated.length ? average(deltas) : null,
        median_delta_usd: evaluated.length ? median(deltas) : null
      };
    }
  }

  return report;
}

function buildReportTarget(reportsDir, nowMs) {
  const date = new Date(nowMs);
  const pad = (value) => String(value).padStart(2, "0");
  const stamp = [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate())
  ].join("") + "-" + [pad(date.getUTCHours()), pad(date.getUTCMinutes()), pad(date.getUTCSeconds())].join("");
  const digits = stamp.replace("-", "");

  let suffix = 1;
  while (true) {
    const suffixText = suffix === 1 ? "" : `-${suffix}`;
    const filename = `profit-take-calibration-${stamp}${suffixText}.json`;
    const reportPath = path.join(reportsDir, filename);
    if (!fs.existsSync(reportPath)) {
      return {
        reportPath,
        reportId: `profit_take_calibration_${digits}${suffixText}`
      };
    }
    suffix++;
  }
}

function fetchPriceFromTokenInfo(address, env = process.env) {
  try {
    const apiBaseUrl = env.E3D_API_BASE_URL || "https://e3d.ai/api";
    const apiKey = env.E3D_API_KEY || "";
    const url = `${apiBaseUrl}/token-info/${encodeURIComponent(address)}`;
    const curlArgs = ["-s", "--max-time", "15", url];
    if (apiKey) curlArgs.push("-H", `Authorization: Bearer ${apiKey}`);
    const stdout = execFileSync("curl", curlArgs, { encoding: "utf8", timeout: 20000 });
    const parsed = JSON.parse(stdout);
    const price = parsed?.priceUSD
      ?? parsed?.price_usd
      ?? parsed?.current_price
      ?? parsed?.market_data?.current_price?.usd
      ?? null;
    return toPositiveNumber(price);
  } catch {
    return null;
  }
}

export function runProfitTakeCalibration(options = {}) {
  const portfolioPath = options.portfolioPath || DEFAULT_PORTFOLIO_PATH;
  const ledgerPath = options.ledgerPath || DEFAULT_LEDGER_PATH;
  const reportsDir = options.reportsDir || DEFAULT_REPORTS_DIR;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const env = options.env || process.env;
  const fetchPrice = typeof options.fetchPrice === "function"
    ? options.fetchPrice
    : (address) => fetchPriceFromTokenInfo(address, env);

  const nowMs = now();
  const recordedAt = new Date(nowMs).toISOString();
  const portfolio = loadPortfolio(portfolioPath);
  const currentSnapshots = loadLedgerSnapshots(ledgerPath);
  const closedTrades = Array.isArray(portfolio.closed_trades) ? portfolio.closed_trades : [];
  const pendingSnapshots = [];
  const processedTradeIds = new Set();

  for (let index = 0; index < closedTrades.length; index++) {
    const trade = closedTrades[index];
    if (!trade || typeof trade !== "object" || Array.isArray(trade)) continue;
    if (trade.side != null && trade.side !== "sell") continue;

    const normalized = normalizeTrade(trade, index, recordedAt);
    if (!normalized) continue;
    if (processedTradeIds.has(normalized.trade_id)) continue;
    processedTradeIds.add(normalized.trade_id);

    const existingSnapshot = currentSnapshots.get(normalized.trade_id);
    if (!existingSnapshot) {
      let nextSnapshot = normalized;
      const eligibleHorizons = getEligibleHorizons(nextSnapshot, nowMs);
      if (eligibleHorizons.length) {
        let observedPrice = null;
        try {
          observedPrice = toPositiveNumber(fetchPrice(nextSnapshot.contract_address));
        } catch {
          observedPrice = null;
        }
        if (observedPrice != null) {
          nextSnapshot = resolveEligibleHorizons(nextSnapshot, eligibleHorizons, observedPrice, recordedAt);
        }
        // A failed fetch leaves every due horizon null and un-flagged, so the next
        // run retries all of them from scratch.
      }
      pendingSnapshots.push(nextSnapshot);
      currentSnapshots.set(nextSnapshot.trade_id, nextSnapshot);
      continue;
    }

    const eligibleHorizons = getEligibleHorizons(existingSnapshot, nowMs);
    if (!eligibleHorizons.length) continue;

    let observedPrice = null;
    try {
      observedPrice = toPositiveNumber(fetchPrice(existingSnapshot.contract_address));
    } catch {
      observedPrice = null;
    }
    if (observedPrice == null) continue;

    const nextSnapshot = resolveEligibleHorizons(existingSnapshot, eligibleHorizons, observedPrice, recordedAt);

    if (snapshotEqualsIgnoringRecordedAt(existingSnapshot, nextSnapshot)) continue;
    pendingSnapshots.push(nextSnapshot);
    currentSnapshots.set(nextSnapshot.trade_id, nextSnapshot);
  }

  if (!pendingSnapshots.length) {
    return {
      appendedCount: 0,
      ledgerPath,
      reportPath: null,
      report: null
    };
  }

  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  const ledgerPayload = pendingSnapshots.map((snapshot) => JSON.stringify(snapshot)).join("\n") + "\n";
  fs.appendFileSync(ledgerPath, ledgerPayload);

  fs.mkdirSync(reportsDir, { recursive: true });
  const { reportPath, reportId } = buildReportTarget(reportsDir, nowMs);
  const report = buildReport(currentSnapshots, reportId, recordedAt);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");

  return {
    appendedCount: pendingSnapshots.length,
    ledgerPath,
    reportPath,
    report
  };
}

if (isDirectlyInvoked()) {
  try {
    const result = runProfitTakeCalibration();
    console.log(`profitTakeCalibration: appended ${result.appendedCount} snapshot${result.appendedCount === 1 ? "" : "s"}`);
  } catch (error) {
    console.error(error?.message || String(error));
    process.exit(1);
  }
}
