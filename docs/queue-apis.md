# Queue APIs

Reference for every HTTP endpoint related to **process queues** and **Redis tenant queues** in this project.

For how process jobs behave after they run (batch import, sync direction, field meanings), see [process-system.md](./process-system.md).

---

## Base URL and authentication

| Environment          | Base path                               |
| -------------------- | --------------------------------------- |
| Local                | `http://localhost:8000/api`             |
| Production (example) | `https://your-domain.com/pos_admin/api` |

**Authentication**

Most queue endpoints require a **Bearer token** from `POST /api/user/login`:

```http
Authorization: Bearer <token>
```

| Endpoint group                                   | Auth required?                                              |
| ------------------------------------------------ | ----------------------------------------------------------- |
| Process queue create / enqueue / worker / status | Yes                                                         |
| Company queue list / peek / enqueue / clear      | Yes                                                         |
| Integration fetch-product queue                  | Yes                                                         |
| `execute-process`                                | **No** (public route — can be called by cron without token) |

`company_id` is taken from the logged-in user when omitted. You can override it in the request body or query string where noted.

**Content types** (process create endpoints):

- `application/json`
- `application/x-www-form-urlencoded`
- `multipart/form-data`

---

## How the queue works

### Redis key format

Each company has one or more module queues stored as Redis sorted sets (ZSET):

```text
{companyId}:{module}:queue
```

Example: `6a0b716e96e8f4d982b91243:process:queue`

- **Member** = process document `_id` (string)
- **Score** = `priority * 1e13 + enqueuedAt` (lower priority number runs first; ties broken by enqueue time)

### When a job is queued

A process row is enqueued when:

