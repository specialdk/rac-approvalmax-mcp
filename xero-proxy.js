// xero-proxy.js (Day 3j)
//
// Server-side proxy to Matt's Xero API (rac-xero-api-matt). Lets the AM
// dashboard show FY26 Budget vs Actual per entity without hitting Matt's
// server directly from the browser (which would fail CORS).
//
// Wired into server.js by registering the handler on /api/budget-vs-actual.
// Placement matters: the route must be registered BEFORE /api/xero/:type,
// otherwise Express's wildcard matcher captures "budget-vs-actual" as :type.

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

// 5-minute in-memory cache keeps dashboard reloads snappy without
// hammering Matt's server. BI data doesn't change by the second.
const xeroCache = new Map();
const XERO_CACHE_TTL_MS = 5 * 60 * 1000;

function cacheGet(key) {
    const e = xeroCache.get(key);
    if (!e) return null;
    if (Date.now() - e.storedAt > XERO_CACHE_TTL_MS) {
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

                return {
                    entityKey: key,
                    organizationName: orgName,
                    fy26Budget: budget,
                    ytdActual: {
                        revenue: r2(actual.totalRevenue),
                        expenses: r2(actual.totalExpenses),
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

module.exports = {
    handleBudgetVsActual,
    // exported for testing / future routes:
    fetchBudgetSummary,
    fetchProfitLoss,
    parseBudgetReport,
    XERO_ORG_NAME_BY_KEY
};
