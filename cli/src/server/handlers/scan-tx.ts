/**
 * Transaction scan endpoint.
 * POST /api/v1/scan/tx
 *
 * Reuses the core logic from cli/src/commands/scan-tx.ts.
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
import { matchEntitySync } from "@/lib/analysis/entity-filter/entity-match";
import { enrichFromStore } from "../enrich";
import { createClient } from "../../util/api";

interface ScanTxBody {
  txid: string;
  network?: string;
  apiUrl?: string;
  chainDepth?: number;
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

  const client = createClient({
    network: network ?? "mainnet",
    api: apiUrl,
    cache: true,
  });

  // Fetch transaction
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

  // Run heuristic analysis
  const result = await analyzeTransaction(tx, rawHex, undefined, ctx);

  // Chain analysis
  let chainAnalysis: unknown = null;
  let enrichment = { customEntities: [] as unknown[], addressLabels: [] as unknown[], transactionLabels: [] as unknown[] };

  if (chainDepth > 0) {
    const backwardResult = await traceBackward(tx, chainDepth, minSats, client);
    const forwardResult = await traceForward(tx, chainDepth, minSats, client);

    // Entity proximity findings (for score impact - uses built-in entity filter)
    const proximityResult = analyzeEntityProximity(tx, backwardResult.layers, forwardResult.layers);

    // Taint analysis (uses built-in entity filter)
    const entityChecker = (addr: string) => {
      const match = matchEntitySync(addr);
      return match ? { category: match.category, entityName: match.entityName } : null;
    };
    const taintResult = analyzeBackwardTaint(tx, backwardResult.layers, entityChecker);

    const chainFindings = [...proximityResult.findings, ...taintResult.findings];
    result.findings.push(...chainFindings);

    chainAnalysis = {
      backward: {
        depth: chainDepth,
        txsFetched: backwardResult.fetchCount,
        aborted: backwardResult.aborted,
        layers: backwardResult.layers.map((l) => ({ depth: l.depth, txCount: l.txs.size })),
      },
      forward: {
        depth: chainDepth,
        txsFetched: forwardResult.fetchCount,
        aborted: forwardResult.aborted,
        layers: forwardResult.layers.map((l) => ({ depth: l.depth, txCount: l.txs.size })),
      },
      findings: chainFindings,
    };

    // Enrich with custom entities, address labels, and transaction labels from store
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
