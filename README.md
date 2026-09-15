# SpendSync

**Automated corporate card spend → double-entry ledger → Odoo ERP sync pipeline.**

SpendSync receives real-time card transaction webhooks, creates auditable double-entry journal entries in a local PostgreSQL ledger with category and departmental cost-center mapping, and asynchronously syncs them to an Odoo 17 ERP system via BullMQ job queues — with built-in exponential retry logic, dead letter queue (DLQ) alerting, an admin operations API, and a secured Bull Board monitoring dashboard.

---

## Architecture

```
                         ┌──────────────────────────┐
                         │   Card Provider Webhook  │
                         │   (HMAC SHA-256 signed)  │
                         └────────────┬─────────────┘
                                      │ POST /api/v1/webhooks/transactions
                                      ▼
                         ┌──────────────────────────┐
                         │   WebhooksController     │
                         │   ↳ HmacGuard (timestamp │
                         │     & replay prevention) │
                         └────────────┬─────────────┘
                                      │ Idempotent INSERT
                                      ▼
┌─────────────────────────┐     ┌──────────────────────────┐
│       PostgreSQL        │     │   webhook_events (PG)    │
│                         │◄────│   Immutable audit log    │
│  ┌────────────────────┐ │     └────────────┬─────────────┘
│  │ journal_entries    │ │                  │ BullMQ dispatch
│  ├────────────────────┤ │                  ▼
│  │ category_gl_       │ │     ┌──────────────────────────┐
│  │ mapping            │ │     │   transaction-ledger     │
│  ├────────────────────┤ │     │   Queue (Redis)          │
│  │ cost_center_       │ │     └────────────┬─────────────┘
│  │ analytic_mapping   │ │                  │
│  ├────────────────────┤ │                  ▼
│  │ odoo_sync_status   │ │     ┌──────────────────────────┐
│  └────────────────────┘ │     │   LedgerProcessor        │
└─────────────────────────┘     │   ↳ Double-entry booking │
                                │   ↳ Category → GL map    │
                                │   ↳ Cost Center → Analytic│
                                │   ↳ Pessimistic locking  │
                                └────────────┬─────────────┘
                                             │ BullMQ dispatch
                                             ▼
                                ┌──────────────────────────┐
                                │   odoo-sync Queue        │
                                │   (3 retries, exp backoff│
                                └────────────┬─────────────┘
                                             │
                                             ▼
                                ┌──────────────────────────┐
                                │   OdooSyncProcessor      │
                                │   ↳ XML-RPC → Odoo 17    │
                                │   ↳ Creates account.move │
                                │   ↳ Analytic distribution│
                                └────────────┬─────────────┘
                                             │ On exhaustion
                                             ▼
                                ┌──────────────────────────┐
                                │   odoo-sync-dlq Queue    │
                                │   ↳ Slack/log alerting   │
                                └──────────────────────────┘
```

### Key Design Decisions

| Concern | Approach |
|---|---|
| **Idempotency** | Database `UNIQUE` constraint on `source_event_id` + deterministic BullMQ `jobId` deduplication |
| **Double-Entry Ledger** | Every card event creates balanced debit and credit journal lines (expenses vs. card clearing) |
| **Concurrency Control** | `SELECT ... FOR UPDATE` pessimistic locking on webhook events prevents race conditions |
| **GL Account Mapping** | Configurable `category_gl_mapping` table maps transaction categories to GL expense accounts (with fallback) |
| **Cost Centers & Analytics** | Configurable `cost_center_analytic_mapping` links departments to Odoo 17 analytical accounts (`analytic_distribution`) |
| **Retry & DLQ Pipeline** | 3 attempts with exponential backoff (2s base) $\rightarrow$ DLQ queue + formatted Slack alert |
| **Security & Anti-Replay** | HMAC SHA-256 signature verification over `timestamp.payload` with a strict 300-second tolerance window |
| **Observability** | Request correlation IDs (`x-correlation-id`), structured logging, Terminus health checks, and secured Bull Board dashboard |

