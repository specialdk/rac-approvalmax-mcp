// Welfare categoriser for Aboriginal Corp "We Provided" view.
//
// This module applies the heuristics documented in SAMPLING_FINDINGS.md §3-4 to
// classify Aboriginal Corp POs into AR narrative categories (Transport Assistance,
// Family Charitable Payments, etc.) and extract recipient names from description
// text.
//
// SENSITIVITY NOTE:
// Recipient names extracted by this module are real clan member names. They're
// returned by the endpoint because recipient-level visibility is the dashboard's
// core value. Any UI surface consuming this data must respect access control and
// cultural sensitivity (discuss with Paul/Rhian/Matt before exposing beyond
// admin/finance). See ANNUAL_REPORT_LEARNINGS.md §4 ("People Who Appear in AM").
//
// FY25 AR baseline figures (from p.14-15 of the 2024-25 Annual Report).
// These are the reference values the dashboard compares YTD FY26 against.
const FY25_AR_BASELINES = {
    'Family Charitable Payments': 1403221,
    'Transport Assistance':       360000,
    'Family Funeral Support':     205984,
    'Culture & Ceremony Support': 90565,
    'Social & Cultural Programs': 76808,
    'Education & Health':         38237,
    'Medical & Terminally Ill':   37505,
    'Whitegoods':                 25440,
    'Future Leaders Program':     9453
};

const FY25_AR_TOTAL = Object.values(FY25_AR_BASELINES).reduce((a, b) => a + b, 0);
// = $2,247,213 (rounds close to the AR's $2,341,481 — difference is sponsorships
// and the Denise Fincham Education Fund contribution which sit outside the
// "We Provided" member-welfare category in the AR).

// Supplier name patterns that indicate a category regardless of account code.
// Ordered by specificity - first match wins.
const SUPPLIER_CATEGORY_HINTS = [
    { pattern: /gove transport|taxi/i,     category: 'Transport Assistance' },
    { pattern: /funeral|memorial/i,        category: 'Family Funeral Support' },
    { pattern: /medical|pharma|chemist|clinic|hospital/i, category: 'Medical & Terminally Ill' },
    { pattern: /harvey norman|the good guys|appliances online|bing lee/i, category: 'Whitegoods' }
];

// Internal corporate spend patterns - these POs are NOT welfare even though
// they appear in Aboriginal Corp. Detected by description keywords that name
// corporate assets (vehicle regos starting CE, office/building work, etc.).
const INTERNAL_CORPORATE_PATTERNS = [
    /\b[A-Z]{2}\d{2}[A-Z]{2}\b/,  // NT vehicle rego pattern (e.g. CE03AQ)
    /\bstandard service\b/i,
    /\boffice\b/i,
    /\bboardroom\b/i,
    /\bstaff meeting\b/i
];

// Regex for extracting recipient names from description text.
// Matches "to [Name]" or "for [Name]" where Name is 2+ capitalised words,
// optionally followed by "& Family" or "and Family".
//
// Examples it catches:
//   "Fuel to the value of $50 to Gayili Marika"
//   "One way taxi from Yirrkala for Makungun Marika"
//   "One way taxi ... Gayili Marika & Family"
//
// Will miss: first-name-only, nicknames, informal phrasing. Acceptable first-pass.
const RECIPIENT_REGEX = /\b(?:to|for)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+(?:\s+(?:&|and)\s+Family)?)/;

/**
 * Extract a recipient name from a PO's combined line-item descriptions.
 * Returns null if no match found.
 */
function extractRecipient(po) {
    const combinedDescription = (po.lineItems || [])
        .map(li => li.description || '')
        .join(' | ');
    const match = combinedDescription.match(RECIPIENT_REGEX);
    return match ? match[1].trim() : null;
}

/**
 * Check if a PO looks like internal corporate spend rather than welfare.
 */
function isInternalCorporate(po) {
    const combinedDescription = (po.lineItems || [])
        .map(li => li.description || '')
        .join(' ');
    return INTERNAL_CORPORATE_PATTERNS.some(p => p.test(combinedDescription));
}

/**
 * Determine the dominant Xero account code on a PO by summing line-item amounts.
 * Returns { accountCode, account, totalOnThisCode }.
 */
function dominantAccountCode(po) {
    const totals = {};
    for (const li of (po.lineItems || [])) {
        const code = li.accountCode;
        if (!code) continue;
        if (!totals[code]) totals[code] = { accountCode: code, account: li.account, total: 0 };
        totals[code].total += (li.amount || 0);
    }
    const sorted = Object.values(totals).sort((a, b) => b.total - a.total);
    return sorted[0] || null;
}

/**
 * Classify a single PO into an AR welfare category.
 * Returns { category, confidence, reason } or null if should be excluded.
 *
 * confidence: 'high' | 'medium' | 'low' — high when supplier + account code agree,
 * medium when only one signal, low when category inferred from weak signals.
 */
