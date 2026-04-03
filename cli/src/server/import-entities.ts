/**
 * Import entities and addresses from am-i-exposed data sources into SQLite.
 *
 * Reads:
 *   1. src/data/entities.json → entity definitions
 *   2. .cache/entity-data/curated/*.csv → curated address mappings
 *   3. .cache/entity-data/custom/*.csv → custom address mappings
 *   4. .cache/entity-data/maru92/*.csv → Maru92 academic dataset (~30M)
 *   5. .cache/entity-data/temporal/*.csv → BitcoinTemporalGraph
 *   6. src/data/ofac-addresses.json → OFAC sanctioned addresses
 *
 * ALL addresses go into known_addresses. Matched entities get entity_id.
 * Unmatched addresses get category from filename or raw entity name.
 */

import { readFileSync, existsSync, readdirSync } from "fs";
import { join, basename } from "path";
import { createReadStream } from "fs";
import { createInterface } from "readline";
import {
  createEntity as storeCreateEntity,
  getEntityByName,
  addAddressesToEntity,
  bulkAddKnownAddresses,
  entityStoreStats,
} from "../adapters/entity-store";

function projectRoot(): string {
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

/** Guess category from CSV filename. */
function categoryFromFilename(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.includes("exchange")) return "exchange";
  if (lower.includes("darknet")) return "darknet";
  if (lower.includes("ransomware") || lower.includes("ransomwhere")) return "ransomware";
  if (lower.includes("mixer")) return "mixer";
  if (lower.includes("mining")) return "mining";
  if (lower.includes("gambling") || lower.includes("satoshidice")) return "gambling";
  if (lower.includes("scam") || lower.includes("ponzi")) return "scam";
  if (lower.includes("p2p")) return "p2p";
  if (lower.includes("ofac") || lower.includes("doj") || lower.includes("seizure")) return "sanctions";
  if (lower.includes("collectible")) return "collectibles";
  if (lower.includes("bitcointalk") || lower.includes("reddit")) return "forum";
  if (lower.includes("payment") || lower.includes("service")) return "payment";
  return "unknown";
}

/** Guess category from Maru92 raw entity name. */
function categoryFromEntityName(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes("exchange") || lower.includes("trade") || lower.includes("swap")) return "exchange";
  if (lower.includes("casino") || lower.includes("gambl") || lower.includes("dice") || lower.includes("bet")) return "gambling";
  if (lower.includes("pool") || lower.includes("mining")) return "mining";
  if (lower.includes("mix") || lower.includes("tumbl") || lower.includes("fog")) return "mixer";
  if (lower.includes("market") || lower.includes("silk") || lower.includes("hydra")) return "darknet";
  return "exchange"; // Maru92 is mostly exchanges
}

export async function importEntities(opts?: { force?: boolean }): Promise<void> {
  const root = projectRoot();
  const entitiesPath = join(root, "src", "data", "entities.json");

  if (!existsSync(entitiesPath)) {
    console.error(`  entities.json not found at ${entitiesPath}`);
    return;
  }

  console.log("  Loading entity definitions...");
  const entitiesJson = JSON.parse(readFileSync(entitiesPath, "utf-8"));
  const entityDefs: EntityDef[] = entitiesJson.entities;
  console.log(`  Found ${entityDefs.length} entity definitions.`);

  const stats = entityStoreStats();
  if (stats.entities >= entityDefs.length && !opts?.force) {
    console.log(`  Already imported (${stats.entities} entities, ${stats.knownAddresses} known addresses). Use --reimport-entities to force.`);
    return;
  }

  // Create entity definitions
  const entityIdMap = new Map<string, number>();
  for (const def of entityDefs) {
    const existing = getEntityByName(def.name);
    if (existing) {
      entityIdMap.set(def.name.toLowerCase(), existing.id);
      continue;
    }
    const created = storeCreateEntity(
      def.name, def.category,
      [def.country, def.status, def.ofac ? "OFAC" : null].filter(Boolean).join(", ") || undefined,
    );
    if (created) entityIdMap.set(def.name.toLowerCase(), created.id);
  }
  console.log(`  ${entityIdMap.size} entities ready.`);

  // Name resolution map
  const nameLookup = new Map<string, string>();
  for (const def of entityDefs) {
    nameLookup.set(def.name.toLowerCase(), def.name);
    const stripped = def.name.toLowerCase()
      .replace(/\.(com|net|org|io|eu|ag|me|info|st|co\.in|com\.br|com\.au|in\.th)$/i, "")
      .replace(/\s*(marketplace|market)$/i, "")
      .trim();
    if (stripped !== def.name.toLowerCase()) nameLookup.set(stripped, def.name);
  }

  // Process all CSV directories
  const cacheDir = join(root, ".cache", "entity-data");
  const csvDirs = ["curated", "custom", "maru92", "temporal"]
    .map((d) => join(cacheDir, d))
    .filter((d) => existsSync(d));

  let totalMatched = 0;
  let totalUnmatched = 0;
  let totalAutoCreated = 0;
  let totalInvalid = 0;
  let totalFiles = 0;

  for (const dir of csvDirs) {
    const dirName = basename(dir);
    const files = readdirSync(dir).filter((f) => f.endsWith(".csv")).sort();
    if (files.length === 0) continue;
    console.log(`  Processing ${files.length} CSV files from ${dirName}/...`);

    for (const file of files) {
      const filePath = join(dir, file);
      const isMaru92 = dirName === "maru92";
      const result = await importCsvFile(filePath, entityIdMap, nameLookup, isMaru92);
      totalMatched += result.matched;
      totalUnmatched += result.unmatched;
      totalAutoCreated += result.autoCreated;
      totalInvalid += result.invalid;
      totalFiles++;
      const total = result.matched + result.unmatched + result.autoCreated;
      if (total > 0) {
        process.stdout.write(`    ${file}: ${total} addresses`);
        if (result.autoCreated > 0) process.stdout.write(` (${result.autoCreated} new entities)`);
        process.stdout.write("\n");
      }
    }
  }

  // Import OFAC addresses
  const ofacPath = join(root, "src", "data", "ofac-addresses.json");
  if (existsSync(ofacPath)) {
    const ofacData = JSON.parse(readFileSync(ofacPath, "utf-8"));
    const ofacAddrs: string[] = ofacData.addresses ?? [];
    let ofacImported = 0;
    // Match each OFAC address to its entity
    const rows = ofacAddrs.map((addr) => {
      const normalized = normalizeAddress(addr);
      // Try to find entity for this address via the entity filter's name lookup
      // OFAC addresses may not have entity matches in our CSV data, so import as category "sanctions"
      return { address: normalized, category: "sanctions", source: "ofac", confidence: 100 };
    }).filter((r) => isValidAddress(r.address));
    ofacImported = bulkAddKnownAddresses(rows);
    console.log(`  OFAC: ${ofacImported} addresses imported.`);
  }

  const finalStats = entityStoreStats();
  console.log(`  Import complete: ${totalFiles} files.`);
  console.log(`    Matched to entities: ${totalMatched}`);
  console.log(`    Auto-created entities: ${totalAutoCreated}`);
  console.log(`    Category-only (no entity): ${totalUnmatched}`);
  console.log(`    Invalid/skipped: ${totalInvalid}`);
  console.log(`  Store: ${finalStats.entities} entities, ${finalStats.knownAddresses} known addresses.`);
}

