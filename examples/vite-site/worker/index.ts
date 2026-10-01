import { withRouteYes } from "route-yes/worker";

// The Worker only runs when no static asset matches, so every request here is
// a would-be 404. route-yes serves it from ASSETS and reroutes if it can.
export default withRouteYes(undefined, {
  siteDescription: "Acme Cloud, a developer platform for deploying apps",
  onDecision: (d) => console.log(`[route-yes] ${d.from} → ${d.to ?? "(404)"} ${d.kind} ${d.confidence.toFixed(2)}`),
});
