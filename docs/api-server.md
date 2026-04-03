# HTTP API Server

REST API for programmatic access to the am-i-exposed Bitcoin privacy analysis engine.

## Quick Start

```bash
am-i-exposed serve --port 3001

# With entity import and auth
am-i-exposed serve --port 3001 --import-entities --auth-token <secret>

# Full server mode with self-hosted mempool
am-i-exposed serve --port 3001 --import-entities --auth-token <secret> --api http://your-mempool:8999/api
```

| Flag | Default | Description |
|------|---------|-------------|
| `--port <N>` | 3001 | Port to listen on |
| `--host <addr>` | 127.0.0.1 | Bind address |
| `--api <url>` | mempool.space | Custom mempool API URL |
| `--auth-token <token>` | none | Require Bearer token for all requests (except health) |
| `--import-entities` | off | Import entity data from CSV sources into SQLite on startup |
| `--reimport-entities` | off | Force re-import (implies --import-entities) |
| `--no-entities` | false | Skip built-in entity filter loading |
| `--no-cache` | false | Disable SQLite response caching |

**Auth:** When `--auth-token` is set, all requests except `GET /api/v1/health` must include `Authorization: Bearer <token>`.

**CORS:** All origins allowed. Methods: GET, POST, PUT, DELETE, OPTIONS. Headers: Content-Type, Authorization.

**Max request body:** 10 MB. Max addresses per request: 10,000.

---

## Analysis Endpoints

### POST /api/v1/scan/tx

Analyze a Bitcoin transaction. Runs 27 privacy heuristics, optional chain tracing, and returns entities/labels found in the chain.

