/**
 * Enrichment utility for scan-tx and chain-trace responses.
 *
 * Collects all addresses and txids from trace layers,
 * then looks them up against the entity store for:
 *   - Custom entities (via address → entity mapping)
 *   - Address labels
 *   - Transaction labels
 */

import type { MempoolTransaction } from "@/lib/api/types";
import type { TraceLayer } from "@/lib/analysis/chain/recursive-trace";
import {
  lookupKnownAddresses, lookupTransactionLabels,
  type KnownAddress,
} from "../adapters/entity-store";

export interface CustomEntityHit {
  entityName: string;
  category: string;
  address: string;
  txid: string;
  direction: "backward" | "forward";
  hops: number;
}

export interface AddressLabelHit {
  address: string;
  label: string;
  hops: number;
  direction: "backward" | "forward";
}

export interface TransactionLabelHit {
  txid: string;
  label: string;
  hops: number;
}

export interface EnrichmentResult {
  customEntities: CustomEntityHit[];
  addressLabels: AddressLabelHit[];
  transactionLabels: TransactionLabelHit[];
}

/**
 * Enrich trace layers with custom entity, address label, and transaction label data.
 * Also checks the root transaction (hop 0).
 */
export function enrichFromStore(
  rootTx: MempoolTransaction,
  backwardLayers: TraceLayer[],
  forwardLayers: TraceLayer[],
): EnrichmentResult {
  // 1. Collect all unique addresses and txids from root + all layers
  const allAddresses = new Set<string>();
  const allTxids = new Set<string>();
  const addressHops = new Map<string, { hops: number; direction: "backward" | "forward"; txid: string }>();
  const txidHops = new Map<string, number>();

  // Root transaction (hop 0)
  allTxids.add(rootTx.txid);
  txidHops.set(rootTx.txid, 0);
  for (const vin of rootTx.vin) {
    const addr = vin.prevout?.scriptpubkey_address;
    if (addr) {
      allAddresses.add(addr);
      if (!addressHops.has(addr)) {
        addressHops.set(addr, { hops: 0, direction: "backward", txid: rootTx.txid });
      }
    }
  }
  for (const vout of rootTx.vout) {
    const addr = vout.scriptpubkey_address;
    if (addr && vout.scriptpubkey_type !== "op_return") {
      allAddresses.add(addr);
      if (!addressHops.has(addr)) {
        addressHops.set(addr, { hops: 0, direction: "forward", txid: rootTx.txid });
      }
    }
  }

  // Backward layers
  for (const layer of backwardLayers) {
    for (const [txid, layerTx] of layer.txs) {
      allTxids.add(txid);
      if (!txidHops.has(txid)) txidHops.set(txid, layer.depth);
      for (const vin of layerTx.vin) {
        const addr = vin.prevout?.scriptpubkey_address;
        if (addr) {
          allAddresses.add(addr);
          if (!addressHops.has(addr)) {
            addressHops.set(addr, { hops: layer.depth, direction: "backward", txid });
          }
        }
      }
      for (const vout of layerTx.vout) {
        const addr = vout.scriptpubkey_address;
        if (addr && vout.scriptpubkey_type !== "op_return") {
          allAddresses.add(addr);
          if (!addressHops.has(addr)) {
            addressHops.set(addr, { hops: layer.depth, direction: "backward", txid });
          }
        }
      }
    }
  }

  // Forward layers
  for (const layer of forwardLayers) {
    for (const [txid, layerTx] of layer.txs) {
      allTxids.add(txid);
      if (!txidHops.has(txid)) txidHops.set(txid, layer.depth);
      for (const vin of layerTx.vin) {
        const addr = vin.prevout?.scriptpubkey_address;
        if (addr) {
          allAddresses.add(addr);
          if (!addressHops.has(addr)) {
            addressHops.set(addr, { hops: layer.depth, direction: "forward", txid });
          }
        }
      }
      for (const vout of layerTx.vout) {
        const addr = vout.scriptpubkey_address;
        if (addr && vout.scriptpubkey_type !== "op_return") {
          allAddresses.add(addr);
          if (!addressHops.has(addr)) {
            addressHops.set(addr, { hops: layer.depth, direction: "forward", txid });
          }
        }
      }
    }
  }

  // 2. Batch lookup against known_addresses (one query for both entities + labels)
  const addrArray = [...allAddresses];
  const txidArray = [...allTxids];
  const knownHits = lookupKnownAddresses(addrArray);
  const txLabelHits = lookupTransactionLabels(txidArray);

  // 3. Build results — split known addresses into entities and labels
  const customEntities: CustomEntityHit[] = [];
  const addressLabels: AddressLabelHit[] = [];
  const seenEntities = new Set<string>();

  for (const [addr, known] of knownHits) {
    const meta = addressHops.get(addr);
    if (!meta) continue;

    // If has entity → custom entity hit
    if (known.entityId && known.entityName) {
      const key = `${addr}:${meta.direction}`;
      if (!seenEntities.has(key)) {
        seenEntities.add(key);
        customEntities.push({
          entityName: known.entityName,
          category: known.category,
          address: addr,
          txid: meta.txid,
          direction: meta.direction,
          hops: meta.hops,
        });
      }
    }

    // If has label → address label hit
    if (known.label) {
      addressLabels.push({
        address: addr,
        label: known.label,
        hops: meta.hops,
        direction: meta.direction,
      });
    }
  }
  customEntities.sort((a, b) => a.hops - b.hops);
  addressLabels.sort((a, b) => a.hops - b.hops);

  const transactionLabels: TransactionLabelHit[] = [];
  for (const [txid, lbl] of txLabelHits) {
    transactionLabels.push({
      txid,
      label: lbl.label,
      hops: txidHops.get(txid) ?? 0,
    });
  }
  transactionLabels.sort((a, b) => a.hops - b.hops);

  return { customEntities, addressLabels, transactionLabels };
}
