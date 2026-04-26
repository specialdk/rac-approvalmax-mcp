// ApprovalMax API Data Tester - OAuth + DB persistence + real Xero endpoints
// File: server.js

const express = require('express');
const fetch = require('node-fetch');
const { Pool } = require('pg');
const amClient = require('./approvalmax-client');
const welfare = require('./welfare-categoriser');
const {
    handleBudgetVsActual,
    makeUnknownReconciliationHandler,
    makeDraftCleanupHandler
} = require('./xero-proxy');

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
const MAX_PAGES_PER_COUNT = 20;
const MAX_PAGES_FOR_WELFARE = 35;
const MAX_PAGES_FOR_ENTITY_SCAN = 30;

// Statuses that represent genuine procurement intent / commitment at RAC.
// AM at RAC operates as a visibility and compliance layer over decisions the
// business has already made; rejection is rare and usually corrective
// (wrong entity, re-raise) rather than a real veto. So both approved and
// onApproval are included in committed-spend figures.
//
// Drafts are treated as intent-only and excluded from financial totals —
// AM auto-saves partial form state when a user abandons a PO (no explicit
// "discard" action), producing a long tail of zero/low-value abandoned
// records that inflate "Unknown supplier" in the old aggregate view.
// Rejected and cancelled are dead records and also excluded.
//
// See dashboard methodology caption for the user-facing explanation.
const FINANCIAL_STATUSES = new Set(['approved', 'onApproval']);

function extractAnalysisFilters(query) {
    return {
        createdAtOrAfter: query.createdAtOrAfter || undefined,
        orderBy: query.orderBy || undefined,
        orderDirection: query.orderDirection || undefined
    };
}

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