**Request:**
```json
{
  "txid": "64-char hex",
  "network": "mainnet",
  "chainDepth": 6,
  "minSats": 1000,
  "fast": false,
  "apiUrl": "http://your-mempool:8999/api"
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| txid | string | required | 64-character hex transaction ID |
| network | string | mainnet | mainnet, testnet4, or signet |
| chainDepth | number | 6 | Hops to trace (0-20) |
| minSats | number | 1000 | Min sats to follow when tracing |
| fast | boolean | false | Skip parent tx context |
| apiUrl | string | - | Override mempool API URL |

**Response:**
```json
{
  "score": 52,
  "grade": "C",
  "txType": "simple-payment",
  "txInfo": {
    "inputs": 1, "outputs": 2, "fee": 10000,
    "size": 226, "weight": 904,
    "confirmed": true, "blockHeight": 399996
  },
  "findings": [
    {"id": "h2-change-detected", "severity": "high", "scoreImpact": -16, "title": "..."}
  ],
  "recommendation": {"id": "use-coinjoin", "urgency": "immediate", "headline": "..."},
  "chainAnalysis": {
    "backward": {"depth": 6, "txsFetched": 47, "aborted": false, "layers": [...]},
    "forward": {"depth": 6, "txsFetched": 32, "aborted": false, "layers": [...]}
  },
  "customEntities": [
    {"entityName": "My Service", "category": "service", "address": "bc1q...", "txid": "abc...", "direction": "backward", "hops": 0}
  ],
  "addressLabels": [
    {"address": "bc1q...", "label": "flagged address", "hops": 2, "direction": "forward"}
  ],
  "transactionLabels": [
    {"txid": "abc...", "label": "ref:ORD-456", "hops": 0}
  ]
}
```

`customEntities`, `addressLabels`, and `transactionLabels` are populated from your entity store by checking all addresses and txids across all chain hops. They do not affect the privacy score.

**Errors:** 400 (bad input), 404 (tx not found), 502 (mempool API failure)

---

### POST /api/v1/chain-trace

Multi-hop graph analysis without running all 27 heuristics.

**Request:**
```json
{
  "txid": "64-char hex",
  "depth": 6,
  "direction": "both",
  "minSats": 1000
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| txid | string | required | 64-character hex transaction ID |
| depth | number | 6 | Hops to trace (0-20) |
| direction | string | both | backward, forward, or both |
| minSats | number | 1000 | Min sats to follow |

**Response:** Same enrichment fields (`customEntities`, `addressLabels`, `transactionLabels`) plus `backward`, `forward`, `findings`.

---

### GET /api/v1/health

Server status. Always public (no auth required).

```json
{
  "status": "ok",
  "entityFilter": {"status": "ready", "fullLoaded": true},
  "entityStore": {"entities": 369, "addresses": 3680, "addressLabels": 5, "transactionLabels": 2}
}
```

---

## Entity Endpoints

### POST /api/v1/entities

Create an entity. At least one address is required.

```json
{
  "name": "Entity name",
  "category": "service",
  "description": "Optional description",
  "addresses": ["bc1q...", "1A1z..."]
}
```

**Response (201):**
```json
{"id": 1, "name": "Entity name", "category": "service", "addresses": ["bc1q...", "1A1z..."], "addressCount": 2}
```

**Errors:** 400 (missing fields, no addresses, >10,000 addresses), 409 (name exists)

### GET /api/v1/entities

List all entities. Optional `?category=` filter.

### GET /api/v1/entities/:id

Get entity with address count.

### PUT /api/v1/entities/:id

Update entity. Body: any subset of `{name, category, description}`.

### DELETE /api/v1/entities/:id

Delete entity. Cascades: removes all address mappings.

---

## Entity Address Endpoints

### POST /api/v1/entities/:id/addresses

Add addresses to an entity. Max 10,000 per request.

```json
{"addresses": ["bc1q...", "1A1z..."]}
```

An address belongs to one entity. Re-adding to a different entity reassigns it.

### GET /api/v1/entities/:id/addresses

List all addresses for an entity.

### DELETE /api/v1/entities/:id/addresses/:addr

Remove an address from an entity.

---

## Address Label Endpoints

### GET /api/v1/addresses/:addr

Get address info: entity (if mapped) and label (if set).

```json
{"address": "bc1q...", "entity": {"id": 1, "name": "...", "category": "..."}, "label": "some note"}
```

### PUT /api/v1/addresses/:addr/label

Set a freeform label. `{"label": "some note"}`

### DELETE /api/v1/addresses/:addr/label

Remove the label.

---

## Transaction Label Endpoints

### GET /api/v1/transactions/:txid/label

Get label. `{"txid": "abc...", "label": "ref:ORD-456"}`

### PUT /api/v1/transactions/:txid/label

Set label. `{"label": "ref:ORD-456"}`

### DELETE /api/v1/transactions/:txid/label

Remove label.

---

## Lookup Endpoints

### POST /api/v1/lookup/addresses

Batch lookup. Addresses with no data are omitted from results.

```json
{"addresses": ["bc1q...", "1A1z..."]}
```

```json
{"results": {"bc1q...": {"entity": {"id": 1, "name": "...", "category": "..."}, "label": null}}}
```

### POST /api/v1/lookup/transactions

Batch lookup transaction labels.

```json
{"txids": ["abc...", "def..."]}
```

```json
{"results": {"abc...": "ref:ORD-456"}}
```

---

## Entity Import

`--import-entities` reads entity definitions from `src/data/entities.json` (364 entities) and address mappings from CSV files in `.cache/entity-data/` on startup.

For the full 30M address dataset, first download the Maru92 academic dataset:
```bash
node scripts/build-entity-filter.mjs --download
am-i-exposed serve --reimport-entities
```

Import is skipped if entities already exist. Use `--reimport-entities` to force.

---

## Data Model

```
Entity (name, category, description)
  |-- Addresses (one entity per address)

Address Label (freeform text, independent of entity)
Transaction Label (freeform text)
```

- Entities connect to transactions indirectly through addresses
- Input addresses = sender side, output addresses = recipient side
- Labels are freeform annotations, no structure enforced
- Custom entities and labels do not affect privacy scores
- Data stored in `~/.am-i-exposed/entities.sqlite`, separate from the API response cache