---

## Tech Stack

| Layer | Technology |
|---|---|
| **Runtime & Language** | Node.js (≥ 20) · TypeScript (5.7) |
| **Framework** | NestJS 11 (Express platform) |
| **Database** | PostgreSQL 16 (`pg` connection pool) |
| **Job Queue & Cache** | BullMQ 6 · Redis 7 (`ioredis`) |
| **ERP Integration** | Odoo 17 (XML-RPC protocol) |
| **Validation** | `class-validator` · `class-transformer` |
| **Queue Dashboard** | `@bull-board/nestjs` · `@bull-board/express` · `@bull-board/api` |
| **Health Checks** | `@nestjs/terminus` (PostgreSQL ping + Redis ping) |
| **Testing** | Jest 30 · Supertest 7 · ts-jest |

---

## Prerequisites

- **Node.js** ≥ 20.x
- **Docker** & **Docker Compose**
- **npm** ≥ 10.x

---

## Getting Started

### 1. Clone & Install

```bash
git clone <repository-url>
cd spendsync
npm install
```

### 2. Start Infrastructure

Spin up PostgreSQL, Redis, and Odoo with Docker Compose:

```bash
docker compose up -d
```

This launches the following containers:

| Service | Container Name | Port | Description |
|---|---|---|---|
| **PostgreSQL 16** | `spendsync-postgres` | `5432` | Application ledger & audit tables |
| **Redis 7** | `spendsync-redis` | `6379` | BullMQ queue broker |
| **PostgreSQL 15** | `odoo-postgres` | *(internal)* | Dedicated database for Odoo ERP |
| **Odoo 17** | `spendsync-odoo` | `8069` | Odoo 17 ERP web interface & XML-RPC |

> [!NOTE]
> Database migrations in `migrations/001_initial_schema.sql` and `migrations/002_add_cost_centers_and_analytical_accounts.sql` execute automatically upon first database initialization via Docker's `/docker-entrypoint-initdb.d` mount.

### 3. Configure Environment

Copy the example configuration file:

```bash
cp .env.example .env
```

Ensure your `.env` contains:

```env
# Server
PORT=3000
NODE_ENV=development

# Local Ledger Database (PostgreSQL)
DATABASE_URL=postgresql://postgres:postgrespassword@localhost:5432/spendsync

# BullMQ / Redis
REDIS_HOST=localhost
REDIS_PORT=6379

# Webhook Security
WEBHOOK_SECRET=whsec_your_secret_key_here

# Odoo ERP Configuration
ODOO_HOST=localhost
ODOO_PORT=8069
ODOO_DB=spendsync_odoo
ODOO_USERNAME=admin
ODOO_PASSWORD=admin
CARD_CLEARING_ACCOUNT=210000

# Admin Operations API & Bull Board
ADMIN_API_KEY=your_admin_api_key_here

# Notifications (optional)
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/T.../B.../xxx
```

> [!IMPORTANT]
> The application validates all required environment variables at boot using `class-validator` (`validateEnv`). If any required variable is missing or malformed, startup terminates immediately with clear validation errors.

### 4. Configure Odoo 17

1. Navigate to `http://localhost:8069` in your browser.
2. Complete the setup wizard and create a database named `spendsync_odoo` with credentials matching your `.env` (`admin`/`admin`).
3. Install the **Accounting** (or Invoicing) module from the Apps menu.
4. Enable **Analytic Accounting** under *Accounting → Configuration → Settings*.
5. Verify the Chart of Accounts contains the GL codes referenced in mappings:
   - `600100` (IT & Software)
   - `600200` (Travel & Lodging)
   - `600300` (Meals & Entertainment)
   - `600400` (Bank Fees)
   - `600999` (Unallocated Fallback Expense)
   - `210000` (Corporate Card Clearing Account)
