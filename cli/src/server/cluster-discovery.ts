/**
 * Cluster-Entity Cross-Reference + Auto-Discovery
 *
 * After CIOH clustering discovers a set of addresses belonging to the same wallet,
 * this module checks if any of those addresses belong to known entities.
 * If so, all other addresses in the cluster are auto-added to that entity,
 * growing the entity database with every scan.
 */

import {
  lookupAddressEntities, addAddressesToEntity,
  type StoredAddressEntity,
} from "../adapters/entity-store";

export interface ClusterDiscovery {
  entityName: string;
  entityId: number;
  category: string;
  knownAddresses: string[];
  discoveredAddresses: string[];
  clusterSize: number;
  method: "cioh";
}

/**
 * Cross-reference cluster addresses with entity store.
 * Auto-persists newly discovered addresses to their entities.
 */
export function discoverClusterEntities(
  clusterAddresses: Set<string>,
): ClusterDiscovery[] {
  if (clusterAddresses.size <= 1) return [];

  const addrArray = [...clusterAddresses];

  // 1. Check all cluster addresses against entity store
  const entityHits = lookupAddressEntities(addrArray);
  if (entityHits.size === 0) return [];

  // 2. Group by entity ID
  const byEntity = new Map<number, { entity: StoredAddressEntity; knownAddresses: string[] }>();
  for (const [addr, entity] of entityHits) {
    const existing = byEntity.get(entity.entityId);
    if (existing) {
      existing.knownAddresses.push(addr);
    } else {
      byEntity.set(entity.entityId, { entity, knownAddresses: [addr] });
    }
  }

  // 3. For each entity: find cluster addresses NOT already tagged
  const discoveries: ClusterDiscovery[] = [];

  for (const [entityId, { entity, knownAddresses }] of byEntity) {
    const knownSet = new Set(knownAddresses);
    const discovered: string[] = [];

    for (const addr of addrArray) {
      // Skip addresses already belonging to ANY entity (don't steal from other entities)
      if (entityHits.has(addr)) continue;
      if (knownSet.has(addr)) continue;
      discovered.push(addr);
    }

    if (discovered.length > 0) {
      // 4. Auto-persist discovered addresses to this entity
      addAddressesToEntity(entityId, discovered);

      discoveries.push({
        entityName: entity.entityName,
        entityId,
        category: entity.category,
        knownAddresses,
        discoveredAddresses: discovered,
        clusterSize: clusterAddresses.size,
        method: "cioh",
      });
    }
  }

  return discoveries;
}
