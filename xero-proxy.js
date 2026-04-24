// xero-proxy.js (Day 3j)
//
// Server-side proxy to Matt's Xero API (rac-xero-api-matt). Lets the AM
// dashboard show FY26 Budget vs Actual per entity without hitting Matt's
// server directly from the browser (which would fail CORS).
//
// Wired into server.js by registering the handler on /api/budget-vs-actual.
// Placement matters: the route must be registered BEFORE /api/xero/:type,
// otherwise Express's wildcard matcher captures "budget-vs-actual" as :type.
//
// Also exposes handleUnknownReconciliation for investigating "Unknown"
// supplier records in ApprovalMax. Pulls AM POs where contact==='Unknown'
// and cross-references against Xero's current contact list via Matt's
// /api/contacts/:tenantId endpoint.

const fetch = require('node-fetch');

// Matt's Xero API base URL. Override via env if needed.
const XERO_API_BASE = process.env.XERO_API_BASE || 'https://rac-xero-api-matt-production.up.railway.app';

// Maps our AM entity keys to distinctive substrings passed as
// organizationName to Matt's server. Matt does a case-insensitive
// tenantName.includes() so short substrings work — I've chosen them to
// avoid collision with other orgs in the connections list.
const XERO_ORG_NAME_BY_KEY = {
    aborig:       'Rirratjingu Aboriginal Corporation',
    enterprises:  'Rirratjingu Enterprises',
    rpmms:        'Property Management',
    mining:       'Rirratjingu Mining',
    invest:       'Miliditjpi'
};

// Xero tenant UUIDs per entity (retrieved from Matt's /api/connection-status
// on 2026-04-24). Hardcoded because these don't change unless an entity
// re-authorises Xero. Used for endpoints that take tenantId in the URL path
// rather than organizationName in the body (e.g. /api/contacts/:tenantId).
const XERO_TENANT_ID_BY_KEY = {
    aborig:       '27d83979-eb88-428e-9b90-75254dd5c7ef',
    enterprises:  '8a319f5e-d623-4df8-8ae0-46372cfb87b2',
    rpmms:        '5c8149da-bff5-4a86-ac03-75e7dfb3854a',
    mining:       '319abbba-14aa-42ce-bf68-291c3d7454a7',
    invest:       'af01da3f-0533-42cc-ad9a-4d359e2a1dd9'
};

// AM companyId per entity (for calling our own AM client helpers).
// Duplicated from dashboard.html COMPANY_ID_TO_KEY; worth keeping in sync
// but forcing a reverse lookup here would couple the frontend and backend
// for no good reason.
const AM_COMPANY_ID_BY_KEY = {
    aborig:       'c32a3d25-1a02-4f87-82d6-8584746119c1',
    enterprises:  '77b4e48b-4dee-42fb-afdb-dae38c69df3d',
    rpmms:        'ef3d29f3-56da-4b76-8a57-cf1d10919391',
    mining:       '6655cc87-de32-40d1-aee9-5f78abac57fe',
    invest:       '075c13e2-4476-4541-b8e2-85215a5656dc'
};

// 5-minute in-memory cache keeps dashboard reloads snappy without
// hammering Matt's server. BI data doesn't change by the second.
// Contacts use a longer TTL (1 hour) since supplier lists change slowly.
const xeroCache = new Map();
const XERO_CACHE_TTL_MS = 5 * 60 * 1000;
const CONTACTS_CACHE_TTL_MS = 60 * 60 * 1000;

function cacheGet(key, ttlMs = XERO_CACHE_TTL_MS) {
    const e = xeroCache.get(key);
    if (!e) return null;
    if (Date.now() - e.storedAt > ttlMs) {
        xeroCache.delete(key);
        return null;
    }
    return e.value;
}

function cacheSet(key, value) {
    xeroCache.set(key, { value, storedAt: Date.now() });
}

// Fetch Xero Budget Summary report from Matt's server.
// `date` (YYYY-MM-DD) is interpreted by Xero as the START of the window;
// it returns `periods` months forward from there. For full FY26 we pass
// date='2025-07-01' periods=12 to get Jul 2025 - Jun 2026.
async function fetchBudgetSummary(orgName, date, periods = 12) {
    const key = `budget:${orgName}:${date || 'def'}:${periods}`;
    const cached = cacheGet(key);
    if (cached) return cached;

    const body = { organizationName: orgName, periods };
    if (date) body.date = date;

    const res = await fetch(`${XERO_API_BASE}/api/budget-summary`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });

    if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`Xero budget-summary ${res.status}: ${errText.slice(0, 200)}`);
    }

    const data = await res.json();
    cacheSet(key, data);
    return data;
}