6. Verify or create Analytic Accounts matching the seeded department codes:
   - `1010` (Engineering)
   - `1020` (Marketing)
   - `1030` (Sales)
   - `1040` (Operations)
   - `1050` (Finance)

### 5. Run the Application

```bash
# Development (watch mode)
npm run start:dev

# Production build and run
npm run build
npm run start:prod
```

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `3000` | HTTP application port |
| `NODE_ENV` | No | `development` | Environment (`development`, `production`, `test`) |
| `DATABASE_URL` | **Yes** | — | PostgreSQL connection URI |
| `REDIS_HOST` | **Yes** | — | Redis hostname for BullMQ queues |
| `REDIS_PORT` | No | `6379` | Redis port number |
| `WEBHOOK_SECRET` | **Yes** | — | HMAC SHA-256 secret for webhook payload verification |
| `ODOO_HOST` | **Yes** | — | Odoo ERP hostname |
| `ODOO_PORT` | No | `8069` | Odoo XML-RPC port |
| `ODOO_DB` | **Yes** | — | Odoo database name |
| `ODOO_USERNAME` | **Yes** | — | Odoo XML-RPC username |
| `ODOO_PASSWORD` | **Yes** | — | Odoo XML-RPC password |
| `CARD_CLEARING_ACCOUNT` | No | `210000` | GL account code for card clearing liability |
| `ADMIN_API_KEY` | **Yes** | — | Secret token for Admin API endpoints and Bull Board |
| `SLACK_WEBHOOK_URL` | No | — | Slack incoming webhook URL for DLQ failure alerts |

---

## API Reference

### Webhook Ingestion

Ingests card transaction events from card providers (e.g., Swypex).

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/v1/webhooks/transactions` | HMAC SHA-256 | Ingest, verify, and enqueue transaction webhook |

#### Required Headers

- `x-signature` — Hex-encoded HMAC SHA-256 signature calculated over `${timestamp}.${rawBody}` using `WEBHOOK_SECRET`.
- `x-timestamp` — Current Unix timestamp in seconds (must be within $\pm 300$ seconds of server time).
- `Content-Type` — `application/json`

#### HMAC Signature Generation

```javascript
const crypto = require('crypto');

const timestamp = Math.floor(Date.now() / 1000).toString();
const payload = JSON.stringify({ ... });
const signature = crypto
  .createHmac('sha256', process.env.WEBHOOK_SECRET)
  .update(`${timestamp}.${payload}`)
  .digest('hex');
```

#### Request Body Example

```json
{
  "event_id": "evt_card_987654321",
  "event_type": "purchase",
  "data": {
    "transaction_id": "txn_001_aws_monthly",
    "amount": 250.00,
    "currency": "USD",
    "merchant": "Amazon Web Services",
    "category": "software",
    "card_last4": "4242",
    "department": "engineering",
    "cost_center": "engineering"
  }
}
```

*Supported `event_type` values:*
- `purchase` — Standard corporate expense (Debit Expense, Credit Clearing).
- `refund` — Merchant refund (Debit Clearing, Credit Expense).
- `fee` — Card or foreign exchange fee (Debit Bank Fees, Credit Clearing).

*Department / Cost Center resolution:*
- The system checks `cost_center` first, falling back to `department`.
- If mapped in `cost_center_analytic_mapping`, the analytical code is assigned and forwarded to Odoo.

#### Responses

- `202 Accepted` — Event accepted and dispatched to ledger queue:
  ```json
  {
    "status": "enqueued",
    "event_id": "evt_card_987654321"
  }
  ```
- `401 Unauthorized` — Missing signature, invalid HMAC digest, or expired timestamp.
- `409 Conflict` — Duplicate `event_id` (already ingested).

---

### Admin Operations API

All admin endpoints require authentication via the `x-api-key` header matching `ADMIN_API_KEY`.

```bash
# Example header
x-api-key: your_admin_api_key_here
```

#### 1. System Statistics & Monitoring

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/admin/stats` | Aggregate sync metrics (synced, pending, failed/exhausted, total) |

