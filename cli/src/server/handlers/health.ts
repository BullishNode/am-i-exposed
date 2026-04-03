/**
 * Health check endpoint.
 * GET /api/v1/health
 */

import type { IncomingMessage, ServerResponse } from "http";
import { sendJson } from "../router";
import { getFilterStatus, isFullFilterLoaded } from "@/lib/analysis/entity-filter/filter-loader";
import { entityStoreStats } from "../../adapters/entity-store";

export async function handleHealth(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  sendJson(res, 200, {
    status: "ok",
    entityFilter: {
      status: getFilterStatus(),
      fullLoaded: isFullFilterLoaded(),
    },
    entityStore: entityStoreStats(),
  });
}
