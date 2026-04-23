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
// Rirratjingu-specific names
// -----------------------------------------------------------------------------
//
// THE RULE (from Duane, Day 3e):
//   "Marika" in a name = Rirratjingu clan family member.
//   Every other staff member — including C&C and Training staff whose surnames
//   sound Yolŋu (Bromot, Lotu, Mununggurritj, Gumana, Ford) — is RAC staff
//   making purchases ON BEHALF OF family, functionally identical to Rachael
//   Coonan in the Finance team. Filter them as intermediaries.
//
// Exceptions worth noting:
//   - Djay Marika and Shakira Marika ARE clan (Marika surname) despite being
//     on the staff list, so they remain OUT of this denylist.
//   - Directors are all clan and never listed here.

// Staff names that, when extracted as the "recipient" from a PO description,
// should be treated as intermediaries rather than welfare beneficiaries.
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
    // Culture & Community (Day 3e: all RAC staff per Duane's clarification)
    'Rylee Ford', 'Elenie Bromot', 'Eleni Bromot',   // Eleni = variant typo (Day 3f)
    'Zoe Bromot', 'Peter Reeves', 'Tiani Mununggurritj',
    // Mining / Enterprises / Fuel
    'Gavin Law', 'James Ball', 'Uheina Gillon', 'Matthew Henger',
    'Paul McLoughlin', 'Warwick Mylchreest', 'Jarrad Ernst',
    // Employment & Training (exclude Djay Marika, Shakira Marika — both clan)
    'Peter Britto',
    'Wilisoni Lotu', 'Wil Lotu', 'Wilson Lotu',   // variant spellings
    'Jaclyn Bromot', 'Paula Gumana',
    // RPMMS
    'Sam Dentith', 'Max Edema', 'Chris Lamboa', 'Kai Mooney',
    'Jack Aragu', 'Danielle Stolte'
]);

// Yolŋu clan surnames — genuine clan markers only.
const CLAN_SURNAMES = [
    'Marika', 'Yunupingu', 'Garrawurra', 'Bukulatjpi', 'Dhamarrandji',
    'Wanapuyngu', 'Rarrkminy', 'Ulamari'
];

// Place words that should never start an extracted name. Used both as a
// denylist check on extracted strings AND as a negative lookahead in the
// clan-surname regex so the scan doesn't greedy-match "Yirrkala Gary Marika"
// as a single unit and then discard it (Day 3f fix — see PO-12536 case).
const PLACE_WORDS = [
    'Gove', 'Nhulunbuy', 'Yirrkala', 'Elcho', 'Gapuwiyak', 'Darwin',
    'Malpi', 'Arnhem'
];
const PLACE_FIRST_WORDS = new Set(PLACE_WORDS);

// Compiled regex for scanning a description for "First [Middle] Last" where
// Last is a known clan surname. Negative lookahead (Day 3f) prevents the
// pattern from starting at a place word like "Yirrkala", so an address line
// ending in "- Yirrkala" followed by "Gary Waninya Marika" on the next line
// correctly extracts "Gary Waninya Marika" rather than greedy-matching the
// whole string and discarding it.
const CLAN_SURNAME_SCAN_REGEX = new RegExp(
    String.raw`\b(?!(?:${PLACE_WORDS.join('|')})\b)([A-Z][a-z]+(?:\s+(?:[A-Z]\.?|[A-Z][a-z]+))*\s+(?:${CLAN_SURNAMES.join('|')}))\b`,
    'g'
);

// "on behalf of" override regex. When this matches, the captured name takes
// priority over whatever the primary regex might have captured.
const ON_BEHALF_OF_REGEX = /\bon\s+behalf\s+of\s+([A-Z][a-z]+(?:\s+(?:[A-Z]\.?|[A-Z][a-z]+))*\s+[A-Z][a-z]+(?:\s+(?:&|and)\s+[Ff]amily)?)/;

// -----------------------------------------------------------------------------
// Rule sets
// -----------------------------------------------------------------------------

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