// Fetch P&L summary from Matt's server. Returns pre-parsed structure:
// { summary: { totalRevenue, totalExpenses, grossProfit, netProfit, ... },
//   period: { from, to, months, description } }
async function fetchProfitLoss(orgName, periodMonths = 10, date) {
    const key = `pl:${orgName}:${periodMonths}:${date || 'def'}`;
    const cached = cacheGet(key);
    if (cached) return cached;

    const body = { organizationName: orgName, periodMonths };
    if (date) body.date = date;

    const res = await fetch(`${XERO_API_BASE}/api/profit-loss-summary`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });

    if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`Xero P&L ${res.status}: ${errText.slice(0, 200)}`);
    }

    const data = await res.json();
    cacheSet(key, data);
    return data;
}

// Fetch Xero contact list for an entity. Returns array of
// { contactID, name, isSupplier, isCustomer, emailAddress } from Matt's
// GET /api/contacts/:tenantId endpoint. Cached for 1 hour because supplier
// lists rarely change within a working session.
async function fetchContacts(tenantId) {
    const key = `contacts:${tenantId}`;
    const cached = cacheGet(key, CONTACTS_CACHE_TTL_MS);
    if (cached) return cached;

    const res = await fetch(`${XERO_API_BASE}/api/contacts/${tenantId}`, {
        method: 'GET',
        headers: { 'Accept': 'application/json' }
    });

    if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`Xero contacts ${res.status}: ${errText.slice(0, 200)}`);
    }

    const data = await res.json();
    // Matt's endpoint returns the raw Xero contact array; normalise just in
    // case he changes it to wrap in { contacts: [...] } later.
    const contacts = Array.isArray(data) ? data : (data.contacts || data.data || []);
    cacheSet(key, contacts);
    return contacts;
}

// Sum a Xero BudgetSummary report into { revenue, expenses, netProfit }.
// The report has nested Sections (Income, Operating Expenses, Cost of Sales,
// Net Profit); each Row's cells are [accountName, month1, month2, ...].
// We sum non-total rows within Income and Expense sections across all
// periods shown.
//
// IMPORTANT: income section match is EXACT (not substring). Day 3j sanity
// check found title.includes('income') double-counted rollup sections like
// "Net Income" and "Gross Profit" on top of the actual "Income" section,
// inflating revenue ~2.2x.
//
// Expense side uses substring against 'expense' AND 'cost of' so we catch
// both "Operating Expenses"/"Less Operating Expenses" AND "Cost of Sales"/
// "Less Cost of Sales"/"Cost of Goods Sold". Without the 'cost of' clause,
// trading entities (Enterprises, Mining, Property Mgmt) under-reported
// budgeted costs because their COGS lived in a separate section.
//
// The matchedSections diagnostic in the return value lets us verify which
// section titles were summed without redeploying.
function parseBudgetReport(report) {
    let revenue = 0;
    let expenses = 0;
    const matchedSections = { income: [], expense: [] };

    const rows = report?.rows || [];

    for (const section of rows) {
        if (section.rowType !== 'Section' || !Array.isArray(section.rows)) continue;
        const title = (section.title || '').toLowerCase();

        const isIncome  = title === 'income' || title === 'revenue' || title === 'trading income';
        const isExpense = title.includes('expense') || title.includes('cost of');
        if (!isIncome && !isExpense) continue;

        (isIncome ? matchedSections.income : matchedSections.expense).push(section.title);

        for (const row of section.rows) {
            if (row.rowType !== 'Row' || !Array.isArray(row.cells)) continue;
            const accountName = (row.cells[0]?.value || '').toLowerCase();
            if (accountName.startsWith('total')) continue;  // skip subtotals

            let sum = 0;
            for (let i = 1; i < row.cells.length; i++) {
                const v = parseFloat(row.cells[i]?.value);
                if (!isNaN(v)) sum += v;
            }

            if (isIncome) revenue += sum;
            else expenses += sum;
        }
    }

    const r2 = n => Math.round(n * 100) / 100;
    return {
        revenue: r2(revenue),
        expenses: r2(expenses),
        netProfit: r2(revenue - expenses),
        matchedSections
    };
}

