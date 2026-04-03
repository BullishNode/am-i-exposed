/**
 * Address label and lookup endpoints.
 */

import type { IncomingMessage, ServerResponse } from "http";
import { parseJsonBody, sendJson, sendError } from "../router";
import {
  lookupAddressEntity, getAddressLabel, setAddressLabel,
  removeAddressLabel, lookupAddressEntities, lookupAddressLabels,
} from "../../adapters/entity-store";

/** GET /api/v1/addresses/:addr */
export async function handleGetAddress(
  _req: IncomingMessage, res: ServerResponse, params: Record<string, string>,
): Promise<void> {
  const addr = params.addr;
  if (!addr) { sendError(res, 400, "Missing address"); return; }
  const entity = lookupAddressEntity(addr);
  const label = getAddressLabel(addr);
  sendJson(res, 200, {
    address: addr,
    entity: entity ? { id: entity.entityId, name: entity.entityName, category: entity.category } : null,
    label: label?.label ?? null,
  });
}

/** PUT /api/v1/addresses/:addr/label */
export async function handleSetAddressLabel(
  req: IncomingMessage, res: ServerResponse, params: Record<string, string>,
): Promise<void> {
  const addr = params.addr;
  if (!addr) { sendError(res, 400, "Missing address"); return; }
  const body = (await parseJsonBody(req)) as { label?: string } | null;
  if (!body?.label) { sendError(res, 400, "Required field: label"); return; }
  setAddressLabel(addr, body.label);
  sendJson(res, 200, { address: addr, label: body.label });
}

/** DELETE /api/v1/addresses/:addr/label */
export async function handleDeleteAddressLabel(
  _req: IncomingMessage, res: ServerResponse, params: Record<string, string>,
): Promise<void> {
  const addr = params.addr;
  if (!addr) { sendError(res, 400, "Missing address"); return; }
  const removed = removeAddressLabel(addr);
  sendJson(res, 200, { removed });
}

/** POST /api/v1/lookup/addresses */
export async function handleLookupAddresses(
  req: IncomingMessage, res: ServerResponse,
): Promise<void> {
  const body = (await parseJsonBody(req)) as { addresses?: string[] } | null;
  if (!body?.addresses || !Array.isArray(body.addresses)) {
    sendError(res, 400, "Required field: addresses (string array)");
    return;
  }
  const entities = lookupAddressEntities(body.addresses);
  const labels = lookupAddressLabels(body.addresses);
  const results: Record<string, { entity: { id: number; name: string; category: string } | null; label: string | null }> = {};
  for (const addr of body.addresses) {
    const ent = entities.get(addr);
    const lbl = labels.get(addr);
    if (ent || lbl) {
      results[addr] = {
        entity: ent ? { id: ent.entityId, name: ent.entityName, category: ent.category } : null,
        label: lbl?.label ?? null,
      };
    }
  }
  sendJson(res, 200, { results });
}
