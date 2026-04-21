# RAC ApprovalMax Dashboard — Project Context

**Owner:** Duane (specialdk) · **Entity:** Rirratjingu Aboriginal Corporation (NT, Australia)
**Stack:** Node/Express + Postgres on Railway · deployed via GitHub MCP
**Repo:** https://github.com/specialdk/rac-approvalmax-mcp
**Live:** https://rac-approvalmax-mcp.up.railway.app/
**Last session:** Day 1 — 2026-04-21 (foundation complete, real data flowing)

---

## Why this project exists

Rhian (CEO) and Paul (CFO) currently have no cross-entity visibility across RAC's 5 ApprovalMax organisations. ApprovalMax itself has no multi-entity dashboard. The goal is a single view showing bottlenecks, committed spend, approver workload, spend patterns, compliance/anomaly signals, and throughput velocity — first for Rhian/Paul, then a v1.1 for Matt (accountant).

Duane's **primary focus is ANALYSIS and value proposition** — not building a generic-looking dashboard. The insight layer is where the value lives; visualisation is the delivery mechanism, not the product.

**Scope (short term):** READ-ONLY. No write operations to AM. No handling of journal-entries (not in the AM Xero endpoint set anyway).

---

## The 5 entities

| # | Name | Company UUID |
|---|---|---|
| 1 | Rirratjingu Mining Pty Ltd 7168 | `6655cc87-de32-40d1-aee9-5f78abac57fe` |
| 2 | Rirratjingu Invest P/L ATF Miliditjpi Trust | `075c13e2-4476-4541-b8e2-85215a5656dc` |
| 3 | Rirratjingu Aboriginal Corporation 8538 | `c32a3d25-1a02-4f87-82d6-8584746119c1` |
| 4 | Rirratjingu Property Management & Maintenance Services Pty Ltd | `ef3d29f3-56da-4b76-8a57-cf1d10919391` |
| 5 | Rirratjingu Enterprises Pty Ltd | `77b4e48b-4dee-42fb-afdb-dae38c69df3d` |

AM Subscription: **AMS-14868**. **Now on 14-day All Features trial started 2026-04-21** (trial ends approximately 2026-05-05 — commercial decision required before then).

---

## Current state — end of Day 1

Pipeline is working end-to-end for the first time in RAC's 17-month ApprovalMax history. One click of the **Cross-entity summary** button returns:

```
totalCount: 902 (floor — clamped at limit=100 per entity per type)
  purchase-orders: 473
  bills: 429
  across 5 entities
```

All 4 of Mining/Aboriginal Corp/Property/Enterprises hit exactly 100 POs and 100 Bills, meaning they have more requests that pagination would reveal. Only Invest (73 POs / 29 Bills) returned complete data.

### What's proven to work

OAuth authorisation code flow with `offline_access` scope. Access and refresh tokens persisted in Postgres (table `approvalmax_tokens`, singleton key `approvalmax_integration`). Auto-refresh within 5 minutes of expiry. Token survives Railway redeploys. `/api/companies` returns all 5 orgs cleanly. Cross-entity summary aggregates POs + Bills across all 5 entities into a typed response. Homepage has type/status/entity dropdowns + KPI cards. Postgres persistence verified — the whole point of the DB was to avoid losing state across redeploys; it works.

### Deployed endpoints

- `GET /` — homepage (HTML from template literal inside server.js)
- `GET /auth/start`, `GET /callback/approvalmax`, `GET /auth/status` — OAuth
- `GET /api/companies` — list the 5 orgs
- `GET /api/xero/summary` — cross-entity KPI aggregation (POs + Bills × 5 orgs) with optional `?requestStatus=X`
- `GET /api/xero/:type` — one request type across all entities
- `GET /api/xero/:type/:companyId` — one type for one entity
- `GET /api/debug/raw?companyId=X&path=Y` — raw passthrough for reconciliation
- `GET /debug/info`, `GET /health` — diagnostics

### Latest commit on main

`5c160c7` — *Default /api/xero/summary to no requestStatus filter*

---

## Day 1 lessons learned (hard-won knowledge)

### The real AM API shape

The Public API does NOT use a generic `/requests` endpoint with a `type` query param. Instead, each platform × request type has its own URL:

