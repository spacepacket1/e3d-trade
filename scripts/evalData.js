// Loaders shared by the evaluation scripts (baselineCompare, settingsLedger,
// snapshotCompleteness). Read-only: they stream JSONL files line by line and keep
// only the fields evaluation needs. They never read portfolio.json, .env or reports/.
import fs from "fs";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "..");
export const DEFAULT_FILES = {
  snapshots: path.join(ROOT, "logs", "candidate-snapshots.jsonl"),
  settingsLedger: path.join(ROOT, "logs", "settings-ledger.jsonl"),
  trainingEvents: path.join(ROOT, "logs", "training-events.jsonl")
};
export const WETH_ADDRESS = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";

export function toMs(value) {
  if (value == null || value === "") return null;
  const ms = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

export function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

// Streams a JSONL file; calls onRecord(record) for each parseable line whose raw text
// passes the optional cheap prefilter. Missing file -> { exists: false }.
export async function streamJsonl(filePath, onRecord, prefilter = null) {
  const stats = { exists: false, lines: 0, parsed: 0, malformed: 0 };
  if (!filePath || !fs.existsSync(filePath)) return stats;
  stats.exists = true;
  const rl = readline.createInterface({ input: fs.createReadStream(filePath, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    stats.lines += 1;
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (prefilter && !prefilter(trimmed)) continue;
    let record;
    try { record = JSON.parse(trimmed); } catch { stats.malformed += 1; continue; }
    stats.parsed += 1;
    onRecord(record);
  }
  return stats;
}

export async function loadSnapshots(filePath = DEFAULT_FILES.snapshots) {
  const records = [];
  const stats = await streamJsonl(filePath, (r) => { if (r && r.record_type) records.push(r); });
  return { records, stats };
}

export async function loadSettingsLedger(filePath = DEFAULT_FILES.settingsLedger) {
  const records = [];
  const stats = await streamJsonl(filePath, (r) => { if (r?.settings_hash) records.push(r); });
  return { records, stats };
}

// Minimal training-event view: cycle_start ids and trade events (buy/sell legs).
export async function loadTrainingEvents(filePath = DEFAULT_FILES.trainingEvents) {
  const cycleStarts = [];
  const tradeEvents = [];
  const stats = await streamJsonl(filePath, (r) => {
    if (r?.event_type === "cycle_start") {
      cycleStarts.push({ cycle_id: r.cycle_id || null, ts: r.ts || null });
    } else if (r?.event_type === "trade") {
      const t = r.payload?.trade || {};
      tradeEvents.push({
        ts: t.ts || r.ts || null,
        cycle_id: r.cycle_id || null,
        side: t.side || null,
        symbol: t.symbol || null,
        contract_address: String(t.contract_address || "").toLowerCase() || null,
        position_id: t.position_id || r.position_id || null,
        trade_id: t.trade_id || r.trade_id || null,
        trade_lifecycle: t.trade_lifecycle || r.payload?.trade_lifecycle || null,
        cash_debit_usd: Number.isFinite(Number(t.cash_debit_usd)) ? Number(t.cash_debit_usd) : null,
        cost_portion_usd: Number.isFinite(Number(t.cost_portion_usd)) ? Number(t.cost_portion_usd) : null,
        pnl_usd: Number.isFinite(Number(t.pnl_usd)) ? Number(t.pnl_usd) : null,
        price: Number.isFinite(Number(t.price)) ? Number(t.price) : null,
        settings_hash: t.settings_hash || null
      });
    }
  }, (line) => line.includes("\"cycle_start\"") || line.includes("\"trade\""));
  return { cycleStarts, tradeEvents, stats };
}

// Group buy/sell legs into closed positions. A position is closed when a sell leg has
// trade_lifecycle "close". Net return = sum(sell pnl) / sum(sell cost portion); the
// cost basis already includes the buy fee and proceeds are net of the sell fee.
export function buildClosedPositions(tradeEvents) {
  const byPosition = new Map();
  for (const leg of tradeEvents) {
    const key = leg.position_id || `${leg.contract_address || leg.symbol}`;
    if (!key) continue;
    if (!byPosition.has(key)) byPosition.set(key, { key, buys: [], sells: [] });
    const group = byPosition.get(key);
    if (leg.side === "buy") group.buys.push(leg);
    else if (leg.side === "sell") group.sells.push(leg);
  }
  const closed = [];
  for (const group of byPosition.values()) {
    group.buys.sort((a, b) => (toMs(a.ts) ?? 0) - (toMs(b.ts) ?? 0));
    group.sells.sort((a, b) => (toMs(a.ts) ?? 0) - (toMs(b.ts) ?? 0));
    const closeIdx = group.sells.findIndex((leg) => leg.trade_lifecycle === "close");
    if (!group.buys.length || closeIdx === -1) continue;
    const sells = group.sells.slice(0, closeIdx + 1);
    const entry = group.buys[0];
    const exit = sells[sells.length - 1];
    const pnl = sells.reduce((sum, leg) => sum + (leg.pnl_usd ?? 0), 0);
    const cost = sells.reduce((sum, leg) => sum + (leg.cost_portion_usd ?? 0), 0);
    const entryMs = toMs(entry.ts);
    const exitMs = toMs(exit.ts);
    if (entryMs == null || exitMs == null || !(cost > 0)) continue;
    closed.push({
      position_id: group.key,
      symbol: entry.symbol,
      contract_address: entry.contract_address,
      entry_ts: entry.ts,
      entry_ms: entryMs,
      exit_ts: exit.ts,
      exit_ms: exitMs,
      holding_ms: Math.max(0, exitMs - entryMs),
      entry_cycle_id: entry.cycle_id,
      entry_price: entry.price,
      cost_usd: cost,
      pnl_usd: pnl,
      net_return: pnl / cost,
      entry_settings_hash: entry.settings_hash || null,
      exit_settings_hash: exit.settings_hash || null,
      legs: group.buys.length + sells.length
    });
  }
  return closed.sort((a, b) => a.entry_ms - b.entry_ms || String(a.position_id).localeCompare(String(b.position_id)));
}
