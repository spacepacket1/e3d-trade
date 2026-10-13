import { E3D_API_BASE_URL, e3dRequest } from "../e3dAuthClient.js";

const MAPS_API_BASE_URL = process.env.E3D_MAPS_BASE_URL || E3D_API_BASE_URL;
// Future prepaid Maps access, if introduced, should purchase credits from
// POST /api/payments/credits/purchase with { product: "maps" } and send the
// returned bearer key (e3d_maps_pay_...) to Maps data routes.

function mapsWarn(message, meta = {}) {
  if (Object.keys(meta).length) {
    console.warn(`WARN: ${message}`, meta);
    return;
  }
  console.warn(`WARN: ${message}`);
}

function buildMapsUrl(pathname, query = {}) {
  const trimmedBase = String(MAPS_API_BASE_URL || "").replace(/\/+$/g, "");
  const trimmedPath = String(pathname || "").replace(/^\/+/g, "");
  const url = new URL(`${trimmedBase}/${trimmedPath}`);
  for (const [key, value] of Object.entries(query)) {
    if (value == null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function parseJsonResponse(response, endpointName, fallbackValue) {
  if (!response?.ok) {
    mapsWarn(`Maps request failed for ${endpointName}`, {
      status: response?.status ?? null,
      status_text: response?.statusText ?? null
    });
    return fallbackValue;
  }

  try {
    return await response.json();
  } catch (error) {
    mapsWarn(`Maps returned invalid JSON for ${endpointName}`, { message: error?.message || String(error) });
    return fallbackValue;
  }
}

// The live API wraps every list under a named field rather than returning a
// bare array - e.g. GET maps/destinations returns {"status":"ok","destinations":[...]}.
// Each call site below passes that field's name as unwrapKey. Without this,
// every payload failed the old bare-Array.isArray(payload) check and silently
// fell back to [] - the "Maps returned non-array payload" warning was firing
// on every single call, for every endpoint, discarding real signal data
// (destinations/hazards/congestion/closures feed real precheck and scoring
// logic in mapsHarvestPrecheck.js/mapsScoutRoute.js, so this wasn't cosmetic).
async function requestMapsArray(pathname, query, endpointName, unwrapKey) {
  const fallbackValue = [];
  try {
    const response = await e3dRequest(buildMapsUrl(pathname, query));
    const payload = await parseJsonResponse(response, endpointName, fallbackValue);
    if (Array.isArray(payload)) return payload;
    if (unwrapKey && payload && typeof payload === "object" && Array.isArray(payload[unwrapKey])) {
      return payload[unwrapKey];
    }
    mapsWarn(`Maps returned non-array payload for ${endpointName}`);
    return fallbackValue;
  } catch (error) {
    mapsWarn(`Maps request error for ${endpointName}`, { message: error?.message || String(error) });
    return fallbackValue;
  }
}

// Same wrapping convention for single-object endpoints - e.g. maps/graph
// returns {"status":"ok","graph":{...}}, not the graph object itself.
async function requestMapsObject(pathname, query, endpointName, { allowNull = false, unwrapKey } = {}) {
  const fallbackValue = null;
  try {
    const response = await e3dRequest(buildMapsUrl(pathname, query));
    if (allowNull && response?.status === 404) {
      mapsWarn(`Maps returned no data for ${endpointName}`, { status: response.status });
      return null;
    }
    const payload = await parseJsonResponse(response, endpointName, fallbackValue);
    const unwrapped = unwrapKey ? payload?.[unwrapKey] : undefined;
    if (unwrapped && typeof unwrapped === "object" && !Array.isArray(unwrapped)) return unwrapped;
    if (payload && typeof payload === "object" && !Array.isArray(payload)) return payload;
    if (payload == null && allowNull) return null;
    mapsWarn(`Maps returned non-object payload for ${endpointName}`);
    return fallbackValue;
  } catch (error) {
    mapsWarn(`Maps request error for ${endpointName}`, { message: error?.message || String(error) });
    return fallbackValue;
  }
}

function normalizeLimit(limit, fallback = 10) {
  const numeric = Number(limit);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : fallback;
}

async function fetchMapsSignals(options = {}) {
  const query = {};
  if (options.signalType) query.signal_type = options.signalType;
  if (options.minConfidence != null) query.min_confidence = options.minConfidence;
  if (options.limit != null) query.limit = options.limit;
  if (options.offset != null) query.offset = options.offset;
  return requestMapsArray("maps/signals", query, "fetchMapsSignals", "signals");
}

async function fetchMapsDestinations({ limit = 10 } = {}) {
  return requestMapsArray("maps/destinations", { limit: normalizeLimit(limit) }, "fetchMapsDestinations", "destinations");
}

async function fetchMapsCongestion({ limit = 10 } = {}) {
  return requestMapsArray("maps/congestion", { limit: normalizeLimit(limit) }, "fetchMapsCongestion", "congestion");
}

async function fetchMapsHazards({ limit = 10 } = {}) {
  return requestMapsArray("maps/hazards", { limit: normalizeLimit(limit) }, "fetchMapsHazards", "hazards");
}

async function fetchMapsClosures({ limit = 10 } = {}) {
  return requestMapsArray("maps/signals", { signal_type: "route_closure", limit: normalizeLimit(limit) }, "fetchMapsClosures", "signals");
}

async function fetchMapsFlowGraph() {
  return requestMapsObject("maps/graph", {}, "fetchMapsFlowGraph", { allowNull: true, unwrapKey: "graph" });
}

async function fetchMapsFlowGraphNode(node) {
  if (!String(node || "").trim()) {
    mapsWarn("Maps flow graph node fetch skipped: node is required");
    return null;
  }
  return requestMapsObject(`maps/graph/${encodeURIComponent(String(node).trim())}`, {}, "fetchMapsFlowGraphNode", { allowNull: true, unwrapKey: "node" });
}

async function fetchMapsCalibration() {
  return requestMapsObject("maps/calibration", {}, "fetchMapsCalibration", { unwrapKey: "calibration" });
}

async function fetchMapsContext({ signalLimit = 5 } = {}) {
  const limit = normalizeLimit(signalLimit, 5);
  try {
    const [destinations, congestion, hazards, closures, flowGraph] = await Promise.all([
      fetchMapsDestinations({ limit }),
      fetchMapsCongestion({ limit }),
      fetchMapsHazards({ limit }),
      fetchMapsClosures({ limit }),
      fetchMapsFlowGraph()
    ]);

    return {
      destinations: Array.isArray(destinations) ? destinations : [],
      congestion: Array.isArray(congestion) ? congestion : [],
      hazards: Array.isArray(hazards) ? hazards : [],
      closures: Array.isArray(closures) ? closures : [],
      flow_graph: flowGraph && typeof flowGraph === "object" && !Array.isArray(flowGraph) ? flowGraph : null,
      fetched_at: new Date().toISOString()
    };
  } catch (error) {
    mapsWarn("Maps context aggregation failed unexpectedly", { message: error?.message || String(error) });
    return {
      destinations: [],
      congestion: [],
      hazards: [],
      closures: [],
      flow_graph: null,
      fetched_at: new Date().toISOString()
    };
  }
}

export {
  MAPS_API_BASE_URL,
  fetchMapsCalibration,
  fetchMapsClosures,
  fetchMapsCongestion,
  fetchMapsContext,
  fetchMapsDestinations,
  fetchMapsFlowGraph,
  fetchMapsFlowGraphNode,
  fetchMapsHazards,
  fetchMapsSignals
};
