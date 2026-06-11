import { getMapsDestinationsForSymbol } from "./mapsHarvestPrecheck.js";

function toNum(value, fallback = NaN) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function normalizeSymbol(symbol) {
  return String(symbol || "").trim().toUpperCase();
}

function normalizeDestination(destination) {
  return String(destination || "").trim();
}

function edgeStatusPriority(edgeStatus) {
  const normalized = String(edgeStatus || "").trim().toLowerCase();
  if (normalized === "closed") return 5;
  if (normalized === "weakening") return 4;
  if (normalized === "strengthening") return 3;
  if (normalized === "active") return 2;
  if (normalized === "new") return 1;
  return 0;
}

function compareEdgesByConfidence(a, b) {
  return (
    edgeStatusPriority(b?.edge_status) - edgeStatusPriority(a?.edge_status)
    || toNum(b?.confidence, -1) - toNum(a?.confidence, -1)
  );
}

export function buildScoutMapsRoute(symbol, mapsContext) {
  const normalizedSymbol = normalizeSymbol(symbol);
  const destinations = getMapsDestinationsForSymbol(normalizedSymbol);
  const edges = Array.isArray(mapsContext?.flow_graph?.edges) ? mapsContext.flow_graph.edges : [];

  const destinationSet = new Set(destinations.map((destination) => normalizeDestination(destination)).filter(Boolean));
  const edge = edges
    .filter((candidate) => destinationSet.has(normalizeDestination(candidate?.destination)))
    .sort(compareEdgesByConfidence)[0];
  if (edge) {
    return {
      destination: normalizeDestination(edge.destination) || destinations[0] || normalizedSymbol,
      edge_status: String(edge?.edge_status || "").trim() || null,
      edge_confidence: Number.isFinite(toNum(edge?.confidence, NaN)) ? toNum(edge.confidence, NaN) : null,
      edge_strength: String(edge?.strength || "").trim() || null,
      hazard_level: String(edge?.hazard_level || "").trim() || null
    };
  }

  return null;
}

export function applyMapsRouteScoreAdjustment(thesisSignalScore, mapsRoute, config = {}) {
  const baseScore = toNum(thesisSignalScore, NaN);
  const closedRoutePenalty = toNum(config.closedRoutePenalty, 0.25);
  const strengtheningRouteBonus = toNum(config.strengtheningRouteBonus, 0.10);
  const minConfidenceThreshold = toNum(config.minConfidenceThreshold, 0.50);

  if (!Number.isFinite(baseScore)) {
    return {
      base_score: null,
      adjusted_score: null,
      score_delta: null,
      adjustment_applied: false,
      adjustment_reason: "invalid_base_score"
    };
  }

  const roundedBaseScore = Math.max(0, Math.min(100, Math.round(baseScore)));
  const edgeConfidence = toNum(mapsRoute?.edge_confidence, NaN);
  const edgeStatus = String(mapsRoute?.edge_status || "").trim().toLowerCase();

  if (!mapsRoute) {
    return {
      base_score: roundedBaseScore,
      adjusted_score: roundedBaseScore,
      score_delta: 0,
      adjustment_applied: false,
      adjustment_reason: "no_maps_route"
    };
  }

  if (!Number.isFinite(edgeConfidence) || edgeConfidence < minConfidenceThreshold) {
    return {
      base_score: roundedBaseScore,
      adjusted_score: roundedBaseScore,
      score_delta: 0,
      adjustment_applied: false,
      adjustment_reason: "below_confidence_threshold"
    };
  }

  let adjustedScore = roundedBaseScore;
  let adjustmentReason = "no_adjustment";

  if (edgeStatus === "closed") {
    adjustedScore = Math.round(roundedBaseScore * (1 - Math.max(0, closedRoutePenalty)));
    adjustmentReason = "closed_route_penalty";
  } else if (edgeStatus === "strengthening") {
    adjustedScore = Math.round(roundedBaseScore * (1 + Math.max(0, strengtheningRouteBonus)));
    adjustmentReason = "strengthening_route_bonus";
  }

  adjustedScore = Math.max(0, Math.min(100, adjustedScore));

  return {
    base_score: roundedBaseScore,
    adjusted_score: adjustedScore,
    score_delta: adjustedScore - roundedBaseScore,
    adjustment_applied: adjustedScore !== roundedBaseScore,
    adjustment_reason: adjustmentReason
  };
}
