// Welfare categoriser for Aboriginal Corp "We Provided" view.
//
// This module applies the heuristics documented in SAMPLING_FINDINGS.md §3-4 to
// classify Aboriginal Corp POs into AR narrative categories (Transport Assistance,
// Family Charitable Payments, etc.) and extract recipient names from description
// text.
//
// SENSITIVITY NOTE:
// Recipient names extracted by this module are real clan member names. The
// current dashboard DOES NOT surface individual names — it rolls them up at
// clan-family level. Recipient-level detail is preserved in the API response
// for authorised finance use only. See ANNUAL_REPORT_LEARNINGS.md §4.
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
// See DAY2_HANDOVER.md and SAMPLING_FINDINGS.md for context on the staff-list
// vs clan-member distinction. Only Marikas are clan in the staff roster.
const NON_CLAN_STAFF_NAMES = new Set([
    'Rhian Oliver', 'Jade Van Beelen', 'Paul Martin', 'Samuel Hinton',
    'Matt Muscat', 'Nancy Halafihi', 'Saheel Shah', 'Himanshu Pathak',
    'Kabita Adhikari',
    'Rachael Coonan', 'Shawn Mhaka',
    'Brodie Apthorpe', 'Rachael Schofield', 'Adrian Rota', 'Duane Kuru',
    'Jodie Douglas', 'Cassandra Richert', 'Jamie Schofield',
    'Rylee Ford', 'Elenie Bromot', 'Eleni Bromot',
    'Zoe Bromot', 'Peter Reeves', 'Tiani Mununggurritj',
    'Gavin Law', 'James Ball', 'Uheina Gillon', 'Matthew Henger',
    'Paul McLoughlin', 'Warwick Mylchreest', 'Jarrad Ernst',
    'Peter Britto',
    'Wilisoni Lotu', 'Wil Lotu', 'Wilson Lotu',
    'Jaclyn Bromot', 'Paula Gumana',
    'Sam Dentith', 'Max Edema', 'Chris Lamboa', 'Kai Mooney',
    'Jack Aragu', 'Danielle Stolte'
]);

const CLAN_SURNAMES = [
    'Marika', 'Yunupingu', 'Garrawurra', 'Bukulatjpi', 'Dhamarrandji',
    'Wanapuyngu', 'Rarrkminy', 'Ulamari'
];

const PLACE_WORDS = [
    'Gove', 'Nhulunbuy', 'Yirrkala', 'Elcho', 'Gapuwiyak', 'Darwin',
    'Malpi', 'Arnhem'
];
const PLACE_FIRST_WORDS = new Set(PLACE_WORDS);

const CLAN_SURNAME_SCAN_REGEX = new RegExp(
    String.raw`\b(?!(?:${PLACE_WORDS.join('|')})\b)([A-Z][a-z]+(?:\s+(?:[A-Z]\.?|[A-Z][a-z]+))*\s+(?:${CLAN_SURNAMES.join('|')}))\b`,
    'g'
);

const ON_BEHALF_OF_REGEX = /\bon\s+behalf\s+of\s+([A-Za-z][a-z]+(?:\s+(?:[A-Z]\.?|[A-Za-z][a-z]+))*\s+[A-Z][a-z]+(?:\s+(?:&|and)\s+[Ff]amily)?)/;

// Day 3h: extended recipient-trigger regex
//   - added "picked up by" and "collected by" triggers (staff intermediary pattern)
//   - relaxed first-letter casing to [A-Za-z] so "jaclyn Bromot" (typo'd lowercase)
//     still captures; output is normalised via normalizeNameCase() before denylist
const RECIPIENT_REGEX = /\b(?:[Tt]o|[Ff]or|[Pp]assenger|[Rr]equ(?:ired|ested)\s+[Bb]y|[Pp]icked\s+up\s+[Bb]y|[Cc]ollected\s+[Bb]y)\b[:\s]+([A-Za-z][a-z]+(?:\s+(?:[A-Z]\.?|[A-Za-z][a-z]+))*\s+[A-Z][a-z]+(?:\s+(?:&|and)\s+[Ff]amily)?)/;