```
/api/v1/companies/{companyId}/xero/purchase-orders
/api/v1/companies/{companyId}/xero/bills
/api/v1/companies/{companyId}/xero/credit-notes
/api/v1/companies/{companyId}/xero/sales-invoices
/api/v1/companies/{companyId}/xero/batch-payments
/api/v1/companies/{companyId}/xero/quotes
```

Query param is `requestStatus` (NOT `status` — that produces 404s). Paged response shape is `{ "payload": [...], "continuationToken": "..." }`. Source of truth is the swagger spec at https://public-api.approvalmax.com/swagger/v1/swagger.json — but the spec is large (60k+ tokens and still didn't reach the `PublicApiApplicationRequestsRequestStatus` enum definition on a single fetch).

### Subscription tier gate (the big one)

**Public API data endpoints require Premium subscription, or an active All Features trial.** Advanced is NOT enough, despite earlier planning assumptions. The gate is two-layered:

- `/companies` is gated by OAuth consent only — works on any tier. That's why we could see the 5 orgs even with zero data access.
- `/xero/*` data endpoints are gated by subscription tier. On Advanced, returns HTTP 400 with `"detail": "The <companyId> is disabled."`

This is documented at https://developer.approvalmax.com/docs/authorization-flow under Prerequisites: *"for access to your data via the ApprovalMax public API, make sure your Organisation(-s) is/are under a Premium subscription, a trial, or an active All Features trial."*

Trial activation immediately unlocks data access — confirmed working 2026-04-21.

### Error body format (and a stringification bug we fixed)

AM returns ASP.NET Problem Details:

```json
{
  "type": "/api/errors/invalidInput",
  "title": "Invalid input.",
  "status": 400,
  "detail": "human-readable",
  "instance": "/api/v1/companies/.../xero/purchase-orders",
  "error": {
    "code": "invalidInput",
    "parameters": [
      { "path": "requestStatus", "name": "requestStatus", "value": "OnApproval",
        "errorMessage": "unrecognized value 'OnApproval' for 'RequestStatus'" }
    ],
    "title": "Invalid input."
  },
  "traceId": "00-..."
}
```

The `error` field is an OBJECT, not a string. Template literal interpolation (`` `${data.error}` ``) produces `[object Object]` and hides the real message. The fix lives in `approvalmax-client.js` as `extractErrorMessage()` — it walks common string fields (`error`, `message`, `detail`, `title`) before falling back to `JSON.stringify(data)` truncated to 800 chars. Per-entity error handlers in `server.js` also pass `err.body` through so the caller sees the full AM response, not just the summary string.

### requestStatus enum — still undocumented

`OnApproval` was a guess. AM rejected it: *"unrecognized value 'OnApproval' for 'RequestStatus'"*. The swagger spec has the enum definition somewhere but it's deep in the schema list and we haven't reached it yet. Current UI workaround: default to "(no filter)" and label known guesses as `(guess)` in the dropdown. **The real enum values will appear in the returned items' `requestStatus` field** once we actually inspect some data (next session's first task).

### OneDrive + Git gotcha (resolved)

