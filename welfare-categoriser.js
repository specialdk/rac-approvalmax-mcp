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

// -----------------------------------------------------------------------------
// Rule sets (ordered by specificity — first match wins within each tier)
// -----------------------------------------------------------------------------

// High-confidence supplier + account code combinations.
// These fire BEFORE the generic supplier-name hints because a supplier + account
// pairing is a stronger signal than supplier name alone.
// Observed in Day 3 sampling: Yirrkala Enterprises uses the 250xx code family
// for member charitable vouchers (food/goods/mobile to named recipients),
// BP Nhulunbuy uses 63415 for fuel-voucher charitable payments, and Gove
// Warehouse uses 64480 for whitegoods.
const SUPPLIER_ACCOUNT_COMBOS = [
    {
        supplierPattern: /yirrkala enterprises/i,
        accountCodes: ['25003', '25005', '25007', '25009'],
        category: 'Family Charitable Payments',
        confidence: 'high',
        reason: 'Yirrkala Enterprises + 250xx account code → member voucher'
    },
    {
        supplierPattern: /\bbp\b/i,
        accountCodes: ['63415'],
        category: 'Family Charitable Payments',
        confidence: 'high',
        reason: 'BP + 63415 → member fuel voucher'
    },
    {
        supplierPattern: /gove warehouse/i,
        accountCodes: ['64480'],
        category: 'Whitegoods',
        confidence: 'high',
        reason: 'Gove Warehouse + 64480 → whitegoods/appliances'
    }
];

// Supplier name patterns that indicate a category regardless of account code.
// Ordered by specificity - first match wins.
const SUPPLIER_CATEGORY_HINTS = [
    // Road transport
    { pattern: /gove transport|taxi|letsgo/i,     category: 'Transport Assistance' },
    // Aviation / charter (Day 3: needed so recipient-fallback doesn't misfile
    // charter flights as Family Charitable)
    { pattern: /air frontier|black diamond aviation|maf international|nhulunbuy air/i, category: 'Transport Assistance' },
    // Funeral / memorial
    { pattern: /funeral|memorial/i,               category: 'Family Funeral Support' },
    // Medical / pharmacy
    { pattern: /medical|pharma|chemist|clinic|hospital/i, category: 'Medical & Terminally Ill' },
    // Whitegoods / large-appliance retail
    { pattern: /harvey norman|the good guys|appliances online|bing lee/i, category: 'Whitegoods' }
];

// Internal corporate spend patterns - these POs are NOT welfare even though
// they appear in Aboriginal Corp. Detected by description keywords that name
// corporate assets (vehicle regos, office/building work, RAC staff pickups).
const INTERNAL_CORPORATE_PATTERNS = [
    /\b[A-Z]{2}\d{2}[A-Z]{2}\b/,              // NT vehicle rego pattern (e.g. CE03AQ)
    /\bstandard service\b/i,
    /\boffice\b/i,
    /\bboardroom\b/i,
    /\bstaff meeting\b/i,
    /\bpick ?up by rac\b/i,                   // Day 3: "Pick up by RAC Staff"
    /\bfor rac staff\b/i,
    /\brac office\b/i
];

// Primary recipient extractor. Matches:
//   "to First Last"             → "First Last"
//   "for First Last"            → "First Last"
//   "to First M Last"           → "First M Last"   (middle initial, with or without period)
//   "to First Middle Last"      → "First Middle Last"
//   "passenger: First Last"     → "First Last"
//   optional "... and Family" / "... & Family" suffix
//
// The middle-initial branch (`[A-Z]\.?`) was added Day 3 after sampling showed
// many charitable PO descriptions use initials (e.g. "Jerome G Yunupingu",
// "Janice M Marika"). The "passenger" prefix was added for charter-flight POs.
// "[Tt]o" / "[Ff]or" / "[Pp]assenger" handles descriptions that begin with a
// capital letter (start of sentence).
const RECIPIENT_REGEX = /\b(?:[Tt]o|[Ff]or|[Pp]assenger)\b[:\s]+([A-Z][a-z]+(?:\s+(?:[A-Z]\.?|[A-Z][a-z]+))*\s+[A-Z][a-z]+(?:\s+(?:&|and)\s+[Ff]amily)?)/;

