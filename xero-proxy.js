// xero-proxy.js
// Server-to-server proxy to the RAC Xero API (rac-xero-api-matt on Railway).
// Exposes GET /api/xero/budget-vs-actual returning FY26 budget + YTD actuals
// for all 5 AM entities.

const express = require('express');
const fetch = require('node-fetch');

const router = express.Router();

const XERO_API_BASE = process.env.XERO_API_BASE
    || 'https://rac-xero-api-matt-production.up.railway.app';

const ENTITY_XERO_ORG_NAME = {
    'aborig':      'Aboriginal Corporation',
    'enterprises': 'Enterprises',
    'rpmms':       'Property Management',
    'mining':      'Mining',
    'invest':      'Miliditjpi'
};

const cache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;

function getCached(key) {
    const e = cache.get(key);
    if (!e) return null;
    if (Date.now() - e.t > CACHE_TTL_MS) { cache.delete(key); return null; }
    return e.v;
}
function setCached(key, v) { cache.set(key, { t: Date.now(), v }); }

async function postJson(path, body) {
    const res = await fetch(`${XERO_API_BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`Xero ${path} returned ${res.status}: ${txt.slice(0, 300)}`);
    }
    return res.json();
}

function parseBudgetReport(report) {
    const result = { income: 0, operatingExpenses: 0, incomeAccounts: [], expenseAccounts: [], reportDate: null, reportTitles: null };
    if (!report || !Array.isArray(report.rows)) return result;
    result.reportDate = report.reportDate || null;
    result.reportTitles = report.reportTitles || null;

    for (const section of report.rows) {
        if (section.rowType !== 'Section') continue;
        const title = (section.title || '').toLowerCase();
        const isIncome = title === 'income' || title === 'revenue' || title.includes('income');
        const isExpense = title.includes('expense') || title.includes('cost of') || title.includes('operating');
        if (!isIncome && !isExpense) continue;

        for (const row of (section.rows || [])) {
            if (row.rowType !== 'Row') continue;
            const cells = row.cells || [];
            if (cells.length < 2) continue;
            const accountName = (cells[0] && cells[0].value) || 'Unknown';
            let rowTotal = 0;
            for (let i = 1; i < cells.length; i++) {
                const v = parseFloat(cells[i] && cells[i].value);
                if (!isNaN(v)) rowTotal += v;
            }
            if (isIncome) {
                result.income += rowTotal;
                if (rowTotal !== 0) result.incomeAccounts.push({ name: accountName, total: rowTotal });
            } else if (isExpense) {
                result.operatingExpenses += rowTotal;
                if (rowTotal !== 0) result.expenseAccounts.push({ name: accountName, total: rowTotal });
            }
        }
    }
    result.incomeAccounts.sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
    result.expenseAccounts.sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
    return result;
}

function computeMonthsElapsed(fyStartIso, today = new Date()) {
    const fyStart = new Date(fyStartIso);
    const months = (today.getFullYear() - fyStart.getFullYear()) * 12
        + (today.getMonth() - fyStart.getMonth()) + 1;
    return Math.max(1, Math.min(12, months));
}

router.get('/api/xero/budget-vs-actual', async (req, res) => {
    const cacheKey = 'budget-vs-actual-fy26';
    try {
        if (!req.query.nocache) {
            const cached = getCached(cacheKey);
            if (cached) return res.json({ ...cached, fromCache: true });
        }
        const fyStart = '2025-07-01';
        const budgetPeriods = 12;
        const monthsElapsed = computeMonthsElapsed(fyStart);
        const entries = Object.entries(ENTITY_XERO_ORG_NAME);

        console.log(`[xero-proxy] Fetching budget + P&L for ${entries.length} entities, monthsElapsed=${monthsElapsed}`);

        const results = await Promise.all(entries.map(async ([entityKey, orgName]) => {
            try {
                const [budgetRes, plRes] = await Promise.all([
                    postJson('/api/budget-summary', { organizationName: orgName, date: fyStart, periods: budgetPeriods }),
                    postJson('/api/profit-loss-summary', { organizationName: orgName, periodMonths: monthsElapsed })
                ]);
                const budget = parseBudgetReport(budgetRes.report);
                const plSummary = plRes.summary || {};
                return {
                    entityKey,
                    organizationName: orgName,
                    period: plRes.period || { months: monthsElapsed },
                    fy26Budget: {
                        revenue: Math.round(budget.income),
                        expenses: Math.round(budget.operatingExpenses),
                        netProfit: Math.round(budget.income - budget.operatingExpenses)
                    },
                    ytdActual: {
                        revenue: Math.round(plSummary.totalRevenue || 0),
                        expenses: Math.round(plSummary.totalExpenses || 0),
                        grossProfit: Math.round(plSummary.grossProfit || 0),
                        netProfit: Math.round(plSummary.netProfit || 0)
                    },
                    diagnostic: {
                        budgetReportDate: budget.reportDate,
                        budgetReportTitles: budget.reportTitles,
                        budgetIncomeAccountCount: budget.incomeAccounts.length,
                        budgetExpenseAccountCount: budget.expenseAccounts.length
                    }
                };
            } catch (err) {
                console.error(`[xero-proxy] ${orgName} error:`, err.message);
                return { entityKey, organizationName: orgName, error: err.message };
            }
        }));

        const payload = {
            success: true,
            generatedAt: new Date().toISOString(),
            fyLabel: 'FY26',
            budgetWindow: { anchor: fyStart, periods: budgetPeriods },
            ytdWindow: { months: monthsElapsed, fyStart },
            entities: results
        };
        setCached(cacheKey, payload);
        res.json(payload);
    } catch (error) {
        console.error('[xero-proxy] Top-level error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;