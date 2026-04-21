// ApprovalMax Public API client - wraps the real typed endpoints
// File: approvalmax-client.js
//
// Reference: https://public-api.approvalmax.com/swagger/v1/swagger.json
// Key findings:
//   - Each request type has its own endpoint: /xero/bills, /xero/purchase-orders, etc.
//   - Query param is "requestStatus" (NOT "status")
//   - Paged responses return { payload: [...], continuationToken: "..." }

const fetch = require('node-fetch');

const BASE_URL = 'https://public-api.approvalmax.com/api/v1';

// Xero request types we currently support fetching
// Values map to URL path segments: /api/v1/companies/{id}/xero/{type}
const XERO_TYPES = [
    'purchase-orders',
    'bills',
    'credit-notes',
    'sales-invoices',
    'batch-payments',
    'quotes'
];

// Extract a readable error message from an AM error body.
// AM returns ASP.NET-style problem details, and validation errors come as
// { errors: { fieldName: ["...reason..."] } } rather than a plain string.
function extractErrorMessage(data, status) {
    if (!data) return `HTTP ${status}`;
    if (typeof data.error === 'string') return data.error;
    if (typeof data.message === 'string') return data.message;
    if (typeof data.detail === 'string') return data.detail;
    if (typeof data.title === 'string' && !data.errors) return data.title;
    // ASP.NET model validation: { errors: { requestStatus: ["..."] } }
    if (data.errors && typeof data.errors === 'object') {
        try {
            return 'Validation: ' + JSON.stringify(data.errors);
        } catch (e) { /* fall through */ }
    }
    // Fallback: serialise the body (truncated)
    try {
        const s = JSON.stringify(data);
        return s.length > 800 ? s.slice(0, 800) + '...' : s;
    } catch (e) {
        return `HTTP ${status}`;
    }
}

// Core HTTP helper - all API methods route through here
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
        const errMsg = extractErrorMessage(data, response.status);
        const err = new Error(`AM API ${response.status}: ${errMsg}`);
        err.status = response.status;
        err.body = data;
        err.url = url;
        throw err;
    }

    return data;
}

// Build query string from filter object
function buildQueryString(filters = {}) {
    const { requestStatus, limit = 100, continuationToken, reference, documentNumber,
            createdAtOrAfter, modifiedAtOrAfter, decidedAtOrAfter,
            orderBy, orderDirection } = filters;

    const params = new URLSearchParams();
    if (requestStatus) params.append('requestStatus', requestStatus);
    if (limit) params.append('limit', String(limit));
    if (continuationToken) params.append('continuationToken', continuationToken);
    if (reference) params.append('reference', reference);
    if (documentNumber) params.append('documentNumber', documentNumber);
    if (createdAtOrAfter) params.append('createdAtOrAfter', createdAtOrAfter);
    if (modifiedAtOrAfter) params.append('modifiedAtOrAfter', modifiedAtOrAfter);
    if (decidedAtOrAfter) params.append('decidedAtOrAfter', decidedAtOrAfter);
    if (orderBy) params.append('orderBy', orderBy);
    if (orderDirection) params.append('orderDirection', orderDirection);

    const qs = params.toString();
    return qs ? '?' + qs : '';
}

// Normalise AM paged response shape
function normalisePagedResponse(data) {
    if (!data) return { items: [], continuationToken: null, raw: data };
    // Official shape: { payload: [...], continuationToken: "..." }
    if (Array.isArray(data.payload)) {
        return {
            items: data.payload,
            continuationToken: data.continuationToken || null,
            raw: data
        };
    }
    // Fallback for shapes we haven't seen yet
    if (Array.isArray(data)) {
        return { items: data, continuationToken: null, raw: data };
    }
    return { items: [], continuationToken: null, raw: data };
}

// Companies
async function getCompanies(accessToken) {
    return callAM(accessToken, '/companies');
}

// Xero requests (generic by type)
async function getXeroRequests(accessToken, companyId, xeroType, filters = {}) {
    const qs = buildQueryString(filters);
    const data = await callAM(accessToken, `/companies/${companyId}/xero/${xeroType}${qs}`);
    return normalisePagedResponse(data);
}

async function getXeroRequest(accessToken, companyId, xeroType, requestId) {
    return callAM(accessToken, `/companies/${companyId}/xero/${xeroType}/${requestId}`);
}

async function getXeroPurchaseOrders(accessToken, companyId, filters = {}) {
    return getXeroRequests(accessToken, companyId, 'purchase-orders', filters);
}
async function getXeroBills(accessToken, companyId, filters = {}) {
    return getXeroRequests(accessToken, companyId, 'bills', filters);
}
async function getXeroCreditNotes(accessToken, companyId, filters = {}) {
    return getXeroRequests(accessToken, companyId, 'credit-notes', filters);
}
async function getXeroSalesInvoices(accessToken, companyId, filters = {}) {
    return getXeroRequests(accessToken, companyId, 'sales-invoices', filters);
}
async function getXeroBatchPayments(accessToken, companyId, filters = {}) {
    return getXeroRequests(accessToken, companyId, 'batch-payments', filters);
}
async function getXeroQuotes(accessToken, companyId, filters = {}) {
    return getXeroRequests(accessToken, companyId, 'quotes', filters);
}

async function rawGet(accessToken, path) {
    return callAM(accessToken, path.startsWith('/') ? path : '/' + path);
}

module.exports = {
    BASE_URL,
    XERO_TYPES,
    getCompanies,
    getXeroRequests,
    getXeroRequest,
    getXeroPurchaseOrders,
    getXeroBills,
    getXeroCreditNotes,
    getXeroSalesInvoices,
    getXeroBatchPayments,
    getXeroQuotes,
    rawGet,
    extractErrorMessage
};