**Sample Response:**
```json
{
  "synced": 420,
  "pending": 2,
  "failed": 1,
  "total": 423
}
```

---

#### 2. Sync History & Failure Management

| Method | Path | Query / Body | Description |
|---|---|---|---|
| `GET` | `/api/v1/admin/sync-history` | `?limit=50` | List recently synced journal entries with Odoo move IDs |
| `GET` | `/api/v1/admin/sync-failures` | `?limit=50` | List failed and exhausted sync jobs with error stack traces |
| `POST` | `/api/v1/admin/sync-failures/:journalId/retry` | `{ "new_debit_account": "600100", "new_analytic_account": "1010" }` | Re-queue a specific failed job with optional account/analytic code overrides |
| `POST` | `/api/v1/admin/sync-failures/retry-all` | — | Bulk re-queue all failed and exhausted sync jobs |

**Single Retry Request Body (Optional Overrides):**
```json
{
  "new_debit_account": "600100",
  "new_analytic_account": "1010"
}
```

**Bulk Retry Response:**
```json
{
  "message": "Successfully re-queued 3 sync jobs",
  "count": 3,
  "journalIds": [
    "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "b2c3d4e5-f6a7-8901-bcde-f12345678901"
  ]
}
```

---

#### 3. Category → GL Account Mappings

Maps spend categories from transaction payloads to general ledger expense accounts.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/admin/mappings` | List all category GL mappings |
| `POST` | `/api/v1/admin/mappings` | Create a new category GL mapping |
| `PUT` | `/api/v1/admin/mappings/:category` | Update an existing category mapping |
| `DELETE` | `/api/v1/admin/mappings/:category` | Delete a category mapping (`204 No Content`) |

**Create Mapping Payload:**
```json
{
  "category": "advertising",
  "expense_account": "600500",
  "description": "Digital Marketing & Advertising"
}
```

---

#### 4. Cost Center → Analytical Account Mappings

Maps corporate departments/cost centers to Odoo 17 analytical accounts.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/admin/cost-centers` | List all cost center mappings |
| `POST` | `/api/v1/admin/cost-centers` | Create a new cost center mapping |
| `PUT` | `/api/v1/admin/cost-centers/:costCenter` | Update an existing cost center mapping |
| `DELETE` | `/api/v1/admin/cost-centers/:costCenter` | Delete a cost center mapping (`204 No Content`) |

**Create Cost Center Mapping Payload:**
```json
{
  "cost_center": "data_science",
  "analytic_account_code": "1060",
  "description": "Data Science & AI Infrastructure"
}
```

---

### Health Check

