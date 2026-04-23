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

// -----------------------------------------------------------------------------
// Rirratjingu-specific names (Day 3d)
// -----------------------------------------------------------------------------
//
// Sourced from "Rirratjingu Staff Contacts - January 2026" provided by Duane.
// Used to disambiguate recipient extraction: when a staff name appears in a
// PO description, we need to know whether they're the actual welfare
// beneficiary, or acting as an intermediary (picking up / handling on behalf
// of a clan member).

// Non-clan RAC staff. If one of these names is extracted as the "recipient",
// it's almost certainly an intermediary or operational role, not the actual
// welfare recipient. Filtered out of recipient attribution (but the PO may
// still classify correctly via account code or other signals).
//
// IMPORTANT: Does NOT include staff who are also Yolŋu clan/community
// members — they can legitimately receive welfare:
//   Rylee Ford (Culture & Community Manager)
//   Elenie Bromot (Cultural Learning Coordinator)
//   Zoe Bromot (Member Support Officer)
//   Tiani Mununggurritj (C&C Project Support Officer)
//   Djay Marika (Career Pathway Mentor)
//   Shakira Marika (Administration Support)
//   Jaclyn Bromot (Career Pathway Coordinator)
//   Wilisoni "Wil" Lotu (Career Pathway Coordinator)
//   Paula Gumana (Employment & Training)
// All Directors are also clan — never listed here.
const NON_CLAN_STAFF_NAMES = new Set([
    // Exec
    'Rhian Oliver', 'Jade Van Beelen', 'Paul Martin', 'Samuel Hinton',
    // Finance
    'Matt Muscat', 'Nancy Halafihi', 'Saheel Shah', 'Himanshu Pathak',
    'Kabita Adhikari',
    // Administration
    'Rachael Coonan', 'Shawn Mhaka',
    // Corporate Services
    'Brodie Apthorpe', 'Rachael Schofield', 'Adrian Rota', 'Duane Kuru',
    'Jodie Douglas', 'Cassandra Richert', 'Jamie Schofield',
    // Culture & Community (non-clan)
    'Peter Reeves',
    // Mining / Enterprises / Fuel
    'Gavin Law', 'James Ball', 'Uheina Gillon', 'Matthew Henger',
    'Paul McLoughlin', 'Warwick Mylchreest', 'Jarrad Ernst',
    // Employment & Training (non-clan)
    'Peter Britto',
    // RPMMS
    'Sam Dentith', 'Max Edema', 'Chris Lamboa', 'Kai Mooney',
    'Jack Aragu', 'Danielle Stolte'
]);

// Yolŋu / Rirratjingu clan surnames. Any 2+ word capitalised name ending in
// one of these is presumptively a real clan welfare recipient, even when the
// primary regex misses the trigger word. Powers the Priority-3 fallback in
// extractRecipient().
const CLAN_SURNAMES = [
    'Marika', 'Yunupingu', 'Garrawurra', 'Bukulatjpi', 'Dhamarrandji',
    'Wanapuyngu', 'Gumana', 'Bromot', 'Ulamari', 'Mununggurritj',
    'Lotu', 'Rarrkminy'
];

// Compiled regex for scanning a description for "First [Middle] Last" where
// Last is a known clan surname. Global flag so we can find all matches and
// pick the best (non-denylisted) one.
const CLAN_SURNAME_SCAN_REGEX = new RegExp(
    String.raw`\b([A-Z][a-z]+(?:\s+(?:[A-Z]\.?|[A-Z][a-z]+))*\s+(?:${CLAN_SURNAMES.join('|')}))\b`,
    'g'
);

// "on behalf of" override regex. When this matches, the captured name takes
// priority over whatever the primary regex might have captured.
const ON_BEHALF_OF_REGEX = /\bon\s+behalf\s+of\s+([A-Z][a-z]+(?:\s+(?:[A-Z]\.?|[A-Z][a-z]+))*\s+[A-Z][a-z]+(?:\s+(?:&|and)\s+[Ff]amily)?)/;

// -----------------------------------------------------------------------------
// Rule sets (ordered by specificity — first match wins within each tier)
// -----------------------------------------------------------------------------