const SUPPLIER_CATEGORY_HINTS = [
    { pattern: /gove transport|taxi|letsgo/i,     category: 'Transport Assistance' },
    { pattern: /air frontier|black diamond aviation|maf international|nhulunbuy air|\bhm air\b/i, category: 'Transport Assistance' },
    { pattern: /funeral|memorial/i,               category: 'Family Funeral Support' },
    { pattern: /medical|pharma|chemist|clinic|hospital/i, category: 'Medical & Terminally Ill' },
    { pattern: /harvey norman|the good guys|appliances online|bing lee/i, category: 'Whitegoods' },
    { pattern: /buku larrngay/i,                   category: 'Culture & Ceremony Support' }
];

const ACCOUNT_CODE_CATEGORY_HINTS = [
    {
        pattern: /^250\d{2}$/,
        category: 'Family Charitable Payments',
        confidence: 'high',
        reason: 'account 250xx family → member charitable voucher'
    }
];

const DESCRIPTION_CATEGORY_HINTS = [
    {
        pattern: /\bceremon(?:y|ial|ies)\b|\bbu[ŋn]gul\b|ceremonial\s+ground/i,
        category: 'Culture & Ceremony Support',
        confidence: 'medium',
        reason: 'description mentions ceremony/ceremonial/buŋgul'
    }
];

const INTERNAL_CORPORATE_DESCRIPTION_PATTERNS = [
    /\b[A-Z]{2}\d{2}[A-Z]{2}\b/,
    /\bstandard service\b/i,
    /\boffice\b/i,
    /\bboardroom\b/i,
    /\bstaff meeting\b/i,
    /\bpick ?up by rac\b/i,
    /\bfor rac staff\b/i,
    /\brac office\b/i
];

const INTERNAL_CORPORATE_SUPPLIER_PATTERNS = [
    /^rirratjingu /i,
    /\bzip print\b/i,
    /\bdon whyte\b/i,
    /\bthe pin factory\b/i,
    /\ball flags and signs\b/i,
    /\bbz technology\b/i,
    /\bofficeworks\b/i,
    /\bbig nt print\b/i,
    /\bcarwash kingz\b/i,
    /\bbendesigns\b/i          // Day 3f: vinyl banner with RAC logo (corporate branding)
];

const RECIPIENT_REGEX = /\b(?:[Tt]o|[Ff]or|[Pp]assenger|[Rr]equ(?:ired|ested)\s+[Bb]y)\b[:\s]+([A-Z][a-z]+(?:\s+(?:[A-Z]\.?|[A-Z][a-z]+))*\s+[A-Z][a-z]+(?:\s+(?:&|and)\s+[Ff]amily)?)/;

const NON_PERSON_NAMES = new Set([
    'Ski Beach', 'Boat Club', 'Gove Dhalinbuy', 'Yanawal Units',
    'Hospital Driver', 'Hospital Pickup', 'Training Group',
    'Air Frontier', 'Black Diamond', 'Yirrkala Enterprises',
    'Gove Warehouse', 'Gove Transport', 'BP Nhulunbuy',
    'Peninsula Bakery', 'Kamayan Cafe', 'Territory Funerals',
    'Simplicity Funerals', 'Harvey Norman', 'Sodexo Remote',
    'MAF International',
    'Country Music Video',
    'Cruise Ship'     // Day 3f: appeared in Culture & Ceremony topRecipients
]);

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function combinedDescription(po) {
    return (po.lineItems || [])
        .map(li => (li.description || '').replace(/\s+/g, ' ').trim())
        .join(' | ');
}

function normalizeRecipientName(name) {
    return name.replace(/\s+(&|and)\s+family$/i, ' and Family');
}

function isDenylistedName(name) {
    if (NON_PERSON_NAMES.has(name)) return true;
    if (NON_CLAN_STAFF_NAMES.has(name)) return true;
    const firstWord = name.split(' ')[0];
    if (PLACE_FIRST_WORDS.has(firstWord)) return true;
    return false;
}

