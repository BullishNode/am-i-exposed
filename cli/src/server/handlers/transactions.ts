/**
 * Transaction label endpoints.
 */

import type { IncomingMessage, ServerResponse } from "http";
import { parseJsonBody, sendJson, sendError } from "../router";
import {
  getTransactionLabel, setTransactionLabel, removeTransactionLabel,
  lookupTransactionLabels,
} from "../../adapters/entity-store";

/** GET /api/v1/transactions/:txid/label */
export async function handleGetTransactionLabel(
  _req: IncomingMessage, res: ServerResponse, params: Record<string, string>,
): Promise<void> {
  const txid = params.txid;
  if (!txid) { sendError(res, 400, "Missing txid"); return; }
  const result = getTransactionLabel(txid);
  sendJson(res, 200, { txid, label: result?.label ?? null });
}

/** PUT /api/v1/transactions/:txid/label */
export async function handleSetTransactionLabel(
  req: IncomingMessage, res: ServerResponse, params: Record<string, string>,
): Promise<void> {
  const txid = params.txid;
  if (!txid) { sendError(res, 400, "Missing txid"); return; }
  const body = (await parseJsonBody(req)) as { label?: string } | null;
  if (!body?.label) { sendError(res, 400, "Required field: label"); return; }
  setTransactionLabel(txid, body.label);
  sendJson(res, 200, { txid, label: body.label });
}

/** DELETE /api/v1/transactions/:txid/label */
export async function handleDeleteTransactionLabel(
  _req: IncomingMessage, res: ServerResponse, params: Record<string, string>,
): Promise<void> {
  const txid = params.txid;
  if (!txid) { sendError(res, 400, "Missing txid"); return; }
  const removed = removeTransactionLabel(txid);
  sendJson(res, 200, { removed });
}

/** POST /api/v1/lookup/transactions */
export async function handleLookupTransactions(
  req: IncomingMessage, res: ServerResponse,
): Promise<void> {
  const body = (await parseJsonBody(req)) as { txids?: string[] } | null;
  if (!body?.txids || !Array.isArray(body.txids)) {
    sendError(res, 400, "Required field: txids (string array)");
    return;
  }
  const labels = lookupTransactionLabels(body.txids);
  const results: Record<string, string> = {};
  for (const [txid, stored] of labels) {
    results[txid] = stored.label;
  }
  sendJson(res, 200, { results });
}
