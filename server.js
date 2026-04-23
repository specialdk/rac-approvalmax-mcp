// ApprovalMax API Data Tester - OAuth + DB persistence + real Xero endpoints
// File: server.js

const express = require('express');
const fetch = require('node-fetch');
const { Pool } = require('pg');
const amClient = require('./approvalmax-client');
const welfare = require('./welfare-categoriser');

const app = express();
const port = process.env.PORT || 3000;

const APPROVALMAX_CONFIG = {
    clientId: process.env.APPROVALMAX_CLIENT_ID || '2A81A6DEEAA244C188D518BA59601780',
    clientSecret: process.env.APPROVALMAX_CLIENT_SECRET || '',
    redirectUri: process.env.APPROVALMAX_REDIRECT_URI || 'https://rac-approvalmax-mcp.up.railway.app/callback/approvalmax',
    baseUrl: 'https://public-api.approvalmax.com/api/v1',
    authUrl: 'https://identity.approvalmax.com/connect/authorize',
    tokenUrl: 'https://identity.approvalmax.com/connect/token',
    scopes: [
        'https://www.approvalmax.com/scopes/public_api/read',
        'https://www.approvalmax.com/scopes/public_api/write',
        'offline_access'
    ]
};

const INTEGRATION_KEY = 'approvalmax_integration';

// The core Xero types we fetch for cross-entity aggregation
// Kept short intentionally - expand if needed for specific reporting
const DEFAULT_XERO_TYPES_FOR_AGGREGATION = ['purchase-orders', 'bills'];

// Safe default for AM adoption cutoff - see PROJECT_CONTEXT.md
// "AM adoption at RAC" section. Records created before this are backfill.
const DEFAULT_AM_ERA_CUTOFF = '2025-06-01';

// FY26 start for Aboriginal Corp welfare view. Australian FY is Jul 1 - Jun 30.
// Used as default in /api/welfare/aboriginal-corp endpoint.
const DEFAULT_WELFARE_FY_START = '2025-07-01';

// Aboriginal Corp's companyId, hardcoded because this is a dedicated endpoint.
// If RAC ever re-onboards AM with a new org ID this will need updating.
const ABORIGINAL_CORP_COMPANY_ID = 'c32a3d25-1a02-4f87-82d6-8584746119c1';

// Maximum pages fetched per (entity, type) combo in summary endpoint.
// AM caps limit at 100 per page, so MAX_PAGES_PER_COUNT=20 = 2,000 records.
// AM rate limit is 100 reads/min per ClientId+CompanyId; 5 entities × 2 types × 20 pages
// = 200 calls worst case but spread across different CompanyIds so well within limits.
const MAX_PAGES_PER_COUNT = 20;

// For the welfare endpoint we may need more pages than the summary cap because
// Aboriginal Corp hits 2,000+ POs per year and we want the *items themselves*,
// not just the count. Set higher and revisit if it becomes an issue.
const MAX_PAGES_FOR_WELFARE = 35;  // 3,500 records max

// For the entity-scan endpoint (Day 3g). Cross-entity reconnaissance pulls
// items with line items so we can aggregate by account code. 30 pages × 100 =
// 3,000 records per entity. Aboriginal Corp is near this cap; other entities
// are expected to have far fewer POs.
const MAX_PAGES_FOR_ENTITY_SCAN = 30;

// Helper: pull the three new filter params from a request's query string in one go.
// Returns { createdAtOrAfter, orderBy, orderDirection } with undefineds for absent values.
function extractAnalysisFilters(query) {
    return {
        createdAtOrAfter: query.createdAtOrAfter || undefined,
        orderBy: query.orderBy || undefined,
        orderDirection: query.orderDirection || undefined
    };
}

// Helper: fully paginate through AM's continuationToken for one (entity, type) combo
// and return the total record count. Does NOT return the items themselves - that would
// defeat the purpose of an aggregation endpoint. Stops at MAX_PAGES_PER_COUNT with
// capped=true so we never loop indefinitely.
async function countAllPages(accessToken, companyId, xeroType, baseFilters) {
    let count = 0;
    let pages = 0;
    let continuationToken = undefined;
    let capped = false;

    do {
        const result = await amClient.getXeroRequests(accessToken, companyId, xeroType, {
            ...baseFilters,
            limit: 100,
            continuationToken
        });
        count += result.items.length;
        continuationToken = result.continuationToken;
        pages++;
        if (pages >= MAX_PAGES_PER_COUNT && continuationToken) {
            capped = true;
            break;
        }
    } while (continuationToken);

    return { count, pages, capped };
}

// Helper: fully paginate and RETURN the items themselves (unlike countAllPages).
// Used by the welfare endpoint where we need to inspect each PO's line items,
// tracking, and events. Accepts a configurable page cap so different callers
// can tune the ceiling (welfare view = 35, entity scan = 30).
async function fetchAllPages(accessToken, companyId, xeroType, baseFilters, pageCap = MAX_PAGES_FOR_WELFARE) {
    const allItems = [];
    let pages = 0;
    let continuationToken = undefined;
    let capped = false;

    do {
        const result = await amClient.getXeroRequests(accessToken, companyId, xeroType, {
            ...baseFilters,
            limit: 100,
            continuationToken
        });
        allItems.push(...result.items);
        continuationToken = result.continuationToken;
        pages++;
        if (pages >= pageCap && continuationToken) {
            capped = true;
            break;
        }
    } while (continuationToken);

    return { items: allItems, pages, capped };
}

// Helper (Day 3g): given an array of POs, return aggregate shape data —
// total $ value, status breakdown, top 5 suppliers by $, top 5 account codes
// by $ and poCount, earliest/latest date seen. Purpose is to give a one-shot
// "what does this entity's AM data look like" snapshot to inform dashboard
// design. Does NOT do welfare-category classification — that's a separate
// concern specific to Aboriginal Corp.
function summarisePosShape(pos) {
    let totalValue = 0;
    const statusCounts = {};
    const supplierCounts = {};
    const supplierTotals = {};
    const accountTotals = {};
    let earliestDate = null;
    let latestDate = null;

    for (const po of pos) {
        totalValue += (po.total || 0);

        const status = po.requestStatus || 'unknown';
        statusCounts[status] = (statusCounts[status] || 0) + 1;

        const supplier = po.contact || 'Unknown';
        supplierTotals[supplier] = (supplierTotals[supplier] || 0) + (po.total || 0);
        supplierCounts[supplier] = (supplierCounts[supplier] || 0) + 1;

        if (Array.isArray(po.lineItems)) {
            for (const li of po.lineItems) {
                const code = li.accountCode;
                if (!code) continue;
                if (!accountTotals[code]) {
                    accountTotals[code] = {
                        accountCode: code,
                        account: li.account || null,
                        total: 0,
                        poCount: 0
                    };
                }
                accountTotals[code].total += (li.amount || 0);
                accountTotals[code].poCount += 1;
            }
        }

        const poDate = po.createdAt || po.date || po.modifiedAt || null;
        if (poDate) {
            if (!earliestDate || poDate < earliestDate) earliestDate = poDate;
            if (!latestDate || poDate > latestDate) latestDate = poDate;
        }
    }

    const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100;

    const topSuppliersByValue = Object.entries(supplierTotals)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name, total]) => ({
            name,
            total: r2(total),
            poCount: supplierCounts[name] || 0
        }));

    const topAccountsByValue = Object.values(accountTotals)
        .sort((a, b) => b.total - a.total)
        .slice(0, 5)
        .map(a => ({
            accountCode: a.accountCode,
            account: a.account,
            total: r2(a.total),
            poCount: a.poCount
        }));

    return {
        totalValue: r2(totalValue),
        statusCounts,
        topSuppliersByValue,
        topAccountsByValue,
        earliestDate,
        latestDate,
        uniqueSuppliers: Object.keys(supplierTotals).length,
        uniqueAccountCodes: Object.keys(accountTotals).length
    };
}

