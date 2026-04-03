/**
 * SQLite-based store for the API server.
 *
 * Tables:
 *   - entities: named actors (Coinbase, Silk Road, etc.)
 *   - known_addresses: every address we know about, with optional entity link and label
 *   - transaction_labels: freeform annotations on txids
 *
 * Database: ~/.am-i-exposed/entities.sqlite
 */

import Database from "better-sqlite3";
import { mkdirSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const STORE_DIR = join(homedir(), ".am-i-exposed");
const DB_PATH = join(STORE_DIR, "entities.sqlite");

let db: Database.Database | null = null;
let dbUnavailable = false;

function getDb(): Database.Database | null {
  if (db) return db;
  if (dbUnavailable) return null;

  try {
    if (!existsSync(STORE_DIR)) {
      mkdirSync(STORE_DIR, { recursive: true });
    }
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("foreign_keys = ON");
  } catch {
    dbUnavailable = true;
    return null;
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      category TEXT NOT NULL,
      description TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_entities_category ON entities(category);

    CREATE TABLE IF NOT EXISTS known_addresses (
      address TEXT PRIMARY KEY,
      entity_id INTEGER REFERENCES entities(id) ON DELETE SET NULL,
      label TEXT,
      category TEXT NOT NULL DEFAULT 'unknown',
      source TEXT NOT NULL DEFAULT 'api',
      confidence INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_known_entity ON known_addresses(entity_id);
    CREATE INDEX IF NOT EXISTS idx_known_category ON known_addresses(category);
    CREATE INDEX IF NOT EXISTS idx_known_source ON known_addresses(source);

    CREATE TABLE IF NOT EXISTS transaction_labels (
      txid TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      source TEXT DEFAULT 'api',
      created_at INTEGER NOT NULL
    );
  `);

  // Migrate old tables if they exist
  migrateOldTables(db);

  return db;
}

/** Migrate entity_addresses + address_labels into known_addresses (one-time). */
function migrateOldTables(d: Database.Database): void {
  const hasOld = d.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='entity_addresses'",
  ).get();
  if (!hasOld) return;

  const now = Date.now();
  d.exec(`
    INSERT OR IGNORE INTO known_addresses (address, entity_id, category, source, confidence, created_at, updated_at)
    SELECT ea.address, ea.entity_id, COALESCE(e.category, 'unknown'), ea.source, 80, ea.created_at, ${now}
    FROM entity_addresses ea LEFT JOIN entities e ON ea.entity_id = e.id;
  `);

  const hasLabels = d.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='address_labels'",
  ).get();
  if (hasLabels) {
    // For addresses already migrated, add the label. For new ones, insert.
    const labels = d.prepare("SELECT * FROM address_labels").all() as Array<{
      address: string; label: string; source: string; created_at: number;
    }>;
    const upsert = d.prepare(`
      INSERT INTO known_addresses (address, label, category, source, confidence, created_at, updated_at)
      VALUES (?, ?, 'flagged', ?, 50, ?, ${now})
      ON CONFLICT(address) DO UPDATE SET label = excluded.label, updated_at = ${now}
    `);
    const tx = d.transaction(() => {
      for (const row of labels) {
        upsert.run(row.address, row.label, row.source, row.created_at);
      }
    });
    tx();
    d.exec("DROP TABLE address_labels");
  }

  d.exec("DROP TABLE entity_addresses");
}

// ── Types ──

export interface StoredEntity {
  id: number;
  name: string;
  category: string;
  description: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface KnownAddress {
  address: string;
  entityId: number | null;
  entityName: string | null;
  label: string | null;
  category: string;
  source: string;
  confidence: number;
  createdAt: number;
  updatedAt: number;
}

export interface StoredTransactionLabel {
  txid: string;
  label: string;
  source: string;
  createdAt: number;
}

// ── Entity CRUD ──

export function createEntity(name: string, category: string, description?: string): StoredEntity | null {
  const d = getDb();
  if (!d) return null;
  const now = Date.now();
  const result = d.prepare(
    "INSERT INTO entities (name, category, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(name, category, description ?? null, now, now);
  return { id: Number(result.lastInsertRowid), name, category, description: description ?? null, createdAt: now, updatedAt: now };
}

export function getEntity(id: number): StoredEntity | null {
  const d = getDb();
  if (!d) return null;
  const row = d.prepare("SELECT * FROM entities WHERE id = ?").get(id) as
    | { id: number; name: string; category: string; description: string | null; created_at: number; updated_at: number } | undefined;
  if (!row) return null;
  return { id: row.id, name: row.name, category: row.category, description: row.description, createdAt: row.created_at, updatedAt: row.updated_at };
}

export function getEntityByName(name: string): StoredEntity | null {
  const d = getDb();
  if (!d) return null;
  const row = d.prepare("SELECT * FROM entities WHERE name = ?").get(name) as
    | { id: number; name: string; category: string; description: string | null; created_at: number; updated_at: number } | undefined;
  if (!row) return null;
  return { id: row.id, name: row.name, category: row.category, description: row.description, createdAt: row.created_at, updatedAt: row.updated_at };
}

export function listEntities(category?: string): StoredEntity[] {
  const d = getDb();
  if (!d) return [];
  const rows = category
    ? d.prepare("SELECT * FROM entities WHERE category = ? ORDER BY name").all(category)
    : d.prepare("SELECT * FROM entities ORDER BY name").all();
  return (rows as Array<{ id: number; name: string; category: string; description: string | null; created_at: number; updated_at: number }>).map(
    (r) => ({ id: r.id, name: r.name, category: r.category, description: r.description, createdAt: r.created_at, updatedAt: r.updated_at }),
  );
}

export function updateEntity(id: number, updates: { name?: string; category?: string; description?: string }): boolean {
  const d = getDb();
  if (!d) return false;
  const fields: string[] = [];
  const values: unknown[] = [];
  if (updates.name !== undefined) { fields.push("name = ?"); values.push(updates.name); }
  if (updates.category !== undefined) { fields.push("category = ?"); values.push(updates.category); }
  if (updates.description !== undefined) { fields.push("description = ?"); values.push(updates.description); }
  if (fields.length === 0) return false;
  fields.push("updated_at = ?");
  values.push(Date.now());
  values.push(id);
  return d.prepare(`UPDATE entities SET ${fields.join(", ")} WHERE id = ?`).run(...values).changes > 0;
}

export function deleteEntity(id: number): boolean {
  const d = getDb();
  if (!d) return false;
  // ON DELETE SET NULL: known_addresses.entity_id becomes NULL, address stays
  return d.prepare("DELETE FROM entities WHERE id = ?").run(id).changes > 0;
}

export function entityAddressCount(id: number): number {
  const d = getDb();
  if (!d) return 0;
  const row = d.prepare("SELECT COUNT(*) as cnt FROM known_addresses WHERE entity_id = ?").get(id) as { cnt: number } | undefined;
  return row?.cnt ?? 0;
}

// ── Known Addresses ──

type KnownRow = {
  address: string; entity_id: number | null; entity_name: string | null;
  label: string | null; category: string; source: string; confidence: number;
  created_at: number; updated_at: number;
};

function rowToKnown(r: KnownRow): KnownAddress {
  return {
    address: r.address, entityId: r.entity_id, entityName: r.entity_name,
    label: r.label, category: r.category, source: r.source, confidence: r.confidence,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

const KNOWN_SELECT = `
  SELECT ka.address, ka.entity_id, e.name as entity_name, ka.label, ka.category, ka.source, ka.confidence, ka.created_at, ka.updated_at
  FROM known_addresses ka LEFT JOIN entities e ON ka.entity_id = e.id
`;

export function getKnownAddress(address: string): KnownAddress | null {
  const d = getDb();
  if (!d) return null;
  const row = d.prepare(`${KNOWN_SELECT} WHERE ka.address = ?`).get(address) as KnownRow | undefined;
  return row ? rowToKnown(row) : null;
}

export function lookupKnownAddresses(addresses: string[]): Map<string, KnownAddress> {
  const d = getDb();
  const results = new Map<string, KnownAddress>();
  if (!d || addresses.length === 0) return results;

  if (addresses.length <= 50) {
    const stmt = d.prepare(`${KNOWN_SELECT} WHERE ka.address = ?`);
    for (const addr of addresses) {
      const row = stmt.get(addr) as KnownRow | undefined;
      if (row) results.set(row.address, rowToKnown(row));
    }
  } else {
    d.exec("CREATE TEMP TABLE IF NOT EXISTS _ka_lookup (addr TEXT PRIMARY KEY)");
    d.exec("DELETE FROM _ka_lookup");
    const ins = d.prepare("INSERT OR IGNORE INTO _ka_lookup (addr) VALUES (?)");
    const tx = d.transaction(() => { for (const a of addresses) ins.run(a); });
    tx();
    const rows = d.prepare(`${KNOWN_SELECT} INNER JOIN _ka_lookup t ON ka.address = t.addr`).all() as KnownRow[];
    for (const r of rows) results.set(r.address, rowToKnown(r));
  }
  return results;
}

/** Add addresses with entity link. */
export function addAddressesToEntity(entityId: number, addresses: string[], source = "api"): number {
  const d = getDb();
  if (!d || addresses.length === 0) return 0;
  const entity = getEntity(entityId);
  const category = entity?.category ?? "unknown";
  const now = Date.now();
  const stmt = d.prepare(`
    INSERT INTO known_addresses (address, entity_id, category, source, confidence, created_at, updated_at)
    VALUES (?, ?, ?, ?, 80, ?, ?)
    ON CONFLICT(address) DO UPDATE SET entity_id = excluded.entity_id, category = excluded.category, source = excluded.source, updated_at = excluded.updated_at
  `);
  let count = 0;
  const tx = d.transaction(() => { for (const addr of addresses) { stmt.run(addr, entityId, category, source, now, now); count++; } });
  tx();
  return count;
}

/** List addresses for an entity. */
export function listEntityAddresses(entityId: number): KnownAddress[] {
  const d = getDb();
  if (!d) return [];
  return (d.prepare(`${KNOWN_SELECT} WHERE ka.entity_id = ? ORDER BY ka.created_at`).all(entityId) as KnownRow[]).map(rowToKnown);
}

/** Remove address from entity (keeps address if it has a label). */
export function removeAddressFromEntity(entityId: number, address: string): boolean {
  const d = getDb();
  if (!d) return false;
  const row = d.prepare("SELECT label FROM known_addresses WHERE address = ? AND entity_id = ?").get(address, entityId) as { label: string | null } | undefined;
  if (!row) return false;
  if (row.label) {
    // Has label — keep the address, just unlink entity
    d.prepare("UPDATE known_addresses SET entity_id = NULL, updated_at = ? WHERE address = ?").run(Date.now(), address);
  } else {
    // No label — delete the row
    d.prepare("DELETE FROM known_addresses WHERE address = ? AND entity_id = ?").run(address, entityId);
  }
  return true;
}

/** Set label on an address (creates known_address if doesn't exist). */
export function setAddressLabel(address: string, label: string, source = "api"): void {
  const d = getDb();
  if (!d) return;
  const now = Date.now();
  d.prepare(`
    INSERT INTO known_addresses (address, label, category, source, confidence, created_at, updated_at)
    VALUES (?, ?, 'flagged', ?, 50, ?, ?)
    ON CONFLICT(address) DO UPDATE SET label = excluded.label, updated_at = excluded.updated_at
  `).run(address, label, source, now, now);
}

/** Remove label from address (keeps address if it has entity). */
export function removeAddressLabel(address: string): boolean {
  const d = getDb();
  if (!d) return false;
  const row = d.prepare("SELECT entity_id FROM known_addresses WHERE address = ?").get(address) as { entity_id: number | null } | undefined;
  if (!row) return false;
  if (row.entity_id) {
    d.prepare("UPDATE known_addresses SET label = NULL, updated_at = ? WHERE address = ?").run(Date.now(), address);
  } else {
    d.prepare("DELETE FROM known_addresses WHERE address = ?").run(address);
  }
  return true;
}

/** Bulk add known addresses (generic — can set entity_id, label, category, source, confidence). */
export function bulkAddKnownAddresses(
  rows: Array<{ address: string; entityId?: number; label?: string; category?: string; source?: string; confidence?: number }>,
): number {
  const d = getDb();
  if (!d || rows.length === 0) return 0;
  const now = Date.now();
  const stmt = d.prepare(`
    INSERT INTO known_addresses (address, entity_id, label, category, source, confidence, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(address) DO UPDATE SET
      entity_id = COALESCE(excluded.entity_id, known_addresses.entity_id),
      label = COALESCE(excluded.label, known_addresses.label),
      category = CASE WHEN excluded.category != 'unknown' THEN excluded.category ELSE known_addresses.category END,
      source = excluded.source,
      confidence = MAX(excluded.confidence, known_addresses.confidence),
      updated_at = excluded.updated_at
  `);
  let count = 0;
  const tx = d.transaction(() => {
    for (const r of rows) {
      if (!r.address) continue;
      stmt.run(r.address, r.entityId ?? null, r.label ?? null, r.category ?? "unknown", r.source ?? "api", r.confidence ?? 0, now, now);
      count++;
    }
  });
  tx();
  return count;
}

/** Get all known addresses that have an entity (for client-side entity matching). */
export function getAllEntityAddresses(): Map<string, { entityName: string; category: string }> {
  const d = getDb();
  const result = new Map<string, { entityName: string; category: string }>();
  if (!d) return result;
  const rows = d.prepare(
    "SELECT ka.address, e.name as entity_name, e.category FROM known_addresses ka JOIN entities e ON ka.entity_id = e.id WHERE ka.entity_id IS NOT NULL",
  ).all() as Array<{ address: string; entity_name: string; category: string }>;
  for (const r of rows) result.set(r.address, { entityName: r.entity_name, category: r.category });
  return result;
}

// ── Transaction Labels ──

export function setTransactionLabel(txid: string, label: string, source?: string): void {
  const d = getDb();
  if (!d) return;
  d.prepare("INSERT OR REPLACE INTO transaction_labels (txid, label, source, created_at) VALUES (?, ?, ?, ?)").run(txid, label, source ?? "api", Date.now());
}

export function getTransactionLabel(txid: string): StoredTransactionLabel | null {
  const d = getDb();
  if (!d) return null;
  const row = d.prepare("SELECT * FROM transaction_labels WHERE txid = ?").get(txid) as
    | { txid: string; label: string; source: string; created_at: number } | undefined;
  if (!row) return null;
  return { txid: row.txid, label: row.label, source: row.source, createdAt: row.created_at };
}

export function removeTransactionLabel(txid: string): boolean {
  const d = getDb();
  if (!d) return false;
  return d.prepare("DELETE FROM transaction_labels WHERE txid = ?").run(txid).changes > 0;
}

export function lookupTransactionLabels(txids: string[]): Map<string, StoredTransactionLabel> {
  const d = getDb();
  const results = new Map<string, StoredTransactionLabel>();
  if (!d || txids.length === 0) return results;
  const stmt = d.prepare("SELECT * FROM transaction_labels WHERE txid = ?");
  for (const txid of txids) {
    const row = stmt.get(txid) as { txid: string; label: string; source: string; created_at: number } | undefined;
    if (row) results.set(row.txid, { txid: row.txid, label: row.label, source: row.source, createdAt: row.created_at });
  }
  return results;
}

// ── Stats ──

export function entityStoreStats(): {
  entities: number;
  knownAddresses: number;
  withEntity: number;
  withLabel: number;
  transactionLabels: number;
} {
  const d = getDb();
  if (!d) return { entities: 0, knownAddresses: 0, withEntity: 0, withLabel: 0, transactionLabels: 0 };
  const e = d.prepare("SELECT COUNT(*) as cnt FROM entities").get() as { cnt: number };
  const ka = d.prepare("SELECT COUNT(*) as cnt FROM known_addresses").get() as { cnt: number };
  const we = d.prepare("SELECT COUNT(*) as cnt FROM known_addresses WHERE entity_id IS NOT NULL").get() as { cnt: number };
  const wl = d.prepare("SELECT COUNT(*) as cnt FROM known_addresses WHERE label IS NOT NULL").get() as { cnt: number };
  const tl = d.prepare("SELECT COUNT(*) as cnt FROM transaction_labels").get() as { cnt: number };
  return { entities: e.cnt, knownAddresses: ka.cnt, withEntity: we.cnt, withLabel: wl.cnt, transactionLabels: tl.cnt };
}

export function closeEntityStore(): void {
  if (db) { db.close(); db = null; }
}
