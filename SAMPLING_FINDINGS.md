# RAC ApprovalMax Dashboard — Sampling Findings (Day 2)

**Source:** 25 real AM-era purchase orders sampled 23 April 2026 via `/api/xero/purchase-orders?limit=5&createdAtOrAfter=2025-06-01` across all 5 RAC entities.

**Purpose:** The third leg of the handover stool alongside `PROJECT_CONTEXT.md` (technical state) and `ANNUAL_REPORT_LEARNINGS.md` (organisational/strategic state). This doc captures the *data shape* discoveries — what the dashboard can actually group, filter, and reveal based on what's really in the records.

A future Claude session should read all three in order before engaging with Duane on new work.

---

## 1. The Punchline

**Xero account codes are the reliable grouping anchor. Tracking categories are not.**

Account codes appear on every line item in the sample, they're standardised across all 5 entities, and they roll up to the same chart of accounts that feeds the AR financials. That makes them the natural BI grouping dimension and the natural bridge to AR narrative.

Tracking categories are entity-specific, inconsistently used, and only genuinely useful for Mining and Miliditjpi Trust. Two entities (Aboriginal Corp and Enterprises) effectively tag everything with one placeholder value.

This reshapes the dashboard design:

- **Primary BI grouping dimension:** `accountCode`
- **Secondary filter:** tracking category (surfaced only where meaningful)
- **AR-insight layer:** a small lookup table `accountCode → AR narrative line`, applied as subtle captions/tooltips, not as headline grouping
- **Aboriginal Corp welfare view:** uses `accountCode` + regex extraction of recipient names from `description` text (AR-grade narrative is in the prose, not the metadata)
- **Exceptions tile:** surfaces governance signals already visible in the `events` array (self-approval, post-approval changes, reject-then-reapprove, duplicate submissions)

---

## 2. Per-Entity Tracking Category Reality

Each entity has its own Xero tracking setup. From the 25-PO sample:

### Rirratjingu Mining Pty Ltd (5 POs sampled)

- **Tracking category:** "Job"
- **Options observed:** `05 - Gravel and Sand Quarry`, `09 - Pond 5 Work`
- **Quality:** **Excellent.** These map near-1:1 to AR narrative. "Pond 5 Work" is exactly the Rio Tinto rehabilitation activity the AR describes (55,571 tonnes crushed rock delivered FY25). "Gravel and Sand Quarry" is the quarry operations line.
- **Coverage in sample:** 100% of non-cancelled POs have meaningful tracking
- **Implication:** Mining's entity view can genuinely be driven by tracking. "Operational spend against tonnages sold" is buildable with `tracking.optionName` + `accountCode`.

### Rirratjingu Invest P/L ATF Miliditjpi Trust (5 POs sampled)

- **Tracking category:** "Job"
- **Options observed:** `01 - Administration`, `13 - Yanawal Units`
- **Quality:** **Good.** "Yanawal Units" is the AR's flagship short-stay accommodation asset (~$150K outdoor kitchen mentioned in AR). Administration covers consultancy/travel.
- **Coverage in sample:** 80% (one draft PO had empty tracking)
- **Implication:** Miliditjpi's "Property portfolio BAU spend" view works with tracking. Yanawal Units tracking = that specific asset's lifecycle costs.

### Rirratjingu Aboriginal Corporation 8538 (5 POs sampled)

