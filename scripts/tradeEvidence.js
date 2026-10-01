import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPOSITORY_ROOT = path.dirname(__dirname);
const DEFAULT_SIDECAR_PATH = path.join(REPOSITORY_ROOT, "logs", "trade-evidence.jsonl");
const EVIDENCE_FIELDS = ["order_lifecycle", "token_risk_scan", "simulated_execution"];

function hasOwn(target, key) {
  return Object.prototype.hasOwnProperty.call(target, key);
}

function buildAbsentEvidence() {
  return {
    order_lifecycle: null,
    token_risk_scan: null,
    simulated_execution: null
  };
}

function normalizeEmbeddedEvidence(trade) {
  return {
    order_lifecycle: hasOwn(trade, "order_lifecycle") && trade.order_lifecycle !== undefined ? trade.order_lifecycle : null,
    token_risk_scan: hasOwn(trade, "token_risk_scan") && trade.token_risk_scan !== undefined ? trade.token_risk_scan : null,
    simulated_execution: hasOwn(trade, "simulated_execution") && trade.simulated_execution !== undefined ? trade.simulated_execution : null
  };
}

function isValidEvidenceRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return false;
  if (typeof record.trade_id !== "string") return false;
  return EVIDENCE_FIELDS.every((field) => hasOwn(record, field));
}

function shouldShortCircuitToEmbeddedEvidence(trade) {
  if (!trade || typeof trade !== "object" || Array.isArray(trade)) return false;
  return EVIDENCE_FIELDS.some((field) => hasOwn(trade, field));
}

function resolveSidecarPath(options = {}) {
  return options.sidecarPath || DEFAULT_SIDECAR_PATH;
}

function isAlreadyExternalizedTrade(trade) {
  if (!trade || typeof trade !== "object" || Array.isArray(trade)) return false;
  if (typeof trade.evidence_ref !== "string" || !trade.evidence_ref) return false;
  return EVIDENCE_FIELDS.every((field) => !hasOwn(trade, field));
}

function buildExternalizedRecord(trade) {
  if (!trade || typeof trade !== "object" || Array.isArray(trade)) {
    throw new Error("trade_id must be a non-empty string");
  }
  if (typeof trade.trade_id !== "string" || !trade.trade_id) {
    throw new Error("trade_id must be a non-empty string");
  }
  return {
    trade_id: trade.trade_id,
    order_lifecycle: hasOwn(trade, "order_lifecycle") && trade.order_lifecycle !== undefined ? trade.order_lifecycle : null,
    token_risk_scan: hasOwn(trade, "token_risk_scan") && trade.token_risk_scan !== undefined ? trade.token_risk_scan : null,
    simulated_execution: hasOwn(trade, "simulated_execution") && trade.simulated_execution !== undefined ? trade.simulated_execution : null
  };
}

function fileNeedsSeparator(sidecarPath) {
  let stats;
  try {
    stats = fs.statSync(sidecarPath);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (!stats.size) return false;
  const fd = fs.openSync(sidecarPath, "r");
  try {
    const tail = Buffer.alloc(1);
    fs.readSync(fd, tail, 0, 1, stats.size - 1);
    return tail[0] !== 0x0a;
  } finally {
    fs.closeSync(fd);
  }
}

function defaultAppend(sidecarPath, line) {
  fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });
  const payload = fileNeedsSeparator(sidecarPath) ? `\n${line}` : line;
  fs.appendFileSync(sidecarPath, payload, "utf8");
}

function defaultFsync(sidecarPath) {
  const fd = fs.openSync(sidecarPath, "r+");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function readEvidenceLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

// resolveTradeEvidence() is called once per trade by every consumer that loops over
// portfolio history (reconciliationAccounting.js, signalAttribution.js, etc. -- 1,845+
// trades as of the Sep 2026 migration). Without caching, each call re-read and re-parsed
// the entire sidecar file, turning a single report into an O(trades x file size) scan --
// confirmed live: signalAttribution.js took over 2.5 minutes and was still running when
// killed, pegged at 100%+ CPU, against an 18MB sidecar. Cache the parsed
// trade_id -> evidence map per resolved sidecarPath, keyed on the file's mtimeMs/size so a
// change (a new externalized trade) is picked up on the next call rather than served stale.
const sidecarCache = new Map();

function loadSidecarRecordsByTradeId(sidecarPath) {
  let stats;
  try {
    stats = fs.statSync(sidecarPath);
  } catch {
    sidecarCache.delete(sidecarPath);
    return null;
  }
  const cached = sidecarCache.get(sidecarPath);
  if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
    return cached.recordsByTradeId;
  }
  let raw;
  try {
    raw = fs.readFileSync(sidecarPath, "utf8");
  } catch {
    sidecarCache.delete(sidecarPath);
    return null;
  }
  const recordsByTradeId = new Map();
  for (const line of raw.split("\n")) {
    const record = readEvidenceLine(line);
    if (!isValidEvidenceRecord(record)) continue;
    recordsByTradeId.set(record.trade_id, {
      order_lifecycle: record.order_lifecycle ?? null,
      token_risk_scan: record.token_risk_scan ?? null,
      simulated_execution: record.simulated_execution ?? null
    });
  }
  sidecarCache.set(sidecarPath, { mtimeMs: stats.mtimeMs, size: stats.size, recordsByTradeId });
  return recordsByTradeId;
}

function resolveTradeEvidence(trade, options = {}) {
  if (!trade || typeof trade !== "object" || Array.isArray(trade)) {
    return buildAbsentEvidence();
  }
  if (shouldShortCircuitToEmbeddedEvidence(trade)) {
    return normalizeEmbeddedEvidence(trade);
  }
  if (typeof trade.evidence_ref !== "string" || !trade.evidence_ref) {
    return buildAbsentEvidence();
  }

  const recordsByTradeId = loadSidecarRecordsByTradeId(resolveSidecarPath(options));
  if (!recordsByTradeId) return buildAbsentEvidence();

  return recordsByTradeId.get(trade.evidence_ref) || buildAbsentEvidence();
}

function externalizeTradeEvidence(trade, options = {}) {
  if (isAlreadyExternalizedTrade(trade)) {
    return trade;
  }

  const record = buildExternalizedRecord(trade);
  const line = `${JSON.stringify(record)}\n`;
  const sidecarPath = resolveSidecarPath(options);
  const fileOps = options.fileOps || null;
  const append = fileOps?.append || defaultAppend;
  const fsync = fileOps?.fsync || defaultFsync;

  append(sidecarPath, line);
  fsync(sidecarPath);

  trade.evidence_ref = trade.trade_id;
  delete trade.order_lifecycle;
  delete trade.token_risk_scan;
  delete trade.simulated_execution;
  return trade;
}

export {
  externalizeTradeEvidence,
  resolveTradeEvidence,
  DEFAULT_SIDECAR_PATH
};