// Day 3h: dollar-amount followed by name. Catches the common shop-slip format
// "Goods to the value of $472 Sam Dentith" where there's no "to"/"for" verb.
// Must be paired with isBusinessName() check so "$500 Peninsula Bakery" doesn't
// get mistaken for a welfare recipient.
const DOLLAR_NAME_REGEX = /\$[\d,]+(?:\.\d+)?\s+([A-Z][a-z]+(?:\s+(?:[A-Z]\.?|[A-Z][a-z]+))*\s+[A-Z][a-z]+)/;

// Day 3h: business-name suffix regex. If an extracted "name" contains any of
// these tokens, it's a supplier/business, not a person — reject.
const BUSINESS_NAME_SUFFIXES = /\b(Pty|Ltd|Inc|Enterprises|Supplies|Services|Group|Bakery|Warehouse|Transport|Logistics|Plumbing|Electrical|Mechanical|Industrial|Consulting|Construction|Contracting|Cleaning|Aviation|Clinic|Pharmacy|Hospital|Corporation|Cafe|Bank|Insurance|Towing|Printing|Mulka)\b/i;

const NON_PERSON_NAMES = new Set([
    'Ski Beach', 'Boat Club', 'Gove Dhalinbuy', 'Yanawal Units',
    'Hospital Driver', 'Hospital Pickup', 'Training Group',
    'Air Frontier', 'Black Diamond', 'Yirrkala Enterprises',
    'Gove Warehouse', 'Gove Transport', 'BP Nhulunbuy',
    'Peninsula Bakery', 'Kamayan Cafe', 'Territory Funerals',
    'Simplicity Funerals', 'Harvey Norman', 'Sodexo Remote',
    'MAF International',
    'Country Music Video',
    'Cruise Ship',
    'Lot Rd', 'Galpu Rd', 'Fender Rumble'
]);

// -----------------------------------------------------------------------------
// Rule sets
// -----------------------------------------------------------------------------


const SUPPLIER_ACCOUNT_COMBOS = [
    { supplierPattern: /\bbp\b/i, accountCodes: ['63415'], category: 'Family Charitable Payments', confidence: 'high', reason: 'BP + 63415 → member fuel voucher' },
    { supplierPattern: /gove warehouse/i, accountCodes: ['64480'], category: 'Whitegoods', confidence: 'high', reason: 'Gove Warehouse + 64480 → whitegoods/appliances' }
];

const SUPPLIER_CATEGORY_HINTS = [
    { pattern: /gove transport|taxi|letsgo/i, category: 'Transport Assistance' },
    { pattern: /air frontier|black diamond aviation|maf international|nhulunbuy air|\bhm air\b/i, category: 'Transport Assistance' },
    { pattern: /funeral|memorial/i, category: 'Family Funeral Support' },
    { pattern: /medical|pharma|chemist|clinic|hospital/i, category: 'Medical & Terminally Ill' },
    { pattern: /harvey norman|the good guys|appliances online|bing lee/i, category: 'Whitegoods' },
    { pattern: /buku larrngay/i, category: 'Culture & Ceremony Support' }
];

const ACCOUNT_CODE_CATEGORY_HINTS = [
    { pattern: /^250\d{2}$/, category: 'Family Charitable Payments', confidence: 'high', reason: 'account 250xx family → member charitable voucher' }
];

const DESCRIPTION_CATEGORY_HINTS = [
    { pattern: /\bceremon(?:y|ial|ies)\b|\bbu[ŋn]gul\b|ceremonial\s+ground/i, category: 'Culture & Ceremony Support', confidence: 'medium', reason: 'description mentions ceremony/ceremonial/buŋgul' }
];