function classifyPO(po) {
    // Exclude drafts and cancelled
    if (po.requestStatus === 'draft')     return { excluded: 'draft' };
    if (po.requestStatus === 'cancelled') return { excluded: 'cancelled' };
    if (po.requestStatus === 'rejected')  return { excluded: 'rejected' };

    const supplier = po.contact || '';
    const dominantAcct = dominantAccountCode(po);
    const accountCode = dominantAcct ? dominantAcct.accountCode : null;

    // Step 1: Check for internal corporate spend first - exclude these.
    if (isInternalCorporate(po)) {
        return { excluded: 'internal_corporate' };
    }

    // Step 2: Supplier-name hints (highest signal).
    for (const hint of SUPPLIER_CATEGORY_HINTS) {
        if (hint.pattern.test(supplier)) {
            return {
                category: hint.category,
                confidence: 'high',
                reason: `supplier name matches "${hint.pattern.source}" pattern`
            };
        }
    }

    // Step 3: Account code inference (medium signal).
    // 64605 Travel = Transport Assistance (if no supplier match above)
    if (accountCode === '64605') {
        return {
            category: 'Transport Assistance',
            confidence: 'medium',
            reason: 'account 64605 Travel, no supplier match'
        };
    }

    // 63950 Meeting Expenses with a recipient name = Family Charitable Payments
    // (this covers the "Fuel to X", "Goods to X" pattern observed in sample)
    if (accountCode === '63950') {
        const recipient = extractRecipient(po);
        if (recipient) {
            return {
                category: 'Family Charitable Payments',
                confidence: 'medium',
                reason: 'account 63950 + extracted recipient name'
            };
        }
        // 63950 without a recipient is probably internal meeting catering
        return {
            category: 'Social & Cultural Programs',
            confidence: 'low',
            reason: 'account 63950 without clear recipient — may be catering/meeting'
        };
    }

    // Step 4: Unmatched. Return as uncategorised so we can inspect and tune.
    return {
        category: 'Uncategorised',
        confidence: 'none',
        reason: `no match: supplier="${supplier}", accountCode=${accountCode}`
    };
}

/**
 * Main entry point. Given an array of raw Aboriginal Corp POs from AM,
 * returns the dashboard-shaped welfare summary payload.
 *
 * @param {Array} pos - Array of PO objects from AM API
 * @param {Object} opts - { fyStart: 'YYYY-MM-DD', asOfDate: 'YYYY-MM-DD', fyLabel: 'FY26' }
 */