// High-confidence supplier + specific-account-code combinations.
const SUPPLIER_ACCOUNT_COMBOS = [
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
// Fires before account-code family hints so known transport/funeral/medical/
// whitegoods/cultural vendors keep their specific AR line.
const SUPPLIER_CATEGORY_HINTS = [
    // Road transport
    { pattern: /gove transport|taxi|letsgo/i,     category: 'Transport Assistance' },
    // Aviation / charter
    { pattern: /air frontier|black diamond aviation|maf international|nhulunbuy air|\bhm air\b/i, category: 'Transport Assistance' },
    // Funeral / memorial
    { pattern: /funeral|memorial/i,               category: 'Family Funeral Support' },
    // Medical / pharmacy
    { pattern: /medical|pharma|chemist|clinic|hospital/i, category: 'Medical & Terminally Ill' },
    // Whitegoods / large-appliance retail
    { pattern: /harvey norman|the good guys|appliances online|bing lee/i, category: 'Whitegoods' },
    // Cultural / arts (Day 3d: Buku Larrngay Mulka is the Yirrkala art centre)
    { pattern: /buku larrngay/i,                   category: 'Culture & Ceremony Support' }
];

// Account code family → category hints (supplier-agnostic, high confidence).
const ACCOUNT_CODE_CATEGORY_HINTS = [
    {
        pattern: /^250\d{2}$/,
        category: 'Family Charitable Payments',
        confidence: 'high',
        reason: 'account 250xx family → member charitable voucher'
    }
];

// Description-keyword hints (medium confidence). Fire after supplier/account
// hints but before the recipient-fallback. Useful when a one-off event is
// clear from the description but the supplier/account don't carry the signal.
const DESCRIPTION_CATEGORY_HINTS = [
    {
        pattern: /\bceremon(?:y|ial|ies)\b|\bbu[ŋn]gul\b|ceremonial\s+ground/i,
        category: 'Culture & Ceremony Support',
        confidence: 'medium',
        reason: 'description mentions ceremony/ceremonial/buŋgul'
    }
];

// Internal corporate spend patterns (description-based).
const INTERNAL_CORPORATE_DESCRIPTION_PATTERNS = [
    /\b[A-Z]{2}\d{2}[A-Z]{2}\b/,              // NT vehicle rego pattern (e.g. CE03AQ)
    /\bstandard service\b/i,
    /\boffice\b/i,
    /\bboardroom\b/i,
    /\bstaff meeting\b/i,
    /\bpick ?up by rac\b/i,
    /\bfor rac staff\b/i,
    /\brac office\b/i
];

// Internal corporate spend patterns (supplier-based).
// Suppliers that are either other RAC trading entities (intercompany billing)
// or operational vendors for non-welfare activities.
const INTERNAL_CORPORATE_SUPPLIER_PATTERNS = [
    /^rirratjingu /i,             // Intercompany: RAC's own trading entities
    /\bzip print\b/i,
    /\bdon whyte\b/i,             // Don Whyte Framing
    /\bthe pin factory\b/i,
    /\ball flags and signs\b/i,
    /\bbz technology\b/i,
    /\bofficeworks\b/i,           // Day 3d: ~$15K of "stationary" in Uncategorised
    /\bbig nt print\b/i,          // Day 3d: printing vendor
    /\bcarwash kingz\b/i          // Day 3d: vehicle washing (operational)
];

// Primary recipient extractor. Matches:
//   "to First Last"             → "First Last"
//   "for First Last"            → "First Last"
//   "to First M Last"           → "First M Last"
//   "to First Middle Last"      → "First Middle Last"
//   "passenger: First Last"     → "First Last"
//   "required by First Last"    → "First Last"
//   "requested by First Last"   → "First Last"
//   optional "... and Family" / "... & Family" suffix
const RECIPIENT_REGEX = /\b(?:[Tt]o|[Ff]or|[Pp]assenger|[Rr]equ(?:ired|ested)\s+[Bb]y)\b[:\s]+([A-Z][a-z]+(?:\s+(?:[A-Z]\.?|[A-Z][a-z]+))*\s+[A-Z][a-z]+(?:\s+(?:&|and)\s+[Ff]amily)?)/;

// Strings that the regex may extract but which are not actual people.
const NON_PERSON_NAMES = new Set([
    'Ski Beach', 'Boat Club', 'Gove Dhalinbuy', 'Yanawal Units',
    'Hospital Driver', 'Hospital Pickup', 'Training Group',
    'Air Frontier', 'Black Diamond', 'Yirrkala Enterprises',
    'Gove Warehouse', 'Gove Transport', 'BP Nhulunbuy',
    'Peninsula Bakery', 'Kamayan Cafe', 'Territory Funerals',
    'Simplicity Funerals', 'Harvey Norman', 'Sodexo Remote',
    'MAF International',
    'Country Music Video'
]);

// First-word denylist: any extracted "recipient" whose first word is one of
// these is almost certainly a place name, not a person.
const PLACE_FIRST_WORDS = new Set([
    'Gove', 'Nhulunbuy', 'Yirrkala', 'Elcho', 'Gapuwiyak', 'Darwin',
    'Malpi', 'Arnhem'
]);

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Return combined description text for a PO, with whitespace normalised.
 */
function combinedDescription(po) {
    return (po.lineItems || [])
        .map(li => (li.description || '').replace(/\s+/g, ' ').trim())
        .join(' | ');
}

/**
 * Normalise the trailing "and family" / "& family" capitalisation.
 */
function normalizeRecipientName(name) {
    return name.replace(/\s+(&|and)\s+family$/i, ' and Family');
}

/**
 * True if the name is filtered out (non-person, place-first-word, or
 * non-clan staff acting as intermediary).
 */
function isDenylistedName(name) {
    if (NON_PERSON_NAMES.has(name)) return true;
    if (NON_CLAN_STAFF_NAMES.has(name)) return true;
    const firstWord = name.split(' ')[0];
    if (PLACE_FIRST_WORDS.has(firstWord)) return true;
    return false;
}

/**
 * Scan description text for any "First [Middle] Last" pattern where Last is
 * a known clan surname. Returns the first non-denylisted match or null.
 * Used as Priority-3 fallback when primary trigger-based regex misses.
 */
function scanForClanSurname(text) {
    // Reset regex state (global flag means it tracks position across calls)
    CLAN_SURNAME_SCAN_REGEX.lastIndex = 0;
    const matches = text.matchAll(CLAN_SURNAME_SCAN_REGEX);
    for (const m of matches) {
        const candidate = m[1].trim();
        if (!isDenylistedName(candidate)) {
            return candidate;
        }
    }
    return null;
}

/**
 * Extract a recipient name from a PO's combined line-item descriptions.
 * Priority-tiered extraction (Day 3d):
 *   1. "on behalf of X" override — X is the beneficiary, not the extract-er
 *   2. Primary trigger-word regex (to/for/passenger/required by/requested by)
 *      — filtering non-clan staff as intermediaries
 *   3. Clan-surname scan — "First [Middle] Marika|Yunupingu|..." anywhere
 *      in the description
 * Returns null if none of the three produce a valid name.
 */
function extractRecipient(po) {
    const text = combinedDescription(po);

    // Priority 1: "on behalf of X" — the real beneficiary
    const behalfMatch = text.match(ON_BEHALF_OF_REGEX);
    if (behalfMatch) {
        const name = behalfMatch[1].trim();
        if (!isDenylistedName(name)) {
            return normalizeRecipientName(name);
        }
    }

    // Priority 2: Primary regex, filtered for non-clan staff intermediaries
    const primaryMatch = text.match(RECIPIENT_REGEX);
    if (primaryMatch) {
        const name = primaryMatch[1].trim();
        if (!isDenylistedName(name)) {
            return normalizeRecipientName(name);
        }
        // If primary matched a staff name, fall through to clan-surname scan
        // — there may be a real clan beneficiary elsewhere in the description.
    }

    // Priority 3: Clan-surname fallback scan
    const clanMatch = scanForClanSurname(text);
    if (clanMatch) {
        return normalizeRecipientName(clanMatch);
    }

    return null;
}

/**
 * Check if a PO looks like internal corporate spend rather than welfare.
 */
function isInternalCorporate(po) {
    const supplier = po.contact || '';
    if (INTERNAL_CORPORATE_SUPPLIER_PATTERNS.some(p => p.test(supplier))) {
        return true;
    }
    const text = combinedDescription(po);
    if (INTERNAL_CORPORATE_DESCRIPTION_PATTERNS.some(p => p.test(text))) {
        return true;
    }
    return false;
}

/**
 * Determine the dominant Xero account code on a PO.
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
 *
 * Rule order:
 *   1. Status-based exclusions (draft/cancelled/rejected)
 *   2. Internal corporate exclusion (supplier- or description-based)
 *   3. Supplier + account combos                ← high confidence
 *   4. Supplier-name hints                      ← high confidence
 *   5. Account-code family hints (e.g. 250xx)   ← high confidence
 *   6. Account-code specific (64605, 63950)     ← medium/low confidence
 *   7. Description keyword hints (ceremonial)   ← medium confidence
 *   8. Recipient-fallback                       ← medium confidence
 *   9. Uncategorised
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

    // Step 5: Account-code family hints.
    for (const hint of ACCOUNT_CODE_CATEGORY_HINTS) {
        if (accountCode && hint.pattern.test(accountCode)) {
            return {
                category: hint.category,
                confidence: hint.confidence,
                reason: hint.reason
            };
        }
    }

    // Step 6: Account-code specific inference.
    if (accountCode === '64605') {
        return {
            category: 'Transport Assistance',
            confidence: 'medium',
            reason: 'account 64605 Travel, no supplier match'
        };
    }

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

    // Step 7: Description keyword hints (e.g. ceremonial → Culture & Ceremony).
    const descriptionText = combinedDescription(po);
    for (const hint of DESCRIPTION_CATEGORY_HINTS) {
        if (hint.pattern.test(descriptionText)) {
            return {
                category: hint.category,
                confidence: hint.confidence,
                reason: hint.reason
            };
        }
    }

    // Step 8: Recipient-name fallback.
    const fallbackRecipient = extractRecipient(po);
    if (fallbackRecipient) {
        return {
            category: 'Family Charitable Payments',
            confidence: 'medium',
            reason: `recipient "${fallbackRecipient}" extracted (supplier/account not in specific rules)`
        };
    }

    // Step 9: Unmatched. Return as uncategorised so we can inspect and tune.
    return {
        category: 'Uncategorised',
        confidence: 'none',
        reason: `no match: supplier="${supplier}", accountCode=${accountCode}`
    };
}

// -----------------------------------------------------------------------------
// Main entry point
// -----------------------------------------------------------------------------

function buildWelfareSummary(pos, opts = {}) {
    const fyStart = opts.fyStart || '2025-07-01';
    const asOfDate = opts.asOfDate || new Date().toISOString().slice(0, 10);
    const fyLabel = opts.fyLabel || 'FY26';

    const fyStartDate = new Date(fyStart);
    const asOfDateObj = new Date(asOfDate);
    const daysElapsed = Math.floor((asOfDateObj - fyStartDate) / (1000 * 60 * 60 * 24));
    const fyPaceFraction = Math.max(0, Math.min(1, daysElapsed / 365));

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
    categories['Uncategorised'] = {
        arLine: 'Uncategorised',
        fy25Baseline: null,
        ytdTotal: 0,
        ytdPOs: 0,
        confidenceBreakdown: { high: 0, medium: 0, low: 0, none: 0 },
        uniqueRecipients: new Set(),
        suppliers: {},
        recipientTotals: {},
        sampleDescriptions: []
    };

    const excluded = { draft: 0, cancelled: 0, rejected: 0, internal_corporate: 0 };

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

        if (bucket.fy25Baseline) {
            out.ytdPercentOfBaseline = round1((bucket.ytdTotal / bucket.fy25Baseline) * 100);
            const projectedFullYear = fyPaceFraction > 0.05
                ? bucket.ytdTotal / fyPaceFraction
                : null;
            out.projectedFullYear = projectedFullYear ? round2(projectedFullYear) : null;
            out.projectedVsBaseline = projectedFullYear
                ? round1(((projectedFullYear - bucket.fy25Baseline) / bucket.fy25Baseline) * 100)
                : null;
        }

        if (bucket.sampleDescriptions) {
            out.sampleDescriptions = bucket.sampleDescriptions;
        }

        return out;
    });

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
                'Internal corporate exclusion: vehicle regos, office keywords, "pick up by RAC"; intercompany Rirratjingu suppliers; printing/signage/IT/stationery vendors',
                'Supplier + account combo (high): BP + 63415 → Family Charitable; Gove Warehouse + 64480 → Whitegoods',
                'Supplier name hint (high): Gove Transport/taxi, Air Frontier/Black Diamond/MAF/HM Air → Transport; funeral/memorial → Family Funeral; medical/chemist → Medical; Harvey Norman → Whitegoods; Buku Larrngay Mulka → Culture & Ceremony',
                'Account code family (high): 250xx → Family Charitable (member voucher, supplier-agnostic)',
                'Account code 64605 Travel → Transport; 63950 + recipient → Family Charitable; 63950 no recipient → Social & Cultural',
                'Description keyword (medium): "ceremonial/ceremony/buŋgul" → Culture & Ceremony Support',
                'Recipient extraction: tiered — "on behalf of X" (priority 1), to/for/required by/requested by [Name] (priority 2, filtering non-clan staff), clan-surname scan Marika/Yunupingu/Garrawurra/... (priority 3)',
                'Recipient-fallback: any extractable recipient → Family Charitable (medium)',
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