const INTERNAL_CORPORATE_DESCRIPTION_PATTERNS = [
    /\b[A-Z]{2}\d{2}[A-Z]{2}\b/,
    /\bstandard service\b/i,
    /\boffice\b/i,
    /\bboardroom\b/i,
    /\bstaff meeting\b/i,
    /\bpick ?up by rac\b/i,
    /\bfor rac staff\b/i,
    /\brac office\b/i,
    /\bbarawun cent(?:re|er)\b/i,   // Day 3h: RAC-owned community facility
    /\bisep bus\b/i,                 // Day 3h: RAC-owned program bus
    /\bneal workshop\b/i             // Day 3h: RAC-owned workshop
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
    /\bbendesigns\b/i
];

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

// Day 3h: capitalise each word's first letter. Handles lowercase-typed names
// like "jaclyn Bromot" → "Jaclyn Bromot" so the staff-denylist check matches.
function normalizeNameCase(name) {
    return name.split(' ').map(w => {
        if (!w) return w;
        if (w === '&' || w.toLowerCase() === 'and') return w.toLowerCase();
        if (w.toLowerCase() === 'family') return 'Family';
        return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    }).join(' ');
}

// Day 3h: reject strings containing business/supplier suffix words
// (Pty, Bakery, Supplies, etc.) to prevent supplier names being mistaken
// for recipients when dollar-amount patterns match.
function isBusinessName(name) {
    return BUSINESS_NAME_SUFFIXES.test(name);
}

function isDenylistedName(name) {
    if (NON_PERSON_NAMES.has(name)) return true;
    if (NON_CLAN_STAFF_NAMES.has(name)) return true;
    if (isBusinessName(name)) return true;
    const firstWord = name.split(' ')[0];
    if (PLACE_FIRST_WORDS.has(firstWord)) return true;
    return false;
}

function scanForClanSurname(text) {
    CLAN_SURNAME_SCAN_REGEX.lastIndex = 0;
    const matches = text.matchAll(CLAN_SURNAME_SCAN_REGEX);
    for (const m of matches) {
        const candidate = m[1].trim();
        if (!isDenylistedName(candidate)) return candidate;
    }
    return null;
}

function extractRecipient(po) {
    const text = combinedDescription(po);

    const behalfMatch = text.match(ON_BEHALF_OF_REGEX);
    if (behalfMatch) {
        const name = normalizeNameCase(behalfMatch[1].trim());
        if (!isDenylistedName(name)) return normalizeRecipientName(name);
    }

    const primaryMatch = text.match(RECIPIENT_REGEX);
    if (primaryMatch) {
        const name = normalizeNameCase(primaryMatch[1].trim());
        if (!isDenylistedName(name)) return normalizeRecipientName(name);
    }

    // Day 3h: dollar-amount + name priority, between primary regex and clan scan
    const dollarMatch = text.match(DOLLAR_NAME_REGEX);
    if (dollarMatch) {
        const name = normalizeNameCase(dollarMatch[1].trim());
        if (!isDenylistedName(name)) return normalizeRecipientName(name);
    }

    const clanMatch = scanForClanSurname(text);
    if (clanMatch) return normalizeRecipientName(clanMatch);

    return null;
}

function hasRecipientPattern(po) {
    const text = combinedDescription(po);
    if (ON_BEHALF_OF_REGEX.test(text)) return true;
    if (RECIPIENT_REGEX.test(text)) return true;
    if (DOLLAR_NAME_REGEX.test(text)) return true;   // Day 3h
    if (scanForClanSurname(text) !== null) return true;
    return false;
}

function isInternalCorporate(po) {
    const supplier = po.contact || '';
    if (INTERNAL_CORPORATE_SUPPLIER_PATTERNS.some(p => p.test(supplier))) return true;
    const text = combinedDescription(po);
    if (INTERNAL_CORPORATE_DESCRIPTION_PATTERNS.some(p => p.test(text))) return true;
    return false;
}

