import assert from "assert/strict";
import {
  MAPS_DESTINATION_MAP,
  buildMapsNavigatorPrecheck,
  getMapsDestinationsForSymbol,
  signalMatchesPosition
} from "./mapsHarvestPrecheck.js";

assert.deepEqual(getMapsDestinationsForSymbol("ETH"), MAPS_DESTINATION_MAP.ETH);
assert.deepEqual(getMapsDestinationsForSymbol("unknown"), ["UNKNOWN"]);

const mapsContext = {
  closures: [
    {
      origin: "stablecoins",
      destination: "ETH_DEFI",
      asset_scope: ["AAVE", "ETH"],
      answer: "Validator exit queue is congested and primary DeFi routes are impaired.",
      recommended_action: "Exit or materially reduce exposure.",
      confidence: 0.91,
      risk_level: "critical"
    }
  ],
  hazards: [
    {
      origin: "stablecoins",
      destination: "ARB",
      asset_scope: ["ARB"],
      answer: "Bridge latency is rising and execution quality is deteriorating.",
      confidence: 0.73,
      risk_level: "high"
    }
  ]
};

assert.equal(signalMatchesPosition(mapsContext.closures[0], "ETH", ["ETH_DEFI", "LIQUID_STAKING"]), true);
assert.equal(signalMatchesPosition(mapsContext.hazards[0], "OP", ["L2_NETWORKS", "OP"]), false);

const ethPrecheck = buildMapsNavigatorPrecheck({ symbol: "ETH", mapsContext });
assert.equal(ethPrecheck.closure_matches.length, 1);
assert.equal(ethPrecheck.hazard_matches.length, 0);
assert.match(ethPrecheck.prompt_prefix, /\[MAPS NAVIGATOR\] Route closure detected for ETH_DEFI:/);
assert.match(ethPrecheck.prompt_prefix, /Recommended action: Exit or materially reduce exposure\./);
assert.match(ethPrecheck.prompt_prefix, /Confidence: 0\.91\. Risk: critical\./);

const arbPrecheck = buildMapsNavigatorPrecheck({ symbol: "ARB", mapsContext });
assert.equal(arbPrecheck.closure_matches.length, 0);
assert.equal(arbPrecheck.hazard_matches.length, 1);
assert.match(arbPrecheck.prompt_prefix, /\[MAPS NAVIGATOR\] Route hazard on stablecoins→ARB:/);
assert.match(arbPrecheck.prompt_prefix, /Risk level: high\. Confidence: 0\.73\./);

const nullPrecheck = buildMapsNavigatorPrecheck({ symbol: "USDC", mapsContext: null });
assert.equal(nullPrecheck.prompt_prefix, "");
assert.equal(nullPrecheck.closure_matches.length, 0);
assert.equal(nullPrecheck.hazard_matches.length, 0);

console.log(JSON.stringify({
  verified: true,
  destination_map_keys: Object.keys(MAPS_DESTINATION_MAP).length,
  eth_lines: ethPrecheck.lines.length,
  arb_lines: arbPrecheck.lines.length,
  null_maps_ok: nullPrecheck.prompt_prefix === ""
}, null, 2));