// Postgres pool
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

pool.on('error', (err) => {
    console.error('Unexpected DB pool error:', err.message);
});

async function ensureSchema() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS approvalmax_tokens (
                id SERIAL PRIMARY KEY,
                integration_key VARCHAR(255) UNIQUE NOT NULL,
                access_token TEXT NOT NULL,
                refresh_token TEXT,
                expires_at BIGINT NOT NULL,
                organizations JSONB,
                last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('approvalmax_tokens table ready');
    } catch (err) {
        console.error('Schema migration failed:', err.message);
    }
}

async function storeApprovalMaxToken(tokens, organizations = null) {
    const expiresAt = Date.now() + (tokens.expires_in * 1000);
    const orgsJson = organizations ? JSON.stringify(organizations) : null;

    await pool.query(
        `INSERT INTO approvalmax_tokens
            (integration_key, access_token, refresh_token, expires_at, organizations, last_seen, updated_at)
         VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT (integration_key) DO UPDATE SET
            access_token = EXCLUDED.access_token,
            refresh_token = COALESCE(EXCLUDED.refresh_token, approvalmax_tokens.refresh_token),
            expires_at = EXCLUDED.expires_at,
            organizations = COALESCE(EXCLUDED.organizations, approvalmax_tokens.organizations),
            last_seen = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP`,
        [INTEGRATION_KEY, tokens.access_token, tokens.refresh_token || null, expiresAt, orgsJson]
    );

    console.log('Token stored. Expires at', new Date(expiresAt).toISOString());
}

async function refreshApprovalMaxToken(refreshToken) {
    console.log('Refreshing ApprovalMax access token...');
    const response = await fetch(APPROVALMAX_CONFIG.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: APPROVALMAX_CONFIG.clientId,
            client_secret: APPROVALMAX_CONFIG.clientSecret,
            refresh_token: refreshToken
        })
    });

    const tokens = await response.json();
    if (!response.ok) {
        console.error('Refresh failed:', tokens);
        throw new Error(`Refresh failed: ${tokens.error || 'unknown'} - ${tokens.error_description || ''}`);
    }

    await storeApprovalMaxToken(tokens);
    console.log('Token refreshed successfully');
    return tokens.access_token;
}

