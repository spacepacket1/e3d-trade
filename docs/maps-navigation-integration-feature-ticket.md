# E3D Maps Navigation Integration — Feature Ticket

## Overview

E3D Maps is a separate service (repo: `e3d-maps`) running on the same machine. It reads
on-chain stories, theses, wallet activity, and market state, then generates forward-looking
`NavigationSignal` objects: machine-readable predictions about where capital is moving,
which routes are open or closing, where congestion is forming, and more.

This ticket wires Maps into the trading floor as a read-only intelligence layer. Maps
signals become a third input to cycle context alongside `macro` (quant regime) and
`mergedContext` (stories + evidence). The pipeline is the driver. Maps is the navigator.

**Run this spec from the `e3d-agent-trading-floor` root:**

```bash
codex-spec-runner docs/maps-navigation-integration-feature-ticket.md all --provider claude
```

**Or phase-by-phase:**

```bash
codex-spec-runner docs/maps-navigation-integration-feature-ticket.md 1 --provider claude
```

---

## Background

### What the Trading Floor Does Today

The pipeline (`pipeline.js`) runs a cycle with two agents:

- **Scout** — scans the token universe from `/actions`, `/theses`, and on-chain flow data.
  Builds candidate evidence packets and calls the LLM to rank them.
- **Harvest** — reviews held positions for exit signals using story-type analysis plus LLM.

Cycle context is assembled from:
1. `_cycleQuantContext` — macro regime (risk_on/risk_off/neutral), BTC change, fear/greed.
2. `mergedContext` — stories, evidence packets, flow data, dossier data.

The LLM system prompt is built around line 4898 of `pipeline.js` and injects `MACRO: regime=...`
as a one-line context string.

Maps adds a third lane: **where is capital moving at the route level**, independent of
token-level price signals.

### What E3D Maps Provides

Maps exposes navigation signals via the main E3D API under `/api/maps/`. The base URL is
`E3D_API_BASE_URL` (same env var the trading floor already uses). Auth is handled by
`e3dAuthClient.js` via `e3dRequest`.

**Key endpoints:**

| Endpoint | What it provides |
|---|---|
| `GET /api/maps/signals` | All recent NavigationSignals (paginated). Query params: `signal_type`, `min_confidence`, `limit`, `offset` |
| `GET /api/maps/destinations` | `destination_prediction` signals ranked by confidence |
| `GET /api/maps/congestion` | `congestion_formation` signals, newest first |
| `GET /api/maps/hazards` | `route_hazard` signals |
| `GET /api/maps/graph` | Latest FlowGraph: nodes + directed edges with strength/status |
| `GET /api/maps/graph/:node` | Subgraph around a single capital location node |
| `GET /api/maps/calibration` | Per-signal-type realized accuracy + utility scores over last 30 days |

**NavigationSignal fields used by the trading floor:**

```
signal_type         — one of 10 types (see below)
answer              — 2-3 sentence plain-English prediction
origin              — capital source (e.g. "stablecoins", "ETH", "PERPS")
destination         — capital target (e.g. "ETH_DEFI", "BASE_DEFI", "CEX")
asset_scope         — relevant tokens (e.g. ["ETH", "AAVE"])
chain_scope         — relevant chains (e.g. ["ethereum", "base"])
time_horizon_hours  — prediction horizon (6, 12, or 24)
confidence          — float 0.0–1.0 (treat ≥ 0.65 as actionable)
risk_level          — "low" | "medium" | "high" | "critical"
signal_strength     — "weak" | "moderate" | "strong"
market_state        — "risk_on" | "risk_off" | "neutral" | "transitioning"
recommended_action  — plain-English action hint
supporting_story_ids — IDs of E3D stories backing this signal (same IDs the trading floor knows)
created_at          — ISO timestamp
outcome_status      — "pending" | "correct" | "incorrect" | "mixed"
```

**The 10 signal types and their trading relevance:**

