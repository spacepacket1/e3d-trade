const MAPS_DESTINATION_MAP = {
  ETH: ["ETH_DEFI", "LIQUID_STAKING"],
  AAVE: ["ETH_DEFI"],
  COMP: ["ETH_DEFI"],
  ARB: ["L2_NETWORKS", "ARB"],
  OP: ["L2_NETWORKS", "OP"],
  BASE: ["L2_NETWORKS", "BASE_DEFI"],
  USDC: ["stablecoins"],
  USDT: ["stablecoins"],
  DAI: ["stablecoins"],
  BTC: ["BTC"]
};

function normalizeSymbol(symbol) {
  return String(symbol || "").trim().toUpperCase();
}

function normalizeDestination(destination) {
  return String(destination || "").trim();
}

function normalizeAssetScope(assetScope) {
  if (Array.isArray(assetScope)) {
    return assetScope.map((value) => normalizeSymbol(value)).filter(Boolean);
  }
  if (typeof assetScope === "string") {
    return assetScope
      .split(/[,\s|]+/g)
      .map((value) => normalizeSymbol(value))
      .filter(Boolean);
  }
  return [];
}

function getMapsDestinationsForSymbol(symbol) {
  const normalizedSymbol = normalizeSymbol(symbol);
  const mapped = MAPS_DESTINATION_MAP[normalizedSymbol];
  if (Array.isArray(mapped) && mapped.length) return mapped.map((value) => normalizeDestination(value)).filter(Boolean);
  return normalizedSymbol ? [normalizedSymbol] : [];
}

function signalMatchesPosition(signal, tokenSymbol, destinations = []) {
  const normalizedSymbol = normalizeSymbol(tokenSymbol);
  const signalDestination = normalizeDestination(signal?.destination);
  const signalAssetScope = normalizeAssetScope(signal?.asset_scope);
  return (
    (signalDestination && destinations.includes(signalDestination))
    || (normalizedSymbol && signalAssetScope.includes(normalizedSymbol))
  );
}

function formatConfidence(confidence) {
  const numeric = Number(confidence);
  return Number.isFinite(numeric) ? numeric.toFixed(2) : "0.00";
}

function buildMapsNavigatorPrecheck({ symbol, mapsContext } = {}) {
  const normalizedSymbol = normalizeSymbol(symbol);
  const destinations = getMapsDestinationsForSymbol(normalizedSymbol);
  const closures = Array.isArray(mapsContext?.closures) ? mapsContext.closures : [];
  const hazards = Array.isArray(mapsContext?.hazards) ? mapsContext.hazards : [];
  const closureMatches = closures.filter((signal) => signalMatchesPosition(signal, normalizedSymbol, destinations));
  const hazardMatches = hazards.filter((signal) => signalMatchesPosition(signal, normalizedSymbol, destinations));

  const lines = [];
  for (const closure of closureMatches) {
    const destination = normalizeDestination(closure?.destination) || destinations[0] || normalizedSymbol;
    lines.push(`[MAPS NAVIGATOR] Route closure detected for ${destination}: "${String(closure?.answer || "").trim()}"`);
    lines.push(`Recommended action: ${String(closure?.recommended_action || "monitor").trim()}`);
    lines.push(`Confidence: ${formatConfidence(closure?.confidence)}. Risk: ${String(closure?.risk_level || "unknown").trim()}.`);
  }
  for (const hazard of hazardMatches) {
    const origin = normalizeDestination(hazard?.origin) || "unknown";
    const destination = normalizeDestination(hazard?.destination) || destinations[0] || normalizedSymbol;
    lines.push(`[MAPS NAVIGATOR] Route hazard on ${origin}→${destination}: "${String(hazard?.answer || "").trim()}"`);
    lines.push(`Risk level: ${String(hazard?.risk_level || "unknown").trim()}. Confidence: ${formatConfidence(hazard?.confidence)}.`);
  }

  return {
    symbol: normalizedSymbol,
    destinations,
    closure_matches: closureMatches,
    hazard_matches: hazardMatches,
    lines,
    prompt_prefix: lines.join("\n")
  };
}

export {
  MAPS_DESTINATION_MAP,
  buildMapsNavigatorPrecheck,
  getMapsDestinationsForSymbol,
  signalMatchesPosition
};
