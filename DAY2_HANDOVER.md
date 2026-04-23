# Day 2 End-of-Session Handover

**Date:** 23 April 2026, end of session
**Status:** Welfare "We Provided" prototype is LIVE and returning real data. Classifier needs tuning before iterating further.

Read order for next session:
1. `PROJECT_CONTEXT.md` — technical state
2. `ANNUAL_REPORT_LEARNINGS.md` — organisational/strategic state
3. `SAMPLING_FINDINGS.md` — data shape findings
4. THIS DOC — where we ended on Day 2
5. Then engage with Duane

---

## What we shipped Day 2

- Wired filter plumbing (`createdAtOrAfter`, `orderBy`, `orderDirection`)
- Pagination for true cross-entity counts (`/api/xero/summary`)
- Sample-friendly "limit per page" picker (default 5)
- Annual Report read end-to-end, purpose reframed as AR-supporting dashboard
- 25 live AM-era POs sampled and analysed (data shape understood)
- `welfare-categoriser.js` module with FY25 AR baselines hardcoded
- `/api/welfare/aboriginal-corp` endpoint deployed
- Welfare UI section with KPI tiles, 9 AR category cards, Uncategorised bucket with sample descriptions for rule tuning

---

## First live run of the welfare view (FY26, 297 days elapsed, 81% of FY)

Run at 2026-04-23 with `fyStart=2025-07-01`.

### Headline numbers

- Aboriginal Corp YTD FY26: **~2,699 POs total, ~$1.04M** in actual welfare-eligible spend
- Split: **368 POs / $92K categorised** into AR buckets, **2,331 POs / $947K in Uncategorised**
- Only 4.1% of FY25's $2.25M AR baseline total captured — almost all the value is hiding in Uncategorised

### Per-category results (FY26 YTD)

| AR category | YTD | POs | FY25 baseline | % baseline | Verdict |
|---|---|---|---|---|---|
| Family Charitable Payments | $1,727.51 | 19 | $1,403,221 | 0.1% | **Broken** — regex too strict |
| Transport Assistance | $44,764.94 | 256 | $360,000 | 12.4% | Working; likely genuinely lower than FY25 OR missing taxis at other suppliers |
| Family Funeral Support | $5,940 | 3 | $205,984 | 2.9% | Undercounting — need supplier/description patterns |
| Culture & Ceremony Support | $0 | 0 | $90,565 | 0% | No rule yet |
| Social & Cultural Programs | $37,130.34 | 89 | $76,808 | 48.3% | Running hot — probably catching internal catering mis-classified |
| Education & Health | $0 | 0 | $38,237 | 0% | No rule yet |
| Medical & Terminally Ill | $0 | 0 | $37,505 | 0% | No rule yet |
| Whitegoods | $2,437 | 1 | $25,440 | 9.6% | Pattern fired once, plausible |
| Future Leaders Program | $0 | 0 | $9,453 | 0% | No rule yet |
| **Uncategorised** | **$946,967.27** | **2,331** | — | — | **Gold mine for rule tuning** |

### Signal from Uncategorised

- 392 unique recipients (close to clan member population × families receiving on behalf)
- $947K of remaining ~$1.3M welfare budget lives here
- Sample descriptions accordion not yet inspected — **this is the next action**

---

## Next session: immediate next steps (in order)

### Step 1: Grab the uncategorised samples (Duane task)

Duane to open directly in browser:

```
https://rac-approvalmax-mcp.up.railway.app/api/welfare/aboriginal-corp?fyStart=2025-07-01
```

Paste the full JSON response (or just the `summary.categories[].sampleDescriptions` array from the Uncategorised entry) into the next session's first message.

### Step 2: Classifier tuning (Claude task, after seeing samples)

Three hypothesised refinements to `welfare-categoriser.js`:

1. **Broaden recipient regex.** Current pattern needs 2+ capitalised words. Probably need:
   - Single first-name fallback when account=63950 (e.g. "groceries for Sarah")
   - Initial+surname pattern (e.g. "M Marika")
   - Collective pattern ("Marika family", "the family")

2. **Flip the 63950-without-recipient default.** Currently defaults to `Social & Cultural Programs` (low confidence). That's probably backwards — account 63950 + supermarket/retail supplier is more likely Family Charitable Payments. Should route on supplier TYPE (supermarket/retail → Charitable; catering company → Social & Cultural).

3. **Add supplier patterns for missing categories:**
   - Funeral Support: look for funeral parlour/directors/memorial suppliers beyond just the name "funeral"
   - Medical: specific clinic names, Miwatj Health mentioned in AR
   - Whitegoods: broaden beyond the 4 patterns currently listed
   - Education: school names, textbook suppliers
   - Culture & Ceremony: buŋgul-related, clothing for ceremony

### Step 3: After tuning, re-run welfare view

Target: get Uncategorised below 20% of total welfare spend. Currently 91%. That's the iteration success metric.

### Step 4: THEN consider building second view

Once welfare view has decent coverage (Aboriginal Corp "We Provided" is credible), next candidate views in descending value order:

- Cross-entity exceptions tile (self-approval, post-approval changes, reject-then-reapprove)
- Mining "Pond 5 Work" rollup (clean tracking → easy win)
- RPMMS "Maintenance Contract" view

---

## Open questions for Duane (not urgent)

1. Is Transport Assistance genuinely lower in FY26 vs FY25, or are we missing taxis at other suppliers? Matt/Saheel may know. The gap ($44K YTD vs $288K expected at 80% of baseline) is large enough to investigate.
2. Can we get an `authorId → name` mapping from finance team? Lights up every "who approved what" view.
3. Sensitivity check: who can see recipient-level drill-downs vs category-level aggregates only? (Real clan member names in UI — worth the conversation with Paul/Rhian before wider exposure.)

---

## Commercial clock

- AM trial expires ~2026-05-05, ~12 days remaining
- AM Premium pitch now has a concrete demo artifact (the welfare view itself)
- Pitch language locked in from AR: "make real the governance commitment already made publicly in the Annual Report"

---

## Docs in repo as of end of Day 2

- `PROJECT_CONTEXT.md` — technical
- `ANNUAL_REPORT_LEARNINGS.md` — strategic/organisational
- `SAMPLING_FINDINGS.md` — data shape
- `DAY2_HANDOVER.md` (this) — ephemeral session state, can be deleted once Day 3 absorbs its content into the other three

Latest commit before this handover doc: the welfare prototype (server.js + welfare-categoriser.js), which is already live on Railway.

---

## One-liner for next session's opening message

> "Day 3 — welfare prototype ran, Uncategorised bucket has $947K across 2,331 POs needing classifier tuning. Duane to paste uncategorised sample descriptions from `/api/welfare/aboriginal-corp?fyStart=2025-07-01`, then iterate on rules in `welfare-categoriser.js`. Full context: read DAY2_HANDOVER.md."