Terminus-backed health check verifying active connectivity to both PostgreSQL and Redis.

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/health` | None | Returns health check status of database and Redis |

**Sample Response (`200 OK`):**
```json
{
  "status": "ok",
  "info": {
    "database": { "status": "up" },
    "redis": { "status": "up" }
  },
  "error": {},
  "details": {
    "database": { "status": "up" },
    "redis": { "status": "up" }
  }
}
```

---

### Bull Board Queue Dashboard

Bull Board provides a visual dashboard for monitoring queues, inspecting jobs, viewing failure backtraces, and triggering retries manually.

| Path | Auth | Description |
|---|---|---|
| `/admin/queues` | Basic Auth (`admin`:`ADMIN_API_KEY`) or `x-api-key` header | BullMQ monitoring UI |

> [!TIP]
> When accessing `/admin/queues` from a browser, a standard HTTP Basic Authentication prompt will appear. Use username `admin` (or any username) and your configured `ADMIN_API_KEY` as the password. API clients can pass the `x-api-key` header directly.

---

## Database Schema & Accounting Model

```mermaid
erDiagram
    webhook_events ||--o{ journal_entries : "generates"
    category_gl_mapping ||--o{ journal_entries : "categorizes"
    cost_center_analytic_mapping ||--o{ journal_entries : "allocates"
    journal_entries ||--|| odoo_sync_status : "tracked by"

    webhook_events {
        uuid id PK
        string source_event_id UK
        string event_type
        jsonb payload
        timestamptz received_at
        string status
        string error_message
    }

    category_gl_mapping {
        string category PK
        string expense_account
        string description
    }

    cost_center_analytic_mapping {
        string cost_center PK
        string analytic_account_code
        string description
    }

    journal_entries {
        uuid id PK
        uuid webhook_event_id FK
        string transaction_type
        numeric amount
        varchar currency
        string debit_account
        string credit_account
        varchar card_last4
        string merchant_name
        string cost_center
        string analytic_account_code
        timestamptz created_at
    }

    odoo_sync_status {
        uuid journal_entry_id PK,FK
        int odoo_move_id
        string status
        int attempts
        string last_error
        timestamptz last_attempt_at
        timestamptz synced_at
    }
```

### Double-Entry Accounting Matrix

Every card transaction books balanced debit and credit entries:

| Transaction Type | Debit Leg | Credit Leg | Analytic Distribution |
|---|---|---|---|
| `purchase` | Mapped Expense Account (e.g. `600100` or fallback `600999`) | Card Clearing Account (`210000`) | Assigned to Debit line (`{ [analytic_id]: 100 }`) |
| `refund` | Card Clearing Account (`210000`) | Mapped Expense Account (e.g. `600100`) | Assigned to Credit line |
| `fee` | Bank Fees Account (`600400`) | Card Clearing Account (`210000`) | Assigned to Debit line if cost center present |

---

## Job Queues & Resiliency

SpendSync splits the processing pipeline into asynchronous BullMQ job queues:

```
[Inbound Webhook] 
        │
        ▼ (Queue: transaction-ledger)
[LedgerProcessor] 
        │
        ├── PostgreSQL Transaction BEGIN
        ├── Pessimistic Lock (SELECT ... FOR UPDATE)
        ├── Resolve GL & Cost Center Mappings
        ├── Insert balanced journal_entries
        ├── Insert odoo_sync_status (status: 'pending')
        └── COMMIT
        │
        ▼ (Queue: odoo-sync)
[OdooSyncProcessor]
        │
        ├── Resolve Odoo account IDs via XML-RPC
        ├── Resolve Odoo analytic account ID
        ├── Create Odoo account.move with analytic_distribution
        └── Update odoo_sync_status (status: 'synced', odoo_move_id)
        │
        ▼ (On 3 Failed Retries: Exponential Backoff)
[Dead Letter Queue: odoo-sync-dlq]
        │
        ├── Update odoo_sync_status (status: 'exhausted')
        └── Send Slack Alert via NotificationsService
```

### Resiliency Policies

- **Retries:** The `odoo-sync` queue retries up to 3 times with exponential backoff (`delay: 2000ms`, backoff doubling: 2s $\rightarrow$ 4s $\rightarrow$ 8s).
- **Dead Letter Queue (DLQ):** When all attempts fail, the worker catches the failure, marks status as `exhausted` in PostgreSQL, adds the job to `odoo-sync-dlq`, and dispatches a Slack alert with the error message and journal ID.
- **Operations Intervention:** Ops teams can inspect `/api/v1/admin/sync-failures`, fix missing accounts or Odoo connectivity, and trigger `/api/v1/admin/sync-failures/:journalId/retry` (or `retry-all`).

---

## Project Structure

```
spendsync/
├── docker-compose.yml              # PostgreSQL 16, Redis 7, Odoo 17, Odoo PG 15 infrastructure
├── migrations/
│   ├── 001_initial_schema.sql      # Core ledger schema, constraints, seed categories
│   └── 002_add_cost_centers_and_analytical_accounts.sql # Cost centers & analytical accounts schema
├── src/
│   ├── main.ts                     # NestJS bootstrap, shutdown hooks, global pipes & filters
│   ├── app.module.ts               # Root module (BullMQ, Bull Board, Config, Providers)
│   ├── app.controller.ts           # Root controller
│   ├── app.service.ts              # Root service
│   ├── all-exceptions.filter.ts    # Re-export for global exception sanitization
│   ├── common/
│   │   ├── filters/
│   │   │   ├── all-exceptions.filter.ts       # Production-safe 500 error sanitization
│   │   │   └── all-exceptions.filter.spec.ts
│   │   ├── guards/
│   │   │   ├── hmac.guard.ts                  # HMAC SHA-256 webhook guard & anti-replay
│   │   │   ├── hmac.guard.spec.ts
│   │   │   ├── admin-api-key.guard.ts         # Admin API key authentication guard
│   │   │   └── admin-api-key.guard.spec.ts
│   │   └── middleware/
│   │       ├── request-logger.middleware.ts   # Correlation ID & structured logging
│   │       ├── request-logger.middleware.spec.ts
│   │       └── bull-board-auth.middleware.ts  # Timing-safe Basic Auth & API key guard for Bull Board
│   ├── config/
│   │   ├── env.validation.ts                  # Environment variable schema & validation
│   │   └── env.validation.spec.ts
│   └── modules/
│       ├── admin/                  # Admin Operations API
│       │   ├── admin.controller.ts            # Stats, sync failures, retries, mapping CRUD
│       │   ├── admin.controller.spec.ts
│       │   └── dto/
│       │       ├── category-mapping.dto.ts
│       │       └── cost-center-mapping.dto.ts
│       ├── database/               # PostgreSQL Database Connection
│       │   ├── database.module.ts
│       │   └── database.service.ts
│       ├── health/                 # Health Check Endpoint
│       │   ├── health.controller.ts           # Terminus health checks (PostgreSQL + Redis)
│       │   ├── health.controller.spec.ts
│       │   └── health.module.ts
│       ├── ledger/                 # Double-Entry Ledger Worker
│       │   ├── ledger.processor.ts            # BullMQ worker: books debit/credit & mappings
│       │   └── ledger.processor.spec.ts
│       ├── notifications/          # Alerts & Notifications
│       │   ├── notifications.service.ts       # Slack webhook alert dispatcher
│       │   └── notifications.service.spec.ts
│       ├── odoo/                   # Odoo ERP Integration
│       │   ├── odoo.client.ts                 # XML-RPC client for account & analytic queries
│       │   ├── odoo-sync.processor.ts         # BullMQ worker: posts account.move to Odoo 17
│       │   └── odoo-sync.processor.spec.ts
│       └── webhooks/               # Webhook Ingestion Layer
│           ├── webhooks.controller.ts         # Ingestion endpoint with HMAC guard
│           ├── webhooks.service.ts            # Webhook storage & queue dispatch
│           ├── webhooks.service.spec.ts
│           └── dto/
│               └── card-transaction-webhook.dto.ts
├── test/
│   ├── app.e2e-spec.ts             # Application boot & health endpoint E2E
│   ├── webhooks.e2e-spec.ts        # Webhook ingestion, HMAC verification & replay tests E2E
│   ├── admin.e2e-spec.ts           # Admin stats, CRUD operations & retry flow E2E
│   ├── full-pipeline.e2e-spec.ts   # Full async pipeline E2E (Webhook → Ledger → Sync status)
│   ├── helpers/
│   │   └── test-helpers.ts         # Test app bootstrap, HMAC generator & cleanup utilities
│   └── jest-e2e.json               # E2E test configuration
├── package.json
└── tsconfig.json
```

---

## Testing

SpendSync features automated unit tests and end-to-end (E2E) integration test suites.

```bash
# Run all unit tests
npm test

# Run tests in watch mode
npm run test:watch

# Generate test coverage report
npm run test:cov

# Run all end-to-end (E2E) integration suites
npm run test:e2e
```

### Test Coverage Overview

#### Unit Test Suites (12 Suites)

| Module / Component | Spec File | Coverage Highlights |
|---|---|---|
| `LedgerProcessor` | `ledger.processor.spec.ts` | Balanced debit/credit accounting for purchase, refund, fee; GL fallback account; department cost-center resolution; pessimistic lock conflict handling; transaction rollback |
| `OdooSyncProcessor` | `odoo-sync.processor.spec.ts` | Odoo XML-RPC account ID lookup; analytic distribution assembly; successful `account.move` creation; retry on failure; DLQ routing on exhaustion |
| `WebhooksService` | `webhooks.service.spec.ts` | Idempotent event insertion; duplicate rejection; BullMQ job dispatch with correlation ID |
| `AdminController` | `admin.controller.spec.ts` | Stats aggregation; sync history; failure listings; retry job dispatch; category GL CRUD; cost-center CRUD; parameter overrides |
| `HmacGuard` | `hmac.guard.spec.ts` | Missing headers; expired timestamps; future timestamp boundary; tampered payloads; valid signature acceptance |
| `AdminApiKeyGuard` | `admin-api-key.guard.spec.ts` | Rejection of missing/invalid API key; acceptance of valid `x-api-key` header |
| `NotificationsService` | `notifications.service.spec.ts` | DLQ alert formatting; Slack HTTP webhook dispatch; error handling when Slack webhook is unconfigured |
| `HealthController` | `health.controller.spec.ts` | Database ping success/failure; Redis client ping check |
| `RequestLoggerMiddleware`| `request-logger.middleware.spec.ts` | Correlation ID generation; header pass-through; structured request logging |
| `AllExceptionsFilter` | `all-exceptions.filter.spec.ts` | HTTP exception status preservation; 500 error sanitization in production |
| `EnvValidation` | `env.validation.spec.ts` | Missing required environment variables rejection; defaults assignment; valid configuration acceptance |
| `AppController` | `app.controller.spec.ts` | Root greeting endpoint verification |

#### End-to-End (E2E) Integration Suites

| Suite | File | What It Verifies |
|---|---|---|
| **Webhooks Ingestion** | `webhooks.e2e-spec.ts` | Live HTTP ingestion: valid HMAC acceptance, tampered body rejection, expired/future timestamp tolerance, missing headers, schema validation, and database deduplication |
| **Admin Operations** | `admin.e2e-spec.ts` | Security guards (`x-api-key`), sync stats aggregation, Category GL mapping CRUD lifecycle, Cost Center mapping CRUD lifecycle, failure listing, bulk retry-all, and Bull Board authentication |
| **Full Async Pipeline** | `full-pipeline.e2e-spec.ts` | Real asynchronous pipeline: HTTP POST Webhook $\rightarrow$ PG `webhook_events` $\rightarrow$ BullMQ `transaction-ledger` $\rightarrow$ `LedgerProcessor` $\rightarrow$ balanced `journal_entries` $\rightarrow$ `odoo_sync_status` $\rightarrow$ Admin dashboard verification |
| **App & Health** | `app.e2e-spec.ts` | Application bootstrap, root route, and `/health` system connectivity checks (Postgres + Redis) |

---

## Development & Code Quality

```bash
# Run linter with auto-fix
npm run lint

# Format code with Prettier
npm run format

# Compile TypeScript to dist/
npm run build
```

---

## Production & Operational Guidelines

1. **Graceful Shutdown**: `app.enableShutdownHooks()` ensures BullMQ workers cleanly complete active jobs before terminating during rolling deployments.
2. **Error Sanitization**: `AllExceptionsFilter` intercepts unhandled exceptions, logs full stack traces internally with correlation IDs, and returns sanitized generic error messages in production to protect system internals.
3. **Replay Defense**: Always ensure card webhook providers synchronize with standard NTP time servers; signatures older than 300 seconds are rejected automatically.
4. **Monitoring & Alerting**: Configure `SLACK_WEBHOOK_URL` to receive real-time notifications whenever a sync job exhausts retries and enters `odoo-sync-dlq`.

---

## License

UNLICENSED — Private corporate repository.
