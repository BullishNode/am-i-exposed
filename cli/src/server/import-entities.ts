/**
 * Import entities and addresses from am-i-exposed data sources into SQLite.
 *
 * Reads:
 *   1. src/data/entities.json → entity definitions
 *   2. .cache/entity-data/curated/*.csv → curated address mappings (~195K)
 *   3. .cache/entity-data/custom/*.csv → custom address mappings
 *   4. .cache/entity-data/maru92/*.csv → Maru92 academic dataset (~30M, optional)
 *   5. .cache/entity-data/temporal/*.csv → BitcoinTemporalGraph (~100K, optional)
 *
 * Run with: am-i-exposed serve --import-entities
 */

import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { createReadStream } from "fs";
import { createInterface } from "readline";
import {
  createEntity as storeCreateEntity,
  getEntityByName,
  addAddressesToEntity,
  entityStoreStats,
} from "../adapters/entity-store";

/** Resolve the am-i-exposed project root (where src/data/entities.json lives). */
function projectRoot(): string {
  // Try common locations: CWD, parent of CWD (if running from cli/), __dirname
  const candidates = [
    process.cwd(),
    join(process.cwd(), ".."),
    __dirname,
    join(__dirname, ".."),
    join(__dirname, "..", ".."),
    join(__dirname, "..", "..", ".."),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, "src", "data", "entities.json"))) return dir;
  }
  // Fallback: walk up from CWD
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "src", "data", "entities.json"))) return dir;
    dir = join(dir, "..");
  }
  return process.cwd();
}

interface EntityDef {
  name: string;
  category: string;
  status?: string;
  country?: string;
  ofac?: boolean;
  priority?: number;
}

function normalizeAddress(addr: string): string {
  if (addr.startsWith("bc1") || addr.startsWith("tb1")) return addr.toLowerCase();
  return addr;
}

function isValidAddress(addr: string): boolean {
  if (!addr || addr.length < 26 || addr.length > 90) return false;
  return /^(1|3|bc1|tb1)/.test(addr);
}

/**
 * Import all entity data into SQLite.
 * Skips if data has already been imported (checks entity count).
 */
export async function importEntities(opts?: { force?: boolean }): Promise<void> {
  const root = projectRoot();
  const entitiesPath = join(root, "src", "data", "entities.json");

  if (!existsSync(entitiesPath)) {
    console.error(`  entities.json not found at ${entitiesPath}`);
    return;
  }

  // Check if already imported
  const stats = entityStoreStats();
  if (stats.entities > 0 && !opts?.force) {
    console.log(`  Entity store already has ${stats.entities} entities, ${stats.addresses} addresses. Use --reimport-entities to force.`);
    return;
  }

  console.log("  Loading entity definitions...");
  const entitiesJson = JSON.parse(readFileSync(entitiesPath, "utf-8"));
  const entityDefs: EntityDef[] = entitiesJson.entities;
  console.log(`  Found ${entityDefs.length} entity definitions.`);

  // Build lookup: lowercase name → entity id
  const entityIdMap = new Map<string, number>();

  for (const def of entityDefs) {
    const existing = getEntityByName(def.name);
    if (existing) {
      entityIdMap.set(def.name.toLowerCase(), existing.id);
      continue;
    }
    const created = storeCreateEntity(
      def.name,
      def.category,
      [def.country, def.status, def.ofac ? "OFAC" : null].filter(Boolean).join(", ") || undefined,
    );
    if (created) {
      entityIdMap.set(def.name.toLowerCase(), created.id);
    }
  }
  console.log(`  Imported ${entityIdMap.size} entities.`);

  // Build name resolution map (same logic as build-entity-filter.mjs)
  const nameLookup = new Map<string, string>();
  for (const def of entityDefs) {
    nameLookup.set(def.name.toLowerCase(), def.name);
    // Strip common TLDs for fuzzy matching
    const stripped = def.name
      .toLowerCase()
      .replace(/\.(com|net|org|io|eu|ag|me|info|st|co\.in|com\.br|com\.au|in\.th)$/i, "")
      .replace(/\s*(marketplace|market)$/i, "")
      .trim();
    if (stripped !== def.name.toLowerCase()) {
      nameLookup.set(stripped, def.name);
    }
  }

  // Collect CSV directories
  const cacheDir = join(root, ".cache", "entity-data");
  const csvDirs = ["curated", "custom", "maru92", "temporal"]
    .map((d) => join(cacheDir, d))
    .filter((d) => existsSync(d));

  let totalAddresses = 0;
  let totalErrors = 0;
  let totalFiles = 0;

  for (const dir of csvDirs) {
    const files = readdirSync(dir).filter((f) => f.endsWith(".csv")).sort();
    if (files.length === 0) continue;
    console.log(`  Processing ${files.length} CSV files from ${dir.split("/").pop()}/...`);

    for (const file of files) {
      const filePath = join(dir, file);
      const result = await importCsvFile(filePath, entityIdMap, nameLookup);
      totalAddresses += result.imported;
      totalErrors += result.errors;
      totalFiles++;
      if (result.imported > 0) {
        process.stdout.write(`    ${file}: ${result.imported} addresses\n`);
      }
    }
  }

  const finalStats = entityStoreStats();
  console.log(`  Import complete: ${totalFiles} files, ${totalAddresses} addresses imported, ${totalErrors} errors.`);
  console.log(`  Entity store: ${finalStats.entities} entities, ${finalStats.addresses} addresses.`);
}