- **Tracking category:** "Job"
- **Options observed:** `Administration` (only — all 5 POs)
- **Quality:** **Poor for narrative purposes.** Every welfare PO — fuel to a member, taxi for a funeral journey, groceries for a family — is tagged "Administration" with no distinguishing option. This is not an accounting failure (it's the correct cost-centre), just not useful for AR-narrative grouping.
- **Coverage in sample:** 100%
- **Implication:** Cannot use tracking to drive the Aboriginal Corp "We Provided" view. **See Section 4 for the extraction approach that does work.**

### Rirratjingu Property Management & Maintenance Services (5 POs sampled)

- **Tracking category:** "AroFlo" (different category name — references RPMMS's job management system)
- **Options observed:** `03 - Maintenance Contract`, `01 - Administration`
- **Quality:** **Mixed.** "Maintenance Contract" is AR-useful (RPMMS did 1,350 maintenance tasks FY25). But sampling also showed 2 POs with `tracking: []` (empty array) — including the $1,050 sand donation for Yirrkala Sports Carnival and $205 catering for Peninsula Bakery.
- **Coverage in sample:** 60% (3 of 5 had tracking)
- **Implication:** Useful where present, but we need to handle empty tracking gracefully. The `accountCode` always fills the gap (sand donation = 63930 Materials & Supplies, catering = 63950 Meeting Expenses).

### Rirratjingu Enterprises Pty Ltd (5 POs sampled)

- **Tracking category:** "Job"
- **Options observed:** `Stage All` (only — all 5 POs)
- **Quality:** **Poor.** Every PO — ramp equipment, waste dumping, full vehicle service, hand tools, PPE boots — tagged `Stage All`. This is a placeholder that tracks nothing useful.
- **Coverage in sample:** 100%
- **Implication:** Cannot use tracking for Enterprises. Falls back to `accountCode` + supplier name. Good news: Enterprises' account codes ARE granular (51060 Cost - Parts & Labour, 49500 RIA Labour hire, 42017 Sales - Remove & Dispose, 51050 Cost - Materials) so the fallback works.

### Summary table

| Entity | Tracking quality | Coverage | Usable for AR narrative? |
|---|---|---|---|
| Mining | Excellent | 100% | Yes |
| Miliditjpi Trust | Good | 80% | Yes |
| RPMMS | Mixed | 60% | Partial — fallback to accountCode for gaps |
| Aboriginal Corp | Poor (one option only) | 100% | No — use accountCode + description regex |
| Enterprises | Poor (placeholder only) | 100% | No — use accountCode + supplier |

---

## 3. Xero Account Codes Observed in Sample

Standardised across all 5 entities (roll up to the same chart of accounts that feeds the AR financials).

### Cost of goods / materials / labour

- `51050 - Cost - Materials` (Mining, Enterprises)
- `51060 - Cost - Parts & Labour` (Enterprises)
- `42017 - Sales - Remove & Dispose of unserviceable goods` (Enterprises — revenue-side)
- `49500 - RIA - Labour hire` (Enterprises)
- `63680 - Freight & Cartage` (Mining)
- `63930 - Materials & Supplies` (RPMMS)

### Operating expenses

- `63170 - Consultancy Fees` (Invest)
- `63900 - Licences & Permits` (Invest)
- `63950 - Meeting Expenses` (Aboriginal Corp, RPMMS)
- `64000 - Motor Vehicle Expenses` (RPMMS)
- `64170 - Safety Equipment & Uniforms` (Mining)
- `64284 - Repairs - Plant & Equipment` (Mining, RPMMS)
- `64290 - Motor Vehicle Costs` (Aboriginal Corp — slight naming variant vs RPMMS's 64000)
- `64605 - Travel` (Aboriginal Corp)

### Observations

- Account naming isn't perfectly uniform ("Motor Vehicle Expenses" 64000 at RPMMS vs "Motor Vehicle Costs" 64290 at Aboriginal Corp) — each entity's chart of accounts is slightly independent
- The **numeric code range** is a more reliable grouping than the name. 51xxx = Cost of sales, 63xxx = Operating overheads, 64xxx = Admin/facility costs
- Account codes are populated on **every** non-empty line item in the sample (one line in PO-0458 had `accountCode: null` but also `amount: 0` — looks like a header/stub line)

### AR narrative mapping candidates (the "subtle insight layer")

From the AR "We Provided" / "We Sold" / "We Received" / "We Invested" buckets, tentative account-code mappings:

| AR narrative line | FY25 AR amount | Candidate account codes |
|---|---|---|
| Member's Transport Assistance | $360,000 | `64605 Travel` in Aboriginal Corp, filtered to Gove Transport supplier |
| Family Charitable Payments | $1,403,221 | Likely a consolidated sum — account codes TBC, probably 63950 Meeting Expenses + 64605 Travel + others in Aboriginal Corp |
| Support for Whitegoods | $25,440 | Needs sampling — possibly 63930 Materials or a dedicated welfare code |
| Family Funeral Support | $205,984 | Needs sampling |
| Culture & Ceremony Support | $90,565 | Needs sampling |
| Social & Cultural Programs | $76,808 | Possibly 63950 Meeting Expenses (catering patterns) |
| "We Sold" — quarry tonnages | 55,571t rock + 7,236t gravel + 3,366t sand | Cannot be inferred from POs/Bills; this is **sales**, comes from Xero invoices, not AM approval data |

**Important limitation:** The dashboard can report on *procurement* (cost side). The AR's "We Sold" section reports on *revenue*. Unless the user subscribes to AM for sales-invoices (which they may, per the `sales-invoices` type in the picker), we can't reflect the "We Sold" view from AM data alone. Something to raise with Duane.

---

## 4. Aboriginal Corp Welfare: The Description-Field Extraction Pattern

Since tracking category is useless for welfare narrative, the recipient name + purpose live in the `lineItems[].description` text.

### Observed patterns from 5 Aboriginal Corp POs

- `PO-12134` (BP Nhulunbuy, $50, account 63950): *"Fuel to the value of $50 to **Gayili Marika**"*
- `PO-12135` (Yirrkala Enterprises, $100, account 63950): *"Goods to the value of $100 to **Rachael Coonan**"*
- `PO-12136` (Darkys Mechanical, $1000, account 64290): *"CE03AQ Standard Service"* — corporate vehicle, no recipient (good — shows pattern is narrow to welfare)
- `PO-12137` (Gove Transport, $100, account 64605): *"One way taxi from Yirrkala to Gallupa — Ski Beach today (2/6) at 11 am. Pick up - Bunuwal Office - Yirrkala. **Gayili Marika & Family**"*
- `PO-12138` (Gove Transport, $50, account 64605): *"One way taxi from Yirrkala to Town today (2/6) for **Makungun Marika**"* (note: Makungun is Brendan Marika's Yolŋu name — Deputy Chair per the AR)

### Extraction strategy

Two recurring prepositional patterns:
- **"to [Name]"** — used when goods/fuel/money are provided TO a person
- **"for [Name]"** — used when a service (typically taxi) is arranged FOR a person

A regex like `/\b(?:to|for)\s+((?:[A-Z][a-z]+\s+)+[A-Z][a-z]+(?:\s+(?:&|and)\s+Family)?)/` would capture most cases. Will miss edge cases (first-name-only references, collective "the family") — acceptable for a first pass; can refine as we see more data.

### Welfare category inference from account code

- `64605 Travel` + Gove Transport supplier → **Transport Assistance** (AR line: $360K)
- `63950 Meeting Expenses` + retail/supermarket supplier + description with "to [Name]" → **Family Charitable Payments** (AR line: $1.4M)
- `63950 Meeting Expenses` + catering supplier (Peninsula Bakery etc.) → probably **Social & Cultural Programs** or **Meeting costs** (internal, not member-facing)
- `64290 Motor Vehicle Costs` + no recipient name → internal corporate spend, **not** welfare

The dashboard's Aboriginal Corp "We Provided" view emerges:

1. Filter Aboriginal Corp POs to those with extractable recipient names from description
2. Group by inferred welfare category (account code + supplier type)
3. Running YTD totals displayed alongside FY25 AR baseline (e.g. "Transport Assistance YTD: $X, tracking at Y% of FY25 $360K annual")
4. Secondary view: recipient frequency distribution (who's receiving what, how often)

**Sensitivity note:** Recipient names will appear in the UI. This is real member data. Access control and cultural sensitivity matter. Worth a conversation with Paul/Rhian/Matt about who can see the recipient-level drill-down vs who sees category-level aggregates only.

---

## 5. Compliance Signals Already Visible in 25 POs

Four distinct governance patterns surfaced in this small sample. All extractable from the `events` array plus event ordering/author comparison.

### A. Self-approval (same person submits AND approves)

**Observed in:**
- `PO-12134`, `PO-12135`, `PO-12137`, `PO-12138` — author `babc085f-3e3b-4169-be85-63066f9ca330` submits AND approves all four Aboriginal Corp welfare POs (all ≤$100)
- `PO-12136` — author `d22064da-582b-4659-8169-64ea4cca9bb1` self-approves $1,000 Aboriginal Corp vehicle service
- `PO-0461` — author `3bc6cdc7-fce2-46d4-b0c9-56e426eb4e86` self-approves $293.49 PPE boots in Enterprises (14 seconds gap between submit and approve)

**Detection:** `events[n].authorId WHERE eventType = "requesterSubmitted"` equals `events[m].authorId WHERE eventType = "approverApprovedRequestApproved"`.

**Interpretation:** Could be policy-configured delegated authority (common for low-value POs) OR a workflow gap. Needs conversation with Matt/Saheel to understand the intent. The dashboard surfaces the pattern, leadership interprets it.

### B. Post-approval change detected

**Observed in:** `PO-0460` (Enterprises, Gove Motors, $250) — has a `postApprovalChangeDetected` system event on 2025-06-16, two weeks after approval on 2025-06-03.

**Detection:** Any event with `eventType: "postApprovalChangeDetected"`.

**Interpretation:** AM is flagging that the PO was edited in Xero AFTER being pushed from AM. This is exactly the integrity signal external auditors (PKF Merit) care about — was the approved amount actually what got billed? The dashboard should treat this as a high-priority exception.

### C. Reject-then-reapprove (governance working well)

**Observed in:** `PO-0707` (RPMMS, Darkys Mechanical) — approver rejected $500 at 2025-06-06 with comment *"$500? What is the hrs of details of this invoice?"*, requester came back 10 days later with proper quote attachment, approved at $390.56 on 2025-06-17.

**Detection:** Sequence `requesterSubmitted` → `approverRejected` → `requesterUpdatedWithReset` → `approverApprovedRequestApproved` within the same `requestId`.

**Interpretation:** This is the workflow doing its job. The dashboard should **celebrate these**, not hide them. They're evidence that controls are active. Good positive-story material for Board reporting and the FY26 AR.

### D. Near-duplicate submission

**Observed in:** Invest, 26 June 2025:
- `PO-0216` approved at 05:14 for $18,535 (HPC Consulting — 4-phase scope-of-works)
- `PO-0000` (no document number) submitted at 06:55 for $2,777 (same contact, travel line items)
- `PO-0000` rejected at 07:33 with comment *"Didn't see this upload and submitted & approved it elsewhere"*
- `PO-0217` created at 07:29, approved at 07:32 for $2,777 (same contact, same travel)

**Detection:** Multiple POs for same `contactId` + overlapping amounts + approved/rejected within short window.

**Interpretation:** Benign in this case (someone forgot they'd already approved the travel), but the pattern is what a workflow-bypass or duplicate-payment attempt would look like. Flag it.

---

## 6. Author IDs Observed — The People Map Is Real

Distinct `authorId` values seen in the 25-PO sample, grouped by cross-entity appearance:

### Cross-entity senior finance (high value)

| authorId | Entities appeared in | Notes |
|---|---|---|
| `d22064da-582b-4659-8169-64ea4cca9bb1` | Mining, Invest, Aboriginal Corp, RPMMS (4 of 5) | Senior finance — almost certainly Matt, Rhian, Paul, or Saheel |
| `e8fad88d-be19-4c58-928d-89aa9ae510b3` | Invest, RPMMS | Approver role — possibly Saheel or Matt |
| `3bc6cdc7-fce2-46d4-b0c9-56e426eb4e86` | Mining, Enterprises | Commercial-side approver |
| `8aaf788b-5f46-491e-91cb-0b5d32868c70` | Mining, Enterprises | Commercial-side requester |

### Single-entity authors (ops roles)

- `5d0b9a5b-a62c-427b-bf0d-5c8b0b73a8be` — Mining requester
- `babc085f-3e3b-4169-be85-63066f9ca330` — Aboriginal Corp (welfare PO submitter/approver)
- `4df35708-e8d8-4d1c-a075-51f8e3ab53e1` — RPMMS (Enterprises approver on one PO too)
- `9bf5d68b-2c88-4d4b-8d0e-3597e51472f6` — RPMMS (rejected PO-0707, approved after update)
- `4f1c2bd5-7000-42c9-bbe3-a075102ae0bd` — RPMMS (catering submitter)
- `3385f2da-5610-4730-b409-886acd97a2fc` — Invest approver
- `3542336d-c500-4e8e-8a2b-84b0d8670475` — Invest requester (Yanawal Units PO)
- `d22064da-582b-4659-8169-64ea4cca9bb1` — Invest requester

### System author

- `00000000-0000-0000-0000-000000000000` with `isSystem: true` — AM's own events (pushedToSource, emailToPartnerSent, captureAttachmentAssigned, postApprovalChangeDetected). Always filter out when counting human activity.

### Ask for Duane

Before building the "who approved what" view, we need an **authorId → name** mapping from Matt/Saheel. This unlocks:

- Cross-entity approver concentration charts
- "Hot hands" detection (one person approving most things)
- Segregation-of-duties visibility (requester-approver pairs)
- Proper attribution in the reject-then-reapprove celebratory view

Without the mapping, we can still aggregate by hashed-ID but the human-readable layer needs this.

---

## 7. Other Incidental Findings

### Draft POs exist (Invest PO #1 in sample)

First Invest record was `requestStatus: "draft"`, `documentNumber: ""`, no lineItems, no events. Drafts shouldn't be counted in compliance analysis but should be visible in "Work-in-progress" exception tiles — a stale draft that's sat for weeks may indicate abandoned work.

### Cancelled POs with comments (first Mining PO in sample)

`PO-0000` Mining, Gorrkbuy Industrial Supplies, $660 — cancelled by requester with comment *"PO not required with gas account"*. Useful audit trail. The dashboard should preserve/surface cancellation reasons, not just the cancellation count.

### Inter-entity transactions visible (RPMMS PO-0695)

RPMMS raised a $1,050 PO **to Rirratjingu Mining** for sand (for Yirrkala Sports Carnival). This is an inter-RAC transaction — it appears as an expense in RPMMS's AM and presumably as a sales invoice in Mining's Xero. The dashboard should be aware of inter-entity POs (they'd inflate consolidated spend if double-counted). Pattern: `contact` field matches another RAC entity name.

### PO numbering schemes vary

- Mining: PO-0664, PO-0665 (sequential)
- Aboriginal Corp: PO-12134, PO-12135 (higher sequence, different prefix)
- RPMMS: PO-0695, PO-0696, PO-0697 (sequential but with out-of-order creation — 0695 created AFTER 0696/0697)
- Invest: PO-0216, PO-0217 (lower sequence)
- Enterprises: PO-0456, PO-0457 (sequential)

Each entity has its own numbering. `documentNumber` isn't globally unique; `requestId` (UUID) is.

### Attachments are rich signal

Most approved POs have 2 attachments: a quote/invoice PDF + the AM-generated PO PDF. Some have captured photos (e.g. PO-0669 Gove Warehouse sealant — 5.1MB JPG). Attachment count/presence could feed a data-quality indicator ("% of POs with supporting documentation").

---

## 8. Reshapes to the Dashboard Design

Concretely, what this sample changes:

### Confirmed choices

1. **BI-first architecture with AR-insight layer** — design is on track. Primary view is tiles/charts/filters by accountCode, tracking, entity, supplier. AR insights sit as secondary captions.
2. **Five entity-specific views** with different dominant grouping — Mining and Invest use tracking prominently, Aboriginal Corp / RPMMS / Enterprises use account codes.
3. **Exceptions tile** has clear content: self-approval, post-approval changes, reject-then-reapprove, near-duplicates.

### Adjusted choices

4. **Account codes are primary, not tracking.** Previous hypothesis was tracking might drive the whole thing. Sample proves tracking is supplementary for 3 of 5 entities.
5. **Welfare recipient extraction is a dashboard feature.** Didn't know this until we saw the data. Aboriginal Corp's "We Provided" view requires description-text parsing, not just metadata aggregation.
6. **"We Sold" section of AR likely out of scope for AM data.** Unless sales-invoices are in AM, revenue reporting comes from Xero directly. Flag to Duane.

### New requirements

7. **AuthorId → name mapping** needed from finance team.
8. **Access control consideration** for recipient-level Aboriginal Corp welfare data.
9. **Inter-entity PO awareness** — avoid double-counting in consolidated views.
10. **Attachment data-quality indicator** — nice-to-have.

---

## 9. Next Build Candidates (Prioritised)

In descending order of AR-resonance and Board-visibility:

1. **Aboriginal Corp "We Provided" view** — highest Board value, directly mirrors AR page 14. Build: accountCode-driven welfare category rollup + description-regex recipient extraction + YTD vs FY25 baseline comparison. This is the "mic drop" artifact.
2. **Cross-entity exceptions tile** — self-approval + post-approval-change detector. Direct PKF Merit audit-support value.
3. **Mining "Pond 5 Work" rollup** — easy win because tracking is pristine. Shows Rio Tinto rehabilitation spend in real time. Supports the AR's mine-transition narrative.
4. **RPMMS "Maintenance Contract" view** — maps to the AR's 1,350 maintenance tasks headline, potentially with cost-per-task inference.
5. **Invest Yanawal Units lifecycle view** — specific asset tracking, supports the Miliditjpi investment narrative.
6. **Enterprises operational spend** — hardest because tracking is placeholder-only. Falls back to accountCode + supplier concentration.

My recommendation: **start with #1 (Aboriginal Corp "We Provided")**. It's the highest-stakes, most Board-resonant, and the data path is now clear.

---

## Document metadata

- Drafted: Day 2 session, 23 April 2026
- Source data: `/api/xero/purchase-orders?limit=5&createdAtOrAfter=2025-06-01&requestStatus=ALL` across 5 entities = 25 POs
- Author: Claude (via Duane's session)
- Read-order reminder for future sessions: `PROJECT_CONTEXT.md` (technical) → `ANNUAL_REPORT_LEARNINGS.md` (strategic) → THIS doc (data shape) → engage with Duane
- If the sample is ever rerun with different filters and shapes things differently, update this doc rather than creating a new one
