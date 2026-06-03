#!/usr/bin/env node
// One-shot backfill: reconstructs AgentPortfolioSnapshots from portfolio_snapshot
// data stored in E3DAgentActions.payload_json (one row per unique cycle_id).
// Safe to run once. Re-running without --force exits early.
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

function loadDotEnv(root) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(root, ".env"), "utf8");
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex < 1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    if (!key || key.includes(" ") || process.env[key] != null) continue;
    let value = trimmed.slice(eqIndex + 1).split("#")[0].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
loadDotEnv(ROOT);

const CH_BASE_URL = process.env.AWS_E3D_CLICKHOUSE_HTTP_URL || process.env.LOCAL_CLICKHOUSE_HTTP_URL || "";
const CH_DATABASE = process.env.AWS_E3D_CLICKHOUSE_DATABASE || process.env.LOCAL_CLICKHOUSE_DATABASE || "default";
const CH_USER = process.env.AWS_E3D_CLICKHOUSE_USER || process.env.LOCAL_CLICKHOUSE_USER || "default";
const CH_PASSWORD = process.env.AWS_E3D_CLICKHOUSE_PASSWORD || process.env.LOCAL_CLICKHOUSE_PASSWORD || "";

const PORTFOLIO_ID = "default";
const INITIAL_CASH_USD = 100000;
const BATCH_SIZE = 500;
const STATE_FILE = path.join(ROOT, "state", "portfolio-snapshot-writer-state.json");

function chQuery({ query, input = "", timeoutMs = 60000 }) {
  if (!CH_BASE_URL) throw new Error("ClickHouse URL not configured. Set AWS_E3D_CLICKHOUSE_HTTP_URL.");
  const url = new URL(CH_BASE_URL);
  url.searchParams.set("database", CH_DATABASE);
  const body = `${query}${input ? `\n${input}` : ""}`;
  const args = [
    "-sS", "--fail-with-body",
    "--max-time", String(Math.max(1, Math.ceil(timeoutMs / 1000))),
    "-u", `${CH_USER}:${CH_PASSWORD}`,
    url.toString(),
    "--data-binary", "@-",
  ];
  try {
    return execFileSync("curl", args, { encoding: "utf8", timeout: timeoutMs, input: body });
  } catch (err) {
    const detail = err?.stdout || err?.stderr || "";
    throw new Error(`${err?.message || String(err)}${detail ? `\n${detail.slice(0, 2000)}` : ""}`);
  }
}

