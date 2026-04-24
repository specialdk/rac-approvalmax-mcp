# RAC ApprovalMax Dashboard — Walkthrough

This is a guide to reading the ApprovalMax cross-entity dashboard. It walks through the screens in the order you see them, explains what each one is showing, and flags the patterns worth watching for.

**Live dashboard:** https://rac-approvalmax-mcp.up.railway.app/dashboard.html

---

## Three golden rules

Before the walkthrough, three rules that apply across every screen.

**Financial figures show approved and on-approval POs only.** Committed spend, top suppliers, spend concentration, budget-vs-actual — all drawn from the same pool: POs that have either been approved by a signatory or are awaiting one. Rejected and cancelled POs are excluded (they never became real commitments). Drafts are excluded (see below).

**PO counts exclude drafts.** "Total POs" means PO decisions — approved, on-approval, rejected, cancelled. Drafts are not decisions; they're abandoned form-state that accumulates when someone starts raising a PO in AM and doesn't finish. They're counted separately in the governance drawer but never contribute to financial or operational totals.

**Drafts belong to the person who raised them.** By AM's design, only the original raiser can delete a draft. So draft hygiene is distributed across every PO raiser, not something one administrator can solve centrally. The dashboard surfaces draft counts per entity as a prompt for culture, not an administrative queue.

---

## Screen 1 — Masthead and KPI strip

