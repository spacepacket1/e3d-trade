import { E3D_API_BASE_URL, e3dRequest } from "../e3dAuthClient.js";

const MAPS_API_BASE_URL = process.env.E3D_MAPS_BASE_URL || E3D_API_BASE_URL;

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

async function requestMapsArray(pathname, query, endpointName) {
  const fallbackValue = [];
  try {
    const response = await e3dRequest(buildMapsUrl(pathname, query));
    const payload = await parseJsonResponse(response, endpointName, fallbackValue);
    if (Array.isArray(payload)) return payload;
    mapsWarn(`Maps returned non-array payload for ${endpointName}`);
    return fallbackValue;
  } catch (error) {
    mapsWarn(`Maps request error for ${endpointName}`, { message: error?.message || String(error) });
    return fallbackValue;
  }
}

async function requestMapsObject(pathname, query, endpointName, { allowNull = false } = {}) {
  const fallbackValue = null;
  try {
    const response = await e3dRequest(buildMapsUrl(pathname, query));
    if (allowNull && response?.status === 404) {
      mapsWarn(`Maps returned no data for ${endpointName}`, { status: response.status });
      return null;
    }
    const payload = await parseJsonResponse(response, endpointName, fallbackValue);
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
  return requestMapsArray("maps/signals", query, "fetchMapsSignals");
}

async function fetchMapsDestinations({ limit = 10 } = {}) {
  return requestMapsArray("maps/destinations", { limit: normalizeLimit(limit) }, "fetchMapsDestinations");
}

async function fetchMapsCongestion({ limit = 10 } = {}) {
  return requestMapsArray("maps/congestion", { limit: normalizeLimit(limit) }, "fetchMapsCongestion");
}

async function fetchMapsHazards({ limit = 10 } = {}) {
  return requestMapsArray("maps/hazards", { limit: normalizeLimit(limit) }, "fetchMapsHazards");
}

async function fetchMapsClosures({ limit = 10 } = {}) {
  return requestMapsArray("maps/signals", { signal_type: "route_closure", limit: normalizeLimit(limit) }, "fetchMapsClosures");
}

async function fetchMapsFlowGraph() {
  return requestMapsObject("maps/graph", {}, "fetchMapsFlowGraph", { allowNull: true });
}

async function fetchMapsFlowGraphNode(node) {
  if (!String(node || "").trim()) {
    mapsWarn("Maps flow graph node fetch skipped: node is required");
    return null;
  }
  return requestMapsObject(`maps/graph/${encodeURIComponent(String(node).trim())}`, {}, "fetchMapsFlowGraphNode", { allowNull: true });
}

async function fetchMapsCalibration() {
  return requestMapsObject("maps/calibration", {}, "fetchMapsCalibration");
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
