/**
 * SQLite-based entity store for the API server.
 *
 * Four tables:
 *   - entities: named actors with categories
 *   - entity_addresses: maps addresses to entities (one entity per address)
 *   - address_labels: freeform annotations on addresses
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

    CREATE TABLE IF NOT EXISTS entity_addresses (
      address TEXT PRIMARY KEY,
      entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      source TEXT DEFAULT 'api',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_entaddr_entity ON entity_addresses(entity_id);

    CREATE TABLE IF NOT EXISTS address_labels (
      address TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      source TEXT DEFAULT 'api',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS transaction_labels (
      txid TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      source TEXT DEFAULT 'api',
      created_at INTEGER NOT NULL
    );
  `);

  return db;
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

export interface StoredAddressEntity {
  address: string;
  entityId: number;
  entityName: string;
  category: string;
  source: string;
  createdAt: number;
}

export interface StoredAddressLabel {
  address: string;
  label: string;
  source: string;
  createdAt: number;
}

export interface StoredTransactionLabel {
  txid: string;
  label: string;
  source: string;
  createdAt: number;
}

// ── Entity CRUD ──

export function createEntity(
  name: string,
  category: string,
  description?: string,
): StoredEntity | null {
  const d = getDb();
  if (!d) return null;
  const now = Date.now();
  const result = d.prepare(
    "INSERT INTO entities (name, category, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(name, category, description ?? null, now, now);
  return {
    id: Number(result.lastInsertRowid),
    name,
    category,
    description: description ?? null,
    createdAt: now,
    updatedAt: now,
  };
}

export function getEntity(id: number): StoredEntity | null {
  const d = getDb();
  if (!d) return null;
  const row = d.prepare("SELECT * FROM entities WHERE id = ?").get(id) as
    | { id: number; name: string; category: string; description: string | null; created_at: number; updated_at: number }
    | undefined;
  if (!row) return null;
  return { id: row.id, name: row.name, category: row.category, description: row.description, createdAt: row.created_at, updatedAt: row.updated_at };
}

export function getEntityByName(name: string): StoredEntity | null {
  const d = getDb();
  if (!d) return null;
  const row = d.prepare("SELECT * FROM entities WHERE name = ?").get(name) as
    | { id: number; name: string; category: string; description: string | null; created_at: number; updated_at: number }
    | undefined;
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

export function updateEntity(
  id: number,
  updates: { name?: string; category?: string; description?: string },
): boolean {
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
  const result = d.prepare(`UPDATE entities SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  return result.changes > 0;
}

export function deleteEntity(id: number): boolean {
  const d = getDb();
  if (!d) return false;
  const result = d.prepare("DELETE FROM entities WHERE id = ?").run(id);
  return result.changes > 0;
}

export function entityAddressCount(id: number): number {
  const d = getDb();
  if (!d) return 0;
  const row = d.prepare("SELECT COUNT(*) as cnt FROM entity_addresses WHERE entity_id = ?").get(id) as { cnt: number } | undefined;
  return row?.cnt ?? 0;
}

// ── Entity Addresses ──

export function addAddressesToEntity(
  entityId: number,
  addresses: string[],
  source = "api",
): number {
  const d = getDb();
  if (!d || addresses.length === 0) return 0;
  const now = Date.now();
  const stmt = d.prepare(
    "INSERT OR REPLACE INTO entity_addresses (address, entity_id, source, created_at) VALUES (?, ?, ?, ?)",
  );
  let count = 0;
  const tx = d.transaction(() => {
    for (const addr of addresses) {
      stmt.run(addr, entityId, source, now);
      count++;
    }
  });
  tx();
  return count;
}

export function listEntityAddresses(entityId: number): StoredAddressEntity[] {
  const d = getDb();
  if (!d) return [];
  const rows = d.prepare(
    "SELECT ea.address, ea.entity_id, e.name as entity_name, e.category, ea.source, ea.created_at FROM entity_addresses ea JOIN entities e ON ea.entity_id = e.id WHERE ea.entity_id = ? ORDER BY ea.created_at",
  ).all(entityId) as Array<{ address: string; entity_id: number; entity_name: string; category: string; source: string; created_at: number }>;
  return rows.map((r) => ({
    address: r.address, entityId: r.entity_id, entityName: r.entity_name,
    category: r.category, source: r.source, createdAt: r.created_at,
  }));
}

export function removeAddressFromEntity(entityId: number, address: string): boolean {
  const d = getDb();
  if (!d) return false;
  const result = d.prepare("DELETE FROM entity_addresses WHERE entity_id = ? AND address = ?").run(entityId, address);
  return result.changes > 0;
}

export function lookupAddressEntity(address: string): StoredAddressEntity | null {
  const d = getDb();
  if (!d) return null;
  const row = d.prepare(
    "SELECT ea.address, ea.entity_id, e.name as entity_name, e.category, ea.source, ea.created_at FROM entity_addresses ea JOIN entities e ON ea.entity_id = e.id WHERE ea.address = ?",
  ).get(address) as { address: string; entity_id: number; entity_name: string; category: string; source: string; created_at: number } | undefined;
  if (!row) return null;
  return { address: row.address, entityId: row.entity_id, entityName: row.entity_name, category: row.category, source: row.source, createdAt: row.created_at };
}

export function lookupAddressEntities(addresses: string[]): Map<string, StoredAddressEntity> {
  const d = getDb();
  const results = new Map<string, StoredAddressEntity>();
  if (!d || addresses.length === 0) return results;

  if (addresses.length <= 50) {
    const stmt = d.prepare(
      "SELECT ea.address, ea.entity_id, e.name as entity_name, e.category, ea.source, ea.created_at FROM entity_addresses ea JOIN entities e ON ea.entity_id = e.id WHERE ea.address = ?",
    );
    for (const addr of addresses) {
      const row = stmt.get(addr) as { address: string; entity_id: number; entity_name: string; category: string; source: string; created_at: number } | undefined;
      if (row) {
        results.set(row.address, { address: row.address, entityId: row.entity_id, entityName: row.entity_name, category: row.category, source: row.source, createdAt: row.created_at });
      }
    }
  } else {
    d.exec("CREATE TEMP TABLE IF NOT EXISTS _addr_lookup (addr TEXT PRIMARY KEY)");
    d.exec("DELETE FROM _addr_lookup");
    const ins = d.prepare("INSERT OR IGNORE INTO _addr_lookup (addr) VALUES (?)");
    const tx = d.transaction(() => { for (const a of addresses) ins.run(a); });
    tx();
    const rows = d.prepare(
      "SELECT ea.address, ea.entity_id, e.name as entity_name, e.category, ea.source, ea.created_at FROM entity_addresses ea JOIN entities e ON ea.entity_id = e.id INNER JOIN _addr_lookup t ON ea.address = t.addr",
    ).all() as Array<{ address: string; entity_id: number; entity_name: string; category: string; source: string; created_at: number }>;
    for (const r of rows) {
      results.set(r.address, { address: r.address, entityId: r.entity_id, entityName: r.entity_name, category: r.category, source: r.source, createdAt: r.created_at });
    }
  }
  return results;
}

// ── Address Labels ──

export function setAddressLabel(address: string, label: string, source?: string): void {
  const d = getDb();
  if (!d) return;
  d.prepare(
    "INSERT OR REPLACE INTO address_labels (address, label, source, created_at) VALUES (?, ?, ?, ?)",
  ).run(address, label, source ?? "api", Date.now());
}

export function getAddressLabel(address: string): StoredAddressLabel | null {
  const d = getDb();
  if (!d) return null;
  const row = d.prepare("SELECT * FROM address_labels WHERE address = ?").get(address) as
    | { address: string; label: string; source: string; created_at: number } | undefined;
  if (!row) return null;
  return { address: row.address, label: row.label, source: row.source, createdAt: row.created_at };
}

export function removeAddressLabel(address: string): boolean {
  const d = getDb();
  if (!d) return false;
  return d.prepare("DELETE FROM address_labels WHERE address = ?").run(address).changes > 0;
}

export function lookupAddressLabels(addresses: string[]): Map<string, StoredAddressLabel> {
  const d = getDb();
  const results = new Map<string, StoredAddressLabel>();
  if (!d || addresses.length === 0) return results;
  const stmt = d.prepare("SELECT * FROM address_labels WHERE address = ?");
  for (const addr of addresses) {
    const row = stmt.get(addr) as { address: string; label: string; source: string; created_at: number } | undefined;
    if (row) results.set(row.address, { address: row.address, label: row.label, source: row.source, createdAt: row.created_at });
  }
  return results;
}

export function bulkSetAddressLabels(labels: Array<{ address: string; label: string }>, source = "import"): number {
  const d = getDb();
  if (!d || labels.length === 0) return 0;
  const now = Date.now();
  const stmt = d.prepare(
    "INSERT OR REPLACE INTO address_labels (address, label, source, created_at) VALUES (?, ?, ?, ?)",
  );
  let count = 0;
  const tx = d.transaction(() => {
    for (const { address, label } of labels) {
      if (address && label) {
        stmt.run(address, label, source, now);
        count++;
      }
    }
  });
  tx();
  return count;
}

// ── Transaction Labels ──

export function setTransactionLabel(txid: string, label: string, source?: string): void {
  const d = getDb();
  if (!d) return;
  d.prepare(
    "INSERT OR REPLACE INTO transaction_labels (txid, label, source, created_at) VALUES (?, ?, ?, ?)",
  ).run(txid, label, source ?? "api", Date.now());
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
  addresses: number;
  addressLabels: number;
  transactionLabels: number;
} {
  const d = getDb();
  if (!d) return { entities: 0, addresses: 0, addressLabels: 0, transactionLabels: 0 };
  const e = d.prepare("SELECT COUNT(*) as cnt FROM entities").get() as { cnt: number };
  const a = d.prepare("SELECT COUNT(*) as cnt FROM entity_addresses").get() as { cnt: number };
  const al = d.prepare("SELECT COUNT(*) as cnt FROM address_labels").get() as { cnt: number };
  const tl = d.prepare("SELECT COUNT(*) as cnt FROM transaction_labels").get() as { cnt: number };
  return { entities: e.cnt, addresses: a.cnt, addressLabels: al.cnt, transactionLabels: tl.cnt };
}

/** Return all entity-address mappings as a compact map: address → {entityName, category}. */
export function getAllEntityAddresses(): Map<string, { entityName: string; category: string }> {
  const d = getDb();
  const result = new Map<string, { entityName: string; category: string }>();
  if (!d) return result;
  const rows = d.prepare(
    "SELECT ea.address, e.name as entity_name, e.category FROM entity_addresses ea JOIN entities e ON ea.entity_id = e.id",
  ).all() as Array<{ address: string; entity_name: string; category: string }>;
  for (const r of rows) {
    result.set(r.address, { entityName: r.entity_name, category: r.category });
  }
  return result;
}

export function closeEntityStore(): void {
  if (db) { db.close(); db = null; }
}
