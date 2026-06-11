import assert from "assert/strict";
import { applyMapsRouteScoreAdjustment, buildScoutMapsRoute } from "./mapsScoutRoute.js";

const mapsContext = {
  flow_graph: {
    snapshot_id: "snap_1",
    created_at: "2026-06-11T18:00:00.000Z",
    nodes: ["ETH_DEFI", "L2_NETWORKS", "BASE_DEFI"],
    edges: [
      { origin: "stablecoins", destination: "ETH_DEFI", strength: "strong", confidence: 0.82, hazard_level: "low", edge_status: "strengthening" },
      { origin: "stablecoins", destination: "BASE_DEFI", strength: "moderate", confidence: 0.91, hazard_level: "high", edge_status: "closed" },
      { origin: "stablecoins", destination: "L2_NETWORKS", strength: "moderate", confidence: 0.41, hazard_level: "medium", edge_status: "strengthening" }
    ]
  }
};

const ethRoute = buildScoutMapsRoute("ETH", mapsContext);
assert.deepEqual(ethRoute, {
  destination: "ETH_DEFI",
  edge_status: "strengthening",
  edge_confidence: 0.82,
  edge_strength: "strong",
  hazard_level: "low"
});

const baseRoute = buildScoutMapsRoute("BASE", mapsContext);
assert.deepEqual(baseRoute, {
  destination: "BASE_DEFI",
  edge_status: "closed",
  edge_confidence: 0.91,
  edge_strength: "moderate",
  hazard_level: "high"
});

const unknownRoute = buildScoutMapsRoute("DOGE", mapsContext);
assert.equal(unknownRoute, null);

const strengtheningAdjusted = applyMapsRouteScoreAdjustment(75, ethRoute, {
  closedRoutePenalty: 0.25,
  strengtheningRouteBonus: 0.10,
  minConfidenceThreshold: 0.50
});
assert.equal(strengtheningAdjusted.base_score, 75);
assert.equal(strengtheningAdjusted.adjusted_score, 83);
assert.equal(strengtheningAdjusted.adjustment_applied, true);
assert.equal(strengtheningAdjusted.adjustment_reason, "strengthening_route_bonus");

const closedAdjusted = applyMapsRouteScoreAdjustment(80, {
  destination: "BASE_DEFI",
  edge_status: "closed",
  edge_confidence: 0.91,
  edge_strength: "moderate",
  hazard_level: "high"
}, {
  closedRoutePenalty: 0.25,
  strengtheningRouteBonus: 0.10,
  minConfidenceThreshold: 0.50
});
assert.equal(closedAdjusted.base_score, 80);
assert.equal(closedAdjusted.adjusted_score, 60);
assert.equal(closedAdjusted.adjustment_applied, true);
assert.equal(closedAdjusted.adjustment_reason, "closed_route_penalty");

const informationalOnly = applyMapsRouteScoreAdjustment(75, baseRoute, {
  closedRoutePenalty: 0.25,
  strengtheningRouteBonus: 0.10,
  minConfidenceThreshold: 0.95
});
assert.equal(informationalOnly.adjusted_score, 75);
assert.equal(informationalOnly.adjustment_applied, false);
assert.equal(informationalOnly.adjustment_reason, "below_confidence_threshold");

const missingGraph = buildScoutMapsRoute("ETH", { flow_graph: null });
assert.equal(missingGraph, null);

console.log(JSON.stringify({
  ok: true,
  verified_routes: ["ETH", "BASE", "DOGE"],
  confidence_threshold_behavior: "verified",
  missing_flow_graph_behavior: "verified"
}, null, 2));
