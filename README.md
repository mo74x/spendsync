# SpendSync

**Automated corporate card spend → double-entry ledger → Odoo ERP sync pipeline.**

SpendSync receives real-time card transaction webhooks, creates auditable double-entry journal entries in a local PostgreSQL ledger, and asynchronously syncs them to an Odoo 17 ERP system via BullMQ job queues — with built-in retry logic, dead letter queue (DLQ) alerting, and an admin operations API.

---

## Architecture

```
                         ┌──────────────────────────┐
                         │   Card Provider Webhook   │
                         │   (HMAC SHA-256 signed)   │
                         └────────────┬─────────────┘
                                      │ POST /api/v1/webhooks/transactions
                                      ▼
                         ┌──────────────────────────┐
                         │   WebhooksController      │
                         │   ↳ HmacGuard (replay     │
                         │     attack prevention)    │
                         └────────────┬─────────────┘
                                      │ Idempotent INSERT
                                      ▼
┌─────────────────┐     ┌──────────────────────────┐
│                 │     │   webhook_events (PG)     │
│   PostgreSQL    │◄────│   Immutable audit log     │
│                 │     └────────────┬─────────────┘
│  ┌────────────┐ │                  │ BullMQ dispatch
│  │ journal_   │ │                  ▼
│  │ entries    │ │     ┌──────────────────────────┐
│  ├────────────┤ │     │   transaction-ledger     │
│  │ category_  │ │     │   Queue (Redis)          │
│  │ gl_mapping │ │     └────────────┬─────────────┘
│  ├────────────┤ │                  │
│  │ odoo_sync_ │ │                  ▼
│  │ status     │ │     ┌──────────────────────────┐
│  └────────────┘ │     │   LedgerProcessor        │
│                 │     │   ↳ Double-entry booking  │
└─────────────────┘     │   ↳ Category → GL map    │
                        │   ↳ Pessimistic locking   │
                        └────────────┬─────────────┘
                                     │ BullMQ dispatch
                                     ▼
                        ┌──────────────────────────┐
                        │   odoo-sync Queue         │
                        │   (3 retries, exp backoff)│
                        └────────────┬─────────────┘
                                     │
                                     ▼
                        ┌──────────────────────────┐
                        │   OdooSyncProcessor       │
                        │   ↳ XML-RPC → Odoo 17    │
                        │   ↳ Creates account.move  │
                        └────────────┬─────────────┘
                                     │ On exhaustion
                                     ▼
                        ┌──────────────────────────┐
                        │   odoo-sync-dlq Queue     │
                        │   ↳ Slack/log alerting    │
                        └───────────────────────────┘
```

### Key Design Decisions

| Concern | Approach |
|---|---|
| **Idempotency** | `UNIQUE` constraint on `source_event_id` + BullMQ `jobId` dedup |
| **Double-Entry** | Every transaction creates balanced debit/credit journal entries |
| **Concurrency** | `SELECT ... FOR UPDATE` pessimistic locking on webhook events |
| **GL Mapping** | `category_gl_mapping` table maps spend categories → GL account codes |
| **Retry & DLQ** | BullMQ exponential backoff (3 attempts) → DLQ queue + Slack alert |
| **Security** | HMAC SHA-256 webhook verification with replay attack prevention |
| **Observability** | Request correlation IDs, structured logging, Bull Board dashboard |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js · TypeScript |
| Framework | NestJS 11 |
| Database | PostgreSQL 16 |
| Job Queue | BullMQ 6 + Redis 7 |
| ERP | Odoo 17 (XML-RPC) |
| Validation | class-validator · class-transformer |
| Queue Dashboard | @bull-board/nestjs |
| Health Checks | @nestjs/terminus |

---

## Prerequisites

- **Node.js** ≥ 20
- **Docker** & **Docker Compose** (for PostgreSQL, Redis, and Odoo)
- **npm** ≥ 10

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

This starts:
| Service | Container | Port |
|---|---|---|
| PostgreSQL 16 (app ledger) | `spendsync-postgres` | `5432` |
| Redis 7 (BullMQ) | `spendsync-redis` | `6379` |
| PostgreSQL 15 (Odoo internal) | `odoo-postgres` | — |
| Odoo 17 | `spendsync-odoo` | `8069` |

