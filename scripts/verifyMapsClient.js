import { fetchMapsContext } from "./mapsClient.js";

async function main() {
  try {
    const context = await fetchMapsContext();
    const summary = {
      destinations: Array.isArray(context?.destinations) ? context.destinations.length : 0,
      congestion: Array.isArray(context?.congestion) ? context.congestion.length : 0,
      hazards: Array.isArray(context?.hazards) ? context.hazards.length : 0,
      closures: Array.isArray(context?.closures) ? context.closures.length : 0,
      flow_graph_nodes: Array.isArray(context?.flow_graph?.nodes) ? context.flow_graph.nodes.length : 0,
      fetched_at: context?.fetched_at || null
    };

    console.log(JSON.stringify({
      ok: true,
      checked: "maps_client_context",
      summary
    }, null, 2));

    if (
      summary.destinations === 0 &&
      summary.congestion === 0 &&
      summary.hazards === 0 &&
      summary.closures === 0
    ) {
      console.warn("WARN: Maps returned no data");
    }
  } catch (error) {
    console.error("Maps client verification failed", { message: error?.message || String(error) });
    process.exit(1);
  }
}

await main();
