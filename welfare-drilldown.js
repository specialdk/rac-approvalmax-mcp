// Drilldown handler — returns the actual list of POs that the welfare
// categoriser puts in a given category. Built for reconciliation against
// Xero account exports (e.g. compare what's in Xero account 63205 vs
// what the dashboard is calling "Family Funeral Support"). Reusable
// for any category — pass ?category=... in the query string.
//
// Usage:
//   GET /api/welfare/aboriginal-corp/drilldown
//       ?category=Family%20Funeral%20Support
//       &fyStart=2025-07-01   (optional, defaults to FY26 start)
//
// Returns PO-level detail: documentNumber, supplier, total, status,
// dates, accountCodes touched, Job tags, and the classifier's reason.

function makeDrilldownHandler({ amClient, fetchAllPages, requireToken, welfare, companyId, defaultFyStart, maxPages }) {
    return async function handleDrilldown(req, res) {
        try {
            const tok = await requireToken();
            const fyStart = req.query.fyStart || defaultFyStart;
            const targetCategory = req.query.category || 'Family Funeral Support';

            console.log(`[drilldown] Fetching POs since ${fyStart} for "${targetCategory}"...`);

            const { items: pos, pages, capped } = await fetchAllPages(
                tok.access_token,
                companyId,
                'purchase-orders',
                { createdAtOrAfter: fyStart },
                maxPages
            );

            const matches = [];
            for (const po of pos) {
                const result = welfare.classifyPO(po);
                if (result.category !== targetCategory) continue;

                // Distinct account codes touched on this PO
                const accountCodes = [...new Set((po.lineItems || [])
                    .map(li => li.accountCode)
                    .filter(Boolean))];

                // Distinct Job tracking-category options on this PO
                const jobsSet = new Set();
                for (const li of (po.lineItems || [])) {
                    if (Array.isArray(li.tracking)) {
                        for (const t of li.tracking) {
                            if (t && t.categoryName === 'Job' && t.optionName) {
                                jobsSet.add(t.optionName);
                            }
                        }
                    }
                }

                matches.push({
                    documentNumber: po.documentNumber || null,
                    requestId: po.requestId,
                    supplier: po.contact || null,
                    total: po.total || 0,
                    requestStatus: po.requestStatus,
                    createdAt: po.createdAt,
                    date: po.date,
                    decisionDate: po.decisionDate,
                    accountCodes,
                    jobs: Array.from(jobsSet),
                    classifyReason: result.reason,
                    classifyConfidence: result.confidence
                });
            }

            // Sort by total desc for easy visual scanning
            matches.sort((a, b) => (b.total || 0) - (a.total || 0));

            const totalValue = matches.reduce((s, p) => s + (p.total || 0), 0);
            const r2 = Math.round((totalValue + Number.EPSILON) * 100) / 100;

            console.log(`[drilldown] ${matches.length} POs match "${targetCategory}", total $${r2}`);

            res.json({
                success: true,
                category: targetCategory,
                fyStart,
                posInspected: pos.length,
                pagesFetched: pages,
                capped,
                matchCount: matches.length,
                totalValue: r2,
                pos: matches
            });
        } catch (error) {
            console.error('[drilldown] Error:', error.message);
            res.status(error.status || 500).json({
                success: false,
                error: error.message,
                body: error.body || null
            });
        }
    };
}

module.exports = { makeDrilldownHandler };
