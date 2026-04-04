/**
 * Transaction scan endpoint.
 * POST /api/v1/scan/tx
 */

import type { IncomingMessage, ServerResponse } from "http";
import { parseJsonBody, sendJson, sendError } from "../router";
import { analyzeTransaction } from "@/lib/analysis/orchestrator";
import {
  selectRecommendations,
  type RecommendationContext,
} from "@/lib/recommendations/primary-recommendation";
import type { TxContext } from "@/lib/analysis/heuristics/types";
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
import { TX_BASE_SCORE } from "@/lib/scoring/score";
import { matchEntitySync } from "@/lib/analysis/entity-filter/entity-match";
import { enrichFromStore } from "../enrich";
import { createClient } from "../../util/api";
import type { Finding } from "@/lib/types";

interface ScanTxBody {
  txid: string;
  network?: string;
  apiUrl?: string;
  chainDepth?: number;
  direction?: "backward" | "forward" | "both";
  minSats?: number;
  fast?: boolean;
}

export async function handleScanTx(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = (await parseJsonBody(req)) as ScanTxBody | null;
  if (!body?.txid) {
    sendError(res, 400, "Missing required field: txid");
    return;
  }

  const { txid, network, apiUrl, fast } = body;
  const chainDepth = Math.max(0, Math.min(Number(body.chainDepth ?? 6), 20));
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

  // Fetch transaction
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
  let rawHex: string | undefined;
  try {
    rawHex = await client.getTxHex(txid);
  } catch {
    // Raw hex is optional
  }

  // Build context
  let ctx: TxContext = {};
  if (!fast) {
    ctx = await buildTxContext(tx, client);
  }

  // Run heuristic analysis (27 tx heuristics)
  const result = await analyzeTransaction(tx, rawHex, undefined, ctx);

  // Chain analysis
  let chainAnalysis: unknown = null;
  let enrichment = { customEntities: [] as unknown[], addressLabels: [] as unknown[], transactionLabels: [] as unknown[] };

  const doBackward = direction === "backward" || direction === "both";
  const doForward = direction === "forward" || direction === "both";

  if (chainDepth > 0) {
    const backwardResult = doBackward
      ? await traceBackward(tx, chainDepth, minSats, client)
      : { layers: [], allTxs: new Map<string, MempoolTransaction>(), fetchCount: 0, aborted: false };
    const forwardResult = doForward
      ? await traceForward(tx, chainDepth, minSats, client)
      : { layers: [], allTxs: new Map<string, MempoolTransaction>(), fetchCount: 0, aborted: false };

    // Fetch outspends (needed for forward analysis + spending patterns)
    let outspends: import("@/lib/api/types").MempoolOutspend[] | null = null;
    try {
      outspends = await client.getTxOutspends(txid);
    } catch {
      // Non-critical — forward analysis will be limited
    }

    // Build helper maps
    const parentTxsByIdx = buildParentTxsByIdx(tx, backwardResult.layers, null);
    const childTxsByIdx = buildChildTxsByIdx(outspends, forwardResult.layers, null);

    const chainFindings: Finding[] = [];
    let coinJoinInputIndices: number[] = [];

    // 1. Backward analysis (input provenance)
    if (parentTxsByIdx.size > 0) {
      const backwardAnalysis = analyzeBackward(tx, parentTxsByIdx);
      chainFindings.push(...backwardAnalysis.findings);
      coinJoinInputIndices = backwardAnalysis.coinJoinInputs;
    }

    // 2. Forward analysis (output destinations)
    if (childTxsByIdx.size > 0 && outspends) {
      const forwardAnalysis = analyzeForward(tx, outspends, childTxsByIdx);
      chainFindings.push(...forwardAnalysis.findings);
    }

    // 3. Address clustering (CIOH)
    const hasTraceLayers = backwardResult.layers.length > 0 || forwardResult.layers.length > 0;
    if (hasTraceLayers) {
      const txsByAddress = buildTxsByAddress(tx, backwardResult.layers, forwardResult.layers);
      const seedAddr = tx.vin[0]?.prevout?.scriptpubkey_address;
      if (seedAddr) {
        const clusterResult = buildCluster(seedAddr, txsByAddress);
        chainFindings.push(...clusterResult.findings);
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
    chainFindings.push(...spendingResult.findings);

    // 5. Entity proximity (already existed)
    const proximityResult = analyzeEntityProximity(tx, backwardResult.layers, forwardResult.layers);
    chainFindings.push(...proximityResult.findings);

    // 6. Taint flow (already existed)
    const entityChecker = (addr: string) => {
      const match = matchEntitySync(addr);
      return match ? { category: match.category, entityName: match.entityName } : null;
    };
    if (doBackward) {
      const taintResult = analyzeBackwardTaint(tx, backwardResult.layers, entityChecker);
      chainFindings.push(...taintResult.findings);
    }

    // 7. Linkability matrix
    const linkResult = buildLinkabilityMatrix(tx);
    if (linkResult) chainFindings.push(...linkResult.findings);

    // Enrich all findings with metadata (adversary tiers, temporality)
    result.findings.push(...chainFindings);
    enrichFindingsWithMetadata(result.findings);

    chainAnalysis = {
      backward: doBackward ? {
        depth: chainDepth,
        txsFetched: backwardResult.fetchCount,
        aborted: backwardResult.aborted,
        layers: backwardResult.layers.map((l) => ({ depth: l.depth, txCount: l.txs.size })),
      } : null,
      forward: doForward ? {
        depth: chainDepth,
        txsFetched: forwardResult.fetchCount,
        aborted: forwardResult.aborted,
        layers: forwardResult.layers.map((l) => ({ depth: l.depth, txCount: l.txs.size })),
      } : null,
      findings: chainFindings,
    };

    // Enrich with custom entities, address labels, transaction labels from store
    enrichment = enrichFromStore(tx, backwardResult.layers, forwardResult.layers);
  }

  // Recommendation
  const recCtx: RecommendationContext = {
    findings: result.findings,
    grade: result.grade,
    txType: result.txType,
    walletGuess: null,
  };
  const [primary] = selectRecommendations(recCtx);

  sendJson(res, 200, {
    score: result.score,
    grade: result.grade,
    txType: result.txType ?? null,
    scoreBreakdown: {
      baseScore: TX_BASE_SCORE,
      totalImpact: result.findings.reduce((s, f) => s + f.scoreImpact, 0),
    },
    txInfo: {
      inputs: tx.vin.length,
      outputs: tx.vout.length,
      fee: tx.fee,
      size: tx.size,
      weight: tx.weight,
      confirmed: tx.status?.confirmed ?? false,
      blockHeight: tx.status?.block_height ?? null,
    },
    findings: result.findings,
    recommendation: primary
      ? { id: primary.id, urgency: primary.urgency, headline: primary.headlineDefault }
      : null,
    chainAnalysis,
    customEntities: enrichment.customEntities,
    addressLabels: enrichment.addressLabels,
    transactionLabels: enrichment.transactionLabels,
  });
}

/** Build TxContext (same logic as scan-tx command). */
async function buildTxContext(
  tx: MempoolTransaction,
  client: ReturnType<typeof createClient>,
): Promise<TxContext> {
  const ctx: TxContext = {};
  const parentTxs = new Map<string, MempoolTransaction>();
  const txCounts = new Map<string, number>();
  const allFetches: Promise<void>[] = [];

  const parentTxids = new Set<string>();
  for (const vin of tx.vin) {
    if (!vin.is_coinbase && vin.txid) parentTxids.add(vin.txid);
  }
  for (const ptxid of parentTxids) {
    allFetches.push(
      client.getTransaction(ptxid).then(
        (ptx) => { parentTxs.set(ptxid, ptx); },
        () => {},
      ),
    );
  }

  const outputAddresses = tx.vout
    .map((v) => v.scriptpubkey_address)
    .filter((a): a is string => !!a);
  if (outputAddresses.length <= 20) {
    for (const addr of outputAddresses) {
      allFetches.push(
        client.getAddress(addr).then(
          (d) => { txCounts.set(addr, d.chain_stats.tx_count + d.mempool_stats.tx_count); },
          () => {},
        ),
      );
    }
  }

  await Promise.all(allFetches);
  ctx.parentTxs = parentTxs;
  if (tx.vin[0] && !tx.vin[0].is_coinbase && tx.vin[0].txid) {
    ctx.parentTx = parentTxs.get(tx.vin[0].txid);
  }
  if (txCounts.size > 0) ctx.outputTxCounts = txCounts;
  return ctx;
}
