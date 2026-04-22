# RAC Annual Report 2024-25 — Learnings That Shape This Dashboard

**Source:** Rirratjingu Aboriginal Corporation 2024-25 Annual Report (public, available at rirratjingu.com)
**Read by Claude:** Day 2 session (~session context: post-pagination, ~3,938 AM-era records discovered)
**Purpose of this doc:** Context from the AR that directly informs how the ApprovalMax dashboard should be designed, what it should measure, and why it matters to RAC leadership.

This doc sits alongside `PROJECT_CONTEXT.md`. PROJECT_CONTEXT is the *technical* handover (what we built, what works, what's broken). THIS doc is the *strategic* and *organisational* context (what RAC actually is, why they use AM, what leadership cares about). Both should be read at the start of any future session.

---

## 1. The Big Unlock — AM is Publicly Named in the AR

The COO (Paul Martin, in his first AR report) says on page 12:

> "Strengthened internal controls, including an updated financial delegation policy and **online purchase order approvals**."

That sentence is ApprovalMax. Paul has publicly committed to this system as part of the governance uplift. This reframes the dashboard entirely:

- It's not peripheral tech work. It's Board-visible evidence supporting **Strategic Priority 5 (Retain and Elevate Outstanding Governance)** and **Priority 7 (Build a High-Performing and Professional Organisation)**.
- The Premium upsell business case isn't just "nice to have analytics" — it's "make real the governance commitment already made in public".
- The audience isn't a generic CFO. It's specifically Paul Martin (COO, AM champion), with Rhian Oliver (CEO) as the strategic buyer and Matt/Rhian/Paul/Saheel (accountants) as the daily users.

**Implication:** Every analysis we design should be framed as evidence that "online purchase order approvals" are working — or surfacing where they're not.

---

## 2. The Consolidated Group — AM Sees the Core, Not Everything

From Note 18 of the financials, RAC's consolidated group in 2024-25 is:

### Wholly-owned subsidiaries (in our AM list, 5 orgs)

| AM CompanyId | AM Org Name | Group name in AR | What it does |
|---|---|---|---|
| c32a3d25-... | Rirratjingu Aboriginal Corporation 8538 | **Parent — RAC itself** | Charitable payments, culture & community budget, Future Fund management, Board and governance |
| 6655cc87-... | Rirratjingu Mining Pty Ltd 7168 | **Rirratjingu Mining Pty Ltd** | Gove Blue Metal Quarry. Sells rock/sand/gravel. Major customer: Rio Tinto rehab. Sold 55,571t crushed rock + 7,236t gravel + 3,366t sand in FY25 |
| ef3d29f3-... | Rirratjingu Property Management & Maintenance Services Pty Ltd | **RPMMS** | Housing maintenance, landscaping. 17 staff (13 Indigenous). 1,350 maintenance tasks completed FY25. ~$2M turnover |
| 77b4e48b-... | Rirratjingu Enterprises Pty Ltd | **Rirratjingu Enterprises (RE)** | Civil works, transport logistics, training. New fleet: 35kl water tanker, prime mover, 10m³ tipper. CFMEU Cert III training |
| 075c13e2-... | Rirratjingu Invest P/L ATF Miliditjpi Trust | **The Miliditjpi Trust** | Property investment arm. Yanawal Units, Rirratjingu Business Centre. Holds investment properties worth ~$21M |

### Group entities NOT in our AM list

These exist but aren't surfaced in our current AM pipeline — either because they're new, JVs, or associates:

- **Rirratjingu Project Management Pty Ltd** (RPM) — 51% owned, JV with Sitzler Pty Ltd. First confirmed project: Bunggulwuy Close Development (11 × 2BR dwellings in Nhulunbuy, lock-up H1 2026). May appear in AM later.
- **Ngarrkuwuy Developments Pty Ltd** — 100% owned. Delivering housing + commercial infrastructure.
- **Marrin Square Developments Pty Ltd** — 100% owned. Property development.
- **Gunditpuy Accommodation Village Pty Ltd** — 51% owned.
- **Rirratjingu Fuel Pty Ltd** — 50% JV with Cambridge Gulf Limited (CGL). Delivered 17.6 million litres of diesel across 13 shipments + 735 road deliveries in FY25. Major supplier of Rio Tinto, Laynhapuy Homelands, BP Nhulunbuy Service Station. Treated as **associate** in consolidated accounts.
- **Yirrkala Enterprises Pty Ltd** — 25% associate.

**Implication:** If Duane's team ever asks "why don't I see Rirratjingu Fuel in the dashboard?" — it's because Fuel is a 50/50 JV and probably has its own AM subscription (or none). Same story for RPM. Something to confirm with Duane if it becomes relevant.

---

## 3. The Welfare Pattern — Now Quantified

Day 2 hypothesis was: "Aboriginal Corp is the clan welfare distribution engine." The AR confirms AND quantifies this.

From page 9 (Chairman's Report) and page 14 (2024-25 Spotlights):

**Total culture & community budget FY25: $2,341,481** (23.58% of overhead)

Breakdown:
- Family Charitable Payments: **$1,403,221**
- Member's Transport Assistance: **$360,000** (this is the "taxi" spend Duane mentioned)
- Family Funeral Support: **$205,984**
- Culture & Ceremony Support: **$90,565**
- Social & Cultural Programs: **$76,808**
- Education & Health for Families: **$38,237**
- Support for Medical & Terminally Ill: **$37,505**
- Support for Whitegoods: **$25,440**
- Future Leaders Program: **$9,453**
- Sponsorships (football, music, other): $213,745
- Denise Fincham Education Fund contribution: $70,000

Director-approved family charitable payments per Note 21 of financials: **$1,330,425 in 2025** (up from $1,276,800 in 2024).

**What this means for the dashboard:**

Aboriginal Corp's 2,000+ POs aren't noise — they're this budget in action. Spread across ~100 clan members and ~10 months of AM-era activity, the shape should roughly be:
- ~20 POs per member per year, or one every 2-3 weeks per individual
- Transaction sizes clustered at "grocery + service + transport" scale — likely $50-$500 range
- Supplier concentration probably heavy on supermarkets, taxi services, utility retailers, whitegoods suppliers, funeral services
- Heavier activity around cultural events (Yarrapay Festival, NAIDOC, funerals)

**Analysis implications:**

The compliance/anomaly analysis for Aboriginal Corp should look for:
1. **Recipient frequency anomalies** — any member receiving disproportionately often
2. **Amount clustering just below approval thresholds** — classic workflow bypass signal
3. **Same-day duplicates** — entered-twice vs legitimate genuine-different-purpose
4. **Cross-entity recipients** — same clan member receiving from Aboriginal Corp AND another RAC entity in same period
5. **After-hours / weekend submissions** — legit for urgent funeral support, suspicious for routine grocery top-ups
6. **Unusual supplier spikes** — a supplier suddenly appearing in many POs
7. **Member's Transport Assistance specifically** — $360K in taxis is a category that deserves its own lens; sample the POs, look at distribution by supplier and recipient

For **Mining, RPMMS, Enterprises** — classic commercial procurement anomaly detection:
- Split POs (same supplier, same week, multiple POs just under threshold)
- Related-party suppliers (scan supplier names against Director/staff surnames — careful with cultural sensitivity here, Marika is an extremely common clan name)
- Amount spikes vs historical supplier baseline
- Approver concentration (one person approving everything)

For **Invest (Miliditjpi Trust)** — low volume (82 records AM-era), case-by-case review. Not statistical.

---

## 4. People Who Appear in AM Event Logs

When Task 2 (sample live AM-era records) runs, we'll see human author IDs in the `events` array. Matching them to real people requires knowing who's who. From the AR:

### Board of Directors (FY25)
- **Wanyubi Marika** — Chair (elected 28 Nov 2024). Senior Rirratjingu Leader.
- **Brendan Marika (Makungun)** — Deputy Chair (elected 28 Nov 2024). NLC Council member.
- **Ishmael Marika** — Creative Director, Mulka Project. Graduated Emerging Leaders to Board.
- **Yalmay Yunupingu** — 2024 Senior Australian of the Year. Former Yirrkala Bilingual School educator.
- **Djayminy Marika (Djay)** — Emerging Leader graduate, Director.
- **Guruminbuy Marika (Steven)** — Senior ceremonial leader, Rirratjingu Clan.
- **Djalinda Ulamari** — Alternate director for Yirrmal Marika (since Jan 2024).
- **Witiyana Marika** — Cultural Ambassador (ceased as Director Nov 2024). Chairs Culture Committee. Founding member, Yothu Yindi.

### Board members who ceased during FY25
- **M. Marika (Mr M Marika / Mandaka / Sam)** — ceased 2 June 2025, **passed away June 2025**. Was Chairman until Nov 2024. The AR honours him on the cover and with a full tribute (pages 38-39). Senior Elder, former Dhimurru Rangers MD. **His name may appear in approval logs during FY25 — treat with respect; any analysis involving his activity should be purely factual, not inferential.**
- **Yirrmal Marika** — ceased 28 Nov 2024.

### Executive Leadership (likely frequent approvers)
- **Rhian Oliver** — CEO (since Oct 2021). Director of RPM.
- **Paul Martin** — COO (NEW ROLE FY25). AM champion per his report. First AR appearance.
- **Kate Spinks** — GM Community Services (promoted FY25 from Culture & Community Manager).
- **Sam Hinton** — GM Commercial Services.

### Corporate Services / Finance (likely AM admin users)
- **Matt, Rhian, Paul, Saheel** — the four accountants per user memories. **Saheel Shah** is confirmed in AR — Finance Manager since 2010 (15-year tenure).
- **Adrian Rota** — Corporate Secretary (29-year association with RAC/region).

### Special Advisors (Board-level, not daily ops)
- **Denise Fincham** — 40+ year association. Director of Rirratjingu Fuel & Investments.
- **Danny Keep** — Since 2013. External governance/compliance advisor.
- **Peter Chilman** — July-Dec 2024 only (short term, then left).

### Management (operational approvers)
- **Samuel Dentith** — Manager RPMMS (promoted FY25 from Housing Maintenance Supervisor).
- **Uheina Gillon** — WHS Advisor (promoted FY25).
- **Jerome Dhamarrandji** — long-tenure landscaping team member (since 2009).
- **Himanshu Pathak** — since Nov 2014.

**Sensitivity note:** Marika is the dominant clan surname — many Directors share it but they're not all related in the way a shared surname might suggest in Balanda (non-Indigenous) contexts. Don't infer related-party relationships from surname alone; it would be both inaccurate and culturally naive.

---

## 5. Scale Calibration (What "Normal" Looks Like)

From the consolidated financials:

- **Total revenue FY25: $30.7M** (up from $26.4M FY24)
- **Royalties (Gove + Section 64): $12.2M**
- **Sale of goods: $8.1M** (mostly quarry)
- **Services income: $5.0M**
- **Rental income: $3.0M**
- **Profit after tax: $6.9M** (down from $9.1M — driven by investment property revaluation)
- **Total assets: $68.5M**
- **Future Fund Charitable Payments Reserve: $53.35M accumulated**

**What this tells us for AM-era expectations:**

- Total spend (cost of goods + expenses) in FY25 was ~$24.5M
- If *most* procurement flows through AM, we'd expect AM POs to represent a significant fraction of that $24.5M
- 3,938 AM-era records over ~10 months = ~4,700 annualised
- If average PO is $3,000, that's ~$14M of spend through AM — plausible
- If average PO is $1,000 (welfare-weighted), that's ~$4.7M through AM — also plausible for the Aboriginal Corp + services side

The 2,000-cap on Aboriginal Corp POs may need the cap raised. 2,000 POs over 10 months across ~100 members = 20 POs/member/year, which IS the welfare cadence. True number is likely 2,500-3,500 POs for Aboriginal Corp alone in the AM era.

**Staff scale:** "Grown from a small workforce to nearly 50 employees" in recent years. HR snapshot pages 92-93 shows ~50 staff across RAC + RPMMS + RE.

---

## 6. Audit Context — New Auditors, Fresh Eyes

Per COO report and Note 24 of financials:

- **New external auditors appointed FY25 in line with best-practice audit rotation**: PKF Merit (partner: Matthew Kennon)
- **Previous auditor**: KPMG Australia
- Audit fee FY25: $84,545 (down from $140,915 with KPMG, which included $35K prep assistance)

**What this means:**

PKF Merit is a new set of eyes on RAC's controls. They will be scrutinising the delegation-of-authority and PO workflow during the FY26 audit (their second year). A dashboard that can surface exceptions, approvals-by-delegate, split-POs, and amount-threshold patterns is directly useful to the audit process. If Paul/Saheel can hand the auditor a "flagged exceptions" report from the dashboard before fieldwork, that's audit-quality uplift.

---

## 7. Mining Transition Clock — The Strategic Urgency

From the Chairman's Report, CEO Report, and "Our Region — At the Crossroads" (pages 32-33):

- **Rio Tinto bauxite mine closes 2029**
- RAC's royalty stream (currently $12.2M/year) declines after closure
- 2025-2030 Strategic Plan explicitly targets post-mining transition
- Chairman: "Our Future Fund Charitable Payments Reserve" is now $53.35M — designed to sustain welfare payments after royalties cease
- Commercial Priority 6: "Build Wealth Through Commercial Opportunities & Investments" — growing diversified revenue

**Implication for dashboard:**

Governance efficiency is about to matter more, not less. Every dollar of welfare payment post-mining will come from the Future Fund, which means:
- Compliance visibility becomes more critical (you can't waste Future Fund money on duplicate POs)
- Spend pattern intelligence helps the Board make informed decisions about sustaining welfare at scale with less royalty income
- AM Premium's ~$2,400/year cost is trivial against a $53M reserve, but only justifiable if the analytics *actually prevent* or *detect* 5-10× that value in waste/error/misconduct

---

## 8. Strategic Plan Alignment

The 2025-2030 Strategic Plan has 10 Priorities with ~200 Actions in Year 1 (FY26). The dashboard maps cleanly to:

### Priority 5 — Retain and Elevate Outstanding Governance
The dashboard is the "transparency measure" in action. It makes Board oversight of procurement real-time rather than after-the-fact.

### Priority 7 — Build a High-Performing and Professional Organisation
Modern systems, sharper delivery cadence, traffic-light reporting. The COO specifically mentions a "simple traffic-light reporting framework" for strategic and operational actions. The dashboard could feed that framework with procurement-signal data.

### Priority 8 — Deliver Services that Support Rirratjingu Families
Welfare payment visibility is part of *responsibly* delivering those services. Members deserve to know the mechanism is clean.

---

## 9. Things Deliberately Out of Scope (From the AR)

Things that appear in the AR that are NOT within the dashboard's remit:

- **Cultural approvals and decisions** — the Culture Committee (chaired by Witiyana Marika) makes decisions about ceremonies, sacred sites, language protection. These are Board-level cultural governance, not financial workflow.
- **Strategic Plan delivery tracking** — the "traffic-light framework" for ~200 Actions. Different system, different scope.
- **Native Title / legal matters** — Commonwealth v Yunupingu compensation flows may come in future years. Out of scope.
- **HR / workforce analytics** — covered in HR Report section of AR, separate system.
- **Training outcomes** — Cert II Rural Operations graduates, CFMEU Cert III, polywelding certifications. Separate reporting.
- **Future Fund investment performance** — managed by Morgan and Macquarie (Note 12). Separate portfolio reporting.

The dashboard stays narrow: **AM procurement workflow for the 5 consolidated entities.**

---

## 10. Quotes Worth Remembering

From COO report (page 12):
> "Strengthened internal controls, including an updated financial delegation policy and online purchase order approvals."

From CEO report (page 10):
> "Stronger financial controls, clearer reporting, and streamlined systems have lifted accountability and improved Board oversight. These reforms now give management the tools to plan and deliver with confidence..."

From Chairman's report (page 9):
> "This progress is only possible because of the diligence and courage of the RAC Board."

From Strategic Priority 5:
> "embedding best practice systems, enhancing transparency measures, and deepening community trust"

These phrases are the language the dashboard should use in its own UI, in any business case, and in handover docs to Paul/Rhian/Matt. They already have Board buy-in. Don't reinvent the framing.

---

## 11. First Thing a Future Claude Should Do (After PROJECT_CONTEXT.md)

1. Read `PROJECT_CONTEXT.md` for technical state.
2. Read THIS doc for organisational and strategic state.
3. Internalise: **Aboriginal Corp is the welfare engine, not an outlier. Its 2,000+ POs are proportional to its $2.3M welfare budget over ~100 members.**
4. When designing analysis, remember the audience: **Paul Martin (COO, AM champion), Rhian Oliver (CEO), Matt/Saheel (accountants).**
5. Never infer related-party relationships from shared Marika surname alone.
6. Treat any AM activity associated with the late M. Marika (Chair until Nov 2024, passed June 2025) with factual care — he's honoured on the AR cover for good reason.

---

## Document metadata

- Drafted: Day 2 session by Claude after reading the full 140-page AR end-to-end
- Author: Claude (via Duane's session, committed from his GitHub token)
- Next review: When RAC's FY26 AR lands (typically November-ish each year), compare strategic priorities and update this doc
- If Duane ever asks "what's new vs last year's report?" — the AR itself is at `rirratjingu.com` and the financials section has the historical comparatives