The database migration in `migrations/001_initial_schema.sql` runs automatically on first container start via Docker's `initdb.d` mount.

### 3. Configure Environment

Copy the example and adjust values:

```bash
cp .env.example .env
```

Or create a `.env` file with these variables:

```env
# Server
PORT=3000

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

# Admin Operations API
ADMIN_API_KEY=your_admin_api_key_here

# Notifications (optional)
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/T.../B.../xxx
```

> **Note:** The app validates all required environment variables at startup using `class-validator`. If any required variable is missing, the process will fail fast with a descriptive error message.

### 4. Configure Odoo

1. Open `http://localhost:8069` and complete the Odoo setup wizard.
2. Create a database named `spendsync_odoo`.
3. Install the **Accounting** module.
4. Ensure the GL account codes referenced in `category_gl_mapping` exist in your Odoo Chart of Accounts (e.g., `600100`, `600200`, `210000`).

### 5. Run the Application

```bash
# Development (watch mode)
npm run start:dev

# Production
npm run build
npm run start:prod
```

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `3000` | HTTP server port |
| `NODE_ENV` | No | `development` | `development` · `production` · `test` |
| `DATABASE_URL` | **Yes** | — | PostgreSQL connection string |
| `REDIS_HOST` | **Yes** | — | Redis host for BullMQ |
| `REDIS_PORT` | No | `6379` | Redis port |
| `WEBHOOK_SECRET` | **Yes** | — | HMAC SHA-256 secret for webhook verification |
| `ODOO_HOST` | **Yes** | — | Odoo server hostname |
| `ODOO_PORT` | No | `8069` | Odoo XML-RPC port |
| `ODOO_DB` | **Yes** | — | Odoo database name |
| `ODOO_USERNAME` | **Yes** | — | Odoo XML-RPC user |
| `ODOO_PASSWORD` | **Yes** | — | Odoo XML-RPC password |
| `CARD_CLEARING_ACCOUNT` | No | `210000` | GL code for the card clearing account |
| `ADMIN_API_KEY` | **Yes** | — | API key for admin endpoints |
| `SLACK_WEBHOOK_URL` | No | — | Slack incoming webhook for DLQ alerts |

---

## API Endpoints

### Webhook Ingestion

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/v1/webhooks/transactions` | HMAC SHA-256 | Ingest a card transaction webhook |

**Headers required:**
- `x-signature` — HMAC SHA-256 hex digest of the raw body
- `x-timestamp` — Unix timestamp (must be within 300s of server time)

**Request body example:**
```json
{
  "event_id": "evt_abc123",
  "event_type": "transaction.created",
  "data": {
    "amount": 149.99,
    "currency": "USD",
    "merchant_name": "AWS",
    "card_last4": "4242",
    "category": "software",
    "transaction_type": "purchase"
  }
}
```

**Response:** `202 Accepted`
```json
{
  "status": "enqueued",
  "event_id": "evt_abc123"
}
```

---

### Admin Operations API

All admin endpoints require the `x-api-key` header matching `ADMIN_API_KEY`.

#### Dashboard Stats

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/admin/stats` | Sync statistics (synced/pending/failed/total) |

**Response:**
```json
{
  "synced": 142,
  "pending": 3,
  "failed": 1,
  "total": 146
}
```

#### Sync History & Failures

| Method | Path | Query Params | Description |
|---|---|---|---|
| `GET` | `/api/v1/admin/sync-history` | `?limit=50` | Recent successful syncs |
| `GET` | `/api/v1/admin/sync-failures` | `?limit=50` | Failed syncs with error details |
| `POST` | `/api/v1/admin/sync-failures/:journalId/retry` | — | Re-queue a failed sync (optional `new_debit_account` in body) |

#### Category → GL Account Mappings

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/admin/mappings` | List all category mappings |
| `POST` | `/api/v1/admin/mappings` | Create a new mapping |
| `PUT` | `/api/v1/admin/mappings/:category` | Update an existing mapping |

**Create mapping body:**
```json
{
  "category": "office_supplies",
  "expense_account": "600500",
  "description": "Office Supplies & Stationery"
}
```

---

### Health Check

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/health` | None | Checks PostgreSQL and Redis connectivity |

