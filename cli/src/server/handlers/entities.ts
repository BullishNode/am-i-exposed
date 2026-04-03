/**
 * Entity CRUD and address mapping endpoints.
 */

import type { IncomingMessage, ServerResponse } from "http";
import { parseJsonBody, sendJson, sendError } from "../router";
import {
  createEntity, getEntity, listEntities, updateEntity, deleteEntity,
  entityAddressCount, addAddressesToEntity, listEntityAddresses,
  removeAddressFromEntity, getAllEntityAddresses,
} from "../../adapters/entity-store";

/** POST /api/v1/entities */
export async function handleCreateEntity(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await parseJsonBody(req)) as { name?: string; category?: string; description?: string; addresses?: string[] } | null;
  if (!body?.name || !body?.category) {
    sendError(res, 400, "Required fields: name, category, addresses");
    return;
  }
  if (!body.addresses || !Array.isArray(body.addresses) || body.addresses.length === 0) {
    sendError(res, 400, "At least one address is required");
    return;
  }
  if (body.addresses.length > 10000) {
    sendError(res, 400, "Maximum 10,000 addresses per request");
    return;
  }
  try {
    const entity = createEntity(body.name, body.category, body.description);
    if (!entity) { sendError(res, 500, "Failed to create entity"); return; }
    const added = addAddressesToEntity(entity.id, body.addresses);
    sendJson(res, 201, { ...entity, addresses: body.addresses, addressCount: added });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("UNIQUE")) {
      sendError(res, 409, `Entity with name "${body.name}" already exists`);
    } else {
      throw err;
    }
  }
}

/** GET /api/v1/entities */
export async function handleListEntities(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const category = url.searchParams.get("category") ?? undefined;
  sendJson(res, 200, { entities: listEntities(category) });
}

/** GET /api/v1/entities/:id */
export async function handleGetEntity(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
  const id = Number(params.id);
  if (!id || isNaN(id)) { sendError(res, 400, "Invalid entity ID"); return; }
  const entity = getEntity(id);
  if (!entity) { sendError(res, 404, "Entity not found"); return; }
  sendJson(res, 200, { ...entity, addressCount: entityAddressCount(id) });
}

/** PUT /api/v1/entities/:id */
export async function handleUpdateEntity(req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
  const id = Number(params.id);
  if (!id || isNaN(id)) { sendError(res, 400, "Invalid entity ID"); return; }
  const body = (await parseJsonBody(req)) as { name?: string; category?: string; description?: string } | null;
  if (!body) { sendError(res, 400, "Invalid JSON body"); return; }
  const updated = updateEntity(id, body);
  if (!updated) { sendError(res, 404, "Entity not found"); return; }
  sendJson(res, 200, getEntity(id));
}

/** DELETE /api/v1/entities/:id */
export async function handleDeleteEntity(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
  const id = Number(params.id);
  if (!id || isNaN(id)) { sendError(res, 400, "Invalid entity ID"); return; }
  const deleted = deleteEntity(id);
  sendJson(res, 200, { deleted });
}

/** POST /api/v1/entities/:id/addresses */
export async function handleAddAddresses(req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
  const id = Number(params.id);
  if (!id || isNaN(id)) { sendError(res, 400, "Invalid entity ID"); return; }
  if (!getEntity(id)) { sendError(res, 404, "Entity not found"); return; }
  const body = (await parseJsonBody(req)) as { addresses?: string[] } | null;
  if (!body?.addresses || !Array.isArray(body.addresses) || body.addresses.length === 0) {
    sendError(res, 400, "Required field: addresses (non-empty string array)");
    return;
  }
  if (body.addresses.length > 10000) {
    sendError(res, 400, "Maximum 10,000 addresses per request");
    return;
  }
  const count = addAddressesToEntity(id, body.addresses);
  sendJson(res, 200, { added: count });
}

/** GET /api/v1/entities/:id/addresses */
export async function handleListAddresses(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
  const id = Number(params.id);
  if (!id || isNaN(id)) { sendError(res, 400, "Invalid entity ID"); return; }
  if (!getEntity(id)) { sendError(res, 404, "Entity not found"); return; }
  sendJson(res, 200, { addresses: listEntityAddresses(id) });
}

/** DELETE /api/v1/entities/:id/addresses/:addr */
export async function handleRemoveAddress(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
  const id = Number(params.id);
  if (!id || isNaN(id)) { sendError(res, 400, "Invalid entity ID"); return; }
  const removed = removeAddressFromEntity(id, params.addr);
  sendJson(res, 200, { removed });
}

/** GET /api/v1/entities/addresses/all — compact dump for client-side entity matching */
export async function handleAllEntityAddresses(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const all = getAllEntityAddresses();
  const data: Record<string, { entityName: string; category: string }> = {};
  for (const [addr, info] of all) {
    data[addr] = info;
  }
  sendJson(res, 200, { count: all.size, addresses: data });
}