| Signal type | Trading relevance |
|---|---|
| `capital_migration` | Directional rotation — which sector/chain is receiving capital |
| `destination_prediction` | Probability-weighted target destinations |
| `congestion_formation` | Execution risk — crowding at a destination, size down or delay |
| `route_hazard` | Rising risk on a route, still open — raise stops, reduce exposure |
| `route_closure` | Hard block — capital cannot flow along this path, avoid or reroute |
| `route_emergence` | New route opening — early opportunity window |
| `liquidity_forecast` | Liquidity thinning or building — affects execution quality |
| `capital_conviction` | Committed vs. exploratory capital — follow or fade |
| `narrative_acceleration` | Velocity check — narrative running ahead of on-chain data |
| `agent_swarm_formation` | Crowding warning — multiple actors converging, reflexivity risk |

**FlowGraph edge statuses:**

| Status | Meaning |
|---|---|
| `new` | Route appeared this cycle |
| `strengthening` | Confidence increased > 10% from last snapshot |
| `weakening` | Confidence decreased > 10% |
| `active` | Stable |
| `closed` | Route was present last cycle, now absent |

### Integration Constraints

- All integration goes through the `/api/maps/` HTTP API. No direct Python↔JS imports.
- The trading floor is a **read-only** Maps consumer. Never write to Maps tables.
- Auth is already handled by `e3dAuthClient.js`. Use `e3dRequest` for all Maps calls.
- Maps signals are predictions with confidence scores, not oracles. Low-confidence signals
  (< 0.50) are weak priors. The LLM retains full discretion on ambiguous cases.
- Maps fetch failures must be non-fatal. The pipeline degrades gracefully if Maps is down.
- Do not modify the deterministic buy-gate safety floors, risk engine, or promotion gates.

---

## Phase 1 — Maps API Client

Create `scripts/mapsClient.js` — a lightweight authenticated client for the Maps API.

### What to build

Follow the pattern established by `e3dAuthClient.js` and how `pipeline.js` calls
`${E3D_API_BASE_URL}/stories`, `${E3D_API_BASE_URL}/actions`, etc.

The file should:

1. Import `e3dRequest`, `E3D_API_BASE_URL` from `../e3dAuthClient.js`.
2. Export a `MAPS_API_BASE_URL` constant:
   ```js
   const MAPS_API_BASE_URL = process.env.E3D_MAPS_BASE_URL || E3D_API_BASE_URL;
   ```
   This allows the Maps base URL to be overridden separately if needed (e.g. local dev),
   but defaults to the same `E3D_API_BASE_URL` the rest of the pipeline uses.

3. Export the following async functions. Each must:
   - Use `e3dRequest(url)` for the HTTP call (handles auth headers automatically).
   - Return a parsed JSON object on success.
   - Return a safe default (empty array or `null`) and log a warning on any error.
   - Never throw — Maps is best-effort.

```js
// Returns array of NavigationSignal objects.
// options: { signalType, minConfidence, limit, offset }
export async function fetchMapsSignals(options = {}) { ... }

// Returns array of destination_prediction signals ranked by confidence.
export async function fetchMapsDestinations({ limit = 10 } = {}) { ... }

// Returns array of congestion_formation signals.
export async function fetchMapsCongestion({ limit = 10 } = {}) { ... }

// Returns array of route_hazard signals.
export async function fetchMapsHazards({ limit = 10 } = {}) { ... }

// Returns array of route_closure signals.
export async function fetchMapsClosures({ limit = 10 } = {}) { ... }

// Returns the full FlowGraph: { snapshot_id, created_at, nodes, edges }
// Returns null if no snapshot exists yet.
export async function fetchMapsFlowGraph() { ... }

// Returns subgraph for a single node: { node, snapshot_id, inbound, outbound }
export async function fetchMapsFlowGraphNode(node) { ... }

// Returns calibration data: { summary, reliability_curve, by_signal_type }
export async function fetchMapsCalibration() { ... }

// Returns a consolidated Maps context object suitable for injection into cycle context.
// Calls fetchMapsDestinations, fetchMapsCongestion, fetchMapsHazards, fetchMapsClosures,
// and fetchMapsFlowGraph in parallel. Returns { destinations, congestion, hazards,
// closures, flow_graph, fetched_at }. Always returns the object even if all sub-calls fail.
export async function fetchMapsContext({ signalLimit = 5 } = {}) { ... }
```