**Response:**
```json
{
  "status": "ok",
  "details": {
    "database": { "status": "up" },
    "redis": { "status": "up" }
  }
}
```

---

### Queue Dashboard (Bull Board)

| Path | Auth | Description |
|---|---|---|
| `/admin/queues` | None | Visual BullMQ dashboard (job statuses, retries, failures) |

---

## Database Schema

The application uses four core tables, initialized by `migrations/001_initial_schema.sql`:

| Table | Purpose |
|---|---|
| `webhook_events` | Immutable audit log of all inbound webhook events |
| `category_gl_mapping` | Maps spend categories to GL expense account codes |
| `journal_entries` | Double-entry journal entries (debit/credit pairs) |
| `odoo_sync_status` | Tracks ERP sync state per journal entry |

---

## Job Queues

| Queue | Purpose | Retry Policy |
|---|---|---|
| `transaction-ledger` | Processes webhook → double-entry journal entries | Default |
| `odoo-sync` | Syncs journal entries to Odoo via XML-RPC | 3 attempts, exponential backoff (2s base) |
| `odoo-sync-dlq` | Dead letter queue for permanently failed syncs | — |

When a job exhausts all retries on `odoo-sync`, it is moved to `odoo-sync-dlq` and a Slack notification is dispatched (if `SLACK_WEBHOOK_URL` is configured).

---

## Project Structure

```
spendsync/
├── migrations/
│   └── 001_initial_schema.sql      # PostgreSQL schema + seed data
├── src/
│   ├── main.ts                     # Bootstrap, global pipes/filters/hooks
│   ├── app.module.ts               # Root module (BullMQ, Bull Board, config)
│   ├── all-exceptions.filter.ts    # Global exception filter
│   ├── config/
│   │   └── env.validation.ts       # Startup env validation (class-validator)
│   ├── common/
│   │   ├── guards/
│   │   │   ├── hmac.guard.ts       # HMAC SHA-256 webhook verification
│   │   │   └── admin-api-key.guard.ts
│   │   ├── filters/
│   │   └── middleware/
│   │       └── request-logger.middleware.ts  # Correlation ID + request logging
│   └── modules/
│       ├── webhooks/               # Webhook ingestion controller & service
│       ├── ledger/                 # Double-entry ledger processor (BullMQ)
│       ├── odoo/                   # Odoo XML-RPC sync processor & client
│       ├── admin/                  # Admin operations controller (CRUD + retry)
│       ├── health/                 # Health check endpoint (PG + Redis)
│       ├── database/               # PostgreSQL connection pool module
│       └── notifications/          # Slack DLQ alerting service
├── docker-compose.yml              # PostgreSQL, Redis, Odoo infrastructure
├── package.json
└── tsconfig.json
```

---

## Testing

```bash
# Run all unit tests
npm test

# Watch mode
npm run test:watch

# Coverage report
npm run test:cov
```

### Test Coverage

| Module | Tests |
|---|---|
| `LedgerProcessor` | Double-entry balance (purchase/refund/fee), fallback GL mapping, idempotency, concurrency locks, transaction rollback |
| `WebhooksService` | Duplicate event rejection, new event ingestion + queue dispatch |
| `HmacGuard` | Missing headers, replay attack, invalid/valid HMAC signatures |
| `AdminController` | Stats query, sync history, failure listing, retry flow, category mapping CRUD |
| `OdooSyncProcessor` | Odoo sync success, retry on failure, DLQ routing on exhaustion |
| `EnvValidation` | Missing required vars, defaults, valid config acceptance |

---

## Development

```bash
# Lint
npm run lint

# Format
npm run format

# Build (TypeScript → JavaScript)
npm run build
```

---

## Deployment Notes

- `app.enableShutdownHooks()` is enabled for graceful BullMQ worker shutdown during deployments.
- `AllExceptionsFilter` sanitizes 500 error messages in production to prevent leaking internal details.
- All environment variables are validated at startup — missing required values will fail fast.

---

## License

UNLICENSED — Private project.
