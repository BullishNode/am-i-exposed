/**
 * Address label and lookup endpoints.
 */

import type { IncomingMessage, ServerResponse } from "http";
import { parseJsonBody, sendJson, sendError } from "../router";
import { parseRawBody } from "../router";
import {
  lookupAddressEntity, getAddressLabel, setAddressLabel,
  removeAddressLabel, lookupAddressEntities, lookupAddressLabels,
  bulkSetAddressLabels,
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

/** POST /api/v1/addresses/labels/import — bulk import address labels from JSON array or CSV */
export async function handleBulkImportLabels(
  req: IncomingMessage, res: ServerResponse,
): Promise<void> {
  const contentType = req.headers["content-type"] ?? "";

  if (contentType.includes("json")) {
    const body = (await parseJsonBody(req)) as { labels?: Array<{ address: string; label: string }> } | null;
    if (!body?.labels || !Array.isArray(body.labels)) {
      sendError(res, 400, "Required field: labels (array of {address, label})");
      return;
    }
    const valid = body.labels.filter((l) => l.address && l.label);
    if (valid.length === 0) { sendError(res, 400, "No valid labels"); return; }
    const count = bulkSetAddressLabels(valid);
    sendJson(res, 200, { imported: count, total: body.labels.length, invalid: body.labels.length - valid.length });
    return;
  }

  // CSV: address,label (or address,source,network,category,confidence_score,description,is_active)
  const csvText = await parseRawBody(req);
  if (!csvText.trim()) { sendError(res, 400, "Empty body"); return; }

  const lines = csvText.trim().split("\n");
  let startLine = 0;
  if (lines[0].toLowerCase().includes("address")) startLine = 1;

  const labels: Array<{ address: string; label: string }> = [];
  let errors = 0;

  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#")) continue;

    // Handle CSV with quoted fields (description may contain commas)
    const parts = parseCSVLine(line);
    const address = parts[0]?.trim();
    if (!address || address.length < 26) { errors++; continue; }

    // If it looks like the blacklist CSV (7 columns), build structured label
    if (parts.length >= 5) {
      const source = parts[1]?.trim() || "";
      const category = parts[3]?.trim() || "";
      const confidence = parts[4]?.trim() || "";
      const description = parts[5]?.trim() || "";
      const label = JSON.stringify({ category, source, confidence: Number(confidence) || 0, description });
      labels.push({ address, label });
    } else if (parts.length >= 2) {
      labels.push({ address, label: parts[1]?.trim() || "" });
    } else {
      errors++;
    }
  }

  if (labels.length === 0) { sendJson(res, 200, { imported: 0, errors }); return; }
  const count = bulkSetAddressLabels(labels);
  sendJson(res, 200, { imported: count, errors });
}

/** Parse a CSV line handling quoted fields (commas inside quotes). */
function parseCSVLine(line: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}