// Strings that the regex may extract but which are not actual people.
// These are places, supplier names, or generic nouns that happen to match the
// "two capitalised words" pattern. Added Day 3 after inspecting top-recipients
// output and seeing "Ski Beach", "Boat Club", "Air Frontier" etc.
const NON_PERSON_NAMES = new Set([
    // Places / venues
    'Ski Beach', 'Boat Club', 'Gove Dhalinbuy', 'Yanawal Units',
    'Hospital Driver', 'Hospital Pickup', 'Training Group',
    // Supplier names that sometimes show up as "to Air Frontier" etc.
    'Air Frontier', 'Black Diamond', 'Yirrkala Enterprises',
    'Gove Warehouse', 'Gove Transport', 'BP Nhulunbuy',
    'Peninsula Bakery', 'Kamayan Cafe', 'Territory Funerals',
    'Simplicity Funerals', 'Harvey Norman', 'Sodexo Remote',
    'MAF International'
]);

// First-word denylist: any extracted "recipient" whose first word is one of
// these is almost certainly a place name, not a person.
const PLACE_FIRST_WORDS = new Set([
    'Gove', 'Nhulunbuy', 'Yirrkala', 'Elcho', 'Gapuwiyak', 'Darwin',
    'Gapuwiyak', 'Malpi', 'Arnhem'
]);

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Return combined description text for a PO, with whitespace normalised so
 * newlines (\n, \r) and multiple spaces don't break the recipient regex or
 * pollute extracted names.
 */
function combinedDescription(po) {
    return (po.lineItems || [])
        .map(li => (li.description || '').replace(/\s+/g, ' ').trim())
        .join(' | ');
}

/**
 * Extract a recipient name from a PO's combined line-item descriptions.
 * Returns null if no match found or if the match is on the non-person denylist.
 */
function extractRecipient(po) {
    const text = combinedDescription(po);
    const match = text.match(RECIPIENT_REGEX);
    if (!match) return null;
    const name = match[1].trim();

    // Filter exact-match non-person denylist.
    if (NON_PERSON_NAMES.has(name)) return null;

    // Filter out names where the first word is a known place.
    const firstWord = name.split(' ')[0];
    if (PLACE_FIRST_WORDS.has(firstWord)) return null;

    return name;
}

/**
 * Check if a PO looks like internal corporate spend rather than welfare.
 */
