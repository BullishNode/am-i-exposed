/**
 * am-i-exposed HTTP API Server
 *
 * Exposes the Bitcoin privacy analysis engine as REST endpoints.
 * Started via: am-i-exposed serve --port 3001
 */

import { createServer } from "http";
import { addRoute, clearRoutes, handleRequest, setAuthToken } from "./router";
import { handleHealth } from "./handlers/health";
import { handleScanTx } from "./handlers/scan-tx";
import { handleChainTrace } from "./handlers/chain-trace";
import {
  handleCreateEntity, handleListEntities, handleGetEntity,
  handleUpdateEntity, handleDeleteEntity,
  handleAddAddresses, handleListAddresses, handleRemoveAddress,
} from "./handlers/entities";
import {
  handleGetAddress, handleSetAddressLabel, handleDeleteAddressLabel,
  handleLookupAddresses,
} from "./handlers/addresses";
import {
  handleGetTransactionLabel, handleSetTransactionLabel,
  handleDeleteTransactionLabel, handleLookupTransactions,
} from "./handlers/transactions";
import { entityStoreStats } from "../adapters/entity-store";
import type { GlobalOpts } from "../index";

export async function startApiServer(opts: GlobalOpts): Promise<void> {
  const port = Number(opts.port ?? 3001);
  const host = (opts.host as string) ?? "127.0.0.1";

  // Auth token
  const token = (opts.authToken ?? opts["auth-token"]) as string | undefined;
  if (token) {
    setAuthToken(token);
    console.log("Auth token required for API requests.");
  }

  // Import entities from CSV data sources (optional)
  const shouldReimport = !!(opts.reimportEntities || opts["reimport-entities"]);
  const shouldImport = !!(opts.importEntities || opts["import-entities"]) || shouldReimport;
  if (shouldImport) {
    console.log("Importing entity data from CSV sources...");
    const { importEntities } = await import("./import-entities");
    await importEntities({ force: shouldReimport });
  }

  // Entity store stats
  const stats = entityStoreStats();
  console.log(`Entity store: ${stats.entities} entities, ${stats.addresses} addresses, ${stats.addressLabels} address labels, ${stats.transactionLabels} tx labels.`);

  // Register routes
  clearRoutes();

  // Analysis
  addRoute("GET", "/api/v1/health", handleHealth);
  addRoute("POST", "/api/v1/scan/tx", handleScanTx);
  addRoute("POST", "/api/v1/chain-trace", handleChainTrace);

  // Entities
  addRoute("POST", "/api/v1/entities", handleCreateEntity);
  addRoute("GET", "/api/v1/entities", handleListEntities);
  addRoute("GET", "/api/v1/entities/:id", handleGetEntity);
  addRoute("PUT", "/api/v1/entities/:id", handleUpdateEntity);
  addRoute("DELETE", "/api/v1/entities/:id", handleDeleteEntity);
  addRoute("POST", "/api/v1/entities/:id/addresses", handleAddAddresses);
  addRoute("GET", "/api/v1/entities/:id/addresses", handleListAddresses);
  addRoute("DELETE", "/api/v1/entities/:id/addresses/:addr", handleRemoveAddress);

  // Address labels + lookup
  addRoute("GET", "/api/v1/addresses/:addr", handleGetAddress);
  addRoute("PUT", "/api/v1/addresses/:addr/label", handleSetAddressLabel);
  addRoute("DELETE", "/api/v1/addresses/:addr/label", handleDeleteAddressLabel);
  addRoute("POST", "/api/v1/lookup/addresses", handleLookupAddresses);

  // Transaction labels + lookup
  addRoute("GET", "/api/v1/transactions/:txid/label", handleGetTransactionLabel);
  addRoute("PUT", "/api/v1/transactions/:txid/label", handleSetTransactionLabel);
  addRoute("DELETE", "/api/v1/transactions/:txid/label", handleDeleteTransactionLabel);
  addRoute("POST", "/api/v1/lookup/transactions", handleLookupTransactions);

  // Start HTTP server
  const server = createServer(handleRequest);

  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, host, () => {
      console.log(`am-i-exposed API server listening on http://${host}:${port}`);
      resolve();
    });
  });

  await new Promise<void>(() => {});
}