function buildWelfareSummary(pos, opts = {}) {
    const fyStart = opts.fyStart || '2025-07-01';
    const asOfDate = opts.asOfDate || new Date().toISOString().slice(0, 10);
    const fyLabel = opts.fyLabel || 'FY26';

    // Financial year pace: what fraction of the 12-month year has elapsed?
    const fyStartDate = new Date(fyStart);
    const asOfDateObj = new Date(asOfDate);
    const daysElapsed = Math.floor((asOfDateObj - fyStartDate) / (1000 * 60 * 60 * 24));
    const fyPaceFraction = Math.max(0, Math.min(1, daysElapsed / 365));

    // Initialise category buckets.
    const categories = {};
    for (const [cat, baseline] of Object.entries(FY25_AR_BASELINES)) {
        categories[cat] = {
            arLine: cat,
            fy25Baseline: baseline,
            ytdTotal: 0,
            ytdPOs: 0,
            confidenceBreakdown: { high: 0, medium: 0, low: 0, none: 0 },
            uniqueRecipients: new Set(),
            suppliers: {},
            recipientTotals: {}
        };
    }
    // Also an Uncategorised bucket so we can see what we're missing.
    categories['Uncategorised'] = {
        arLine: 'Uncategorised',
        fy25Baseline: null,
        ytdTotal: 0,
        ytdPOs: 0,
        confidenceBreakdown: { high: 0, medium: 0, low: 0, none: 0 },
        uniqueRecipients: new Set(),
        suppliers: {},
        recipientTotals: {},
        sampleDescriptions: []  // for debugging / tuning
    };

    const excluded = { draft: 0, cancelled: 0, rejected: 0, internal_corporate: 0 };

    // Classify each PO.
    for (const po of pos) {
        const result = classifyPO(po);

        if (result.excluded) {
            excluded[result.excluded] = (excluded[result.excluded] || 0) + 1;
            continue;
        }

        const bucket = categories[result.category];
        if (!bucket) continue;

        bucket.ytdTotal += (po.total || 0);
        bucket.ytdPOs += 1;
        bucket.confidenceBreakdown[result.confidence] += 1;

        const supplier = po.contact || 'Unknown';
        bucket.suppliers[supplier] = (bucket.suppliers[supplier] || 0) + (po.total || 0);

        const recipient = extractRecipient(po);
        if (recipient) {
            bucket.uniqueRecipients.add(recipient);
            bucket.recipientTotals[recipient] = (bucket.recipientTotals[recipient] || 0) + (po.total || 0);
        }

        if (result.category === 'Uncategorised' && bucket.sampleDescriptions.length < 10) {
            const description = (po.lineItems || [])[0]?.description || '';
            bucket.sampleDescriptions.push({
                requestId: po.requestId,
                documentNumber: po.documentNumber || '(no doc number)',
                supplier: po.contact,
                accountCode: dominantAccountCode(po)?.accountCode || null,
                amount: po.total,
                description: description.slice(0, 140),
                reason: result.reason
            });
        }
    }

    // Finalise buckets: convert Sets to counts, extract top N suppliers/recipients.
    const finalCategories = Object.values(categories).map(bucket => {
        const topSuppliers = Object.entries(bucket.suppliers)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([name, total]) => ({ name, total: round2(total) }));

        const topRecipients = Object.entries(bucket.recipientTotals)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([name, total]) => ({ name, total: round2(total), poCount: countPOsForRecipient(pos, name) }));

        const out = {
            arLine: bucket.arLine,
            fy25Baseline: bucket.fy25Baseline,
            ytdTotal: round2(bucket.ytdTotal),
            ytdPOs: bucket.ytdPOs,
            confidenceBreakdown: bucket.confidenceBreakdown,
            uniqueRecipients: bucket.uniqueRecipients.size,
            topSuppliers,
            topRecipients
        };

        // AR-insight metrics - the subtle layer Duane described.
        if (bucket.fy25Baseline) {
            out.ytdPercentOfBaseline = round1((bucket.ytdTotal / bucket.fy25Baseline) * 100);
            // Pace-adjusted: if we're 42% through FY26, are we on track for $360K?
            // ytdTotal / fyPaceFraction = extrapolated full-year spend.
            const projectedFullYear = fyPaceFraction > 0.05  // avoid divide-by-tiny-fraction noise early in FY
                ? bucket.ytdTotal / fyPaceFraction
                : null;
            out.projectedFullYear = projectedFullYear ? round2(projectedFullYear) : null;
            out.projectedVsBaseline = projectedFullYear
                ? round1(((projectedFullYear - bucket.fy25Baseline) / bucket.fy25Baseline) * 100)
                : null;
        }

        // Include sample descriptions only for the Uncategorised bucket.
        if (bucket.sampleDescriptions) {
            out.sampleDescriptions = bucket.sampleDescriptions;
        }

        return out;
    });

    // Sort: AR-matching categories first (by baseline desc), Uncategorised last.
    finalCategories.sort((a, b) => {
        if (a.arLine === 'Uncategorised') return 1;
        if (b.arLine === 'Uncategorised') return -1;
        return (b.fy25Baseline || 0) - (a.fy25Baseline || 0);
    });

    const totalWelfareValue = round2(
        finalCategories
            .filter(c => c.arLine !== 'Uncategorised')
            .reduce((sum, c) => sum + c.ytdTotal, 0)
    );
    const totalWelfarePOs = finalCategories
        .filter(c => c.arLine !== 'Uncategorised')
        .reduce((sum, c) => sum + c.ytdPOs, 0);

    return {
        entity: 'Rirratjingu Aboriginal Corporation 8538',
        fyLabel,
        fyStart,
        asOfDate,
        daysElapsedInFY: daysElapsed,
        fyPaceFraction: round2(fyPaceFraction),
        posInspected: pos.length,
        totalWelfareValue,
        totalWelfarePOs,
        fy25ArBaselineTotal: FY25_AR_TOTAL,
        totalWelfareYtdVsFy25Pct: round1((totalWelfareValue / FY25_AR_TOTAL) * 100),
        categories: finalCategories,
        excluded,
        methodology: {
            note: 'Heuristic classifier. Confidence levels per category indicate signal strength. Uncategorised bucket contains unmatched POs for tuning. See SAMPLING_FINDINGS.md §3-4 for rules.',
            rules: [
                'Supplier name pattern match (e.g. Gove Transport → Transport Assistance): confidence=high',
                'Account code 64605 Travel (no supplier match): confidence=medium, Transport Assistance',
                'Account 63950 + "to/for [Name]" recipient: confidence=medium, Family Charitable Payments',
                'Account 63950 without recipient: confidence=low, Social & Cultural Programs (assumed catering)',
                'Everything else: Uncategorised — inspect sampleDescriptions to tune rules'
            ]
        }
    };
}

// Helpers
function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
function round1(n) { return Math.round((n + Number.EPSILON) * 10) / 10; }

function countPOsForRecipient(pos, recipientName) {
    let count = 0;
    for (const po of pos) {
        if (extractRecipient(po) === recipientName) count += 1;
    }
    return count;
}

module.exports = {
    buildWelfareSummary,
    classifyPO,
    extractRecipient,
    FY25_AR_BASELINES,
    FY25_AR_TOTAL
};
