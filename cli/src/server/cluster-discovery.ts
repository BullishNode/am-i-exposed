/**
 * Cluster-Entity Cross-Reference + Auto-Discovery
 *
 * After CIOH clustering discovers a set of addresses belonging to the same wallet,
 * this module checks if any of those addresses belong to known entities.
 * If so, all other addresses in the cluster are auto-added to that entity,
 * growing the entity database with every scan.
 */

import {
  lookupKnownAddresses, addAddressesToEntity,
  type KnownAddress,
} from "../adapters/entity-store";

/** Maximum cluster size for auto-discovery. Larger clusters are reported but not persisted. */
const MAX_DISCOVERY_CLUSTER_SIZE = 500;

export interface ClusterDiscovery {
  entityName: string;
  entityId: number;
  category: string;
  knownAddresses: string[];
  discoveredAddresses: string[];
  clusterSize: number;
  method: "cioh";
  persisted: boolean;
}

/**
 * Cross-reference cluster addresses with entity store.
 * Auto-persists newly discovered addresses to their entities.
 *
 * When multiple entities exist in the same cluster, untagged addresses
 * are assigned to the entity with the most known addresses in the cluster
 * (strongest signal). Other entities get a report but no new addresses.
 */
export function discoverClusterEntities(
  clusterAddresses: Set<string>,
): ClusterDiscovery[] {
  if (clusterAddresses.size <= 1) return [];

  const addrArray = [...clusterAddresses];

  // 1. Check all cluster addresses against known_addresses store
  const knownHits = lookupKnownAddresses(addrArray);
  // Filter to only addresses that have an entity
  const entityHits = new Map<string, KnownAddress>();
  for (const [addr, known] of knownHits) {
    if (known.entityId) entityHits.set(addr, known);
  }
  if (entityHits.size === 0) return [];

  // 2. Group by entity ID
  const byEntity = new Map<number, { entity: KnownAddress; knownAddresses: string[] }>();
  for (const [addr, known] of entityHits) {
    const existing = byEntity.get(known.entityId!);
    if (existing) {
      existing.knownAddresses.push(addr);
    } else {
      byEntity.set(known.entityId!, { entity: known, knownAddresses: [addr] });
    }
  }

  // 3. Collect untagged addresses (not belonging to ANY entity)
  const untagged: string[] = [];
  for (const addr of addrArray) {
    if (!entityHits.has(addr)) {
      untagged.push(addr);
    }
  }

  // 4. Determine which entity gets the untagged addresses:
  //    the one with the most known addresses in the cluster (strongest signal)
  let primaryEntityId: number | null = null;
  let primaryCount = 0;
  for (const [entityId, { knownAddresses }] of byEntity) {
    if (knownAddresses.length > primaryCount) {
      primaryCount = knownAddresses.length;
      primaryEntityId = entityId;
    }
  }

  // 5. Build discoveries
  const discoveries: ClusterDiscovery[] = [];
  const tooLarge = clusterAddresses.size > MAX_DISCOVERY_CLUSTER_SIZE;

  for (const [entityId, { entity, knownAddresses }] of byEntity) {
    const isPrimary = entityId === primaryEntityId;
    const discovered = isPrimary ? untagged : [];
    const shouldPersist = isPrimary && discovered.length > 0 && !tooLarge;

    if (shouldPersist) {
      addAddressesToEntity(entityId, discovered, "auto-discovered");
    }

    discoveries.push({
      entityName: entity.entityName ?? "Unknown",
      entityId,
      category: entity.category,
      knownAddresses,
      discoveredAddresses: discovered,
      clusterSize: clusterAddresses.size,
      method: "cioh",
      persisted: shouldPersist,
    });
  }

  return discoveries;
}