function scanForClanSurname(text) {
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

function extractRecipient(po) {
    const text = combinedDescription(po);

    const behalfMatch = text.match(ON_BEHALF_OF_REGEX);
    if (behalfMatch) {
        const name = behalfMatch[1].trim();
        if (!isDenylistedName(name)) {
            return normalizeRecipientName(name);
        }
    }

    const primaryMatch = text.match(RECIPIENT_REGEX);
    if (primaryMatch) {
        const name = primaryMatch[1].trim();
        if (!isDenylistedName(name)) {
            return normalizeRecipientName(name);
        }
    }

    const clanMatch = scanForClanSurname(text);
    if (clanMatch) {
        return normalizeRecipientName(clanMatch);
    }

    return null;
}

/**
 * Detect whether a PO description contains ANY recipient-like pattern,
 * even if the extracted name ultimately gets filtered out as staff.
 */
function hasRecipientPattern(po) {
    const text = combinedDescription(po);
    if (ON_BEHALF_OF_REGEX.test(text)) return true;
    if (RECIPIENT_REGEX.test(text)) return true;
    if (scanForClanSurname(text) !== null) return true;
    return false;
}

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

function classifyPO(po) {
    if (po.requestStatus === 'draft')     return { excluded: 'draft' };
    if (po.requestStatus === 'cancelled') return { excluded: 'cancelled' };
    if (po.requestStatus === 'rejected')  return { excluded: 'rejected' };

    const supplier = po.contact || '';
    const dominantAcct = dominantAccountCode(po);
    const accountCode = dominantAcct ? dominantAcct.accountCode : null;

    if (isInternalCorporate(po)) {
        return { excluded: 'internal_corporate' };
    }

    for (const combo of SUPPLIER_ACCOUNT_COMBOS) {
        if (combo.supplierPattern.test(supplier) && combo.accountCodes.includes(accountCode)) {
            return {
                category: combo.category,
                confidence: combo.confidence,
                reason: combo.reason
            };
        }
    }

    for (const hint of SUPPLIER_CATEGORY_HINTS) {
        if (hint.pattern.test(supplier)) {
            return {
                category: hint.category,
                confidence: 'high',
                reason: `supplier name matches "${hint.pattern.source}" pattern`
            };
        }
    }

    for (const hint of ACCOUNT_CODE_CATEGORY_HINTS) {
        if (accountCode && hint.pattern.test(accountCode)) {
            return {
                category: hint.category,
                confidence: hint.confidence,
                reason: hint.reason
            };
        }
    }

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

    // Step 8: Recipient-fallback. Uses hasRecipientPattern so POs where a
    // staff intermediary is named still classify as welfare even when the
    // beneficiary isn't attributable.
    if (hasRecipientPattern(po)) {
        const attributedName = extractRecipient(po);
        return {
            category: 'Family Charitable Payments',
            confidence: 'medium',
            reason: attributedName
                ? `recipient "${attributedName}" extracted`
                : 'recipient-pattern detected in description (staff intermediary, beneficiary not attributed)'
        };
    }

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
                'Internal corporate exclusion: vehicle regos, office keywords, "pick up by RAC"; intercompany Rirratjingu suppliers; printing/signage/IT/stationery/branding vendors',
                'Supplier + account combo (high): BP + 63415 → Family Charitable; Gove Warehouse + 64480 → Whitegoods',
                'Supplier name hint (high): Gove Transport/taxi, Air Frontier/Black Diamond/MAF/HM Air → Transport; funeral/memorial → Family Funeral; medical/chemist → Medical; Harvey Norman → Whitegoods; Buku Larrngay Mulka → Culture & Ceremony',
                'Account code family (high): 250xx → Family Charitable (member voucher, supplier-agnostic)',
                'Account code 64605 Travel → Transport; 63950 + recipient → Family Charitable; 63950 no recipient → Social & Cultural',
                'Description keyword (medium): "ceremonial/ceremony/buŋgul" → Culture & Ceremony Support',
                'Recipient extraction: "on behalf of X" > trigger-word regex (to/for/required by/requested by, filtering RAC staff as intermediaries per Jan 2026 staff list) > clan-surname scan (Marika/Yunupingu/Garrawurra/Bukulatjpi/Dhamarrandji/Wanapuyngu/Rarrkminy/Ulamari, with place-word negative lookahead)',
                'Recipient-fallback (Step 8): if ANY recipient-pattern detected → Family Charitable (medium), even when staff-intermediary filter removes the attributed name',
                'Everything else: Uncategorised — inspect sampleDescriptions to tune rules'
            ]
        }
    };
}

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