async function getApprovalMaxToken() {
    const result = await pool.query(
        'SELECT access_token, refresh_token, expires_at, organizations FROM approvalmax_tokens WHERE integration_key = $1',
        [INTEGRATION_KEY]
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    const expiresAt = Number(row.expires_at);
    const fiveMinutes = 5 * 60 * 1000;

    if (expiresAt > Date.now() + fiveMinutes) {
        return {
            access_token: row.access_token,
            expires_at: expiresAt,
            organizations: row.organizations
        };
    }

    if (row.refresh_token) {
        try {
            const newAccessToken = await refreshApprovalMaxToken(row.refresh_token);
            return {
                access_token: newAccessToken,
                expires_at: Date.now() + (3600 * 1000),
                organizations: row.organizations
            };
        } catch (err) {
            console.error('Refresh failed, token unusable:', err.message);
            return null;
        }
    }

    console.warn('Token expired and no refresh_token - user must re-consent');
    return null;
}

async function requireToken() {
    const tok = await getApprovalMaxToken();
    if (!tok) {
        const err = new Error('No valid access token - please authenticate');
        err.status = 401;
        throw err;
    }
    return tok;
}

// Middleware
app.use(express.json());
app.use(express.static('public'));

// ────────────────────────────────────────────────────────────────────────
// Homepage
// ────────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>RAC ApprovalMax Dashboard - API Data Tester</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            max-width: 1000px;
            margin: 0 auto;
            padding: 20px;
            background: linear-gradient(135deg, #8B5A96 0%, #6A4C93 100%);
            min-height: 100vh;
        }
        .container {
            background: white;
            border-radius: 12px;
            padding: 30px;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
        }
        h1 { color: #2d3748; text-align: center; margin-bottom: 30px; }
        .section {
            background: #f8fafc;
            border: 1px solid #e2e8f0;
            border-radius: 8px;
            padding: 20px;
            margin: 20px 0;
        }
        .section h3 { margin-top: 0; color: #4a5568; }
        .section h4 { color: #4a5568; margin-top: 16px; margin-bottom: 8px; }
        .section.welfare { border-left: 4px solid #8B5A96; background: #faf5ff; }
        .section.scan { border-left: 4px solid #059669; background: #f0fdf4; }
        .status {
            padding: 12px;
            border-radius: 6px;
            margin: 10px 0;
            font-weight: 500;
        }
        .status.connected { background: #ecfdf5; border: 1px solid #10b981; color: #047857; }
        .status.disconnected { background: #fef2f2; border: 1px solid #ef4444; color: #dc2626; }
        .status.pending { background: #fffbeb; border: 1px solid #f59e0b; color: #d97706; }
        button {
            background: #8B5A96;
            color: white;
            border: none;
            padding: 12px 20px;
            border-radius: 6px;
            cursor: pointer;
            margin: 5px;
            font-size: 14px;
        }
        button:hover { background: #6A4C93; }
        button:disabled { background: #9ca3af; cursor: not-allowed; }
        button.scan-btn { background: #059669; }
        button.scan-btn:hover { background: #047857; }
        .result {
            background: #1f2937;
            color: #f9fafb;
            padding: 15px;
            border-radius: 6px;
            font-family: monospace;
            font-size: 12px;
            white-space: pre-wrap;
            max-height: 500px;
            overflow-y: auto;
            margin: 10px 0;
        }
        .button-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
            gap: 10px;
            margin: 15px 0;
        }
        .control-row {
            display: flex;
            flex-wrap: wrap;
            gap: 10px;
            align-items: center;
            margin: 10px 0;
        }
        .control-row label { font-weight: 500; color: #4a5568; min-width: 130px; }
        .control-row select, .control-row input[type="date"] {
            padding: 8px;
            border-radius: 6px;
            border: 1px solid #cbd5e1;
            font-size: 14px;
            flex: 1;
            min-width: 200px;
        }
        .highlight { background: #fef3c7; padding: 2px 4px; border-radius: 3px; }
        .kpi-row {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
            gap: 12px;
            margin: 15px 0;
        }
        .kpi-card {
            background: white;
            border: 1px solid #e2e8f0;
            border-radius: 8px;
            padding: 16px;
            text-align: center;
        }
        .kpi-card .num { font-size: 24px; font-weight: 700; color: #8B5A96; }
        .kpi-card .label { font-size: 12px; color: #64748b; margin-top: 4px; }
        .category-card {
            background: white;
            border: 1px solid #e2e8f0;
            border-radius: 8px;
            padding: 16px;
            margin: 10px 0;
        }
        .category-card .cat-name { font-size: 16px; font-weight: 600; color: #2d3748; }
        .category-card .cat-figures { display: flex; gap: 20px; margin: 8px 0; flex-wrap: wrap; }
        .category-card .cat-fig-label { font-size: 11px; color: #64748b; text-transform: uppercase; }
        .category-card .cat-fig-value { font-size: 18px; font-weight: 700; color: #8B5A96; }
        .category-card .ar-caption { font-size: 12px; color: #64748b; font-style: italic; margin-top: 8px; }
        .pace-on-track { color: #059669; }
        .pace-over { color: #dc2626; }
        .pace-under { color: #d97706; }
        .filter-summary {
            background: #eff6ff;
            border: 1px solid #bfdbfe;
            color: #1e40af;
            padding: 10px 14px;
            border-radius: 6px;
            font-size: 13px;
            margin: 10px 0;
        }
        .capped-warning {
            background: #fffbeb;
            border: 1px solid #f59e0b;
            color: #92400e;
            padding: 10px 14px;
            border-radius: 6px;
            font-size: 13px;
            margin: 10px 0;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>RAC ApprovalMax Dashboard - API Data Tester</h1>

        <div class="section">
            <h3>Connection Status</h3>
            <div id="connectionStatus" class="status disconnected">
                Not Connected - Need to authenticate first
            </div>
            <p><strong>Setup:</strong></p>
            <ul>
                <li>Client ID: ${APPROVALMAX_CONFIG.clientId}</li>
                <li>Redirect URI: ${APPROVALMAX_CONFIG.redirectUri}</li>
                <li>Token Status: <span id="tokenStatus">Checking...</span></li>
                <li>Persistence: <span class="highlight">Postgres (survives restarts)</span></li>
            </ul>
        </div>

        <div class="section">
            <h3>Step 1: Authentication</h3>
            <p>Runs the ApprovalMax OAuth flow. Tokens persist and auto-refresh before expiry.</p>
            <button onclick="startAuth()">Start ApprovalMax Authentication</button>
            <div id="authResult"></div>
        </div>

        <div class="section scan">
            <h3>Cross-Entity Reconnaissance (Day 3g)</h3>
            <p style="color: #64748b; font-size: 13px;">
                One-shot scan of all 7 entities. For each: total PO count &amp; $, top 5 suppliers, top 5 account codes,
                status breakdown, date range. Purpose: inform dashboard design decisions about which entities need
                dedicated views and what the dominant procurement "story" is for each.
            </p>
            <div class="button-grid">
                <button onclick="fetchEntityScan()" disabled id="btn-entity-scan" class="scan-btn">Run entity scan (all 7 orgs, post-AM-era)</button>
            </div>
            <div id="entityScanResult"></div>
        </div>

        <div class="section welfare">
            <h3>Aboriginal Corp — "We Provided" view (prototype)</h3>
            <p style="color: #64748b; font-size: 13px;">
                BAU procurement visibility for welfare payments. Structured to tell the Annual Report story in real time.
                Major project spend is managed outside AM and reported separately.
            </p>

            <div class="control-row">
                <label for="welfareFyStart">FY start:</label>
                <input type="date" id="welfareFyStart" value="${DEFAULT_WELFARE_FY_START}">
                <small style="width: 100%; color: #64748b; margin-top: 4px;">
                    Default <code>${DEFAULT_WELFARE_FY_START}</code> is FY26 start. Use <code>2024-07-01</code> for FY25 comparison.
                </small>
            </div>

            <div class="button-grid">
                <button onclick="fetchWelfareView()" disabled id="btn-welfare">Build "We Provided" view</button>
            </div>

            <div id="welfareFilterSummary"></div>
            <div id="welfareCappedWarning"></div>
            <div id="welfareKpiRow"></div>
            <div id="welfareCategories"></div>
            <div id="welfareResult"></div>
        </div>

        <div class="section">
            <h3>Step 2: Xero Request Data (raw / sampling)</h3>
            <p>Hits the real AM endpoints: <code>/api/v1/companies/{id}/xero/{type}</code></p>

            <div class="control-row">
                <label for="typePicker">Request type:</label>
                <select id="typePicker">
                    <option value="purchase-orders" selected>purchase-orders</option>
                    <option value="bills">bills</option>
                    <option value="credit-notes">credit-notes</option>
                    <option value="sales-invoices">sales-invoices</option>
                    <option value="batch-payments">batch-payments</option>
                    <option value="quotes">quotes</option>
                </select>
            </div>

            <div class="control-row">
                <label for="statusPicker">Request status:</label>
                <select id="statusPicker">
                    <option value="" selected>(no filter - all statuses)</option>
                    <option value="approved">approved (confirmed)</option>
                    <option value="onApproval">onApproval (guess)</option>
                    <option value="rejected">rejected (guess)</option>
                    <option value="draft">draft (guess)</option>
                    <option value="cancelled">cancelled (guess)</option>
                    <option value="submitted">submitted (guess)</option>
                </select>
            </div>

            <div class="control-row">
                <label for="createdAtOrAfterPicker">Created on or after:</label>
                <input type="date" id="createdAtOrAfterPicker" value="${DEFAULT_AM_ERA_CUTOFF}">
                <small style="width: 100%; color: #64748b; margin-top: 4px;">
                    Default <code>${DEFAULT_AM_ERA_CUTOFF}</code> skips pre-AM backfill records. Clear the date to include everything (incl. backfill).
                </small>
            </div>

            <div class="control-row">
                <label for="sortPicker">Sort:</label>
                <select id="sortPicker">
                    <option value="" selected>(no sort - AM default)</option>
                    <option value="CreatedAt|Desc">CreatedAt Desc (guess - REJECTED by AM)</option>
                    <option value="ModifiedAt|Desc">ModifiedAt Desc (guess)</option>
                    <option value="DecisionDate|Desc">DecisionDate Desc (guess)</option>
                    <option value="Date|Desc">Date Desc (guess)</option>
                </select>
                <small style="width: 100%; color: #64748b; margin-top: 4px;">
                    OrderBy enum unknown. Both 'createdAt' and 'CreatedAt' rejected. Parked for now.
                </small>
            </div>

            <div class="control-row">
                <label for="companyPicker">Entity:</label>
                <select id="companyPicker">
                    <option value="">(all entities)</option>
                </select>
            </div>

            <div class="control-row">
                <label for="limitPicker">Limit per page:</label>
                <select id="limitPicker">
                    <option value="3">3 (sampling)</option>
                    <option value="5" selected>5 (sampling, default)</option>
                    <option value="10">10</option>
                    <option value="25">25</option>
                    <option value="50">50</option>
                    <option value="100">100 (AM max)</option>
                </select>
                <small style="width: 100%; color: #64748b; margin-top: 4px;">
                    Small = easier to read one page of JSON when sampling. 100 = AM's maximum per request. Only affects "Fetch by type" — cross-entity summary paginates for true counts regardless.
                </small>
            </div>

            <h4>Actions</h4>
            <div class="button-grid">
                <button onclick="callApi('/api/companies')" disabled id="btn-api-companies">GET /api/companies</button>
                <button onclick="fetchCrossEntitySummary()" disabled id="btn-summary">Cross-entity summary (POs + Bills, all 5 orgs)</button>
                <button onclick="fetchXeroByType()" disabled id="btn-xero-type">Fetch by type (uses selectors above)</button>
            </div>

            <div id="filterSummary"></div>
            <div id="cappedWarning"></div>
            <div id="kpiRow"></div>
            <div id="apiResult"></div>
        </div>

        <div class="section">
            <h3>Debug</h3>
            <button onclick="showDebugInfo()">Show DB Token State</button>
            <div id="debugInfo"></div>
        </div>
    </div>

    <script>
        let isAuthenticated = false;
        let companies = [];

        function startAuth() {
            fetch('/auth/start')
                .then(r => r.json())
                .then(data => {
                    if (data.authUrl) {
                        document.getElementById('authResult').innerHTML =
                            '<div class="status pending">Redirecting to ApprovalMax...</div>';
                        window.location.href = data.authUrl;
                    } else {
                        document.getElementById('authResult').innerHTML =
                            '<div class="status disconnected">Error: ' + (data.error || 'Failed') + '</div>';
                    }
                })
                .catch(err => {
                    document.getElementById('authResult').innerHTML =
                        '<div class="status disconnected">Network Error: ' + err.message + '</div>';
                });
        }

        function buildFilterParams() {
            const parts = [];
            const status = document.getElementById('statusPicker').value;
            if (status) parts.push('requestStatus=' + encodeURIComponent(status));

            const createdAtOrAfter = document.getElementById('createdAtOrAfterPicker').value;
            if (createdAtOrAfter) parts.push('createdAtOrAfter=' + encodeURIComponent(createdAtOrAfter));

            const sortValue = document.getElementById('sortPicker').value;
            if (sortValue) {
                const [orderBy, orderDirection] = sortValue.split('|');
                if (orderBy) parts.push('orderBy=' + encodeURIComponent(orderBy));
                if (orderDirection) parts.push('orderDirection=' + encodeURIComponent(orderDirection));
            }

            return parts.join('&');
        }

        function renderFilterSummary() {
            const status = document.getElementById('statusPicker').value || '(all statuses)';
            const createdAtOrAfter = document.getElementById('createdAtOrAfterPicker').value || '(no date filter — includes backfill)';
            const sortValue = document.getElementById('sortPicker').value;
            let sortLabel = '(no sort)';
            if (sortValue) {
                const [orderBy, orderDirection] = sortValue.split('|');
                sortLabel = orderBy + ' ' + orderDirection;
            }
            const limit = document.getElementById('limitPicker').value || '5';
            document.getElementById('filterSummary').innerHTML =
                '<div class="filter-summary">Filters: status=<strong>' + status +
                '</strong>, createdAtOrAfter=<strong>' + createdAtOrAfter +
                '</strong>, sort=<strong>' + sortLabel +
                '</strong>, limit/page=<strong>' + limit + '</strong></div>';
        }

        function renderCappedWarning(data) {
            const cappedEl = document.getElementById('cappedWarning');
            if (!cappedEl) return;
            if (data && data.anyCapped) {
                const cappedCombos = [];
                (data.byCompany || []).forEach(c => {
                    (c.cappedTypes || []).forEach(t => cappedCombos.push(c.companyName + ' / ' + t));
                });
                cappedEl.innerHTML =
                    '<div class="capped-warning">⚠️ Pagination cap reached (' +
                    data.paginationCap + ' pages × 100 = ' + (data.paginationCap * 100) + ' records) for: <strong>' +
                    cappedCombos.join(', ') + '</strong>. True counts may be higher.</div>';
            } else {
                cappedEl.innerHTML = '';
            }
        }

        function callApi(path) {
            showLoading('apiResult');
            document.getElementById('kpiRow').innerHTML = '';
            document.getElementById('cappedWarning').innerHTML = '';
            fetch(path)
                .then(r => r.json())
                .then(data => {
                    document.getElementById('apiResult').innerHTML =
                        '<div class="result">' + JSON.stringify(data, null, 2) + '</div>';
                })
                .catch(err => {
                    document.getElementById('apiResult').innerHTML =
                        '<div class="status disconnected">Error: ' + err.message + '</div>';
                });
        }

        function fetchXeroByType() {
            const type = document.getElementById('typePicker').value;
            const companyId = document.getElementById('companyPicker').value;
            const limit = document.getElementById('limitPicker').value || '5';
            const filterParams = buildFilterParams();
            const basePath = companyId
                ? '/api/xero/' + type + '/' + companyId
                : '/api/xero/' + type;
            const qs = 'limit=' + encodeURIComponent(limit) + (filterParams ? '&' + filterParams : '');
            renderFilterSummary();
            callApi(basePath + '?' + qs);
        }

        function fetchCrossEntitySummary() {
            const filterParams = buildFilterParams();
            const qs = filterParams ? '?' + filterParams : '';
            renderFilterSummary();
            showLoading('apiResult');
            document.getElementById('kpiRow').innerHTML = '';
            document.getElementById('cappedWarning').innerHTML = '';
            fetch('/api/xero/summary' + qs)
                .then(r => r.json())
                .then(data => {
                    renderSummaryKPIs(data);
                    renderCappedWarning(data);
                    document.getElementById('apiResult').innerHTML =
                        '<div class="result">' + JSON.stringify(data, null, 2) + '</div>';
                })
                .catch(err => {
                    document.getElementById('apiResult').innerHTML =
                        '<div class="status disconnected">Error: ' + err.message + '</div>';
                });
        }

        function fetchEntityScan() {
            document.getElementById('entityScanResult').innerHTML =
                '<div class="status pending">Scanning all 7 entities... this pulls POs with line items so expect 60–180 seconds.</div>';
            fetch('/api/am/entity-scan')
                .then(r => r.json())
                .then(data => {
                    document.getElementById('entityScanResult').innerHTML =
                        '<div class="result">' + JSON.stringify(data, null, 2) + '</div>';
                })
                .catch(err => {
                    document.getElementById('entityScanResult').innerHTML =
                        '<div class="status disconnected">Error: ' + err.message + '</div>';
                });
        }

        function renderSummaryKPIs(data) {
            if (!data || !data.success) return;
            const html =
                '<div class="kpi-row">' +
                '<div class="kpi-card"><div class="num">' + (data.totalCount || 0) + '</div><div class="label">Total (' + data.requestStatus + ')</div></div>' +
                '<div class="kpi-card"><div class="num">' + (data.totalsByType?.['purchase-orders'] || 0) + '</div><div class="label">Purchase Orders</div></div>' +
                '<div class="kpi-card"><div class="num">' + (data.totalsByType?.['bills'] || 0) + '</div><div class="label">Bills</div></div>' +
                '<div class="kpi-card"><div class="num">' + (data.entityCount || 0) + '</div><div class="label">Entities</div></div>' +
                '</div>';
            document.getElementById('kpiRow').innerHTML = html;
        }

        // ──── Welfare view ────
        function fetchWelfareView() {
            const fyStart = document.getElementById('welfareFyStart').value || '${DEFAULT_WELFARE_FY_START}';
            document.getElementById('welfareFilterSummary').innerHTML =
                '<div class="filter-summary">FY start: <strong>' + fyStart + '</strong>. Fetching all Aboriginal Corp POs (this may take 15-30 seconds due to pagination)...</div>';
            document.getElementById('welfareKpiRow').innerHTML = '';
            document.getElementById('welfareCategories').innerHTML = '';
            document.getElementById('welfareCappedWarning').innerHTML = '';
            document.getElementById('welfareResult').innerHTML =
                '<div class="status pending">Loading welfare view...</div>';

            fetch('/api/welfare/aboriginal-corp?fyStart=' + encodeURIComponent(fyStart))
                .then(r => r.json())
                .then(data => {
                    if (!data.success) {
                        document.getElementById('welfareResult').innerHTML =
                            '<div class="status disconnected">Error: ' + (data.error || 'unknown') + '</div>';
                        return;
                    }
                    renderWelfareKPIs(data.summary);
                    renderWelfareCategories(data.summary);
                    if (data.capped) {
                        document.getElementById('welfareCappedWarning').innerHTML =
                            '<div class="capped-warning">⚠️ Fetched ' + data.pagesFetched + ' pages (' + data.summary.posInspected + ' POs). Hit pagination cap — there may be more POs not included.</div>';
                    }
                    document.getElementById('welfareResult').innerHTML =
                        '<details><summary style="cursor: pointer; color: #6A4C93; margin-top: 10px;">Show raw JSON</summary>' +
                        '<div class="result">' + JSON.stringify(data, null, 2) + '</div></details>';
                })
                .catch(err => {
                    document.getElementById('welfareResult').innerHTML =
                        '<div class="status disconnected">Error: ' + err.message + '</div>';
                });
        }

        function renderWelfareKPIs(summary) {
            const html =
                '<div class="kpi-row">' +
                '<div class="kpi-card"><div class="num">$' + formatMoney(summary.totalWelfareValue) + '</div><div class="label">YTD Welfare Spend</div></div>' +
                '<div class="kpi-card"><div class="num">' + summary.totalWelfarePOs + '</div><div class="label">Welfare POs (YTD)</div></div>' +
                '<div class="kpi-card"><div class="num">' + summary.totalWelfareYtdVsFy25Pct + '%</div><div class="label">Of FY25 total</div></div>' +
                '<div class="kpi-card"><div class="num">' + Math.round(summary.fyPaceFraction * 100) + '%</div><div class="label">Of FY elapsed</div></div>' +
                '</div>';
            document.getElementById('welfareKpiRow').innerHTML = html;
        }

        function renderWelfareCategories(summary) {
            const html = summary.categories.map(cat => {
                const isUncat = cat.arLine === 'Uncategorised';
                const ytd = '$' + formatMoney(cat.ytdTotal);
                const baseline = cat.fy25Baseline ? '$' + formatMoney(cat.fy25Baseline) : '—';

                let paceHtml = '';
                if (cat.fy25Baseline && cat.projectedFullYear !== null) {
                    const pct = cat.projectedVsBaseline;
                    const paceClass = pct > 15 ? 'pace-over' : pct < -15 ? 'pace-under' : 'pace-on-track';
                    const paceWord = pct > 15 ? 'ahead of' : pct < -15 ? 'behind' : 'on track with';
                    paceHtml = '<div class="ar-caption ' + paceClass + '">' +
                        'Projected full-year: $' + formatMoney(cat.projectedFullYear) +
                        ' (' + (pct >= 0 ? '+' : '') + pct + '% vs FY25 baseline — ' + paceWord + ' last year)' +
                        '</div>';
                }

                let sampleHtml = '';
                if (isUncat && cat.sampleDescriptions && cat.sampleDescriptions.length > 0) {
                    sampleHtml = '<details style="margin-top: 10px;"><summary style="cursor: pointer; color: #6A4C93;">Sample uncategorised POs (for rule tuning)</summary>' +
                        '<ul style="font-size: 12px; color: #64748b;">' +
                        cat.sampleDescriptions.map(s =>
                            '<li><strong>' + (s.documentNumber || '(no #)') + '</strong> — ' + s.supplier + ' ($' + formatMoney(s.amount) + ', acct ' + (s.accountCode || '?') + '): <em>' + escapeHtml(s.description) + '</em></li>'
                        ).join('') +
                        '</ul></details>';
                }

                let recipientsHtml = '';
                if (cat.topRecipients && cat.topRecipients.length > 0) {
                    recipientsHtml = '<details style="margin-top: 8px;"><summary style="cursor: pointer; color: #6A4C93; font-size: 13px;">Top recipients (' + cat.uniqueRecipients + ' unique)</summary>' +
                        '<ul style="font-size: 12px;">' +
                        cat.topRecipients.map(r =>
                            '<li>' + escapeHtml(r.name) + ' — $' + formatMoney(r.total) + ' across ' + r.poCount + ' POs</li>'
                        ).join('') +
                        '</ul></details>';
                }

                const pctOfBaseline = cat.ytdPercentOfBaseline !== undefined
                    ? cat.ytdPercentOfBaseline + '%'
                    : '—';

                return '<div class="category-card">' +
                    '<div class="cat-name">' + cat.arLine + (isUncat ? ' <span style="background: #fef3c7; padding: 2px 6px; border-radius: 3px; font-size: 11px;">needs tuning</span>' : '') + '</div>' +
                    '<div class="cat-figures">' +
                    '<div><div class="cat-fig-label">YTD</div><div class="cat-fig-value">' + ytd + '</div></div>' +
                    '<div><div class="cat-fig-label">POs</div><div class="cat-fig-value">' + cat.ytdPOs + '</div></div>' +
                    '<div><div class="cat-fig-label">FY25 Baseline</div><div class="cat-fig-value">' + baseline + '</div></div>' +
                    '<div><div class="cat-fig-label">% of FY25</div><div class="cat-fig-value">' + pctOfBaseline + '</div></div>' +
                    '</div>' +
                    paceHtml +
                    recipientsHtml +
                    sampleHtml +
                    '</div>';
            }).join('');
            document.getElementById('welfareCategories').innerHTML = html;
        }

        function formatMoney(n) {
            if (n === null || n === undefined) return '—';
            return Number(n).toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
        }

        function escapeHtml(s) {
            return String(s || '').replace(/[&<>"']/g, c => ({
                '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
            })[c]);
        }

        function showDebugInfo() {
            fetch('/debug/info')
                .then(r => r.json())
                .then(data => {
                    document.getElementById('debugInfo').innerHTML =
                        '<div class="result">' + JSON.stringify(data, null, 2) + '</div>';
                });
        }

        function showLoading(elementId) {
            document.getElementById(elementId).innerHTML =
                '<div class="status pending">Loading... (pagination may take 5-15 seconds)</div>';
        }

        function enableButtons() {
            ['btn-api-companies', 'btn-summary', 'btn-xero-type', 'btn-welfare', 'btn-entity-scan'].forEach(id => {
                const btn = document.getElementById(id);
                if (btn) btn.disabled = false;
            });
        }

        function populateCompanyPicker(orgs) {
            const picker = document.getElementById('companyPicker');
            picker.innerHTML = '<option value="">(all entities)</option>';
            orgs.forEach(org => {
                const opt = document.createElement('option');
                opt.value = org.companyId || org.id;
                opt.textContent = org.name;
                picker.appendChild(opt);
            });
        }

        fetch('/auth/status')
            .then(r => r.json())
            .then(data => {
                if (data.authenticated) {
                    document.getElementById('connectionStatus').innerHTML =
                        'Connected - ' + (data.organizationCount || 0) + ' organization(s) linked';
                    document.getElementById('connectionStatus').className = 'status connected';
                    document.getElementById('tokenStatus').textContent =
                        'Valid - expires ' + (data.expiresAt ? new Date(data.expiresAt).toLocaleString() : 'unknown');
                    enableButtons();
                    isAuthenticated = true;

                    fetch('/api/companies')
                        .then(r => r.json())
                        .then(response => {
                            if (response.success && response.data) {
                                companies = Array.isArray(response.data) ? response.data : [];
                                populateCompanyPicker(companies);
                            }
                        })
                        .catch(() => {});
                } else {
                    document.getElementById('tokenStatus').textContent = 'No token in DB';
                }
            })
            .catch(() => {
                document.getElementById('tokenStatus').textContent = 'Error checking status';
            });
    </script>
</body>
</html>
    `);
});

// ────────────────────────────────────────────────────────────────────────
// OAuth endpoints
// ────────────────────────────────────────────────────────────────────────
app.get('/auth/start', (req, res) => {
    try {
        const state = Math.random().toString(36).substring(2, 15);
        const params = new URLSearchParams({
            response_type: 'code',
            client_id: APPROVALMAX_CONFIG.clientId,
            scope: APPROVALMAX_CONFIG.scopes.join(' '),
            redirect_uri: APPROVALMAX_CONFIG.redirectUri,
            state: state
        });
        res.json({ authUrl: `${APPROVALMAX_CONFIG.authUrl}?${params.toString()}` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/callback/approvalmax', async (req, res) => {
    try {
        const { code, state, error } = req.query;
        console.log('ApprovalMax callback received:', { code: !!code, state, error });

        if (error) {
            return res.status(400).send(`<h1>ApprovalMax Authorization Failed</h1><p>Error: ${error}</p><a href="/">Back to Home</a>`);
        }
        if (!code) {
            return res.status(400).send(`<h1>No Authorization Code</h1><a href="/">Back to Home</a>`);
        }

        const tokenResponse = await fetch(APPROVALMAX_CONFIG.tokenUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'authorization_code',
                client_id: APPROVALMAX_CONFIG.clientId,
                client_secret: APPROVALMAX_CONFIG.clientSecret,
                redirect_uri: APPROVALMAX_CONFIG.redirectUri,
                code: code
            })
        });

        const tokens = await tokenResponse.json();
        if (!tokenResponse.ok) {
            console.error('Token exchange failed:', tokens);
            return res.status(400).send(`<h1>Token Exchange Failed</h1><p>Error: ${tokens.error}</p><a href="/">Back to Home</a>`);
        }

        let organizations = null;
        try {
            const companiesData = await amClient.getCompanies(tokens.access_token);
            organizations = Array.isArray(companiesData) ? companiesData : (companiesData?.data || null);
            console.log('Retrieved', organizations ? organizations.length : 0, 'organizations');
        } catch (e) {
            console.warn('Could not fetch companies on callback:', e.message);
        }

        await storeApprovalMaxToken(tokens, organizations);

        const orgCount = organizations ? organizations.length : 0;
        res.send(`
            <h1>ApprovalMax Authentication Successful</h1>
            <p>Access token stored in DB. ${orgCount} organisation(s) linked. Refresh token ready.</p>
            <script>setTimeout(() => { window.location.href = '/'; }, 3000);</script>
        `);
    } catch (error) {
        console.error('Callback error:', error);
        res.status(500).send(`<h1>Server Error</h1><p>Error: ${error.message}</p><a href="/">Back to Home</a>`);
    }
});

app.get('/auth/status', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT access_token, refresh_token, expires_at, organizations FROM approvalmax_tokens WHERE integration_key = $1',
            [INTEGRATION_KEY]
        );

        if (result.rows.length === 0) return res.json({ authenticated: false });

        const row = result.rows[0];
        const expiresAt = Number(row.expires_at);
        const authenticated = !!(row.access_token && (expiresAt > Date.now() || row.refresh_token));
        const orgs = row.organizations || [];

        res.json({
            authenticated,
            expiresAt,
            hasRefreshToken: !!row.refresh_token,
            organizationCount: Array.isArray(orgs) ? orgs.length : 0
        });
    } catch (error) {
        res.status(500).json({ authenticated: false, error: error.message });
    }
});

// ═════════════════════════════════════════════════════════════════════════
// REAL API ENDPOINTS - Xero-typed, using approvalmax-client
// ═════════════════════════════════════════════════════════════════════════

// GET /api/companies - list the organisations
app.get('/api/companies', async (req, res) => {
    try {
        const tok = await requireToken();
        const data = await amClient.getCompanies(tok.access_token);
        const list = Array.isArray(data) ? data : (data?.data || []);
        res.json({ success: true, count: list.length, data: list });
    } catch (error) {
        res.status(error.status || 500).json({ success: false, error: error.message, body: error.body || null });
    }
});

// GET /api/welfare/aboriginal-corp - the "We Provided" view prototype
// Fetches all Aboriginal Corp POs from fyStart, classifies into AR welfare
// categories, extracts recipients, returns dashboard-shaped payload.
//
// Query params:
//   fyStart      - date (YYYY-MM-DD), defaults to 2025-07-01 (FY26 start)
//   asOfDate     - date (YYYY-MM-DD), defaults to today, used for pace calc
app.get('/api/welfare/aboriginal-corp', async (req, res) => {
    try {
        const tok = await requireToken();
        const fyStart = req.query.fyStart || DEFAULT_WELFARE_FY_START;
        const asOfDate = req.query.asOfDate || new Date().toISOString().slice(0, 10);
        const fyLabel = fyStart >= '2025-07-01' ? 'FY26' : fyStart >= '2024-07-01' ? 'FY25' : 'Custom FY';

        console.log(`[welfare] Fetching Aboriginal Corp POs since ${fyStart}...`);

        const { items: pos, pages, capped } = await fetchAllPages(
            tok.access_token,
            ABORIGINAL_CORP_COMPANY_ID,
            'purchase-orders',
            { createdAtOrAfter: fyStart },
            MAX_PAGES_FOR_WELFARE
        );

        console.log(`[welfare] Fetched ${pos.length} POs across ${pages} pages (capped=${capped}).`);

        const summary = welfare.buildWelfareSummary(pos, {
            fyStart,
            asOfDate,
            fyLabel
        });

        res.json({
            success: true,
            pagesFetched: pages,
            capped,
            summary
        });
    } catch (error) {
        console.error('[welfare] Error:', error.message);
        res.status(error.status || 500).json({
            success: false,
            error: error.message,
            body: error.body || null
        });
    }
});

// GET /api/am/entity-scan - cross-entity reconnaissance (Day 3g)
// For each connected AM company, paginates through POs (post-AM-era only by
// default) and returns aggregate shape data per entity: total count, total $
// value, top 5 suppliers by value, top 5 account codes by value, status
// breakdown, earliest/latest date. Purpose: inform dashboard design
// decisions about which entities justify dedicated views and what the
// dominant procurement "story" is for each.
//
// Query params:
//   createdAtOrAfter - date, defaults to DEFAULT_AM_ERA_CUTOFF (2025-06-01)
app.get('/api/am/entity-scan', async (req, res) => {
    try {
        const tok = await requireToken();
        const createdAtOrAfter = req.query.createdAtOrAfter || DEFAULT_AM_ERA_CUTOFF;

        let companies = Array.isArray(tok.organizations) ? tok.organizations : [];
        if (companies.length === 0) {
            const fresh = await amClient.getCompanies(tok.access_token);
            companies = Array.isArray(fresh) ? fresh : (fresh?.data || []);
        }

        console.log(`[entity-scan] Starting scan of ${companies.length} entities (createdAtOrAfter=${createdAtOrAfter})`);

        const entitySummaries = [];
        for (const company of companies) {
            const companyId = company.companyId || company.id;
            const companyName = company.name || 'Unknown';
            try {
                console.log(`[entity-scan] Fetching ${companyName}...`);
                const { items: pos, pages, capped } = await fetchAllPages(
                    tok.access_token,
                    companyId,
                    'purchase-orders',
                    { createdAtOrAfter },
                    MAX_PAGES_FOR_ENTITY_SCAN
                );
                const shape = summarisePosShape(pos);
                console.log(`[entity-scan] ${companyName}: ${pos.length} POs, $${shape.totalValue}, ${pages} pages (capped=${capped})`);
                entitySummaries.push({
                    companyId,
                    companyName,
                    pagesFetched: pages,
                    capped,
                    posTotal: pos.length,
                    ...shape
                });
            } catch (err) {
                console.error(`[entity-scan] Error on ${companyName}:`, err.message);
                entitySummaries.push({
                    companyId,
                    companyName,
                    error: err.message,
                    body: err.body || null
                });
            }
        }

        // Sort entities by posTotal desc so the dominant ones are at the top.
        entitySummaries.sort((a, b) => (b.posTotal || 0) - (a.posTotal || 0));

        res.json({
            success: true,
            createdAtOrAfter,
            entityCount: companies.length,
            paginationCap: MAX_PAGES_FOR_ENTITY_SCAN,
            entitySummaries
        });
    } catch (error) {
        console.error('[entity-scan] Top-level error:', error.message);
        res.status(error.status || 500).json({
            success: false,
            error: error.message
        });
    }
});

// GET /api/xero/summary - cross-entity KPI summary (POs + Bills across all 5 orgs)
// Now paginates through all continuationToken pages per (entity, type) for TRUE totals.
// Query: requestStatus, createdAtOrAfter, orderBy, orderDirection (all optional)
app.get('/api/xero/summary', async (req, res) => {
    try {
        const tok = await requireToken();
        const requestStatus = req.query.requestStatus || undefined;
        const analysisFilters = extractAnalysisFilters(req.query);

        let companies = Array.isArray(tok.organizations) ? tok.organizations : [];
        if (companies.length === 0) {
            const fresh = await amClient.getCompanies(tok.access_token);
            companies = Array.isArray(fresh) ? fresh : (fresh?.data || []);
        }

        const byCompany = [];
        const totalsByType = {};
        const pagesByTypeTotal = {};
        let totalCount = 0;
        let totalPages = 0;

        for (const company of companies) {
            const companyId = company.companyId || company.id;
            const companyName = company.name || 'Unknown';
            const entry = {
                companyId,
                companyName,
                counts: {},
                pagesByType: {},
                cappedTypes: [],
                totalForCompany: 0
            };

            for (const xeroType of DEFAULT_XERO_TYPES_FOR_AGGREGATION) {
                try {
                    const { count, pages, capped } = await countAllPages(
                        tok.access_token, companyId, xeroType,
                        { requestStatus, ...analysisFilters }
                    );
                    entry.counts[xeroType] = count;
                    entry.pagesByType[xeroType] = pages;
                    if (capped) entry.cappedTypes.push(xeroType);
                    entry.totalForCompany += count;
                    totalsByType[xeroType] = (totalsByType[xeroType] || 0) + count;
                    pagesByTypeTotal[xeroType] = (pagesByTypeTotal[xeroType] || 0) + pages;
                    totalCount += count;
                    totalPages += pages;
                } catch (err) {
                    entry.counts[xeroType] = {
                        error: err.message,
                        status: err.status || null,
                        body: err.body || null
                    };
                }
            }

            byCompany.push(entry);
        }

        const anyCapped = byCompany.some(c => c.cappedTypes && c.cappedTypes.length > 0);

        res.json({
            success: true,
            requestStatus: requestStatus || 'ALL',
            filters: analysisFilters,
            entityCount: companies.length,
            totalCount,
            totalsByType,
            typesFetched: DEFAULT_XERO_TYPES_FOR_AGGREGATION,
            paginationCap: MAX_PAGES_PER_COUNT,
            anyCapped,
            totalPagesFetched: totalPages,
            pagesByTypeTotal,
            byCompany
        });
    } catch (error) {
        res.status(error.status || 500).json({ success: false, error: error.message });
    }
});

// GET /api/xero/:type - single type across ALL entities
// Must come BEFORE /api/xero/:type/:companyId so Express matches correctly
// NOT paginated - returns first page of items. Use /api/xero/summary for true counts.
app.get('/api/xero/:type', async (req, res) => {
    try {
        const tok = await requireToken();
        const xeroType = req.params.type;
        const requestStatus = req.query.requestStatus || undefined;
        const limit = Number(req.query.limit || 100);
        const analysisFilters = extractAnalysisFilters(req.query);

        let companies = Array.isArray(tok.organizations) ? tok.organizations : [];
        if (companies.length === 0) {
            const fresh = await amClient.getCompanies(tok.access_token);
            companies = Array.isArray(fresh) ? fresh : (fresh?.data || []);
        }

        const byCompany = [];
        let totalCount = 0;

        for (const company of companies) {
            const companyId = company.companyId || company.id;
            const companyName = company.name || 'Unknown';
            try {
                const result = await amClient.getXeroRequests(tok.access_token, companyId, xeroType, {
                    requestStatus,
                    limit,
                    ...analysisFilters
                });
                totalCount += result.items.length;
                byCompany.push({
                    companyId,
                    companyName,
                    count: result.items.length,
                    continuationToken: result.continuationToken,
                    items: result.items
                });
            } catch (err) {
                byCompany.push({
                    companyId,
                    companyName,
                    error: err.message,
                    status: err.status || null,
                    body: err.body || null
                });
            }
        }

        res.json({
            success: true,
            xeroType,
            requestStatus: requestStatus || 'ALL',
            filters: analysisFilters,
            entityCount: companies.length,
            totalCount,
            byCompany
        });
    } catch (error) {
        res.status(error.status || 500).json({ success: false, error: error.message });
    }
});

// GET /api/xero/:type/:companyId - single type for a single entity
// NOT paginated - returns one page of items. Caller can pass continuationToken to get next.
app.get('/api/xero/:type/:companyId', async (req, res) => {
    try {
        const tok = await requireToken();
        const xeroType = req.params.type;
        const companyId = req.params.companyId;
        const requestStatus = req.query.requestStatus || undefined;
        const limit = Number(req.query.limit || 100);
        const continuationToken = req.query.continuationToken;
        const analysisFilters = extractAnalysisFilters(req.query);

        const result = await amClient.getXeroRequests(tok.access_token, companyId, xeroType, {
            requestStatus,
            limit,
            continuationToken,
            ...analysisFilters
        });

        res.json({
            success: true,
            xeroType,
            companyId,
            requestStatus: requestStatus || 'ALL',
            filters: analysisFilters,
            count: result.items.length,
            continuationToken: result.continuationToken,
            items: result.items
        });
    } catch (error) {
        res.status(error.status || 500).json({
            success: false,
            xeroType: req.params.type,
            companyId: req.params.companyId,
            error: error.message,
            body: error.body || null
        });
    }
});

// GET /api/debug/raw?companyId=...&path=... - raw passthrough for reconciliation
app.get('/api/debug/raw', async (req, res) => {
    try {
        const tok = await requireToken();
        const companyId = req.query.companyId;
        const subPath = req.query.path || 'xero/purchase-orders';
        if (!companyId) {
            return res.status(400).json({ success: false, error: 'companyId query param required' });
        }
        const fullPath = `/companies/${companyId}/${subPath}`;
        const data = await amClient.rawGet(tok.access_token, fullPath);
        res.json({ success: true, requestedPath: fullPath, data });
    } catch (error) {
        res.status(error.status || 500).json({ success: false, error: error.message, body: error.body || null });
    }
});

// ────────────────────────────────────────────────────────────────────────
// Debug / health
// ────────────────────────────────────────────────────────────────────────
app.get('/debug/info', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT integration_key, expires_at, organizations,
                    (access_token IS NOT NULL) AS has_access_token,
                    (refresh_token IS NOT NULL) AS has_refresh_token,
                    created_at, updated_at, last_seen
             FROM approvalmax_tokens WHERE integration_key = $1`,
            [INTEGRATION_KEY]
        );

        const row = result.rows[0] || null;
        const expiresAt = row ? Number(row.expires_at) : null;

        res.json({
            timestamp: new Date().toISOString(),
            config: {
                clientId: APPROVALMAX_CONFIG.clientId,
                redirectUri: APPROVALMAX_CONFIG.redirectUri,
                scopes: APPROVALMAX_CONFIG.scopes
            },
            dbStatus: {
                recordExists: !!row,
                hasAccessToken: row?.has_access_token || false,
                hasRefreshToken: row?.has_refresh_token || false,
                expiresAt,
                expiresAtIso: expiresAt ? new Date(expiresAt).toISOString() : null,
                isExpired: expiresAt ? expiresAt < Date.now() : null,
                organizationCount: row?.organizations ? (Array.isArray(row.organizations) ? row.organizations.length : 0) : 0,
                createdAt: row?.created_at,
                updatedAt: row?.updated_at,
                lastSeen: row?.last_seen
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/health', async (req, res) => {
    let dbOk = false;
    try {
        await pool.query('SELECT 1');
        dbOk = true;
    } catch (e) {}

    const tokenRecord = await getApprovalMaxToken().catch(() => null);

    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        db: dbOk ? 'connected' : 'disconnected',
        authenticated: !!tokenRecord
    });
});

// Startup
app.listen(port, async () => {
    console.log('ApprovalMax API Data Tester running on port', port);
    console.log('Callback URL:', APPROVALMAX_CONFIG.redirectUri);
    console.log('DB persistence:', process.env.DATABASE_URL ? 'enabled' : 'DISABLED (no DATABASE_URL)');
    await ensureSchema();
});