async function importCsvFile(
  filePath: string,
  entityIdMap: Map<string, number>,
  nameLookup: Map<string, string>,
  autoCreateEntities: boolean,
): Promise<{ matched: number; unmatched: number; autoCreated: number; invalid: number }> {
  let addrIdx = 0;
  let entityIdx = 1;
  let headerDetected = false;
  let matched = 0;
  let unmatched = 0;
  let autoCreated = 0;
  let invalid = 0;

  const filename = basename(filePath);
  const fileCategory = categoryFromFilename(filename);
  const fileSource = basename(filePath, ".csv");

  // Batches: entity-linked addresses and category-only addresses
  const BATCH_SIZE = 10000;
  const entityBatch = new Map<number, string[]>();
  const categoryBatch: Array<{ address: string; category: string; source: string; confidence: number }> = [];
  let batchTotal = 0;

  function flushBatch(): void {
    for (const [eid, addrs] of entityBatch) {
      addAddressesToEntity(eid, addrs, fileSource);
      matched += addrs.length;
    }
    entityBatch.clear();
    if (categoryBatch.length > 0) {
      unmatched += bulkAddKnownAddresses(categoryBatch);
      categoryBatch.length = 0;
    }
    batchTotal = 0;
  }

  const rl = createInterface({
    input: createReadStream(filePath, "utf-8"),
    crlfDelay: Infinity,
  });

  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const parts = line.split(",").map((s) => s.replace(/^"|"$/g, "").trim());

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
        continue;
      }
    }

    const rawAddr = parts[addrIdx];
    if (!rawAddr) { invalid++; continue; }
    const addr = normalizeAddress(rawAddr);
    if (!isValidAddress(addr)) { invalid++; continue; }

    const rawEntity = parts[entityIdx];
    if (!rawEntity) { invalid++; continue; }

    // Try to resolve to a known entity
    const canonicalName = resolveEntityName(rawEntity, nameLookup);
    let entityId = canonicalName ? entityIdMap.get(canonicalName.toLowerCase()) : undefined;

    // Auto-create entity for Maru92 unknowns
    if (!entityId && autoCreateEntities && rawEntity.length > 1) {
      const category = categoryFromEntityName(rawEntity);
      const created = storeCreateEntity(rawEntity, category);
      if (created) {
        entityId = created.id;
        entityIdMap.set(rawEntity.toLowerCase(), created.id);
        nameLookup.set(rawEntity.toLowerCase(), rawEntity);
        autoCreated++;
      }
    }

    if (entityId) {
      const existing = entityBatch.get(entityId);
      if (existing) existing.push(addr);
      else entityBatch.set(entityId, [addr]);
    } else {
      // No entity match — store as category-only known address
      categoryBatch.push({
        address: addr,
        category: fileCategory,
        source: fileSource,
        confidence: fileCategory === "ransomware" ? 60 : 20,
      });
    }
    batchTotal++;
    if (batchTotal >= BATCH_SIZE) flushBatch();
  }

  flushBatch();
  return { matched, unmatched, autoCreated, invalid };
}

function resolveEntityName(rawName: string, nameLookup: Map<string, string>): string | null {
  const lower = rawName.toLowerCase().trim();
  if (nameLookup.has(lower)) return nameLookup.get(lower)!;
  const stripped = lower
    .replace(/\.(com|net|org|io|eu|ag|me|info|st|co\.in|com\.br|com\.au|in\.th)$/i, "")
    .replace(/\s*(marketplace|market)$/i, "")
    .trim();
  if (nameLookup.has(stripped)) return nameLookup.get(stripped)!;
  return null;
}