// Express route handler: GET /api/budget-vs-actual
// Returns budget+actual for all 5 AM entities in parallel.
// Query param: asOfDate (YYYY-MM-DD, defaults to today).
async function handleBudgetVsActual(req, res) {
    try {
        const asOfDate = req.query.asOfDate || new Date().toISOString().slice(0, 10);
        const fyStart  = '2025-07-01';
        const fyEnd    = '2026-06-30';

        const startD = new Date(fyStart);
        const nowD   = new Date(asOfDate);
        const monthsElapsed = Math.min(12, Math.max(1,
            (nowD.getFullYear() - startD.getFullYear()) * 12 +
            (nowD.getMonth() - startD.getMonth()) + 1
        ));

        const keys = Object.keys(XERO_ORG_NAME_BY_KEY);
        console.log(`[budget-vs-actual] ${keys.length} entities, asOf=${asOfDate}, monthsElapsed=${monthsElapsed}`);

        const results = await Promise.all(keys.map(async (key) => {
            const orgName = XERO_ORG_NAME_BY_KEY[key];
            try {
                const [budgetData, plData] = await Promise.all([
                    fetchBudgetSummary(orgName, fyStart, 12),
                    fetchProfitLoss(orgName, monthsElapsed)
                ]);

                const budget = parseBudgetReport(budgetData.report);
                const actual = plData.summary || {};
                const r2 = n => Math.round((n || 0) * 100) / 100;

                // totalCosts = revenue - netProfit. This folds in COGS for
                // trading entities whose P&L splits Cost of Sales out of
                // totalExpenses (Matt's endpoint returns OpEx only in
                // totalExpenses; COGS is absorbed into grossProfit upstream).
                // For non-trading entities the math collapses to the same
                // number as totalExpenses, so this is a safe universal field
                // to compare against fy26Budget.expenses on the dashboard.
                const rev = actual.totalRevenue || 0;
                const net = actual.netProfit   || 0;
                const totalCosts = rev - net;

                return {
                    entityKey: key,
                    organizationName: orgName,
                    fy26Budget: budget,
                    ytdActual: {
                        revenue: r2(actual.totalRevenue),
                        expenses: r2(actual.totalExpenses),   // OpEx only; kept for reference
                        totalCosts: r2(totalCosts),           // OpEx + COGS; use for budget variance
                        grossProfit: r2(actual.grossProfit),
                        netProfit: r2(actual.netProfit),
                        periodDescription: plData.period?.description || null
                    }
                };
            } catch (err) {
                console.error(`[budget-vs-actual] ${key} (${orgName}): ${err.message}`);
                return { entityKey: key, organizationName: orgName, error: err.message };
            }
        }));

        res.json({
            success: true,
            generatedAt: new Date().toISOString(),
            period: { fy: 'FY26', fyStart, fyEnd, asOfDate, monthsElapsed },
            entities: results,
            cacheSize: xeroCache.size
        });
    } catch (err) {
        console.error(`[budget-vs-actual] Top-level: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
}

// Build a handler factory for /api/unknown-reconciliation. The handler
// needs access to the AM client + fetchAllPages helper from server.js,
// so we accept those as dependencies rather than reach across files.
//
// Query params:
//   entity   - required; one of aborig/enterprises/rpmms/mining/invest
//   from     - optional YYYY-MM-DD; createdAtOrAfter filter on AM side
//              (defaults to 2025-06-01, same as dashboard AM_CUTOFF)
//
// Returns:
//   {
//     success: true,
//     entityKey, organizationName, tenantId,
//     amPos: [ { number, createdAt, amSupplier, accountCodes, amount,
//                description, requester, status } ],
//     xeroSuppliers: [ { name, contactID, emailAddress } ],
//     counts: { unknownPos, xeroSuppliersTotal, xeroSuppliersActive }
//   }
function makeUnknownReconciliationHandler({ amClient, fetchAllPages, requireToken, maxPages = 35 }) {
    return async function handleUnknownReconciliation(req, res) {
        try {
            const entityKey = req.query.entity;
            if (!entityKey || !XERO_TENANT_ID_BY_KEY[entityKey]) {
                return res.status(400).json({
                    success: false,
                    error: `entity query param required; must be one of: ${Object.keys(XERO_TENANT_ID_BY_KEY).join(', ')}`
                });
            }

            const createdAtOrAfter = req.query.from || '2025-06-01';
            const tenantId = XERO_TENANT_ID_BY_KEY[entityKey];
            const companyId = AM_COMPANY_ID_BY_KEY[entityKey];
            const orgName = XERO_ORG_NAME_BY_KEY[entityKey];

            console.log(`[unknown-recon] ${entityKey} tenantId=${tenantId} companyId=${companyId} from=${createdAtOrAfter}`);

            const tok = await requireToken();

            // Fetch both sides in parallel. AM side is the slow one (up to
            // 35 pages of 100 POs each); Xero contacts is one call.
            const [amResult, xeroContacts] = await Promise.all([
                fetchAllPages(
                    tok.access_token,
                    companyId,
                    'purchase-orders',
                    { createdAtOrAfter },
                    maxPages
                ),
                fetchContacts(tenantId)
            ]);

            const { items: allPos, pages, capped } = amResult;
            console.log(`[unknown-recon] ${entityKey}: ${allPos.length} AM POs in window, ${xeroContacts.length} Xero contacts`);

            // Filter to just the "Unknown" POs.
            const unknownPos = allPos
                .filter(po => {
                    const supplier = (po.contact || '').trim().toLowerCase();
                    return supplier === '' || supplier === 'unknown';
                })
                .map(po => {
                    // Collect account codes from line items (if any).
                    const accountCodes = Array.isArray(po.lineItems)
                        ? [...new Set(po.lineItems
                            .map(li => li.accountCode)
                            .filter(c => c))]
                        : [];
                    // Collect account names similarly — useful when code alone isn't obvious.
                    const accounts = Array.isArray(po.lineItems)
                        ? [...new Set(po.lineItems
                            .map(li => li.account)
                            .filter(a => a))]
                        : [];
                    // Description fallback: use first non-empty line item description.
                    let description = po.description || po.reference || '';
                    if (!description && Array.isArray(po.lineItems)) {
                        const firstLineDesc = po.lineItems
                            .map(li => li.description)
                            .find(d => d && d.trim());
                        if (firstLineDesc) description = firstLineDesc;
                    }

                    return {
                        number: po.documentNumber || po.number || po.id || null,
                        id: po.id || null,
                        createdAt: po.createdAt || po.date || po.modifiedAt || null,
                        amSupplier: po.contact || '(blank)',
                        accountCodes,
                        accounts,
                        amount: po.total || 0,
                        description: (description || '').slice(0, 200),
                        requester: po.author?.name || po.createdBy?.name || null,
                        status: po.requestStatus || 'unknown'
                    };
                });

            // Sort Unknowns by amount desc so the biggest dollar-risk items are at the top.
            unknownPos.sort((a, b) => (b.amount || 0) - (a.amount || 0));

            // Xero supplier list — filter to isSupplier=true and sort
            // alphabetically for easy eyeballing. Keep archived/inactive
            // separate so we can see if any matches live in the inactive pool.
            const suppliersActive = xeroContacts
                .filter(c => c.isSupplier === true && c.contactStatus !== 'ARCHIVED')
                .map(c => ({
                    name: c.name || '(unnamed)',
                    contactID: c.contactID || null,
                    emailAddress: c.emailAddress || null
                }))
                .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

            const suppliersArchived = xeroContacts
                .filter(c => c.isSupplier === true && c.contactStatus === 'ARCHIVED')
                .map(c => ({
                    name: c.name || '(unnamed)',
                    contactID: c.contactID || null,
                    emailAddress: c.emailAddress || null
                }))
                .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

            res.json({
                success: true,
                generatedAt: new Date().toISOString(),
                entityKey,
                organizationName: orgName,
                tenantId,
                companyId,
                window: { createdAtOrAfter },
                pages: { fetched: pages, capped, maxPages },
                counts: {
                    amPosInWindow: allPos.length,
                    unknownPos: unknownPos.length,
                    unknownTotalValue: Math.round(unknownPos.reduce((s, p) => s + (p.amount || 0), 0) * 100) / 100,
                    xeroContactsTotal: xeroContacts.length,
                    xeroSuppliersActive: suppliersActive.length,
                    xeroSuppliersArchived: suppliersArchived.length
                },
                amPos: unknownPos,
                xeroSuppliersActive,
                xeroSuppliersArchived
            });
        } catch (err) {
            console.error(`[unknown-recon] Error: ${err.message}`);
            res.status(err.status || 500).json({ success: false, error: err.message });
        }
    };
}

module.exports = {
    handleBudgetVsActual,
    makeUnknownReconciliationHandler,
    // exported for testing / future routes:
    fetchBudgetSummary,
    fetchProfitLoss,
    fetchContacts,
    parseBudgetReport,
    XERO_ORG_NAME_BY_KEY,
    XERO_TENANT_ID_BY_KEY,
    AM_COMPANY_ID_BY_KEY
};
