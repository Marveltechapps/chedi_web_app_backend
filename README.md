# CHEDI CSA Member App — Backend

Node.js / Express API implementing [CHEDI_CSA_API_Contract.md](../CHEDI_CSA_API_Contract.md). Layout follows the Mineral Bridge backend structure (`server.js` / `app.js` / `routes` / `lib` / `services` / `middleware`).

## Quick start

```bash
cd chediwebapp_backend
cp .env.example .env
npm install
# Option A — system MongoDB
npm run seed
npm run ensure-indexes
npm run dev

# Option B — no MongoDB installed (in-memory + seed)
npm run dev:memory
```

## Admin console API

Staff JWT under `/api/v1/admin/*` (see `chedi_admin_dashboard/API_CONTRACT.md`).

```bash
POST /api/v1/admin/login
{ "email": "anitha@chedi.in", "password": "ChediAdmin123!" }
```

Use `Authorization: Bearer <accessToken>` on all other `/admin` routes except `POST /admin/refresh`. Seeded roles: Super Admin (`anitha`), Farm Manager (`murugan`), Billing Manager (`sundar`), Delivery Manager (`kavya`), Support Agent (`ramesh`).

Legacy payment tools still work: `POST /admin/payments/:id/approve` with `Authorization: Bearer chedi-admin-demo` (used by `npm run e2e:api`).

## Login OTP (email)

OTPs are generated per request and emailed via Gmail SMTP (`GMAIL_USER` + `GMAIL_APP_PASSWORD`). Set `ALLOW_DEMO_OTP=false` (default in `.env.example`) so codes are never returned in the API response.

| Field | Notes |
|-------|--------|
| Email | Registered member email (seeded e.g. `arun.kumar@example.com`) |
| OTP | Sent to that inbox — check email |
| Admin dashboard | http://localhost:4000/admin (legacy payment tools) |
| Staff console login | `anitha@chedi.in` / `ChediAdmin123!` (after `npm run seed`) |
| Admin key (legacy) | `chedi-admin-demo` |

For local tests without SMTP, set `ALLOW_DEMO_OTP=true` and `DEMO_OTP=1234` (or use `npm run dev:memory`).

Payments use an offline **payment request** flow: member submits a request → admin collects payment → admin marks **Paid** in the dashboard.

## Layout

```
chediwebapp_backend/
├── server.js          # Process entry — DB/Redis + listen
├── app.js             # Express app (exportable for tests)
├── config/            # db.js, redis.js
├── routes/            # /api/v1/* route modules
├── lib/               # Domain helpers (money, phone, payments, …)
├── middleware/        # JWT member auth
├── services/          # JWT + OTP
├── utils/             # hash, OTP generator
├── data/              # Static catalogs (plots, plans, support, legal)
├── seed/              # npm run seed
└── scripts/           # ensure-indexes
```

## Environment

See `.env.example`. Important flags:

- `GMAIL_USER` / `GMAIL_APP_PASSWORD` — Gmail SMTP for real OTP emails
- `ALLOW_DEMO_OTP=true` — only for tests / no-SMTP local (exposes fixed `DEMO_OTP`)
- `GOOGLE_SHEETS_WEBHOOK_URL` — optional audit log of OTP send events (never includes the code)
- `MEMBERSHIP_FEE_INR=500`
- `DELIVERY_CHARGE_INR=10000`
- `STAFF_SEED_PASSWORD=ChediAdmin123!` — password for seeded console users (`anitha@chedi.in`, …)

## Payments

Card / net-banking flows are **simulated** (always succeed after validation). Wire a real gateway via `POST /payments/webhooks/{provider}` when ready. PAN/CVV are never persisted — only masked methods + token refs.

## Scripts

| Command | Purpose |
|---------|---------|
| `npm start` | Production listen |
| `npm run dev` | Watch mode (requires MongoDB) |
| `npm run dev:memory` | In-memory Mongo + seed + listen (local demo) |
| `npm run seed` | Reset + seed catalogs + demo member |
| `npm run ensure-indexes` | Create Mongo indexes |
| `npm test` | Jest |
