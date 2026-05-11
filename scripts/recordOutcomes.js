#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, "..");
const RUN_LEDGER_LOG = path.join(ROOT, "logs", "run-ledger.jsonl");
const E3D_API_BASE_URL = process.env.E3D_API_BASE_URL || "https://e3d.ai/api";
const E3D_API_KEY = process.env.E3D_API_KEY || "";

function readLedger() {
  if (!fs.existsSync(RUN_LEDGER_LOG)) return [];
  return fs.readFileSync(RUN_LEDGER_LOG, "utf8")
    .split("\n").filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

function writeLedger(entries) {
  fs.writeFileSync(RUN_LEDGER_LOG, entries.map(e => JSON.stringify(e)).join("\n") + "\n");
}

function fetchTokenPrice(address) {
  try {
    const url = `${E3D_API_BASE_URL}/token-info/${encodeURIComponent(address)}`;
    const curlArgs = ["-s", "--max-time", "15", url];
    if (E3D_API_KEY) curlArgs.push("-H", `Authorization: Bearer ${E3D_API_KEY}`);
    const stdout = execFileSync("curl", curlArgs, { encoding: "utf8", timeout: 20000 });
    const parsed = JSON.parse(stdout);
    return parsed?.priceUSD ?? parsed?.price_usd ?? parsed?.current_price ?? null;
  } catch {
    return null;
  }
}

function pctChange(from, to) {
  if (!from || from === 0 || to == null) return null;
  return Math.round(((to - from) / from) * 10000) / 100;
}

function now() { return Date.now(); }

async function main() {
  const entries = readLedger();
  if (!entries.length) { console.log("No ledger entries."); return; }

  const nowMs = now();
  let updatedCount = 0;

  for (const entry of entries) {
    if (entry?.outcomes?.recorded_at) continue;
    const cycleTs = new Date(entry?.cycle_ts || 0).getTime();
    const ageSec = (nowMs - cycleTs) / 1000;
    if (ageSec < 3600) continue; // not yet 1h old

    const tradedCandidates = (entry?.scout?.candidates || []).filter(c => c?.market_at_signal?.price_usd > 0 && c?.address);
    if (!tradedCandidates.length) {
      // Mark as pending with no trades
      entry.outcomes = { ...entry.outcomes, recorded_at: new Date().toISOString(), outcome_label: "neutral" };
      updatedCount++;
      continue;
    }

    // Fetch current prices for traded candidates
    const priceChanges = [];
    for (const c of tradedCandidates) {
      const currentPrice = fetchTokenPrice(c.address);
      if (currentPrice == null) continue;
      const pct = pctChange(c.market_at_signal.price_usd, currentPrice);
      if (pct != null) priceChanges.push(pct);
    }

    if (!priceChanges.length) continue;

    const avgChange = priceChanges.reduce((a, b) => a + b, 0) / priceChanges.length;

    // Fill in time-bucketed outcomes
    const outcomes = { ...entry.outcomes };
    outcomes.recorded_at = new Date().toISOString();

    if (ageSec >= 3600 && outcomes.price_1h_pct == null) outcomes.price_1h_pct = avgChange;
    if (ageSec >= 14400 && outcomes.price_4h_pct == null) outcomes.price_4h_pct = avgChange;
    if (ageSec >= 86400 && outcomes.price_24h_pct == null) outcomes.price_24h_pct = avgChange;
    if (ageSec >= 604800 && outcomes.price_7d_pct == null) outcomes.price_7d_pct = avgChange;

    // signal_detected_before_move: true if price moved > 10% within 4h
    if (ageSec >= 14400 && outcomes.signal_detected_before_move == null) {
      outcomes.signal_detected_before_move = (outcomes.price_4h_pct ?? 0) > 10;
    }

    // outcome_label based on best available timeframe
    const bestPct = outcomes.price_24h_pct ?? outcomes.price_4h_pct ?? outcomes.price_1h_pct;
    if (bestPct != null) {
      outcomes.outcome_label = bestPct > 5 ? "win" : bestPct < -5 ? "loss" : "neutral";
    } else {
      outcomes.outcome_label = "pending";
    }

    entry.outcomes = outcomes;
    updatedCount++;
  }

  if (updatedCount > 0) {
    writeLedger(entries);
    console.log(`Updated outcomes for ${updatedCount} ledger entries.`);
  } else {
    console.log("No entries ready for outcome recording.");
  }
}

main().catch(err => { console.error("recordOutcomes error:", err.message); process.exit(1); });