### fetchMapsContext shape

```js
{
  destinations: [  // top destination_prediction signals by confidence
    { destination, confidence, risk_level, signal_strength, answer, time_horizon_hours, asset_scope }
  ],
  congestion: [    // active congestion_formation signals
    { destination, confidence, risk_level, answer, time_horizon_hours }
  ],
  hazards: [       // route_hazard signals
    { origin, destination, confidence, risk_level, answer }
  ],
  closures: [      // route_closure signals
    { origin, destination, confidence, risk_level, answer, recommended_action }
  ],
  flow_graph: {    // from /api/maps/graph, or null
    snapshot_id,
    created_at,
    nodes: ["ETH_DEFI", "stablecoins", ...],
    edges: [
      { origin, destination, strength, confidence, hazard_level, edge_status }
    ]
  },
  fetched_at: "2026-06-11T17:00:00.000Z"
}
```

### Verification

Add a standalone verification script `scripts/verifyMapsClient.js` that:
1. Calls `fetchMapsContext()`.
2. Logs the result summary: number of destinations, congestion signals, hazards, closures,
   graph node count if available.
3. Exits 0 on success, 1 if `fetchMapsContext` itself throws (it shouldn't).
4. Prints a clear `WARN: Maps returned no data` if all arrays are empty — that is
   acceptable (Maps may not have signals yet) but worth surfacing.

Add it to the `check` script in `package.json`:
```
"node --check scripts/mapsClient.js && node --check scripts/verifyMapsClient.js"
```

And add an npm script:
```
"maps:verify": "node scripts/verifyMapsClient.js"
```

---

## Phase 2 — Cycle Context Injection

Inject Maps context into the cycle and into the LLM system prompt.

### Context assembly (pipeline.js)

`_cycleQuantContext` is populated once per cycle. Maps context should be fetched at the
same time as the quant context — once per cycle, stored at module scope as `_cycleMapsContext`,
and reset to `null` at the start of each cycle alongside the other cycle-scoped state.

Locate the section that fetches/resets `_cycleQuantContext` and add a parallel fetch for
Maps context. Maps fetch should run concurrently with — not before or after — the quant
context fetch, so it doesn't add wall-clock time to the cycle.

Store the result at module scope:
```js
let _cycleMapsContext = null;  // reset each cycle
```

### System prompt injection (pipeline.js ~line 4898)

Find where `systemPrompt` is assembled as an array of strings. Currently it includes:
```js
macroContext ? `MACRO: regime=${macroContext.regime} new_positions_ok=...` : "",
```

After that line, add Maps context lines:

```js
// MAPS: capital flow signals from E3D Maps navigator
_cycleMapsContext?.destinations?.length
  ? `MAPS DESTINATIONS: ${_cycleMapsContext.destinations
      .slice(0, 3)
      .map(d => `${d.destination}(conf=${d.confidence.toFixed(2)},${d.risk_level})`)
      .join(", ")}`
  : "",

_cycleMapsContext?.congestion?.length
  ? `MAPS CONGESTION: ${_cycleMapsContext.congestion
      .slice(0, 2)
      .map(c => `${c.destination}(conf=${c.confidence.toFixed(2)})`)
      .join(", ")}`
  : "",

_cycleMapsContext?.hazards?.length
  ? `MAPS HAZARDS: ${_cycleMapsContext.hazards
      .slice(0, 2)
      .map(h => `${h.origin}→${h.destination}(${h.risk_level})`)
      .join(", ")}`
  : "",

_cycleMapsContext?.closures?.length
  ? `MAPS ROUTE CLOSURES: ${_cycleMapsContext.closures
      .map(c => `${c.origin}→${c.destination} CLOSED — ${c.recommended_action}`)
      .join("; ")}`
  : "",
```

### PIPELINE_LOG enrichment

In the cycle summary object that gets written to `PIPELINE_LOG`, include a `maps_context`
field with the `_cycleMapsContext` snapshot (or `null`). This gives training data and
retrospective analysis access to what Maps was saying when each trade decision was made.

Find the object written to `PIPELINE_LOG` at end-of-cycle and add:
```js
maps_context: _cycleMapsContext || null,
```

### Verification

After this phase:
1. `npm run check` must pass.
2. Run `node pipeline.js --once 2>&1 | head -100` and verify:
   - No uncaught errors from Maps fetch.
   - The pipeline completes normally if Maps is down (Maps fetch error → graceful degradation).
3. If Maps has live signals, run with `PIPELINE_DEBUG_MODE=1` and confirm the
   `MAPS DESTINATIONS:` line appears in the logged system prompt.

---

## Phase 3 — Harvest Pre-Check for Route Closures and Hazards

Give the harvest agent privileged awareness of Maps route closures and hazards for its
held positions. A confirmed `route_closure` on a held position's destination is a
hard structural exit signal — the LLM should know before it decides.

### What to build

In the harvest cycle, before calling the LLM, check whether any active Maps closure or
hazard signal covers the destination associated with each held position.

The harvest agent already loops over held positions to decide hold/exit/reduce. In that
loop, for each position:

1. Extract the position's relevant destination node. Use the token symbol or a known
   mapping to Maps destination vocabulary (e.g., `ETH` → `ETH_DEFI`, `ARB` → `L2_NETWORKS`).
   Keep the mapping simple and hardcoded in a `MAPS_DESTINATION_MAP` constant at the top
   of the integration — do not over-engineer this; it can be expanded incrementally.

2. Check `_cycleMapsContext.closures` for any closure where `destination` matches or
   `asset_scope` includes the position's token symbol.

3. Check `_cycleMapsContext.hazards` similarly.

4. Inject findings as a pre-prompt prefix into the harvest LLM user message for that
   position:

```
[MAPS NAVIGATOR] Route closure detected for ${destination}: "${closure.answer}"
Recommended action: ${closure.recommended_action}
Confidence: ${closure.confidence.toFixed(2)}. Risk: ${closure.risk_level}.
```

or for hazards:
```
[MAPS NAVIGATOR] Route hazard on ${origin}→${destination}: "${hazard.answer}"
Risk level: ${hazard.risk_level}. Confidence: ${hazard.confidence.toFixed(2)}.
```

This does not short-circuit the LLM — the harvest agent retains full discretion. It
simply ensures the LLM has the Maps signal as explicit context rather than inferring it
from story data alone.

### MAPS_DESTINATION_MAP

Define a simple constant near the top of `pipeline.js` (or in `mapsClient.js`):

```js
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
  BTC: ["BTC"],
  // Extend as the system learns which tokens map to which Maps destinations.
};
```

### Verification

1. `npm run check` passes.
2. With `PIPELINE_DEBUG_MODE=1`, run a harvest cycle and verify the `[MAPS NAVIGATOR]`
   prefix appears in `logs/agent-raw.jsonl` when Maps has active closure or hazard signals.
3. Verify that when `_cycleMapsContext` is `null` (Maps down), the harvest loop runs
   normally with no errors.

---

## Phase 4 — FlowGraph Edge Check for Scout Route Validation

Give the scout a live route map. Before the LLM ranks candidates, check the FlowGraph to
see whether the destination implied by each candidate's thesis is on an open, strengthening,
weakening, or closed edge. Surface this as a per-candidate annotation.

### What to build

In the scout cycle, after candidate evidence packets are assembled and before the LLM
call, for each candidate:

1. Resolve the candidate's implied Maps destination using `MAPS_DESTINATION_MAP` (same
   constant from Phase 3).

