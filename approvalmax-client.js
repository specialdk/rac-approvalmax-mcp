// ApprovalMax Public API client - thin wrapper around the real endpoints
// File: approvalmax-client.js

const fetch = require('node-fetch');

const BASE_URL = 'https://public-api.approvalmax.com/api/v1';

// Core helper - all API methods route through this
async function callAM(accessToken, path, options = {}) {
    const url = `${BASE_URL}${path}`;
    const response = await fetch(url, {
        ...options,
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            ...(options.headers || {})
        }
    });

    // Try to parse JSON but handle empty responses
    let data = null;
    const text = await response.text();
    if (text) {
        try {
            data = JSON.parse(text);
        } catch (e) {
            data = { raw: text };
        }
    }

    if (!response.ok) {
        const errMsg = data?.error || data?.message || data?.title || `HTTP ${response.status}`;
        const err = new Error(`AM API ${response.status}: ${errMsg}`);
        err.status = response.status;
        err.body = data;
        throw err;
    }

    return data;
}

// ── Companies ────────────────────────────────────────────────────────────
async function getCompanies(accessToken) {
    return callAM(accessToken, '/companies');
}

// ── Requests (the core entity - covers POs, Bills, Sales Invoices, etc.) ─
async function getRequests(accessToken, companyId, filters = {}) {
    const { status, limit = 100, continuationToken } = filters;
    const params = new URLSearchParams();
    if (status) params.append('status', status);
    if (limit) params.append('limit', String(limit));
    if (continuationToken) params.append('continuationToken', continuationToken);

    const qs = params.toString();
    const path = `/companies/${companyId}/requests${qs ? '?' + qs : ''}`;
    return callAM(accessToken, path);
}

async function getRequest(accessToken, companyId, requestId) {
    return callAM(accessToken, `/companies/${companyId}/requests/${requestId}`);
}

// ── Raw passthrough for debug/reconciliation ─────────────────────────────
async function rawGet(accessToken, path) {
    return callAM(accessToken, path.startsWith('/') ? path : '/' + path);
}

module.exports = {
    getCompanies,
    getRequests,
    getRequest,
    rawGet,
    BASE_URL
};