1. Created via `queue-create` / `bulk-create` (except deduplicated `fetch_product`)
2. Created via `queue-enqueue-all`
3. Saved in Admin with `status: active` and `progress` not `completed` / `failed` (mongoose `post("save")` hook)
4. Auto-queued after a POS product edit (internal — see [Auto queue on product edit](#auto-queue-on-product-edit))

A row is **not** queued when `status !== active`, `progress` is `completed` or `failed`, or the row is soft-deleted.

### Environment variables

| Variable                              | Default | Purpose                                                             |
| ------------------------------------- | ------- | ------------------------------------------------------------------- |
| `REDIS_QUEUE_ENABLED`                 | `true`  | Use Redis for queues (falls back to in-memory if Redis unavailable) |
| `REDIS_QUEUE_MEMORY_FALLBACK`         | `true`  | In-process queue when Redis is off                                  |
| `PROCESS_QUEUE_WORKER_ENABLED`        | `true`  | Auto-drain queue after enqueue                                      |
| `PROCESS_QUEUE_WORKER_DEBOUNCE_MS`    | `500`   | Delay before auto-drain starts                                      |
| `PROCESS_QUEUE_WORKER_POLL_MS`        | `10000` | Background poll for pending jobs                                    |
| `PROCESS_QUEUE_WORKER_BATCH_DELAY_MS` | `1000`  | Pause between batches during drain                                  |
| `PROCESS_QUEUE_WORKER_MAX_BATCHES`    | `5000`  | Max batches per manual drain call                                   |

---

## Supported process actions

| Action                             | Direction   | Batch?            | Required fields                 |
| ---------------------------------- | ----------- | ----------------- | ------------------------------- |
| `fetch_product` / `fetch_products` | Store → POS | Yes               | `integration_id`                |
| `fetch_category`                   | Store → POS | Yes               | `integration_id`                |
| `fetch_brand`                      | Store → POS | Yes               | `integration_id`                |
| `fetch_order`                      | Store → POS | Yes               | `integration_id`                |
| `fetch_latest_order`               | Store → POS | Yes               | `integration_id`                |
| `sync_product`                     | POS → Store | No (one product)  | `integration_id`, `product_id`  |
| `sync_category`                    | POS → Store | No (one category) | `integration_id`, `category_id` |
| `sync_brand`                       | POS → Store | No (one brand)    | `integration_id`, `brand_id`    |

**Note:** `fetch_product` reuses one active job per integration. `sync_product`, `sync_category`, and `sync_brand` create **one queue entry per ID** when bulk IDs are passed.

---

## Process queue APIs

### 1. Get queue form schema

Returns field definitions and examples for building queue-create requests.

|            |                           |
| ---------- | ------------------------- |
| **Method** | `GET`                     |
| **Path**   | `/api/process/queue-form` |
| **Auth**   | Yes                       |

**Response `200`**

```json
{
  "success": true,
  "endpoint": "POST /api/process/queue-create",
  "content_types": [
    "application/json",
    "application/x-www-form-urlencoded",
    "multipart/form-data"
  ],
  "form_fields": { "...": "..." },
  "examples": {
    "fetch_category_formdata": {
      "integration_id": "...",
      "action": "fetch_category",
      "limit": 5
    },
    "sync_category_single": {
      "integration_id": "...",
      "action": "sync_category",
      "category_id": "..."
    },
    "sync_category_bulk": {
      "integration_id": "...",
      "action": "sync_category",
      "category_ids": "id1,id2,id3"
    }
  }
}
```

---

### 2. Create process queue records

Creates one or more `process` documents and enqueues each eligible row.

|            |                                                                                                     |
| ---------- | --------------------------------------------------------------------------------------------------- |
| **Method** | `POST`                                                                                              |
| **Paths**  | `/api/process/queue-create` · `/api/process/bulk-create` · `/api/processs/bulk-create` (typo alias) |
| **Auth**   | Yes                                                                                                 |

**Body / form fields**

| Field                          | Required                  | Notes                                                        |
| ------------------------------ | ------------------------- | ------------------------------------------------------------ |
| `action`                       | Yes                       | See [Supported process actions](#supported-process-actions)  |
| `integration_id`               | For fetch/sync            | MongoDB ObjectId                                             |
| `company_id`                   | If not in token           | MongoDB ObjectId                                             |
| `product_id`                   | For single `sync_product` | One product                                                  |
| `product_ids`                  | For bulk `sync_product`   | Comma-separated, JSON array, or repeated field               |
| `category_id` / `category_ids` | For `sync_category`       | Single or bulk                                               |
| `brand_id` / `brand_ids`       | For `sync_brand`          | Single or bulk                                               |
| `items`                        | Optional                  | JSON array of row objects (advanced bulk)                    |
| `priority`                     | No                        | Default `100` (lower = runs first)                           |
| `limit`                        | No                        | Default `1`; batch size for fetch actions                    |
| `page`                         | No                        | Default `1`                                                  |
| `offset`                       | No                        | Default `0`                                                  |
| `status`                       | No                        | Default `active`                                             |
| `remarks`                      | No                        | Log text                                                     |
| `force`                        | No                        | For `fetch_product` only — create new job instead of reusing |

**Single `sync_product` example**

```http
POST /api/process/queue-create
Authorization: Bearer <token>
Content-Type: application/json

{
  "integration_id": "6789abcdef012345678901234",
  "action": "sync_product",
  "product_id": "69150abcdef012345678901234",
  "priority": 50
}
```

**Bulk `sync_product` example**

```json
{
  "integration_id": "6789abcdef012345678901234",
  "action": "sync_product",
  "product_ids": "69150...,69151...,69152...",
  "priority": 50
}
```

**Response**

| Status | Meaning                                       |
| ------ | --------------------------------------------- |
| `201`  | All rows created                              |
| `207`  | Partial success (some rows failed validation) |
| `400`  | Nothing created                               |

```json
{
  "success": true,
  "message": "Created 3 process queue record(s).",
  "data": {
    "created": ["...process documents..."],
    "summary": { "total": 3, "created": 3, "failed": 0 },
    "failed": [],
    "queue_key": "abc123:process",
    "execute_process_url": "/api/process/execute-process"
  }
}
```

For `fetch_product`, the response may say `queue_auto: true` and `queue_reused: true` when an existing active job was refreshed instead of creating a duplicate.

---

### 3. Enqueue all active processes

Adds **every eligible** existing process row to Redis without creating new documents. Useful when rows exist in Admin/DB but were never queued.

|            |                                  |
| ---------- | -------------------------------- |
| **Method** | `GET` or `POST`                  |
| **Path**   | `/api/process/queue-enqueue-all` |
| **Auth**   | Yes                              |

**Query / body parameters**

| Param            | Required        | Description                                  |
| ---------------- | --------------- | -------------------------------------------- |
| `company_id`     | If not in token | Scope to one company                         |
| `action`         | No              | Filter e.g. `sync_product`, `fetch_category` |
| `integration_id` | No              | Filter by integration                        |

**Eligible rows:** `status: active`, `progress` not in `completed` / `failed`, not soft-deleted.

**Example — enqueue all pending sync_product jobs**

```http
POST /api/process/queue-enqueue-all
Authorization: Bearer <token>
Content-Type: application/json

{
  "action": "sync_product"
}
```

**Response `200`**

```json
{
  "success": true,
  "message": "Enqueued 5 process job(s). Call execute-process or run-queue-worker to run.",
  "data": {
    "summary": { "total": 5, "enqueued": 5, "skipped": 0, "failed": 0 },
    "filters": {
      "company_id": "...",
      "action": "sync_product",
      "integration_id": null
    },
    "enqueued": [
      {
        "_id": "...",
        "action": "sync_product",
        "priority": 50,
        "backend": "redis"
      }
    ],
    "skipped": [],
    "failed": [],
    "queue_enabled": true,
    "queue_key": "abc123:process",
    "execute_process_url": "/api/process/execute-process",
    "run_queue_worker_url": "/api/process/run-queue-worker"
  }
}
```

---

### 4. Create fetch_product queue (shortcut)

Creates or reuses one `fetch_product` process for an integration and enqueues it.

|            |                                    |
| ---------- | ---------------------------------- |
| **Method** | `GET` or `POST`                    |
| **Path**   | `/api/process/fetch-product-queue` |
| **Auth**   | Yes                                |

**Parameters**

| Param            | Required        | Default                                         |
| ---------------- | --------------- | ----------------------------------------------- |
| `integration_id` | Yes             | —                                               |
| `company_id`     | If not in token | —                                               |
| `limit`          | No              | `10`                                            |
| `priority`       | No              | `100`                                           |
| `page`           | No              | `1`                                             |
| `offset`         | No              | `0`                                             |
| `remarks`        | No              | Auto text                                       |
| `force`          | No              | `false` — set `true` to always create a new job |

**Example**

```http
POST /api/process/fetch-product-queue
Authorization: Bearer <token>
Content-Type: application/json

{
  "integration_id": "6789abcdef012345678901234",
  "limit": 20,
  "priority": 80
}
```

**Response**

| Status | Meaning                           |
| ------ | --------------------------------- |
| `201`  | New fetch_product job created     |
| `200`  | Existing job reused and refreshed |

---

### 5. Execute one process batch

Runs **one batch** for the next queued job (or a specific process).

|            |                                                                     |
| ---------- | ------------------------------------------------------------------- |
| **Method** | `GET` or `POST`                                                     |
| **Paths**  | `/api/process/execute-process` · `/api/process/execute-process/:id` |
| **Auth**   | No (public — suitable for cron)                                     |

**Query parameters**

| Param         | Description                                 |
| ------------- | ------------------------------------------- |
| `process_id`  | Run a specific process (same as path `:id`) |
| `company_id`  | Scope queue peek to one company             |
| `category_id` | Override category for `sync_category`       |
| `brand_id`    | Override brand for `sync_brand`             |

**Selection order (no explicit `process_id`):**

1. Peek next job from Redis queue `{companyId}:process:queue`
2. Load that process document if still `active` and not completed/failed
3. Otherwise fall back to DB sort: `priority ASC`, `createdAt ASC`

**Response**

| Status | Meaning                                                       |
| ------ | ------------------------------------------------------------- |
| `200`  | Batch ran (check `progress` in body — may still be `started`) |
| `400`  | No active process found                                       |

Call repeatedly until `progress` is `completed` or `failed`.

---

### 6. Run queue worker (drain queue)

Runs multiple `execute-process` batches in a loop until the queue is empty, a job finishes, or `max_batches` is reached.

|            |                                                                       |
| ---------- | --------------------------------------------------------------------- |
| **Method** | `GET` or `POST`                                                       |
| **Paths**  | `/api/process/run-queue-worker` · `/api/process/run-queue-worker/:id` |
| **Auth**   | Yes                                                                   |

**Query parameters**

| Param         | Description                                                               |
| ------------- | ------------------------------------------------------------------------- |
| `company_id`  | Limit to one company                                                      |
| `process_id`  | Drain only one process until completed/failed                             |
| `max_batches` | Override default (env `PROCESS_QUEUE_WORKER_MAX_BATCHES`, default `5000`) |

**Response `200`**

```json
{
  "success": true,
  "message": "Queue worker finished (12 batch(es) run).",
  "data": {
    "status": "done",
    "batches_run": 12,
    "results": [
      {
        "success": true,
        "statusCode": 200,
        "process_id": "...",
        "progress": "started",
        "message": "..."
      }
    ],
    "enabled": true,
    "draining": false,
    "queue_enabled": true
  }
}
```

**Response `409`** — worker already draining.

**Auto worker:** When `PROCESS_QUEUE_WORKER_ENABLED=true`, enqueueing a job schedules an automatic drain after `PROCESS_QUEUE_WORKER_DEBOUNCE_MS`.

---

### 7. Queue worker status

|            |                                    |
| ---------- | ---------------------------------- |
| **Method** | `GET`                              |
| **Path**   | `/api/process/queue-worker-status` |
| **Auth**   | Yes                                |

**Response `200`**

```json
{
  "success": true,
  "data": {
    "enabled": true,
    "draining": false,
    "queue_enabled": true
  }
}
```

---

## Integration queue API

Shortcut to queue a **fetch_product** job from an integration record.

|            |                                                 |
| ---------- | ----------------------------------------------- |
| **Method** | `GET` or `POST`                                 |
| **Path**   | `/api/integration/sync-store-product/:id/queue` |
| **Auth**   | Yes                                             |

`:id` = integration MongoDB ObjectId.

**Query / body (optional)**

| Param      | Description                   |
| ---------- | ----------------------------- |
| `priority` | Queue priority                |
| `limit`    | Products per batch            |
| `page`     | Start page                    |
| `offset`   | Skip cursor                   |
| `remarks`  | Log text                      |
| `force`    | `1` / `true` to force new job |

Same behavior as `/api/process/fetch-product-queue` but resolves `integration_id` from the URL.

**Note:** `GET/POST /api/integration/sync-store-product/:id` (without `/queue`) runs an **immediate** sync, not a queued job.

---

## Company queue management APIs

Low-level Redis queue operations for any module (`process`, etc.).

### 8. List all company queues

|            |                          |
| ---------- | ------------------------ |
| **Method** | `GET`                    |
| **Path**   | `/api/company/queue`     |
| **Auth**   | Yes (company from token) |

**Response `200`**

```json
{
  "success": true,
  "status": 200,
  "message": "Found 1 queue(s) for this company",
  "company_id": "abc123",
  "count": 1,
  "queues": [
    {
      "module": "process",
      "queue_key": "abc123:process",
      "redis_key": "abc123:process:queue",
      "length": 5,
      "pending": [{ "jobId": "...", "score": 10000000000001234 }]
    }
  ],
  "queue_enabled": true,
  "memory_fallback": true
}
```

---

### 9. Peek one module queue

|            |                              |
| ---------- | ---------------------------- |
| **Method** | `GET`                        |
| **Path**   | `/api/company/queue/:module` |
| **Auth**   | Yes                          |

Example: `GET /api/company/queue/process`

**Response `200`**

```json
{
  "success": true,
  "company_id": "abc123",
  "module": "process",
  "queue_key": "abc123:process",
  "length": 5,
  "pending": ["...up to 20 jobs..."],
  "queue_enabled": true
}
```

---

### 10. Enqueue generic job ID

Manually add any job ID to a module queue (advanced — normally use process APIs).

|            |                                      |
| ---------- | ------------------------------------ |
| **Method** | `POST`                               |
| **Path**   | `/api/company/queue/:module/enqueue` |
| **Auth**   | Yes                                  |

**Body**

```json
{
  "job_id": "6789abcdef012345678901234",
  "priority": 100,
  "enqueued_at": 1710000000000
}
```

**Response**

| Status | Meaning                   |
| ------ | ------------------------- |
| `201`  | Job queued                |
| `503`  | Queue storage unavailable |

---

### 11. Clear module queue

Removes all pending jobs from a module queue (does **not** delete process documents in MongoDB).

|            |                              |
| ---------- | ---------------------------- |
| **Method** | `DELETE`                     |
| **Path**   | `/api/company/queue/:module` |
| **Auth**   | Yes                          |

Example: `DELETE /api/company/queue/process`

**Response `200`**

```json
{
  "success": true,
  "message": "Cleared 5 job(s) from abc123:process",
  "company_id": "abc123",
  "module": "process",
  "removed": 5
}
```

---

## Common workflows

### Push many products to the store

```text
1. POST /api/process/queue-create
   { action: "sync_product", integration_id, product_ids: "id1,id2,id3" }

2. POST /api/process/run-queue-worker
   (or call GET /api/process/execute-process repeatedly)
```

### Re-queue existing Admin process rows

```text
1. POST /api/process/queue-enqueue-all
   { action: "sync_product" }   // optional filter

2. POST /api/process/run-queue-worker
```

### Import products from WooCommerce / Shopify

```text
1. POST /api/process/fetch-product-queue
   { integration_id, limit: 20 }

2. GET /api/process/execute-process   (cron or manual, until progress = completed)
```

### Inspect queue before running

```text
1. GET /api/company/queue/process
2. GET /api/process/queue-worker-status
3. POST /api/process/run-queue-worker?max_batches=50
```

---

## Auto queue on product edit

When a POS product is saved in Admin, the server may auto-create `sync_product` jobs via `enqueueProductWebsiteSyncJobs` (internal — no direct HTTP endpoint):

- One job per **active** `sync_product` mapping (`integration_id` + `product_id`)
- Variable products resolve to the **parent** product ID
- Each job is created with `priority: 50` and enqueued automatically

---

## Error reference

| HTTP  | Typical cause                                                                |
| ----- | ---------------------------------------------------------------------------- |
| `400` | Missing `company_id`, invalid `action`, validation failed, no active process |
| `401` | Missing or invalid Bearer token                                              |
| `409` | Queue worker already running                                                 |
| `500` | Server error during enqueue or drain                                         |
| `503` | Redis queue disabled and memory fallback off                                 |

---

## Quick endpoint index

| Method     | Path                                            | Purpose                              |
| ---------- | ----------------------------------------------- | ------------------------------------ |
| `GET`      | `/api/process/queue-form`                       | Form field schema                    |
| `POST`     | `/api/process/queue-create`                     | Create + enqueue process job(s)      |
| `POST`     | `/api/process/bulk-create`                      | Alias of queue-create                |
| `GET/POST` | `/api/process/queue-enqueue-all`                | Enqueue all eligible DB process rows |
| `GET/POST` | `/api/process/fetch-product-queue`              | Create/reuse fetch_product job       |
| `GET/POST` | `/api/process/execute-process`                  | Run one batch (public)               |
| `GET/POST` | `/api/process/execute-process/:id`              | Run one batch for specific process   |
| `GET/POST` | `/api/process/run-queue-worker`                 | Drain queue automatically            |
| `GET/POST` | `/api/process/run-queue-worker/:id`             | Drain one process until done         |
| `GET`      | `/api/process/queue-worker-status`              | Worker enabled / draining state      |
| `GET/POST` | `/api/integration/sync-store-product/:id/queue` | Queue fetch_product for integration  |
| `GET`      | `/api/company/queue`                            | List all module queues for company   |
| `GET`      | `/api/company/queue/:module`                    | Peek pending jobs                    |
| `POST`     | `/api/company/queue/:module/enqueue`            | Enqueue raw job ID                   |
| `DELETE`   | `/api/company/queue/:module`                    | Clear pending jobs                   |

---

## Related docs

- [process-system.md](./process-system.md) — process fields, action behavior, architecture
- [product_sync_wordprss.md](./product_sync_wordprss.md) — WooCommerce `sync_product`
- [sync_product_to_shopify.md](./sync_product_to_shopify.md) — Shopify `sync_product`
- [woocommerce_to_local_product_sync.md](./woocommerce_to_local_product_sync.md) — fetch import
- [shopify_to_local_product_sync.md](./shopify_to_local_product_sync.md) — Shopify fetch import