2. Query the in-memory FlowGraph (`_cycleMapsContext.flow_graph`) for edges where
   `destination` matches. No HTTP call — just read from the already-fetched context.

3. If a matching edge exists, annotate the candidate evidence packet with:

```js
maps_route: {
  destination: edge.destination,
  edge_status: edge.edge_status,      // "new" | "strengthening" | "weakening" | "active" | "closed"
  edge_confidence: edge.confidence,
  edge_strength: edge.strength,       // "weak" | "moderate" | "strong"
  hazard_level: edge.hazard_level,    // "low" | "medium" | "high" | "critical"
}
```

4. In the scout system prompt, add a line for each annotated candidate:
```
MAPS ROUTE [${symbol}]: ${destination} edge=${edge_status} conf=${confidence} hazard=${hazard_level}
```

5. Candidates with `edge_status: "closed"` should have their `thesis_signal_score` reduced
   by a configurable penalty factor (`MAPS_CLOSED_ROUTE_PENALTY = 0.25`). This is applied
   deterministically before the LLM — it is a soft floor, not a hard block. The LLM can
   still act if it has overriding evidence, but the candidate starts at a lower score.

6. Candidates with `edge_status: "strengthening"` may receive a configurable boost
   (`MAPS_STRENGTHENING_ROUTE_BONUS = 0.10`) applied to `thesis_signal_score`.