// Pull Job tracking-category options off line items. AM exposes tracking
// at line level (categoryName: "Job", optionName: "FG 6", etc.). We
// don't pre-process these on the PO — we just walk lineItems here so
// the categoriser is self-contained regardless of who calls it.
function extractJobOptions(po) {
    const jobs = new Set();
    for (const li of (po.lineItems || [])) {
        if (!Array.isArray(li.tracking)) continue;
        for (const t of li.tracking) {
            if (t && t.categoryName === 'Job' && t.optionName) {
                jobs.add(t.optionName);
            }
        }
    }
    return Array.from(jobs);
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

    
    if (isInternalCorporate(po)) return { excluded: 'internal_corporate' };

    // ── Job-based override ──────────────────────────────────────────
    // If a line on this PO carries a Job tag matching the funeral
    // pattern, the team has explicitly told us this is funeral spend.
    // Trust them over any supplier/account/description inference.
    const jobOptions = extractJobOptions(po);
    const funeralJob = jobOptions.find(j =>
        /^FG\s*\d+\b/i.test(j) ||
        /^F\s*\d+\b/i.test(j) ||
        /funeral/i.test(j)
    );
    if (funeralJob) {
        return {
            category: 'Family Funeral Support',
            confidence: 'high',
            reason: `Job tag "${funeralJob}"`
        };
    }

    for (const combo of SUPPLIER_ACCOUNT_COMBOS) {
        if (combo.supplierPattern.test(supplier) && combo.accountCodes.includes(accountCode)) {
            return { category: combo.category, confidence: combo.confidence, reason: combo.reason };
        }
    }

    for (const hint of SUPPLIER_CATEGORY_HINTS) {
        if (hint.pattern.test(supplier)) {
            return { category: hint.category, confidence: 'high', reason: `supplier matches "${hint.pattern.source}"` };
        }
    }

    for (const hint of ACCOUNT_CODE_CATEGORY_HINTS) {
        if (accountCode && hint.pattern.test(accountCode)) {
            return { category: hint.category, confidence: hint.confidence, reason: hint.reason };
        }
    }

    if (accountCode === '64605') {
        return { category: 'Transport Assistance', confidence: 'medium', reason: 'account 64605 Travel, no supplier match' };
    }

    if (accountCode === '63950') {
        const recipient = extractRecipient(po);
        if (recipient) {
            return { category: 'Family Charitable Payments', confidence: 'medium', reason: 'account 63950 + extracted recipient name' };
        }
        return { category: 'Social & Cultural Programs', confidence: 'low', reason: 'account 63950 without clear recipient' };
    }

    const descriptionText = combinedDescription(po);
    for (const hint of DESCRIPTION_CATEGORY_HINTS) {
        if (hint.pattern.test(descriptionText)) {
            return { category: hint.category, confidence: hint.confidence, reason: hint.reason };
        }
    }

    if (hasRecipientPattern(po)) {
        const attributedName = extractRecipient(po);
        return {
            category: 'Family Charitable Payments',
            confidence: 'medium',
            reason: attributedName
                ? `recipient "${attributedName}" extracted`
                : 'recipient-pattern detected (staff intermediary, beneficiary not attributed)'
        };
    }

    return { category: 'Uncategorised', confidence: 'none', reason: `no match: supplier="${supplier}", accountCode=${accountCode}` };
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
            recipientTotals: {},
            familyTotals: {}   // Day 3h: clan-family rollup
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
        familyTotals: {},
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

            // Day 3h: clan-family rollup — use surname word as family key if it's
            // a known clan surname; otherwise lump under 'Other / Unattributed'.
            const parts = recipient.replace(/\s+and\s+Family$/i, '').split(' ');
            const lastWord = parts[parts.length - 1];
            const familyKey = CLAN_SURNAMES.includes(lastWord) ? lastWord : 'Other clan families';
            if (!bucket.familyTotals[familyKey]) {
                bucket.familyTotals[familyKey] = { family: familyKey, total: 0, poCount: 0, recipients: new Set() };
            }
            bucket.familyTotals[familyKey].total += (po.total || 0);
            bucket.familyTotals[familyKey].poCount += 1;
            bucket.familyTotals[familyKey].recipients.add(recipient);
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

        // Day 3h: family rollup output
        const topFamilies = Object.values(bucket.familyTotals)
            .sort((a, b) => b.total - a.total)
            .map(f => ({
                family: f.family,
                total: round2(f.total),
                poCount: f.poCount,
                uniqueRecipients: f.recipients.size
            }));

        const out = {
            arLine: bucket.arLine,
            fy25Baseline: bucket.fy25Baseline,
            ytdTotal: round2(bucket.ytdTotal),
            ytdPOs: bucket.ytdPOs,
            confidenceBreakdown: bucket.confidenceBreakdown,
            uniqueRecipients: bucket.uniqueRecipients.size,
            topSuppliers,
            topRecipients,
            topFamilies
        };

        if (bucket.fy25Baseline) {
            out.ytdPercentOfBaseline = round1((bucket.ytdTotal / bucket.fy25Baseline) * 100);
            const projectedFullYear = fyPaceFraction > 0.05 ? bucket.ytdTotal / fyPaceFraction : null;
            out.projectedFullYear = projectedFullYear ? round2(projectedFullYear) : null;
            out.projectedVsBaseline = projectedFullYear
                ? round1(((projectedFullYear - bucket.fy25Baseline) / bucket.fy25Baseline) * 100)
                : null;
        }

        if (bucket.sampleDescriptions) out.sampleDescriptions = bucket.sampleDescriptions;
        return out;
    });

    finalCategories.sort((a, b) => {
        if (a.arLine === 'Uncategorised') return 1;
        if (b.arLine === 'Uncategorised') return -1;
        return (b.fy25Baseline || 0) - (a.fy25Baseline || 0);
    });

    const totalWelfareValue = round2(
        finalCategories.filter(c => c.arLine !== 'Uncategorised').reduce((sum, c) => sum + c.ytdTotal, 0)
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
            note: 'Heuristic classifier. See SAMPLING_FINDINGS.md §3-4 for rules. Recipient names are rolled up to clan-family level (topFamilies) on the dashboard; individual-level topRecipients is retained for authorised finance use.',
            rules: [
                'Internal corporate exclusion: vehicle regos, office keywords, "pick up by RAC"; RAC facilities (Barawun Centre, ISEP bus, NEAL workshop); intercompany Rirratjingu suppliers; printing/signage/IT/branding vendors',
                'Supplier + account combo (high): BP + 63415 → Family Charitable; Gove Warehouse + 64480 → Whitegoods',
                'Supplier name hint (high): Gove Transport/taxi, Air Frontier/Black Diamond/MAF/HM Air → Transport; funeral/memorial → Family Funeral; medical/chemist → Medical; Harvey Norman → Whitegoods; Buku Larrngay Mulka → Culture & Ceremony',
                'Account code family (high): 250xx → Family Charitable',
                'Account code 64605 Travel → Transport; 63950 + recipient → Family Charitable; 63950 no recipient → Social & Cultural',
                'Description keyword (medium): "ceremonial/ceremony/buŋgul" → Culture & Ceremony Support',
                'Recipient extraction: "on behalf of X" > trigger-word regex (to/for/required by/requested by/picked up by/collected by, filtering RAC staff + business-name suffixes) > $amount-plus-name > clan-surname scan (Marika/Yunupingu/Garrawurra/Bukulatjpi/Dhamarrandji/Wanapuyngu/Rarrkminy/Ulamari, with place-word negative lookahead)',
                'Recipient-fallback (Step 8): if ANY recipient-pattern detected → Family Charitable (medium), even when staff-intermediary filter removes the attributed name',
                'Everything else: Uncategorised — inspect sampleDescriptions'
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