Found a rogue `.git` directory at `C:\` root that was attempting to track Duane's entire C: drive — origin was a throwaway `rac-easter-api` project. Cleaned up. All RAC repos now under `C:\Users\speci\OneDrive\RAC-Projects\` with individual `.git` folders. OneDrive + git is a known-fragile combo but acceptable for this project.

### Browser cache (operational note)

The homepage HTML is built as a template literal inside `server.js`. After a Railway redeploy, the NEW HTML isn't served to already-open browser tabs — the OLD cached version persists. Symptom: UI changes don't appear; dropdowns still have old default values; requests still include old query params. **Fix: hard-refresh (Ctrl+F5).** We hit this at least once during Day 1 — if something "doesn't seem to have deployed," rule this out first before debugging code.

---

## Next session — priorities in order

Duane's preference: concentrate on ANALYSIS and value proposition, not infrastructure. Keep the pipeline minimal and pivot to insight as soon as possible.

### 1. Peek at a single real request — understand the data we have

```
GET /api/xero/purchase-orders/6655cc87-de32-40d1-aee9-5f78abac57fe?limit=1
```

This returns ONE real Mining PO. From it we learn:
- The actual field names on a PO (supplier, amount, currency, approval events, approvers, dates, etc.)
- The real `requestStatus` enum value (replaces our guesses)
- The shape of the approval event log — this is where bottleneck analysis lives
- How amounts, currencies, and totals are structured
- Whether the `events` array has approver identities, timestamps, and actions

This step gates everything else. Dashboard design without knowing the data shape is speculation. Paste the response back and we design from reality.

### 2. Wire up pagination in /api/xero/summary

The `continuationToken` loop — fetch until token is null — so we get accurate totals instead of 100-clamped floors. AM caps `limit` at 100 per call, so we have to loop. Known rate limits: 100 reads/min per ClientId+CompanyId combo. 5 entities × 2 types × a few pages each is well within limits.

### 3. Start the analysis work

Once steps 1-2 are done, the focus shifts to six buckets Duane previously identified:
- Bottleneck view (which approvers hold up which requests, and for how long)
- Committed spend (approved but not yet paid)
- Approver workload distribution
- Spend patterns (by supplier, category, entity, time)
- Compliance / anomaly signals (the "CFO gold mine" — duplicate invoices, split POs, unusual approval paths)
- Velocity / throughput (avg cycle time, bottleneck progression)

The compliance/anomaly bucket is the argued-for premium upsell. That's where Duane wants to spend analysis effort — it's the hardest to get from AM natively and the highest-value output.

### 4. Consider MCP tool exposure (not urgent)

Following the `rac-mex-mcp/mcp-server.js` pattern, expose the REST endpoints as MCP tools for Claude Desktop use by finance team (Rhian/Paul/Matt). NOT priority — REST + browser dashboard first; MCP after the analysis shape is settled.

---

## Out of scope / explicit non-goals

- **No write operations.** Read-only pipeline. No creating, editing, or submitting requests.
- **No journal entries.** Not in the AM Xero endpoint set and not in scope.
- **No generic dashboard for the sake of a dashboard.** Every tile earns its place by answering a question Rhian or Paul actually has.
- **No premature MCP wrapping.** REST API and data model stabilise first.

---

## Commercial decision clock

14-day All Features trial activated 2026-04-21. Expires approximately 2026-05-05. After expiry, if no Premium upgrade, data endpoints return to "disabled" and dev stops.

Premium pricing per earlier context: ~$2,400/year. The Day 1+ work is the business case — prove the compliance/anomaly bucket delivers ROI before the clock runs out, so Paul can sign off on Premium with evidence rather than a pitch.

---

## Environment reference

### Railway service env vars

- `APPROVALMAX_CLIENT_ID` = `2A81A6DEEAA244C188D518BA59601780`
- `APPROVALMAX_CLIENT_SECRET` = (set)
- `APPROVALMAX_REDIRECT_URI` = `https://rac-approvalmax-mcp.up.railway.app/callback/approvalmax`
- `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`

### Local dev path

```
C:\Users\speci\OneDrive\RAC-Projects\rac-mcp\rac-approvalmax-mcp
```

### Deploy workflow

Local edit → `git add / commit / push` → Railway auto-deploys on push to main (~60-90s) → hard-refresh browser to pick up any homepage HTML changes.

### Scopes granted

```
https://www.approvalmax.com/scopes/public_api/read
https://www.approvalmax.com/scopes/public_api/write
offline_access
```

(Write scope retained for future flexibility; not exercised in read-only pipeline.)

### AM API constants

- Base: `https://public-api.approvalmax.com/api/v1`
- Auth: `https://identity.approvalmax.com/connect/authorize`
- Token: `https://identity.approvalmax.com/connect/token`
- Swagger: `https://public-api.approvalmax.com/swagger/v1/swagger.json`
- Rate limit: 100 reads/min per ClientId+CompanyId combo
- Max `limit` per request: 100
- Access token lifetime: 1 hour
- Refresh token lifetime: 30-day sliding window (each refresh extends by 30 days)

---

## First thing a future Claude should do

1. Read this file.
2. Check latest commit on main — confirm it's at or beyond `5c160c7`.
3. Check if the All Features trial is still active (expiry approx 2026-05-05). If expired and no Premium upgrade, data endpoints will return "is disabled" errors and the session will need to start with that conversation.
4. Ask Duane what he wants to do — don't assume it's next-step #1 in this doc unless he says so.
