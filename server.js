// ApprovalMax API Data Tester - Complete OAuth + API Testing
// File: server.js

const express = require('express');
const fetch = require('node-fetch');
const app = express();
const port = process.env.PORT || 3000;

// ApprovalMax Configuration - USING YOUR WORKING CREDENTIALS
const APPROVALMAX_CONFIG = {
    clientId: process.env.APPROVALMAX_CLIENT_ID || '2A81A6DEEAA244C188D518BA59601780',
    clientSecret: process.env.APPROVALMAX_CLIENT_SECRET || '', // Set this in Railway env vars
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

// In-memory storage for tokens and debug data
let tokenData = {};
let debugResults = [];

app.use(express.json());
app.use(express.static('public'));

// Homepage with testing interface
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
        <h1>🔍 ApprovalMax API Data Tester</h1>
        
        <!-- Connection Status -->
        <div class="section">
            <h3>🔗 Connection Status</h3>
            <div id="connectionStatus" class="status disconnected">
                ❌ Not Connected - Need to authenticate first
            </div>
            <p><strong>Current Setup:</strong></p>
            <ul>
                <li>Client ID: ${APPROVALMAX_CONFIG.clientId}</li>
                <li>Redirect URI: ${APPROVALMAX_CONFIG.redirectUri}</li>
                <li>Token Status: <span id="tokenStatus">No tokens</span></li>
            </ul>
        </div>

        <!-- Authentication -->
        <div class="section">
            <h3>🔐 Step 1: Authentication</h3>
            <p>This will use your <span class="highlight">working OAuth credentials</span> that successfully connect to 3 organizations.</p>
            <button onclick="startAuth()">🚀 Start ApprovalMax Authentication</button>
            <div id="authResult"></div>
        </div>

        <!-- API Testing -->
        <div class="section">
            <h3>📊 Step 2: API Data Testing</h3>
            <p>Once authenticated, test these endpoints to find your Purchase Order events:</p>
            
            <div class="button-grid">
                <button onclick="testEndpoint('/companies')" disabled id="btn-companies">🏢 Test Companies</button>
                <button onclick="testEndpoint('/documents')" disabled id="btn-documents">📄 Test Documents</button>
                <button onclick="testEndpoint('/purchase-orders')" disabled id="btn-pos">🛒 Test Purchase Orders</button>
                <button onclick="testEndpoint('/bills')" disabled id="btn-bills">🧾 Test Bills</button>
            </div>
            
            <h4>🎯 Purchase Order Events (Main Focus):</h4>
            <div class="button-grid">
                <button onclick="testPOEvents()" disabled id="btn-po-events">⚡ Test PO Events</button>
                <button onclick="testPOEventsPerOrg()" disabled id="btn-po-events-org">🏢 Test PO Events Per Organization</button>
                <button onclick="debugEmptyArrays()" disabled id="btn-debug">🔍 Debug Empty Arrays Issue</button>
            </div>
            
            <div id="apiResult"></div>
        </div>

        <!-- Debug Information -->
        <div class="section">
            <h3>🐛 Debug Information</h3>
            <p>This will help us understand why you're getting empty arrays despite having 2 POs waiting for approval.</p>
            <button onclick="showDebugInfo()" disabled id="btn-debug-info">📋 Show Debug Info</button>
            <div id="debugInfo"></div>
        </div>
    </div>

    <script>
        let isAuthenticated = false;

        // Start authentication flow
        function startAuth() {
            const authUrl = '/auth/start';
            
            fetch(authUrl)
                .then(response => response.json())
                .then(data => {
                    if (data.authUrl) {
                        document.getElementById('authResult').innerHTML = 
                            '<div class="status pending">🔄 Redirecting to ApprovalMax...</div>';
                        window.location.href = data.authUrl;
                    } else {
                        document.getElementById('authResult').innerHTML = 
                            '<div class="status disconnected">❌ Error: ' + (data.error || 'Failed to generate auth URL') + '</div>';
                    }
                })
                .catch(error => {
                    document.getElementById('authResult').innerHTML = 
                        '<div class="status disconnected">❌ Network Error: ' + error.message + '</div>';
                });
        }

        // Test API endpoints
        function testEndpoint(endpoint) {
            showLoading('apiResult');
            
            fetch('/test' + endpoint)
                .then(response => response.json())
                .then(data => {
                    document.getElementById('apiResult').innerHTML = 
                        '<div class="result">' + JSON.stringify(data, null, 2) + '</div>';
                })
                .catch(error => {
                    document.getElementById('apiResult').innerHTML = 
                        '<div class="status disconnected">❌ Error: ' + error.message + '</div>';
                });
        }

        // Test Purchase Order Events specifically
        function testPOEvents() {
            showLoading('apiResult');
            fetch('/test/po-events')
                .then(response => response.json())
                .then(data => {
                    document.getElementById('apiResult').innerHTML = 
                        '<div class="result">' + JSON.stringify(data, null, 2) + '</div>';
                });
        }

        // Test PO Events per organization
        function testPOEventsPerOrg() {
            showLoading('apiResult');
            fetch('/test/po-events-per-org')
                .then(response => response.json())
                .then(data => {
                    document.getElementById('apiResult').innerHTML = 
                        '<div class="result">' + JSON.stringify(data, null, 2) + '</div>';
                });
        }

        // Debug empty arrays issue
        function debugEmptyArrays() {
            showLoading('apiResult');
            fetch('/debug/empty-arrays')
                .then(response => response.json())
                .then(data => {
                    document.getElementById('apiResult').innerHTML = 
                        '<div class="result">' + JSON.stringify(data, null, 2) + '</div>';
                });
        }

        // Show debug information
        function showDebugInfo() {
            fetch('/debug/info')
                .then(response => response.json())
                .then(data => {
                    document.getElementById('debugInfo').innerHTML = 
                        '<div class="result">' + JSON.stringify(data, null, 2) + '</div>';
                });
        }

        // Helper functions
        function showLoading(elementId) {
            document.getElementById(elementId).innerHTML = 
                '<div class="status pending">🔄 Loading...</div>';
        }

        function enableButtons() {
            const buttons = ['btn-companies', 'btn-documents', 'btn-pos', 'btn-bills', 
                           'btn-po-events', 'btn-po-events-org', 'btn-debug', 'btn-debug-info'];
            buttons.forEach(id => {
                document.getElementById(id).disabled = false;
            });
        }

        // Check authentication status on page load
        fetch('/auth/status')
            .then(response => response.json())
            .then(data => {
                if (data.authenticated) {
                    document.getElementById('connectionStatus').innerHTML = 
                        '✅ Connected - Ready to test API endpoints';
                    document.getElementById('connectionStatus').className = 'status connected';
                    document.getElementById('tokenStatus').textContent = 'Valid access token available';
                    enableButtons();
                    isAuthenticated = true;
                }
            })
            .catch(() => {
                // Ignore errors on page load
            });
    </script>
</body>
</html>
    `);
});

// Generate auth URL and redirect
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
        
        // Store state for verification
        tokenData.state = state;
        
        res.json({ authUrl });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// OAuth callback handler - FIXED TO MATCH APPROVALMAX REDIRECT
app.get('/callback/approvalmax', async (req, res) => {
    try {
        const { code, state, error } = req.query;
        
        console.log('🎯 ApprovalMax callback received:', { code: !!code, state, error });
        
        if (error) {
            return res.status(400).send(`
                <h1>❌ ApprovalMax Authorization Failed</h1>
                <p>Error: ${error}</p>
                <p>Description: ${req.query.error_description || 'No description provided'}</p>
                <a href="/">🏠 Back to Home</a>
            `);
        }

        if (!code) {
            return res.status(400).send(`
                <h1>❌ No Authorization Code</h1>
                <p>ApprovalMax did not provide an authorization code.</p>
                <a href="/">🏠 Back to Home</a>
            `);
        }

        // Exchange code for tokens
        const tokenResponse = await fetch(APPROVALMAX_CONFIG.tokenUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
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
            console.error('❌ Token exchange failed:', tokens);
            return res.status(400).send(`
                <h1>❌ Token Exchange Failed</h1>
                <p>Error: ${tokens.error}</p>
                <p>Description: ${tokens.error_description || 'No description provided'}</p>
                <a href="/">🏠 Back to Home</a>
            `);
        }

        // Store tokens
        tokenData.accessToken = tokens.access_token;
        tokenData.refreshToken = tokens.refresh_token;
        tokenData.expiresAt = Date.now() + (tokens.expires_in * 1000);
        
        console.log('✅ ApprovalMax tokens obtained successfully');
        
        res.send(`
            <h1>🎉 ApprovalMax Authentication Successful!</h1>
            <p>✅ Access token obtained</p>
            <p>✅ Ready to test API endpoints</p>
            <p><strong>Next steps:</strong></p>
            <ol>
                <li>Go back to the <a href="/">testing interface</a></li>
                <li>Test the Purchase Order Events endpoint</li>
                <li>Debug why you're getting empty arrays</li>
            </ol>
            <script>
                setTimeout(() => {
                    window.location.href = '/';
                }, 3000);
            </script>
        `);

    } catch (error) {
        console.error('❌ Callback error:', error);
        res.status(500).send(`
            <h1>❌ Server Error</h1>
            <p>Error: ${error.message}</p>
            <a href="/">🏠 Back to Home</a>
        `);
    }
});

// Check authentication status
app.get('/auth/status', (req, res) => {
    const authenticated = !!(tokenData.accessToken && tokenData.expiresAt > Date.now());
    res.json({ 
        authenticated,
        expiresAt: tokenData.expiresAt,
        hasRefreshToken: !!tokenData.refreshToken
    });
});

// Helper function to make authenticated API requests
async function makeApiRequest(endpoint, options = {}) {
    if (!tokenData.accessToken) {
        throw new Error('No access token available');
    }

    const url = `${APPROVALMAX_CONFIG.baseUrl}${endpoint}`;
    const response = await fetch(url, {
        ...options,
        headers: {
            'Authorization': `Bearer ${tokenData.accessToken}`,
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

// Test endpoints
app.get('/test/companies', async (req, res) => {
    try {
        const result = await makeApiRequest('/companies');
        res.json({
            success: true,
            endpoint: '/companies',
            ...result
        });
    } catch (error) {
        res.json({
            success: false,
            endpoint: '/companies',
            error: error.message
        });
    }
});

app.get('/test/documents', async (req, res) => {
    try {
        const result = await makeApiRequest('/documents?limit=20');
        res.json({
            success: true,
            endpoint: '/documents',
            count: result.data?.length || 0,
            ...result
        });
    } catch (error) {
        res.json({
            success: false,
            endpoint: '/documents',
            error: error.message
        });
    }
});

app.get('/test/purchase-orders', async (req, res) => {
    try {
        const result = await makeApiRequest('/purchase-orders?limit=20');
        res.json({
            success: true,
            endpoint: '/purchase-orders',
            count: result.data?.length || 0,
            ...result
        });
    } catch (error) {
        res.json({
            success: false,
            endpoint: '/purchase-orders',
            error: error.message
        });
    }
});

app.get('/test/bills', async (req, res) => {
    try {
        const result = await makeApiRequest('/bills?limit=20');
        res.json({
            success: true,
            endpoint: '/bills',
            count: result.data?.length || 0,
            ...result
        });
    } catch (error) {
        res.json({
            success: false,
            endpoint: '/bills',
            error: error.message
        });
    }
});

// MAIN FOCUS: Purchase Order Events Testing - UPDATED WITH REAL ENDPOINTS
app.get('/test/po-events', async (req, res) => {
    try {
        // Try the REAL ApprovalMax endpoints based on SyncHub documentation
        const attempts = [
            '/xero-purchase-order',
            '/xero-bill', 
            '/quickbooks-purchase-order',
            '/quickbooks-bill',
            '/workflow',
            '/document'
        ];

        const results = {};
        
        for (const endpoint of attempts) {
            try {
                const result = await makeApiRequest(endpoint + '?limit=50');
                results[endpoint] = {
                    success: true,
                    count: result.data?.length || 0,
                    data: result.data
                };
            } catch (error) {
                results[endpoint] = {
                    success: false,
                    error: error.message
                };
            }
        }

        res.json({
            message: 'Testing REAL ApprovalMax endpoints from SyncHub documentation',
            attempts,
            results
        });
    } catch (error) {
        res.json({
            success: false,
            error: error.message
        });
    }
});

// Test PO Events per organization
app.get('/test/po-events-per-org', async (req, res) => {
    try {
        // First get organizations
        const companiesResult = await makeApiRequest('/companies');
        const organizations = companiesResult.data || [];

        const results = {
            organizations: organizations.map(org => ({ id: org.id, name: org.name })),
            poEventsByOrg: {}
        };

        // Test PO events for each organization
        for (const org of organizations) {
            try {
                const poResult = await makeApiRequest(`/purchase-orders?organizationId=${org.id}&limit=50`);
                results.poEventsByOrg[org.name] = {
                    organizationId: org.id,
                    purchaseOrders: poResult.data?.length || 0,
                    data: poResult.data || []
                };

                // Also try to get events for each PO
                if (poResult.data && poResult.data.length > 0) {
                    for (const po of poResult.data.slice(0, 5)) { // Limit to first 5 POs
                        try {
                            const eventsResult = await makeApiRequest(`/purchase-orders/${po.id}/events`);
                            if (!results.poEventsByOrg[org.name].events) {
                                results.poEventsByOrg[org.name].events = {};
                            }
                            results.poEventsByOrg[org.name].events[po.id] = eventsResult.data;
                        } catch (eventError) {
                            // Event endpoint might not exist
                        }
                    }
                }
            } catch (error) {
                results.poEventsByOrg[org.name] = {
                    error: error.message
                };
            }
        }

        res.json(results);
    } catch (error) {
        res.json({
            success: false,
            error: error.message
        });
    }
});

// Debug empty arrays issue
app.get('/debug/empty-arrays', async (req, res) => {
    try {
        const debug = {
            timestamp: new Date().toISOString(),
            problem: "Getting empty arrays despite 2 POs waiting for approval",
            knownFacts: {
                mining: "1 PO waiting for approval",
                enterprise: "1 PO waiting for approval", 
                totalExpected: 2
            },
            tests: {}
        };

        // Test 1: Basic PO endpoint
        try {
            const poResult = await makeApiRequest('/purchase-orders');
            debug.tests.basicPOs = {
                success: true,
                count: poResult.data?.length || 0,
                isEmpty: !poResult.data || poResult.data.length === 0,
                sampleData: poResult.data?.slice(0, 3) || []
            };
        } catch (error) {
            debug.tests.basicPOs = { success: false, error: error.message };
        }

        // Test 2: POs with different status filters
        const statusFilters = ['pending', 'waiting', 'awaiting', 'submitted', 'draft'];
        debug.tests.statusFilters = {};
        
        for (const status of statusFilters) {
            try {
                const result = await makeApiRequest(`/purchase-orders?status=${status}`);
                debug.tests.statusFilters[status] = {
                    count: result.data?.length || 0,
                    data: result.data?.slice(0, 2) || []
                };
            } catch (error) {
                debug.tests.statusFilters[status] = { error: error.message };
            }
        }

        // Test 3: Documents endpoint (might contain POs)
        try {
            const docResult = await makeApiRequest('/documents?limit=50');
            const poDocuments = docResult.data?.filter(doc => 
                doc.type === 'PurchaseOrder' || 
                doc.documentType === 'PurchaseOrder' ||
                (doc.name && doc.name.toLowerCase().includes('purchase'))
            ) || [];
            
            debug.tests.documentsAsPOs = {
                totalDocuments: docResult.data?.length || 0,
                poDocuments: poDocuments.length,
                poData: poDocuments.slice(0, 3)
            };
        } catch (error) {
            debug.tests.documentsAsPOs = { error: error.message };
        }

        // Test 4: Check what statuses actually exist
        try {
            const allPOs = await makeApiRequest('/purchase-orders?limit=100');
            const statuses = [...new Set((allPOs.data || []).map(po => po.status).filter(Boolean))];
            debug.tests.actualStatuses = {
                uniqueStatuses: statuses,
                totalPOs: allPOs.data?.length || 0
            };
        } catch (error) {
            debug.tests.actualStatuses = { error: error.message };
        }

        res.json(debug);
    } catch (error) {
        res.json({
            success: false,
            error: error.message
        });
    }
});

// Debug info endpoint
app.get('/debug/info', (req, res) => {
    res.json({
        timestamp: new Date().toISOString(),
        config: {
            clientId: APPROVALMAX_CONFIG.clientId,
            redirectUri: APPROVALMAX_CONFIG.redirectUri,
            scopes: APPROVALMAX_CONFIG.scopes
        },
        tokenStatus: {
            hasAccessToken: !!tokenData.accessToken,
            hasRefreshToken: !!tokenData.refreshToken,
            expiresAt: tokenData.expiresAt,
            isExpired: tokenData.expiresAt ? tokenData.expiresAt < Date.now() : null
        },
        debugResults: debugResults.slice(-5) // Last 5 debug results
    });
});

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        authenticated: !!(tokenData.accessToken && tokenData.expiresAt > Date.now())
    });
});

app.listen(port, () => {
    console.log(`🎯 ApprovalMax API Data Tester running on port ${port}`);
    console.log(`📡 Callback URL: ${APPROVALMAX_CONFIG.redirectUri}`);
    console.log(`🌐 Test URL: ${APPROVALMAX_CONFIG.redirectUri.replace('/callback/approvalmax', '')}`);
    console.log(`🔍 Focus: Purchase Order Events debugging`);
    console.log(`💡 Goal: Find why we get empty arrays when 2 POs are waiting for approval`);
});