### Config constants

Add near the top of `pipeline.js` (or a config section):

```js
const MAPS_CLOSED_ROUTE_PENALTY = Number(process.env.MAPS_CLOSED_ROUTE_PENALTY || 0.25);
const MAPS_STRENGTHENING_ROUTE_BONUS = Number(process.env.MAPS_STRENGTHENING_ROUTE_BONUS || 0.10);
const MAPS_MIN_CONFIDENCE_THRESHOLD = Number(process.env.MAPS_MIN_CONFIDENCE_THRESHOLD || 0.50);
```

Only apply edge adjustments when the edge's `confidence >= MAPS_MIN_CONFIDENCE_THRESHOLD`.
Below that threshold, treat the FlowGraph edge as informational only — no score adjustment.

### PIPELINE_LOG enrichment

In the candidate object written to `PIPELINE_LOG`, include `maps_route` when present.
This enables retrospective analysis of whether Maps route status correlated with trade
outcomes.

### Verification

1. `npm run check` passes.
2. Run `node scripts/verifyMapsClient.js` — confirms Maps client is wired and returning data.
3. Run `node pipeline.js --once` with `PIPELINE_DEBUG_MODE=1`. In `logs/agent-raw.jsonl`,
   confirm `maps_route` appears on candidates where a FlowGraph edge was found.
4. Confirm that score adjustments only fire when `edge.confidence >= MAPS_MIN_CONFIDENCE_THRESHOLD`.
5. Confirm that a missing or null `_cycleMapsContext.flow_graph` causes no errors — scout
   runs normally without Maps route annotations.

---

## Appendix: Maps Vocabulary Reference

**Capital location nodes** (used in `origin` and `destination` fields):

```
stablecoins        — idle stable capital (USDC, USDT, DAI)
ETH                — ETH spot
BTC                — BTC spot
ETH_DEFI           — DeFi protocols on Ethereum (AAVE, Compound, Uniswap, Curve, etc.)
BASE_DEFI          — DeFi protocols on Base
MEME_TOKENS        — meme/narrative token sector
PERPS              — perpetual futures venues (dYdX, GMX, Hyperliquid, etc.)
REAL_WORLD_ASSETS  — RWA protocols
L2_NETWORKS        — L2 broadly; use ARB, OP, BASE for specific chains when known
CEX                — centralized exchange deposits (inflow = selling pressure signal)
NFT_MARKETS        — NFT/gaming asset markets
LIQUID_STAKING     — staking derivatives (Lido, Rocket Pool, etc.)
```

**Signal confidence guidance:**

| Confidence | Interpretation |
|---|---|
| ≥ 0.75 | Strong signal — multiple corroborating on-chain evidence sources |
| 0.50–0.74 | Moderate signal — directional but not fully confirmed |
| 0.30–0.49 | Weak signal — informational only, no score adjustments |
| < 0.30 | Suppressed — Maps chose not to emit this (null returned by agent) |

**Maps is updated every 5 minutes.** The `fetched_at` field in `_cycleMapsContext` tells
you how stale the data is. If `fetched_at` is more than 15 minutes old, log a warning —
Maps may have stopped running.
