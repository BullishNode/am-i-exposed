# HTTP API Server

REST API for programmatic access to the am-i-exposed Bitcoin privacy analysis engine.

## Quick Start

```bash
# Start the server
am-i-exposed serve --port 3001 --api https://mempool.space/api

# With self-hosted mempool (recommended for production)
am-i-exposed serve --port 3001 --api http://your-mempool:8999/api
```

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--port <N>` | 3001 | Port to listen on |
| `--host <addr>` | 127.0.0.1 | Bind address |
| `--api <url>` | mempool.space | Custom mempool API URL |
| `--no-entities` | false | Skip entity filter loading (faster startup) |
| `--no-cache` | false | Disable SQLite response caching |

**CORS:** Enabled for all origins. Methods: GET, POST, DELETE, OPTIONS.

**Max request body:** 10 MB.

---

## Endpoints

### GET /api/v1/health

Server status and diagnostics.

**Response:**
```json
{
  "status": "ok",
  "version": "0.35.6",
  "entityFilter": {
    "status": "ready",
    "fullLoaded": true
  },
  "labelProviders": 3
}
```

---

### POST /api/v1/scan/tx

Analyze a Bitcoin transaction for privacy exposure. Runs 27 heuristics, optional chain tracing up to N hops, and returns entity detection with three-dimension relatedness data.

**Request:**
```json
{
  "txid": "0b6461de422c46a221db99608fcbe0326e4f2325ebf2a47c9faf660ed61ee6a4",
  "network": "mainnet",
  "chainDepth": 6,
  "minSats": 1000,
  "fast": false,
  "apiUrl": "http://your-mempool:8999/api"
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| txid | string | Yes | - | 64-character hex transaction ID |
| network | string | No | "mainnet" | "mainnet", "testnet4", or "signet" |
| chainDepth | number | No | 6 | Hops to trace (0-20). 0 = tx-only analysis |
| minSats | number | No | 1000 | Minimum sats to follow when tracing (filters dust) |
| fast | boolean | No | false | Skip parent tx fetching for faster analysis |
| apiUrl | string | No | - | Override mempool API URL for this request |

**Response:**
```json
{
  "score": 52,
  "grade": "C",
  "txType": "simple-payment",
  "txInfo": {
    "inputs": 1,
    "outputs": 2,
    "fee": 10000,
    "size": 226,
    "weight": 904,
    "confirmed": true,
    "blockHeight": 399996
  },
  "findings": [
    {
      "id": "h2-change-detected",
      "severity": "high",
      "confidence": "high",
      "title": "Change output likely identifiable (medium confidence)",
      "description": "3 sub-heuristics point to a likely change output...",
      "recommendation": "Use wallets with change output randomization...",
      "scoreImpact": -16,
      "params": {
        "signalCount": 3,
        "confidence": "medium",
        "changeIndex": 1
      }
    }
  ],
  "recommendation": {
    "id": "use-coinjoin",
    "urgency": "immediate",
    "headline": "Use CoinJoin to break the on-chain trail"
  },
  "chainAnalysis": {
    "backward": {
      "depth": 6,
      "txsFetched": 47,
      "aborted": false,
      "layers": [
        { "depth": 1, "txCount": 1 },
        { "depth": 2, "txCount": 3 }
      ]
    },
    "forward": {
      "depth": 6,
      "txsFetched": 32,
      "aborted": false,
      "layers": [
        { "depth": 1, "txCount": 2 },
        { "depth": 2, "txCount": 8 }
      ]
    },
    "findings": [
      {
        "id": "chain-entity-proximity-backward",
        "severity": "high",
        "title": "2 hops from Binance (exchange)",
        "scoreImpact": -4
      }
    ]
  },
  "entities": [
    {
      "entityName": "Binance",
      "category": "exchange",
      "address": "bc1q...",
      "txid": "abc123...",
      "direction": "backward",
      "origin": "builtin",
      "hops": 2,
      "taintFraction": 0.42,
      "onPeelChain": true,
      "peelChainConfidence": 0.78,
      "ofac": false,
      "coinJoinBarrier": false,
      "coinJoinBarrierCount": 0
    },
    {
      "entityName": "Bull Bitcoin",
      "category": "internal",
      "address": "bc1q...",
      "txid": "def456...",
      "direction": "forward",
      "origin": "custom",
      "hops": 1,
      "taintFraction": null,
      "onPeelChain": false,
      "peelChainConfidence": null,
      "ofac": false,
      "coinJoinBarrier": false,
      "coinJoinBarrierCount": 0
    }
  ]
}
```

**Notes:**
- `chainAnalysis` is `null` when `chainDepth` is 0
- `entities` is empty `[]` when no chain trace is performed
- Custom labels (origin: "custom") appear in `entities` but do NOT affect `score` or `findings`
- Built-in entity findings appear in both `chainAnalysis.findings` (with score impact) and `entities` (with relatedness data)

**Errors:**

| Status | Condition |
|--------|-----------|
| 400 | Missing txid, invalid format, invalid network |
| 404 | Transaction not found |
| 502 | Upstream mempool API failure |

---

### POST /api/v1/chain-trace

Multi-hop transaction graph analysis with entity detection. Dedicated endpoint for chain tracing without running all 27 heuristics.

**Request:**
```json
{
  "txid": "0b6461de422c46a221db99608fcbe0326e4f2325ebf2a47c9faf660ed61ee6a4",
  "depth": 6,
  "direction": "both",
  "minSats": 1000
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| txid | string | Yes | - | 64-character hex transaction ID |
| network | string | No | "mainnet" | "mainnet", "testnet4", or "signet" |
| depth | number | No | 6 | Hops to trace (0-20) |
| direction | string | No | "both" | "backward", "forward", or "both" |
| minSats | number | No | 1000 | Minimum sats to follow |
| apiUrl | string | No | - | Override mempool API URL |

**Response:**
```json
{
  "backward": {
    "depth": 6,
    "txsFetched": 47,
    "aborted": false,
    "layers": [
      { "depth": 1, "txCount": 5 },
      { "depth": 2, "txCount": 18 }
    ]
  },
  "forward": {
    "depth": 6,
    "txsFetched": 32,
    "aborted": false,
    "layers": [
      { "depth": 1, "txCount": 5 },
      { "depth": 2, "txCount": 12 }
    ]
  },
  "findings": [],
  "entities": []
}
```

**Notes:**
- `backward` or `forward` is `null` when not requested via `direction`
- Entity proximity and taint analysis run automatically on the traced layers

**Errors:** Same as scan-tx, plus 400 for invalid `direction`.

---

### POST /api/v1/labels

Add one or more custom labels. Labels associate Bitcoin addresses with entity names and free-form categories.

**Single label:**
```json
{
  "address": "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh",
  "entityName": "Bull Bitcoin",
  "category": "internal",
  "source": "api"
}
```

**Batch:**
```json
{
  "labels": [
    { "address": "bc1q...", "entityName": "Bull Bitcoin", "category": "internal" },
    { "address": "1A1z...", "entityName": "Flagged Wallet", "category": "scam" }
  ]
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| address | string | Yes | - | Bitcoin address |
| entityName | string | Yes | - | Entity or label name |
| category | string | Yes | - | Free-form category (e.g., "exchange", "scam", "internal", "user") |
| source | string | No | "api" | Source attribution |

**Response:**
```json
{
  "added": 2
}
```

**Notes:**
- Duplicate addresses are overwritten (upsert via `INSERT OR REPLACE`)
- Categories are free-form strings - use any value
- In batch mode, invalid entries (missing required fields) are silently skipped; `added` reflects only valid entries

**Errors:**

| Status | Condition |
|--------|-----------|
| 400 | Missing required fields or no valid labels in batch |

---

### POST /api/v1/labels/import

Bulk import labels from CSV text.

**Request:** Raw CSV body (Content-Type: text/csv or text/plain)

```
address,entity_name,category
bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh,Bull Bitcoin,internal
1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa,Satoshi,historical
bc1qflagged123,Suspicious Wallet,flagged
```

**CSV format:**
- Header row is auto-detected (if first line contains "address") and skipped
- 3 columns: `address,entity_name,category`
- 2 columns: `address,entity_name` (category defaults to "custom")
- Address must start with `1`, `3`, `bc1`, or `tb1` and be at least 26 characters
- Empty entity names or categories are rejected
- Windows line endings (\r\n) are handled

**Response:**
```json
{
  "imported": 3,
  "errors": 0
}
```

---

### GET /api/v1/labels/check/:address

Check a single address against all label providers (built-in entities + OFAC + custom labels).

**Example:** `GET /api/v1/labels/check/bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh`

**Response:**
```json
{
  "labels": [
    {
      "address": "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh",
      "entityName": "Bull Bitcoin",
      "category": "internal",
      "source": "api",
      "origin": "custom",
      "ofac": false
    }
  ]
}
```

**Notes:**
- Returns labels from ALL providers. An address can have multiple labels (e.g., both built-in entity filter match and custom label)
- `origin: "builtin"` = from compiled entity data (364+ entities, 31M addresses)
- `origin: "custom"` = from runtime custom labels (SQLite)
- Empty `labels: []` when no match found

---

### POST /api/v1/labels/check

Batch check multiple addresses.

**Request:**
```json
{
  "addresses": [
    "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh",
    "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
    "bc1qunknown"
  ]
}
```

**Response:**
```json
{
  "results": {
    "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh": [
      {
        "address": "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh",
        "entityName": "Bull Bitcoin",
        "category": "internal",
        "source": "api",
        "origin": "custom",
        "ofac": false
      }
    ]
  }
}
```

**Notes:** Addresses with no matches are omitted from the results object.

---

### DELETE /api/v1/labels/:address

Remove a custom label.

**Example:** `DELETE /api/v1/labels/bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh`

**Response:**
```json
{
  "deleted": true
}
```

**Notes:** Returns `"deleted": false` if the address had no custom label. Only removes custom labels - built-in entity data cannot be deleted.

---

### GET /api/v1/labels/stats

Custom label store statistics.

**Response:**
```json
{
  "count": 1542,
  "categories": ["exchange", "flagged", "internal", "scam", "user"]
}
```

---

## Type Reference

### Finding

Privacy analysis finding from one of 27 transaction heuristics or 6 chain analysis modules.

```typescript
{
  id: string;                   // e.g., "h2-change-detected", "chain-entity-proximity-backward"
  severity: "critical" | "high" | "medium" | "low" | "good";
  confidence?: "deterministic" | "high" | "medium" | "low";
  title: string;
  description: string;
  recommendation: string;
  scoreImpact: number;          // Negative = worse privacy, positive = better
  params?: {                    // Heuristic-specific data
    [key: string]: string | number
  };
  remediation?: {
    steps: string[];
    tools?: { name: string; url: string }[];
    urgency: "immediate" | "soon" | "when-convenient";
  };
}
```

### EntityReport

Entity detected in the transaction's chain trace, enriched with three relatedness dimensions.

```typescript
{
  entityName: string;           // "Binance", "Bull Bitcoin", etc.
  category: string;             // "exchange", "internal", "scam", etc.
  address: string;              // The matched Bitcoin address
  txid: string;                 // Transaction where the entity was found
  direction: "backward" | "forward";
  origin: "builtin" | "custom"; // Source of the label

  // Dimension 1: Graph topology
  hops: number;                 // Distance from the analyzed transaction

  // Dimension 2: Value flow (backward direction only)
  taintFraction: number | null; // 0-1: what fraction of the analyzed tx's
                                // input value traces through this entity.
                                // null for forward entities.

  // Dimension 3: Peel chain confidence
  onPeelChain: boolean;         // Is this entity on the detected change output path?
  peelChainConfidence: number | null; // Compound Boltzmann probability at this hop.
                                     // null if not on peel chain.

  // Risk signals
  ofac: boolean;                // OFAC/sanctions flag
  coinJoinBarrier: boolean;     // CoinJoin rounds exist between root tx and entity
  coinJoinBarrierCount: number; // How many CoinJoin rounds
}
```

**Relatedness dimensions explained:**

| Dimension | Question | Source | Range |
|-----------|----------|--------|-------|
| `hops` | How far away? | Transaction graph traversal | 1-20 |
| `taintFraction` | How much money? | Proportional value flow (haircut method) | 0.0-1.0 |
| `peelChainConfidence` | How sure is the link? | Compound Boltzmann probability | 0.0-1.0 |

### Grade Scale

| Grade | Score | Interpretation |
|-------|-------|----------------|
| A+ | 90-100 | Excellent privacy practices |
| B | 75-89 | Good, minor issues |
| C | 50-74 | Fair, notable concerns |
| D | 25-49 | Poor, significant exposure |
| F | 0-24 | Critical privacy failures |

### Transaction Types

| Type | Description |
|------|-------------|
| `whirlpool-coinjoin` | Samourai Whirlpool CoinJoin |
| `wabisabi-coinjoin` | Wasabi WabiSabi CoinJoin |
| `joinmarket-coinjoin` | JoinMarket CoinJoin |
| `generic-coinjoin` | Unclassified CoinJoin |
| `stonewall` | Samourai Stonewall |
| `tx0-premix` | Whirlpool premix transaction |
| `bip47-notification` | BIP47 notification transaction |
| `ricochet` | Samourai Ricochet |
| `consolidation` | Multi-input, single-output |
| `exchange-withdrawal` | Exchange batch withdrawal pattern |
| `batch-payment` | Fan-out payment |
| `peel-chain` | Sequential single-output spends |
| `coinbase` | Mining reward |
| `simple-payment` | Standard payment |
| `unknown` | Unclassified |

---

## Custom Labels

Custom labels are **report-only** - they appear in the `entities` array of scan and chain-trace responses but do **not** affect the privacy `score` or generate `findings`. This design ensures:

1. The privacy score remains objective (driven by built-in entity data and heuristic analysis)
2. Custom labels provide visibility for your own business logic
3. Your backend can apply its own rules based on the `entities` array

**Categories** are free-form strings. Use whatever makes sense for your use case:
- `"exchange"` - known exchange addresses
- `"internal"` - your own wallet addresses
- `"scam"` - flagged/suspicious addresses
- `"user"` - customer addresses
- `"flagged"` - addresses under investigation

**Provider precedence:** When an address matches both a built-in entity and a custom label, both labels are returned. The `origin` field distinguishes them. In the `entities` array (which deduplicates by address), built-in labels take precedence (registered first).

**Persistence:** Custom labels are stored in `~/.am-i-exposed/labels.sqlite` and persist across server restarts.
