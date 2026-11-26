import type { Connector } from "./contracts.js";

/** Connectors ready to use in the sidebar. Others are available through Add connector. */
export function configuredConnectors(connectors: readonly Connector[]): Connector[] {
  return connectors.filter((connector) => connector.status === "detected");
}