// Helper (Day 3g, revised Day 4): given an array of POs, return aggregate
// shape data. Split into two passes:
//
//   - Financial pass: sums $, supplier totals, account totals across POs
//     whose requestStatus is in FINANCIAL_STATUSES (approved, onApproval).
//     Drives all committed-spend-facing cards on the dashboard.
//
//   - Governance pass: counts all POs by status regardless of financial
//     inclusion. Sums dollar value of drafts separately so the governance
//     drawer can show "$X parked in drafts — not counted in committed".
//
// Changes vs original summarisePosShape:
//   - totalValue now excludes draft/rejected/cancelled
//   - supplierTotals / accountTotals exclude same → no more fake "Unknown" row
//     driven by 75+ blank-supplier drafts in Enterprises etc.
//   - statusCounts still covers all statuses for the governance drawer
//   - New fields: financialPosCount, draftValue, onApprovalValue
//   - posTotal stays = full count (dashboard KPI "Total POs" unchanged)
function summarisePosShape(pos) {
    // --- Governance pass: every PO, status counts + draft-value tally ---
    const statusCounts = {};
    let draftValue = 0;
    let draftCount = 0;
    let onApprovalValue = 0;
    let onApprovalCount = 0;
    let earliestDate = null;
    let latestDate = null;

    for (const po of pos) {
        const status = po.requestStatus || 'unknown';
        statusCounts[status] = (statusCounts[status] || 0) + 1;

        if (status === 'draft') {
            draftCount += 1;
            draftValue += (po.total || 0);
        } else if (status === 'onApproval') {
            onApprovalCount += 1;
            onApprovalValue += (po.total || 0);
        }

        const poDate = po.createdAt || po.date || po.modifiedAt || null;
        if (poDate) {
            if (!earliestDate || poDate < earliestDate) earliestDate = poDate;
            if (!latestDate || poDate > latestDate) latestDate = poDate;
        }
    }

    // --- Financial pass: approved + onApproval only ---
    let totalValue = 0;
    let financialPosCount = 0;
    const supplierCounts = {};
    const supplierTotals = {};
    const accountTotals = {};

    for (const po of pos) {
        const status = po.requestStatus || 'unknown';
        if (!FINANCIAL_STATUSES.has(status)) continue;

        financialPosCount += 1;
        totalValue += (po.total || 0);

        // Supplier aggregation. The old code had `po.contact || 'Unknown'`
        // which converted every blank-supplier PO into a phantom "Unknown"
        // supplier. Now that drafts (where blanks cluster) are excluded,
        // blanks in the remaining pool are rare and we keep the fallback
        // label so they still surface if they exist.
        const supplier = po.contact || '(blank)';
        supplierTotals[supplier] = (supplierTotals[supplier] || 0) + (po.total || 0);
        supplierCounts[supplier] = (supplierCounts[supplier] || 0) + 1;

        if (Array.isArray(po.lineItems)) {
            // Job/tracking rollup: collect every distinct option name across
            // all lines on this PO, normalised to upper-case for matching.
            // Stored on the PO so welfare-categoriser can read it without
            // walking line items again. AM exposes tracking at line level
            // only — there's no PO-level tracking field.
            const jobSet = new Set();

            for (const li of po.lineItems) {
                // Existing account aggregation
                const code = li.accountCode;
                if (code) {
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

                // NEW: collect Job tracking options for this line
                if (Array.isArray(li.tracking)) {
                    for (const t of li.tracking) {
                        if (t && t.categoryName === 'Job' && t.optionName) {
                            jobSet.add(t.optionName);
                        }
                    }
                }
            }

            // Stash the rollup on the PO so downstream code can use it
            if (jobSet.size > 0) {
                po.jobCodes = Array.from(jobSet);
            }
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
        // Financial figures (committed/spend) — approved + onApproval only
        totalValue: r2(totalValue),
        financialPosCount,
        topSuppliersByValue,
        topAccountsByValue,
        uniqueSuppliers: Object.keys(supplierTotals).length,
        uniqueAccountCodes: Object.keys(accountTotals).length,

        // Governance figures — all statuses
        statusCounts,
        draftCount,
        draftValue: r2(draftValue),
        onApprovalCount,
        onApprovalValue: r2(onApprovalValue),

        // Date span covers everything fetched, not just financials
        earliestDate,
        latestDate
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
app.get('/api/budget-vs-actual', handleBudgetVsActual);

app.get('/api/unknown-reconciliation', makeUnknownReconciliationHandler({
    amClient,
    fetchAllPages,
    requireToken,
    maxPages: MAX_PAGES_FOR_ENTITY_SCAN
}));

app.get('/api/draft-cleanup', makeDraftCleanupHandler({
    amClient,
    fetchAllPages,
    requireToken,
    maxPages: MAX_PAGES_FOR_ENTITY_SCAN
}));

// ────────────────────────────────────────────────────────────────────────
// Homepage — admin / OAuth-setup and ad-hoc test controls.
// This is the page used to re-authenticate ApprovalMax and to poke at
// API shapes during development. The main user dashboard lives at
// /dashboard.html (served from public/).
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
        .highlight { background: #fef3c7; padding: 2px 4px; border-radius: 3px; }
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
                <li>Main dashboard: <a href="/dashboard.html">/dashboard.html</a></li>
            </ul>
        </div>

        <div class="section">
            <h3>Authentication</h3>
            <p>Runs the ApprovalMax OAuth flow. Tokens persist and auto-refresh before expiry.</p>
            <button onclick="startAuth()">Start ApprovalMax Authentication</button>
            <div id="authResult"></div>
        </div>

        <div class="section scan">
            <h3>Ad-hoc API probes</h3>
            <p style="color: #64748b; font-size: 13px;">
                Direct hits against the real endpoints. Useful for debugging.
                Each opens JSON output below.
            </p>
            <div class="button-grid">
                <button onclick="callApi('/api/companies')" id="btn-api-companies">GET /api/companies</button>
                <button onclick="callApi('/api/am/entity-scan')" id="btn-entity-scan" class="scan-btn">Entity scan (slow, ~60s)</button>
                <button onclick="callApi('/api/budget-vs-actual')" id="btn-budget">Budget vs Actual (all 5)</button>
                <button onclick="callApi('/api/welfare/aboriginal-corp')" id="btn-welfare">Welfare view (Aborig. Corp)</button>
                <button onclick="callApi('/api/unknown-reconciliation?entity=enterprises')" id="btn-recon">Unknown recon (Enterprises)</button>
                <button onclick="callApi('/api/draft-cleanup?entity=enterprises')" id="btn-draft">Draft cleanup (Enterprises)</button>
            </div>
            <div id="apiResult"></div>
        </div>

        <div class="section">
            <h3>Debug</h3>
            <button onclick="showDebugInfo()">Show DB Token State</button>
            <div id="debugInfo"></div>
        </div>
    </div>

    <script>
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

        function callApi(path) {
            document.getElementById('apiResult').innerHTML =
                '<div class="status pending">Loading… (some calls take 30-90s)</div>';
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

        function showDebugInfo() {
            fetch('/debug/info')
                .then(r => r.json())
                .then(data => {
                    document.getElementById('debugInfo').innerHTML =
                        '<div class="result">' + JSON.stringify(data, null, 2) + '</div>';
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
// Helper: build the ApprovalMax OAuth authorise URL.
// Used by both /auth/start (returns JSON for the existing front-end button)
// and /go (the smart bookmark - 302 redirects straight to AM consent).
function buildApprovalMaxAuthUrl() {
    const state = Math.random().toString(36).substring(2, 15);
    const params = new URLSearchParams({
        response_type: 'code',
        client_id: APPROVALMAX_CONFIG.clientId,
        scope: APPROVALMAX_CONFIG.scopes.join(' '),
        redirect_uri: APPROVALMAX_CONFIG.redirectUri,
        state: state
    });
    return `${APPROVALMAX_CONFIG.authUrl}?${params.toString()}`;
}

// Existing JSON endpoint - kept so the / homepage button still works.
app.get('/auth/start', (req, res) => {
    try {
        res.json({ authUrl: buildApprovalMaxAuthUrl() });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Smart entry point. THIS is the one bookmark users get.
//   - Token valid -> redirect to /dashboard.html
//   - Token missing/dead -> redirect straight to AM consent screen
// After AM consent, the existing /callback/approvalmax handler stores the
// token and lands the user on /dashboard.html (see callback change below).
app.get('/go', async (req, res) => {
    try {
        // Force=1 query param lets the dashboard footer "Reconnect" link
        // bypass the auth check and always re-run consent.
        if (req.query.force === '1') {
            return res.redirect(buildApprovalMaxAuthUrl());
        }

        const result = await pool.query(
            'SELECT access_token, expires_at, refresh_token FROM approvalmax_tokens WHERE integration_key = $1',
            [INTEGRATION_KEY]
        );

        const row = result.rows[0];
        const expiresAt = row ? Number(row.expires_at) : 0;
        const isAuthenticated = !!(row && row.access_token && (expiresAt > Date.now() || row.refresh_token));

        if (isAuthenticated) {
            return res.redirect('/dashboard.html');
        }

        return res.redirect(buildApprovalMaxAuthUrl());
    } catch (error) {
        console.error('/go routing error:', error);
        // Safe fallback - punt them to the homepage where they can manually fix it.
        res.redirect('/');
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
            <p>Loading dashboard…</p>
            <script>setTimeout(() => { window.location.href = '/dashboard.html'; }, 1500);</script>
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
// REAL API ENDPOINTS
// ═════════════════════════════════════════════════════════════════════════

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
                console.log(`[entity-scan] ${companyName}: ${pos.length} POs, ${shape.financialPosCount} financial, $${shape.totalValue}, drafts=${shape.draftCount}($${shape.draftValue}), ${pages} pages (capped=${capped})`);
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