function queryRows(sql) {
  const raw = chQuery({ query: `${sql} FORMAT JSONEachRow`, timeoutMs: 60000 });
  return String(raw || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function insertBatch(rows) {
  const input = rows.map((r) => JSON.stringify(r)).join("\n");
  chQuery({
    query: `INSERT INTO ${CH_DATABASE}.AgentPortfolioSnapshots SETTINGS input_format_skip_unknown_fields = 1 FORMAT JSONEachRow`,
    input,
    timeoutMs: 60000,
  });
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return {}; }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function toChDateTime(s) {
  return String(s).replace("T", " ").replace("Z", "");
}

function mapRowToSnapshot(row) {
  const snapshotTime = toChDateTime(row.ts);
  const equityUsd = Number(row.equity_usd) || 0;
  return {
    portfolioId: PORTFOLIO_ID,
    mode: "PAPER",
    snapshotTime,
    equityUsd: +equityUsd.toFixed(6),
    cashUsd: +(Number(row.cash_usd) || 0).toFixed(6),
    unrealizedPnlUsd: +(Number(row.unrealized_pnl_usd) || 0).toFixed(6),
    realizedPnlUsd: +(Number(row.realized_pnl_usd) || 0).toFixed(6),
    totalPnlUsd: +(equityUsd - INITIAL_CASH_USD).toFixed(6),
    benchmarkEthValueUsd: 0,
    benchmarkBtcValueUsd: 0,
    benchmarkCustomValueUsd: 0,
    openPositionsCount: Number(row.open_positions) || 0,
    blockedActionsCount: 0,
    createdAt: snapshotTime,
  };
}

function main() {
  const dryRun = process.argv.includes("--dry-run");
  const force = process.argv.includes("--force");
  const verbose = process.argv.includes("--verbose");

  if (!CH_BASE_URL) {
    console.error("ERROR: ClickHouse URL not configured. Set AWS_E3D_CLICKHOUSE_HTTP_URL.");
    process.exit(1);
  }

  const state = loadState();
  if (state.backfillCompletedAt && !force) {
    console.log(`Backfill already completed at ${state.backfillCompletedAt} (${state.backfillRowsInserted} rows).`);
    console.log("Run with --force to re-run.");
    process.exit(0);
  }

  // Find earliest existing snapshot to avoid duplicating what the cron has already written
  let cutoff = null;
  try {
    const rows = queryRows(
      `SELECT min(snapshotTime) AS earliest
       FROM ${CH_DATABASE}.AgentPortfolioSnapshots
       WHERE portfolioId = '${PORTFOLIO_ID}'`
    );
    const earliest = rows[0]?.earliest;
    if (earliest && !earliest.startsWith("1970")) {
      cutoff = earliest;
      console.log(`Existing snapshots start at ${cutoff} — backfilling only data before that.`);
    }
  } catch (err) {
    console.warn(`warn: could not query existing snapshots (${err.message})`);
  }

  // One row per cycle: take the first executor_decision in each cycle that has equity data.
  // argMin selects the value corresponding to the minimum created_at within the group.
  const cutoffClause = cutoff
    ? `AND created_at < parseDateTime64BestEffort('${cutoff}')`
    : "";

  console.log("Querying E3DAgentActions for per-cycle portfolio snapshots...");
  const rows = queryRows(`
    SELECT
      argMin(created_at, created_at)                                                         AS ts,
      argMin(JSONExtractFloat(payload_json, 'portfolio_snapshot', 'equity_usd'), created_at) AS equity_usd,
      argMin(JSONExtractFloat(payload_json, 'portfolio_snapshot', 'cash_usd'), created_at)   AS cash_usd,
      argMin(JSONExtractFloat(payload_json, 'portfolio_snapshot', 'realized_pnl_usd'), created_at)   AS realized_pnl_usd,
      argMin(JSONExtractFloat(payload_json, 'portfolio_snapshot', 'unrealized_pnl_usd'), created_at) AS unrealized_pnl_usd,
      argMin(JSONExtractUInt(payload_json, 'portfolio_snapshot', 'position_count'), created_at)      AS open_positions
    FROM ${CH_DATABASE}.E3DAgentActions
    WHERE event_type = 'executor_decision'
      AND JSONExtractFloat(payload_json, 'portfolio_snapshot', 'equity_usd') > 0
      ${cutoffClause}
    GROUP BY cycle_id
    ORDER BY ts ASC
  `);

  console.log(`Found ${rows.length} cycles to backfill.`);
  if (rows.length === 0) {
    console.log("Nothing to insert.");
    return;
  }

  if (verbose || rows.length > 0) {
    const first = rows[0];
    const last = rows[rows.length - 1];
    console.log(`  Date range : ${first.ts}  →  ${last.ts}`);
    console.log(`  Equity range: $${Number(first.equity_usd).toFixed(2)}  →  $${Number(last.equity_usd).toFixed(2)}`);
  }

  const snapshots = rows.map(mapRowToSnapshot);
  let inserted = 0;

  for (let i = 0; i < snapshots.length; i += BATCH_SIZE) {
    const batch = snapshots.slice(i, i + BATCH_SIZE);
    const end = Math.min(i + BATCH_SIZE, snapshots.length);
    if (dryRun) {
      console.log(`  dry-run: batch ${i + 1}–${end} (${batch.length} rows)`);
      if (verbose && i === 0) console.log("  first row:", JSON.stringify(batch[0], null, 2));
    } else {
      insertBatch(batch);
      inserted += batch.length;
      console.log(`  inserted ${inserted}/${snapshots.length}`);
    }
  }

  if (dryRun) {
    console.log(`\ndry-run complete — ${snapshots.length} rows would be inserted.`);
    return;
  }

  state.backfillCompletedAt = new Date().toISOString();
  state.backfillRowsInserted = inserted;
  saveState(state);
  console.log(`\nBackfill complete: ${inserted} rows inserted.`);
}

if (process.argv[1] === __filename) {
  try {
    main();
  } catch (err) {
    console.error(`FATAL: ${err.message}`);
    process.exit(1);
  }
}
