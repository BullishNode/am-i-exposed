/**
 * Chain trace endpoint.
 * POST /api/v1/chain-trace
 *
 * Multi-hop transaction graph analysis with entity detection.
 */

import type { IncomingMessage, ServerResponse } from "http";
import { parseJsonBody, sendJson, sendError } from "../router";
import type { MempoolTransaction } from "@/lib/api/types";
import { traceBackward, traceForward } from "@/lib/analysis/chain/recursive-trace";
import { analyzeEntityProximity } from "@/lib/analysis/chain/entity-proximity";
import { analyzeBackwardTaint } from "@/lib/analysis/chain/taint";
import { matchEntitySync } from "@/lib/analysis/entity-filter/entity-match";
import { enrichFromStore } from "../enrich";
import { createClient } from "../../util/api";

interface ChainTraceBody {
  txid: string;
  network?: string;
  apiUrl?: string;
  depth?: number;
  direction?: "backward" | "forward" | "both";
  minSats?: number;
}

export async function handleChainTrace(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = (await parseJsonBody(req)) as ChainTraceBody | null;
  if (!body?.txid) {
    sendError(res, 400, "Missing required field: txid");
    return;
  }

  const { txid, network, apiUrl } = body;
  const depth = Math.max(0, Math.min(Number(body.depth ?? 6), 20));
  const direction = body.direction ?? "both";
  const minSats = Math.max(0, Number(body.minSats ?? 1000));

  if (!/^[0-9a-fA-F]{64}$/.test(txid)) {
    sendError(res, 400, `Invalid txid: expected 64 hex characters`);
    return;
  }

  const validNetworks = ["mainnet", "testnet4", "signet"];
  if (network && !validNetworks.includes(network)) {
    sendError(res, 400, `Invalid network: must be one of ${validNetworks.join(", ")}`);
    return;
  }

  const validDirections = ["backward", "forward", "both"];
  if (!validDirections.includes(direction)) {
    sendError(res, 400, `Invalid direction: must be one of ${validDirections.join(", ")}`);
    return;
  }

  const client = createClient({
    network: network ?? "mainnet",
    api: apiUrl,
    cache: true,
  });

  let tx;
  try {
    tx = await client.getTransaction(txid);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("404") || msg.toLowerCase().includes("not found")) {
      sendError(res, 404, `Transaction not found: ${txid}`);
    } else {
      sendError(res, 502, `Failed to fetch transaction: ${msg}`);
    }
    return;
  }

  // Trace
  const doBackward = direction === "backward" || direction === "both";
  const doForward = direction === "forward" || direction === "both";

  const backwardResult = doBackward
    ? await traceBackward(tx, depth, minSats, client)
    : { layers: [], allTxs: new Map<string, MempoolTransaction>(), fetchCount: 0, aborted: false };
  const forwardResult = doForward
    ? await traceForward(tx, depth, minSats, client)
    : { layers: [], allTxs: new Map<string, MempoolTransaction>(), fetchCount: 0, aborted: false };

  // Entity proximity findings (uses built-in entity filter)
  const proximityResult = analyzeEntityProximity(tx, backwardResult.layers, forwardResult.layers);

  // Taint analysis (uses built-in entity filter)
  const entityChecker = (addr: string) => {
    const match = matchEntitySync(addr);
    return match ? { category: match.category, entityName: match.entityName } : null;
  };
  const taintResult = doBackward
    ? analyzeBackwardTaint(tx, backwardResult.layers, entityChecker)
    : { findings: [], outputTaint: new Map(), inputSources: new Map() };

  const findings = [...proximityResult.findings, ...taintResult.findings];

  // Enrich with custom entities, address labels, and transaction labels from store
  const enrichment = enrichFromStore(tx, backwardResult.layers, forwardResult.layers);

  sendJson(res, 200, {
    backward: doBackward
      ? {
          depth,
          txsFetched: backwardResult.fetchCount,
          aborted: backwardResult.aborted,
          layers: backwardResult.layers.map((l) => ({ depth: l.depth, txCount: l.txs.size })),
        }
      : null,
    forward: doForward
      ? {
          depth,
          txsFetched: forwardResult.fetchCount,
          aborted: forwardResult.aborted,
          layers: forwardResult.layers.map((l) => ({ depth: l.depth, txCount: l.txs.size })),
        }
      : null,
    findings,
    customEntities: enrichment.customEntities,
    addressLabels: enrichment.addressLabels,
    transactionLabels: enrichment.transactionLabels,
  });
}