function isInternalCorporate(po) {
    const text = combinedDescription(po);
    return INTERNAL_CORPORATE_PATTERNS.some(p => p.test(text));
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

// -----------------------------------------------------------------------------
// Classification
// -----------------------------------------------------------------------------

/**
 * Classify a single PO into an AR welfare category.
 * Returns { category, confidence, reason } or { excluded: '...' } if should
 * not contribute to welfare totals.
 *
 * confidence: 'high' | 'medium' | 'low' — high when supplier + account code agree,
 * medium when only one strong signal, low when category inferred weakly.
 *
 * Rule order (most specific to least):
 *   1. Status-based exclusions (draft/cancelled/rejected)
 *   2. Internal corporate exclusion
 *   3. Supplier + account combos (Day 3)       ← high confidence
 *   4. Supplier-name hints                     ← high confidence
 *   5. Account-code inference                  ← medium/low confidence
 *   6. Recipient-fallback (Day 3)              ← medium confidence
 *   7. Uncategorised
 */
function classifyPO(po) {
    // Step 1: Exclude non-final statuses.
    if (po.requestStatus === 'draft')     return { excluded: 'draft' };
    if (po.requestStatus === 'cancelled') return { excluded: 'cancelled' };
    if (po.requestStatus === 'rejected')  return { excluded: 'rejected' };

    const supplier = po.contact || '';
    const dominantAcct = dominantAccountCode(po);
    const accountCode = dominantAcct ? dominantAcct.accountCode : null;

    // Step 2: Internal corporate spend — exclude from welfare totals.
    if (isInternalCorporate(po)) {
        return { excluded: 'internal_corporate' };
    }

    // Step 3: Supplier + account code high-confidence combos.
    // Checked BEFORE supplier-name-only hints because pairing is more specific.
    for (const combo of SUPPLIER_ACCOUNT_COMBOS) {
        if (combo.supplierPattern.test(supplier) && combo.accountCodes.includes(accountCode)) {
            return {
                category: combo.category,
                confidence: combo.confidence,
                reason: combo.reason
            };
        }
    }

    // Step 4: Supplier-name hints.
    for (const hint of SUPPLIER_CATEGORY_HINTS) {
        if (hint.pattern.test(supplier)) {
            return {
                category: hint.category,
                confidence: 'high',
                reason: `supplier name matches "${hint.pattern.source}" pattern`
            };
        }
    }

    // Step 5: Account code inference.
    // 64605 Travel → Transport Assistance (medium).
    if (accountCode === '64605') {
        return {
            category: 'Transport Assistance',
            confidence: 'medium',
            reason: 'account 64605 Travel, no supplier match'
        };
    }

    // 63950 Meeting Expenses:
    //   + recipient → Family Charitable Payments (medium)
    //   - recipient → Social & Cultural Programs (low, assumed catering)
    if (accountCode === '63950') {
        const recipient = extractRecipient(po);
        if (recipient) {
            return {
                category: 'Family Charitable Payments',
                confidence: 'medium',
                reason: 'account 63950 + extracted recipient name'
            };
        }
        return {
            category: 'Social & Cultural Programs',
            confidence: 'low',
            reason: 'account 63950 without clear recipient — may be catering/meeting'
        };
    }

    // Step 6: Recipient-name fallback (Day 3).
    // If we can extract a named recipient and the spend isn't internal, treat
    // as Family Charitable with medium confidence. Catches the long tail of
    // "goods/fuel/tent to [Name]" PO descriptions on account codes that don't
    // map cleanly to any specific rule above.
    const fallbackRecipient = extractRecipient(po);
    if (fallbackRecipient) {
        return {
            category: 'Family Charitable Payments',
            confidence: 'medium',
            reason: `recipient "${fallbackRecipient}" extracted (supplier/account not in specific rules)`
        };
    }

    // Step 7: Unmatched. Return as uncategorised so we can inspect and tune.
    return {
        category: 'Uncategorised',
        confidence: 'none',
        reason: `no match: supplier="${supplier}", accountCode=${accountCode}`
    };
}

// -----------------------------------------------------------------------------
// Main entry point
// -----------------------------------------------------------------------------

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
                'Internal corporate exclusion: vehicle regos, office/boardroom/staff-meeting keywords, "pick up by RAC"',
                'Supplier + account combo (high): Yirrkala Ent + 250xx → Family Charitable; BP + 63415 → Family Charitable; Gove Warehouse + 64480 → Whitegoods',
                'Supplier name hint (high): Gove Transport/taxi → Transport; Air Frontier/Black Diamond/MAF → Transport; funeral/memorial → Family Funeral Support; medical/chemist → Medical; Harvey Norman/The Good Guys → Whitegoods',
                'Account code 64605 Travel → Transport Assistance (medium)',
                'Account 63950 + recipient → Family Charitable (medium); without recipient → Social & Cultural (low)',
                'Recipient-fallback: any extractable "to/for/passenger [Name]" → Family Charitable (medium)',
                'Everything else: Uncategorised — inspect sampleDescriptions to tune rules'
            ]
        }
    };
}

// -----------------------------------------------------------------------------
// Small helpers
// -----------------------------------------------------------------------------

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
