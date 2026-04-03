/**
 * Chain trace endpoint.
 * POST /api/v1/chain-trace
 */

import type { IncomingMessage, ServerResponse } from "http";
import { parseJsonBody, sendJson, sendError } from "../router";
import type { MempoolTransaction } from "@/lib/api/types";
import { traceBackward, traceForward } from "@/lib/analysis/chain/recursive-trace";
import { analyzeEntityProximity } from "@/lib/analysis/chain/entity-proximity";
import { analyzeBackwardTaint } from "@/lib/analysis/chain/taint";
import { analyzeBackward } from "@/lib/analysis/chain/backward";
import { analyzeForward } from "@/lib/analysis/chain/forward";
import { buildCluster } from "@/lib/analysis/chain/clustering";
import { analyzeSpendingPatterns } from "@/lib/analysis/chain/spending-patterns";
import { buildLinkabilityMatrix } from "@/lib/analysis/chain/linkability";
import { buildParentTxsByIdx, buildChildTxsByIdx, buildTxsByAddress } from "@/lib/analysis/chain/trace-maps";
import { enrichFindingsWithMetadata } from "@/lib/analysis/finding-metadata";
import { matchEntitySync } from "@/lib/analysis/entity-filter/entity-match";
import { enrichFromStore } from "../enrich";
import { createClient } from "../../util/api";
import type { Finding } from "@/lib/types";

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

  let tx: MempoolTransaction;
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

  const doBackward = direction === "backward" || direction === "both";
  const doForward = direction === "forward" || direction === "both";

  const backwardResult = doBackward
    ? await traceBackward(tx, depth, minSats, client)
    : { layers: [], allTxs: new Map<string, MempoolTransaction>(), fetchCount: 0, aborted: false };
  const forwardResult = doForward
    ? await traceForward(tx, depth, minSats, client)
    : { layers: [], allTxs: new Map<string, MempoolTransaction>(), fetchCount: 0, aborted: false };

  // Fetch outspends
  let outspends: import("@/lib/api/types").MempoolOutspend[] | null = null;
  try {
    outspends = await client.getTxOutspends(txid);
  } catch { /* non-critical */ }

  // Build helper maps
  const parentTxsByIdx = buildParentTxsByIdx(tx, backwardResult.layers, null);
  const childTxsByIdx = buildChildTxsByIdx(outspends, forwardResult.layers, null);

  const findings: Finding[] = [];
  let coinJoinInputIndices: number[] = [];

  // 1. Backward analysis
  if (doBackward && parentTxsByIdx.size > 0) {
    const backwardAnalysis = analyzeBackward(tx, parentTxsByIdx);
    findings.push(...backwardAnalysis.findings);
    coinJoinInputIndices = backwardAnalysis.coinJoinInputs;
  }

  // 2. Forward analysis
  if (doForward && childTxsByIdx.size > 0 && outspends) {
    const forwardAnalysis = analyzeForward(tx, outspends, childTxsByIdx);
    findings.push(...forwardAnalysis.findings);
  }

  // 3. Address clustering
  const hasTraceLayers = backwardResult.layers.length > 0 || forwardResult.layers.length > 0;
  if (hasTraceLayers) {
    const txsByAddress = buildTxsByAddress(tx, backwardResult.layers, forwardResult.layers);
    const seedAddr = tx.vin[0]?.prevout?.scriptpubkey_address;
    if (seedAddr) {
      const clusterResult = buildCluster(seedAddr, txsByAddress);
      findings.push(...clusterResult.findings);
    }
  }

  // 4. Spending patterns
  const allBackwardTxs = new Map<string, MempoolTransaction>();
  for (const layer of backwardResult.layers) {
    for (const [tid, btx] of layer.txs) allBackwardTxs.set(tid, btx);
  }
  const spendingResult = analyzeSpendingPatterns(
    tx, parentTxsByIdx, coinJoinInputIndices,
    outspends, childTxsByIdx, allBackwardTxs,
  );
  findings.push(...spendingResult.findings);

  // 5. Entity proximity
  const proximityResult = analyzeEntityProximity(tx, backwardResult.layers, forwardResult.layers);
  findings.push(...proximityResult.findings);

  // 6. Taint flow
  const entityChecker = (addr: string) => {
    const match = matchEntitySync(addr);
    return match ? { category: match.category, entityName: match.entityName } : null;
  };
  const taintResult = doBackward
    ? analyzeBackwardTaint(tx, backwardResult.layers, entityChecker)
    : { findings: [], outputTaint: new Map(), inputSources: new Map() };
  findings.push(...taintResult.findings);

  // 7. Linkability matrix
  const linkResult = buildLinkabilityMatrix(tx);
  if (linkResult) findings.push(...linkResult.findings);

  // Enrich findings with metadata
  enrichFindingsWithMetadata(findings);

  // Custom entities, address labels, transaction labels
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