/**
 * Import a single CSV file into the entity store.
 * Auto-detects headers and column positions (same logic as build-entity-filter.mjs).
 */
async function importCsvFile(
  filePath: string,
  entityIdMap: Map<string, number>,
  nameLookup: Map<string, string>,
): Promise<{ imported: number; errors: number }> {
  let addrIdx = 0;
  let entityIdx = 1;
  let headerDetected = false;
  let imported = 0;
  let errors = 0;

  // Batch for performance
  const BATCH_SIZE = 5000;
  const batch = new Map<number, string[]>(); // entityId → addresses

  function flushBatch(): void {
    for (const [eid, addrs] of batch) {
      addAddressesToEntity(eid, addrs);
      imported += addrs.length;
    }
    batch.clear();
  }

  const rl = createInterface({
    input: createReadStream(filePath, "utf-8"),
    crlfDelay: Infinity,
  });

  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const parts = line.split(",").map((s) => s.replace(/^"|"$/g, "").trim());

    // Header detection on first non-empty line
    if (!headerDetected) {
      headerDetected = true;
      const lower = parts.map((c) => c.toLowerCase());
      const hasHeader = lower.some((c) =>
        ["hashadd", "address", "addr", "exchange", "gambling", "mining",
         "service", "historic", "entity", "label", "bitcoin_address"].includes(c),
      );
      if (hasHeader) {
        addrIdx = lower.findIndex((c) =>
          ["hashadd", "address", "addr", "bitcoin_address"].includes(c),
        );
        entityIdx = lower.findIndex((c) =>
          ["entity", "label", "name", "wallet", "owner",
           "exchange", "gambling", "mining", "service", "historic"].includes(c),
        );
        if (addrIdx < 0) addrIdx = 0;
        if (entityIdx < 0) entityIdx = 1;
        continue; // skip header row
      }
    }

    // Extract and validate address
    const rawAddr = parts[addrIdx];
    if (!rawAddr) { errors++; continue; }
    const addr = normalizeAddress(rawAddr);
    if (!isValidAddress(addr)) { errors++; continue; }

    // Extract and resolve entity name
    const rawEntity = parts[entityIdx];
    if (!rawEntity) { errors++; continue; }

    const canonicalName = resolveEntityName(rawEntity, nameLookup);
    if (!canonicalName) { errors++; continue; }

    const entityId = entityIdMap.get(canonicalName.toLowerCase());
    if (!entityId) {
      // Entity not in entities.json — skip
      errors++;
      continue;
    }

    // Add to batch
    const existing = batch.get(entityId);
    if (existing) {
      existing.push(addr);
    } else {
      batch.set(entityId, [addr]);
    }

    // Flush batch when any entity accumulates enough
    let batchTotal = 0;
    for (const addrs of batch.values()) batchTotal += addrs.length;
    if (batchTotal >= BATCH_SIZE) flushBatch();
  }

  // Flush remaining
  flushBatch();

  return { imported, errors };
}

/** Resolve a raw CSV entity name to the canonical name from entities.json. */
function resolveEntityName(
  rawName: string,
  nameLookup: Map<string, string>,
): string | null {
  const lower = rawName.toLowerCase().trim();
  if (nameLookup.has(lower)) return nameLookup.get(lower)!;

  // Strip TLDs
  const stripped = lower
    .replace(/\.(com|net|org|io|eu|ag|me|info|st|co\.in|com\.br|com\.au|in\.th)$/i, "")
    .replace(/\s*(marketplace|market)$/i, "")
    .trim();
  if (nameLookup.has(stripped)) return nameLookup.get(stripped)!;

  return null;
}
