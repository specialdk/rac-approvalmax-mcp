// ApprovalMax API Data Tester - OAuth + DB-backed token persistence
// File: server.js

const express = require('express');
const fetch = require('node-fetch');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3000;

// ApprovalMax Configuration
const APPROVALMAX_CONFIG = {
    clientId: process.env.APPROVALMAX_CLIENT_ID || '2A81A6DEEAA244C188D518BA59601780',
    clientSecret: process.env.APPROVALMAX_CLIENT_SECRET || '', // Set in Railway env vars
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

// Singleton integration key - AM issues one token per user unlocking multiple companies
const INTEGRATION_KEY = 'approvalmax_integration';

// Postgres connection pool
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

pool.on('error', (err) => {
    console.error('Unexpected DB pool error:', err.message);
});

// Auto-migration on startup
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

// Token storage helpers
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

    // Store the new tokens. AM may rotate the refresh token.
    await storeApprovalMaxToken(tokens);
    console.log('Token refreshed successfully');
    return tokens.access_token;
}

async function getApprovalMaxToken() {
    const result = await pool.query(
        'SELECT access_token, refresh_token, expires_at, organizations FROM approvalmax_tokens WHERE integration_key = $1',
        [INTEGRATION_KEY]
    );

    if (result.rows.length === 0) {
        return null;
    }

    const row = result.rows[0];
    const now = Date.now();
    const expiresAt = Number(row.expires_at);
    const fiveMinutes = 5 * 60 * 1000;

    if (expiresAt > now + fiveMinutes) {
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
            console.error('Refresh failed, token is unusable:', err.message);
            return null;
        }
    }

    console.warn('Token expired and no refresh_token available - user must re-consent');
    return null;
}

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Homepage
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>ApprovalMax API Data Tester</title>
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
        .result {
            background: #1f2937;
            color: #f9fafb;
            padding: 15px;
            border-radius: 6px;
            font-family: monospace;
            font-size: 12px;
            white-space: pre-wrap;
            max-height: 400px;
            overflow-y: auto;
            margin: 10px 0;
        }
        .button-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 10px;
            margin: 15px 0;
        }
        .highlight { background: #fef3c7; padding: 2px 4px; border-radius: 3px; }
    </style>
</head>
<body>
    <div class="container">
        <h1>ApprovalMax API Data Tester</h1>

        <div class="section">
            <h3>Connection Status</h3>
            <div id="connectionStatus" class="status disconnected">
                Not Connected - Need to authenticate first
            </div>
            <p><strong>Current Setup:</strong></p>
            <ul>
                <li>Client ID: ${APPROVALMAX_CONFIG.clientId}</li>
                <li>Redirect URI: ${APPROVALMAX_CONFIG.redirectUri}</li>
                <li>Token Status: <span id="tokenStatus">Checking...</span></li>
                <li>Persistence: <span class="highlight">Postgres (survives restarts)</span></li>
            </ul>
        </div>

        <div class="section">
            <h3>Step 1: Authentication</h3>
            <p>Runs the ApprovalMax OAuth flow. Tokens now persist in the database and auto-refresh before expiry.</p>
            <button onclick="startAuth()">Start ApprovalMax Authentication</button>
            <div id="authResult"></div>
        </div>

        <div class="section">
            <h3>Step 2: API Data Testing</h3>
            <p>Once authenticated, test the endpoints:</p>

            <div class="button-grid">
                <button onclick="testEndpoint('/companies')" disabled id="btn-companies">Test Companies</button>
                <button onclick="testEndpoint('/documents')" disabled id="btn-documents">Test Documents</button>
                <button onclick="testEndpoint('/purchase-orders')" disabled id="btn-pos">Test Purchase Orders</button>
                <button onclick="testEndpoint('/bills')" disabled id="btn-bills">Test Bills</button>
            </div>

            <div id="apiResult"></div>
        </div>

        <div class="section">
            <h3>Debug Information</h3>
            <p>View the current token state held in the database.</p>
            <button onclick="showDebugInfo()">Show Debug Info</button>
            <div id="debugInfo"></div>
        </div>
    </div>

    <script>
        let isAuthenticated = false;

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
                            '<div class="status disconnected">Error: ' + (data.error || 'Failed to generate auth URL') + '</div>';
                    }
                })
                .catch(err => {
                    document.getElementById('authResult').innerHTML =
                        '<div class="status disconnected">Network Error: ' + err.message + '</div>';
                });
        }

        function testEndpoint(endpoint) {
            showLoading('apiResult');
            fetch('/test' + endpoint)
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

        function showLoading(elementId) {
            document.getElementById(elementId).innerHTML =
                '<div class="status pending">Loading...</div>';
        }

        function enableButtons() {
            ['btn-companies', 'btn-documents', 'btn-pos', 'btn-bills'].forEach(id => {
                document.getElementById(id).disabled = false;
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

// OAuth: start
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
        const authUrl = `${APPROVALMAX_CONFIG.authUrl}?${params.toString()}`;
        res.json({ authUrl });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// OAuth: callback (DB-backed)
app.get('/callback/approvalmax', async (req, res) => {
    try {
        const { code, state, error } = req.query;
        console.log('ApprovalMax callback received:', { code: !!code, state, error });

        if (error) {
            return res.status(400).send(`
                <h1>ApprovalMax Authorization Failed</h1>
                <p>Error: ${error}</p>
                <p>Description: ${req.query.error_description || 'No description provided'}</p>
                <a href="/">Back to Home</a>
            `);
        }

        if (!code) {
            return res.status(400).send(`
                <h1>No Authorization Code</h1>
                <p>ApprovalMax did not provide an authorization code.</p>
                <a href="/">Back to Home</a>
            `);
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
            return res.status(400).send(`
                <h1>Token Exchange Failed</h1>
                <p>Error: ${tokens.error}</p>
                <p>Description: ${tokens.error_description || 'No description provided'}</p>
                <a href="/">Back to Home</a>
            `);
        }

        // Fetch company list with the new token so we can persist orgs alongside the token
        let organizations = null;
        try {
            const companiesResp = await fetch(`${APPROVALMAX_CONFIG.baseUrl}/companies`, {
                headers: {
                    'Authorization': `Bearer ${tokens.access_token}`,
                    'Accept': 'application/json'
                }
            });
            if (companiesResp.ok) {
                const companiesData = await companiesResp.json();
                organizations = Array.isArray(companiesData) ? companiesData : (companiesData.data || null);
                console.log('Retrieved', organizations ? organizations.length : 0, 'organizations');
            } else {
                console.warn('Could not fetch companies list on callback');
            }
        } catch (e) {
            console.warn('Error fetching companies on callback:', e.message);
        }

        await storeApprovalMaxToken(tokens, organizations);

        const orgCount = organizations ? organizations.length : 0;
        res.send(`
            <h1>ApprovalMax Authentication Successful</h1>
            <p>Access token obtained and persisted to database</p>
            <p>${orgCount} organisation(s) linked</p>
            <p>Refresh token stored - will auto-refresh before expiry</p>
            <p>Redirecting back to the tester in 3 seconds...</p>
            <script>setTimeout(() => { window.location.href = '/'; }, 3000);</script>
        `);

    } catch (error) {
        console.error('Callback error:', error);
        res.status(500).send(`
            <h1>Server Error</h1>
            <p>Error: ${error.message}</p>
            <a href="/">Back to Home</a>
        `);
    }
});

// Auth status (DB-backed)
app.get('/auth/status', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT access_token, refresh_token, expires_at, organizations FROM approvalmax_tokens WHERE integration_key = $1',
            [INTEGRATION_KEY]
        );

        if (result.rows.length === 0) {
            return res.json({ authenticated: false });
        }

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

// API helper (DB-backed with auto-refresh)
async function makeApiRequest(endpoint, options = {}) {
    const tokenRecord = await getApprovalMaxToken();
    if (!tokenRecord) {
        throw new Error('No valid access token - please authenticate');
    }

    const url = `${APPROVALMAX_CONFIG.baseUrl}${endpoint}`;
    const response = await fetch(url, {
        ...options,
        headers: {
            'Authorization': `Bearer ${tokenRecord.access_token}`,
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            ...(options.headers || {})
        }
    });

    const data = await response.json();

    if (!response.ok) {
        throw new Error(`API Error: ${response.status} - ${data.error || data.message || 'Unknown error'}`);
    }

    return { status: response.status, data, headers: response.headers };
}

// Test endpoints (legacy test paths - most will 404 against real AM, kept for reference)
app.get('/test/companies', async (req, res) => {
    try {
        const result = await makeApiRequest('/companies');
        res.json({ success: true, endpoint: '/companies', ...result });
    } catch (error) {
        res.json({ success: false, endpoint: '/companies', error: error.message });
    }
});

app.get('/test/documents', async (req, res) => {
    try {
        const result = await makeApiRequest('/documents?limit=20');
        res.json({ success: true, endpoint: '/documents', count: result.data?.length || 0, ...result });
    } catch (error) {
        res.json({ success: false, endpoint: '/documents', error: error.message });
    }
});

app.get('/test/purchase-orders', async (req, res) => {
    try {
        const result = await makeApiRequest('/purchase-orders?limit=20');
        res.json({ success: true, endpoint: '/purchase-orders', count: result.data?.length || 0, ...result });
    } catch (error) {
        res.json({ success: false, endpoint: '/purchase-orders', error: error.message });
    }
});

app.get('/test/bills', async (req, res) => {
    try {
        const result = await makeApiRequest('/bills?limit=20');
        res.json({ success: true, endpoint: '/bills', count: result.data?.length || 0, ...result });
    } catch (error) {
        res.json({ success: false, endpoint: '/bills', error: error.message });
    }
});

// Debug info (DB-backed)
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
                expiresAt: expiresAt,
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

// Health check
app.get('/health', async (req, res) => {
    let dbOk = false;
    try {
        await pool.query('SELECT 1');
        dbOk = true;
    } catch (e) {
        // leave dbOk false
    }

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
    console.log('Test URL:', APPROVALMAX_CONFIG.redirectUri.replace('/callback/approvalmax', ''));
    console.log('DB persistence:', process.env.DATABASE_URL ? 'enabled' : 'DISABLED (no DATABASE_URL)');
    await ensureSchema();
});