The masthead carries four pieces of context: the status pill (green "Live" when data has loaded successfully; amber "Loading" during fetch; red if something's broken), the date and FY26 day-count elapsed, a trial-days countdown for the AM Premium subscription, and the entity tab strip. Each tab shows that entity's non-draft PO count and committed dollar value, so you can orient before clicking in.

Below the masthead, six KPI cards:

**Committed FY26** — total dollar value of approved + on-approval POs across all five entities live in AM. This is the honest "what has the corporation actually committed to spending?" number.

**Total POs** — count of decided POs (drafts excluded). If drafts were included this number would be meaningfully higher; the difference lives in the governance drawer.

**Approved** — count and percentage of decided POs that carry the final "approved" status. At RAC this number runs at around 99%, which is consistent with AM operating as a visibility and compliance layer over decisions the business has already made rather than as a veto gate.

**On Approval** — count of POs awaiting signatory action, with the dollar value pending below. A persistent non-zero here is a bottleneck signal; zero means the approval queue is clean.

**Rejected / Cancelled** — dead records. Small counts are normal (usually corrective: wrong entity selected, re-raise needed). Large counts would suggest a problem.

**Entities live in AM** — confirms the coverage scope: five of seven corporation entities. Ngarrkuwuy and Marrin Square sit outside AM by design.

Below the KPI strip, the **Governance & draft-rate detail** toggle. Collapsed by default; one click opens the methodology caption, the total drafts parked across the corporation, and per-entity draft metrics. Entities with zero drafts render green ("clean"). This is where responsibility for draft cleanup gets surfaced without letting drafts contaminate the headline figures.

---

## Screen 2 — Cross-entity overview (the "All entities" view)

This is the default view. Five entity cards across the top, each showing committed dollars, PO count, supplier count, and a one-line story summarising what that entity's procurement looks like at a glance. Click any card to jump to its dedicated panel. Cards marked with a terra-coloured top border are dominant-spend entities (Aboriginal Corp, Enterprises, Mining); the others carry a neutral border.

Below the cards, two tables that do most of the interpretive work on this screen.

**Top suppliers across the corporation** ranks the 10 biggest suppliers by committed dollar value, showing which entity the spend came from. Gracie Contracting leads by a wide margin — Enterprises' Pond 5 rehabilitation and hydromulch work. Rirratjingu Fuel in second place is the intercompany fuel flow into Mining. Yirrkala Enterprises Pty Ltd appears with a very high PO count but modest total value — that's the shape of member-level welfare distributions running through a single clan-connected entity. Reading this table is a quick way to see the concentration of real relationships the corporation runs on.

**Spend concentration** shows each entity's dominant-supplier share — i.e. what percentage of that entity's committed spend goes to its single largest supplier. High concentration (above 30%) usually reflects a major project commitment rather than a procurement-diversity problem. Enterprises at around 52% is Gracie Contracting's share of the Pond 5 work. Aboriginal Corp's figure is much lower — welfare spend naturally fans out across many recipients.

At the bottom, the **Intercompany flow callout** appears when the corporation has bought services from itself (e.g. Rirratjingu Fuel selling to Mining). These flows wash out at group-consolidation level but appear as real supplier spend inside AM, so the dashboard flags them explicitly rather than pretending they're external.

---

## Screen 3 — Aboriginal Corporation

The standfirst at the top reads as a sentence: the Corporation has committed $X across Y welfare purchase orders benefitting Z unique clan recipients. That single line is the heart of what this panel is tracking — the Annual Report's "What we provided for our members" narrative, running in real time.

The quickstats on the right anchor the top line against the FY25 baseline ($2.25M). The "vs FY25 at X% pace" row extrapolates the current run-rate to a full-year projection and compares it to last year's actual. Coloured green if on pace, amber if running under, terra if running over. A significant under-pace in FY26 is partly explained by FY25 being an extraordinary year following the passing of a senior leader and the associated funeral and ceremonial costs — at that scale, year-on-year comparison needs context, not just arithmetic.

**FY26 Budget vs Actual** comes directly from Xero (not AM). Revenue, costs, and net profit against the full-year budget. The percentage column is colour-graded against the fraction of FY elapsed, so at 81% through the year a revenue line showing 80% reads green, 60% reads amber, 40% reads terra.

**Welfare categories** is six cards, each showing a category from the Annual Report narrative (Family Charitable, Transport Assistance, Funerals, Culture & Ceremony, Social & Cultural Programs, and a combined card for the smaller ones). Each card has YTD spend, the FY25 baseline, a progress bar coloured by pace (green on-track, amber under, terra over), and the PO count. The Family Funeral Support card currently flags as undercounted because the classifier only matches funeral-named suppliers and doesn't yet route account 63205 (Funeral Expenses) into the category — on the follow-up list.

**Clan family distribution** aggregates Family Charitable recipients up to clan-family level rather than showing individuals. Individual-level detail stays in the API for authorised finance users but never appears on screen, per the anonymisation note beneath the table.

**Top welfare suppliers** shows the real operational partners funnelling welfare spend through — supermarkets, fuel suppliers, travel agents. Useful for procurement relationships; not useful for member-level reporting.

---

## Screen 4 — Enterprises

Enterprises is the contract-led entity. A small number of suppliers do large-dollar work; the supplier list is short, the average PO value is high, and one supplier (Gracie Contracting) accounts for more than half of total spend.

The standfirst and quickstats line this up: highest committed dollars across the corporation, modest PO count, small supplier base, high top-supplier share. All the signals of a project portfolio rather than an operations portfolio.

**Budget vs Actual** as above — Xero-sourced, FY26.

**Top projects / contracts** is the supplier table but with an extra column — average dollar per PO — to surface the contract-vs-spot-buy distinction. Gracie Contracting's average PO value is the Pond 5 rehab work. Hines Contracting's PO count is higher but average value is smaller — ongoing site work rather than single-shot contracts.

**Spend by programme** is the same data viewed by account code rather than supplier. Useful when talking to someone who thinks in ledger categories rather than counterparties.

A flag box sits below the suppliers table, hidden by default. It appears only if a blank-supplier PO survives into the approved or on-approval pool — which shouldn't happen under normal AM use (the Contact field is mandatory on submission) but would be worth investigating if it ever did.

---

## Screen 5 — Property Management & Maintenance (RPMMS)

RPMMS is the operational inverse of Enterprises. Many small POs across a diverse supplier base — materials, tools, vehicles, staff training. The PO count is comparable but the committed dollars are much lower and the top-supplier share is modest. This is what a procurement portfolio looks like when it supports a running maintenance operation.

The standfirst calls out the 1,350 maintenance-tasks figure from the Annual Report as context. The AM footprint is narrower than that number — not every maintenance task runs through a PO — but the dashboard captures the materials and services procurement that supports the work.

**Materials & tools — where the jobs go** ranks the account codes. Gorrkbuy Industrial Supplies dominates here; this is the materials-and-hardware backbone of the maintenance operation.

**Key trade suppliers** complements the account view with a supplier view. Useful when relationship-mapping.

A "future" note below the tables flags the MEX integration opportunity — when asset-management data joins in, this view can show cost-per-asset and maintenance-cycle-adherence metrics. Not in scope for this release but worth signalling.

---

## Screen 6 — Mining

Mining's procurement is dominated by two things: fuel and plant repairs. The standfirst calls out the repair PO count specifically — a long tail of small repair POs for modest total value, sitting alongside a small number of large fuel POs.

The quickstats expose the **Fuel share** — what percentage of Mining's committed spend is fuel. This is a signature metric for the entity and moves with operational intensity.

The intercompany note matters here. Rirratjingu Fuel appears as a top supplier to Mining; that's a Rirratjingu-owned entity selling fuel to another Rirratjingu-owned entity. The dollars are real from AM's perspective (Mining pays Fuel, Fuel earns revenue) but consolidate out at group level. The supplier table marks these intercompany rows explicitly.

**Where the fuel and plant dollars go** breaks the spend out by account code; the repair account is where the long tail of small jobs lives.

Another "future" note flags the FleetComplete opportunity — vehicle and fuel-burn data joined against fuel POs gives a procurement-vs-consumption signal for the mining ops team. Out of scope for now.

---

## Screen 7 — Investments / Miliditjpi Trust

The smallest entity by PO count but meaningful by committed value. Investments runs the property portfolio (Yanawal Units, Wallaby Beach) and episodic capital works.

The quickstats show a high average PO value because the portfolio is dominated by large single-shot contracts — construction jobs, accommodation improvements — rather than recurring operational spend. The "Biggest PO" figure is useful for spotting when a single contract is driving the committed total.

**Top capital-works accounts** and **Top suppliers · capital works** carry the story. Grenfell Build Pty Ltd's one PO worth $140K is the kind of signal you'd expect on this entity — one builder, one contract, material dollar value.

---

## Governance drawer (expanded)

Clicking the Governance & draft-rate detail toggle opens a panel that explains itself through its methodology caption and shows per-entity draft metrics.

The caption states the two rules explicitly: financial figures exclude drafts, PO counts exclude drafts. It names what the dashboard calls "Total POs" for what it really is: PO decisions.

Below the caption, a short narrative line: how many drafts are parked across the corporation, their aggregate dollar value, and a pointer to the `/api/draft-cleanup` endpoint (which produces an Excel-ready CSV of every blank-supplier draft with a suggested action: Delete if more than 30 days old, Follow-up otherwise).

Five per-entity metric cards. Each shows draft count, dollar value, and either an "X% draft" hygiene ratio or "clean" in green for entities with zero drafts. Reading these cards tells you which entity has the most cleanup needed. The operational loop is: reminder email to PO raisers → raisers delete their own drafts → metric cards go green. Anyone's draft count dropping toward zero is a signal the reminder is landing.

The rejected/cancelled POs also called out in this drawer are dead records — no action required, just disclosed.

---

## Coverage scope — what this dashboard does not show

Two things the dashboard deliberately does not cover:

**Ngarrkuwuy and Marrin Square** are two of the seven corporation entities and sit outside the ApprovalMax workflow. Procurement decisions for those entities don't flow through AM and therefore don't appear here. The KPI card "Entities live in AM — 5 of 7" discloses this.

**Spend outside AM within the five live entities.** Not every dollar spent at Aboriginal Corp, Enterprises, RPMMS, Mining, or Investments runs through AM. Wages, direct-debit utilities, grant passthroughs, payroll, credit-card spend, and some JV-managed project spend land in Xero without ever touching AM. The dashboard's committed figures are therefore the **AM-governed subset** of total corporation spend, not the total. The monthly reporting pack remains the source of truth for complete entity-level financials; this dashboard is a real-time view of the governed slice.

A reconciliation view showing the ratio of AM-governed spend to total Xero spend is on the roadmap but not yet built.

---

## Known limitations and what's next

**Funeral category undercount.** The welfare classifier currently matches funeral-named suppliers only; account 63205 (Funeral Expenses) will be added as a routing rule in the next classifier pass.

**Pagination cap.** The entity-scan endpoint fetches up to 30 pages × 100 records = 3,000 POs per entity. Aboriginal Corp is currently at the cap; a "+" suffix on PO counts (e.g. "2,865+") signals the true number is higher than displayed.

**Refresh cadence.** Dashboard pulls live on page load; no background refresh. Allow 60–180 seconds for full load. Re-authentication via the admin page is occasionally needed when AM's refresh token rotates out.

**Year-on-year view.** Not available yet — will be possible once FY26 closes and two full years of AM-era data exist.

**Natural-language chat over the data.** A query surface ("how did Aboriginal Corp's welfare spend compare to last month?") is a phase-3 candidate.

**Reconciliation against Xero totals.** Covered under Coverage scope above. Technical feasibility to be probed; design depends on how the non-AM spend buckets get categorised (wages, grant passthrough, JV-managed, recurring admin, etc.). Matt's existing knowledge of where the non-AM spend sits is the key input.

---

*Dashboard:* https://rac-approvalmax-mcp.up.railway.app/dashboard.html
*Repository:* https://github.com/specialdk/rac-approvalmax-mcp
