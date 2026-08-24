# Machine Maintenance Module

> **Condensed 2026-08-03** ([#634](https://github.com/debola31/Jigged/issues/634)): 5,660 → 4,937 words
> measured, of which ~310 are *new* (this stamp and the [path + test index](#where-it-is-built) at the
> foot), so the inherited prose fell by about a fifth. It does not compress further without losing a
> decision: nearly every remaining paragraph is a decision, its one reason, or a rejected alternative.
> **Cut:** the header changelog naming six revised sections, and each section's long re-telling of its own
> revision (one ran ~900 words on two failed attempts at a single shared-draft bug); second justifications
> for decisions already justified; prose restating component code. **Kept:** every revision as a one-line
> **Withdrawn** entry beside the decision that replaced it; the pilot numbers and kill criterion verbatim;
> every named gap and rejected alternative. **Correction:** §4.6 said the notes system carries a
> work-center subject but "nothing in the app writes one today" — true of the proposal, false of the build
> (`addMachineNote`).

> **As-built, verified 2026-08-03; release state re-verified 2026-08-24.** Phase 1 built and **released to
> every tenant**: the opt-in `machine_maintenance` flag is **retired**, so there is no per-tenant switch and
> no way to scope the module to the shops whose behaviour is being measured. Nothing changed for anyone on
> the day — all three production companies already had the flag on, so retirement released the logbook to no
> new shop — but it ended the pilot as a *measurable* thing; see the **Withdrawn** line in
> [§9](#9-open-questions). A machine-scoped maintenance logbook, shipped with the condition under which it
> gets parked stated in advance ([§2](#2-hypothesis-and-kill-criterion)) so the result cannot be renegotiated
> once it arrives.

**Two lessons from the revisions below.** (1) Several cut a control the proposal asked for, all for one
reason: **a control whose answer changes nothing teaches operators this surface is decorative.** (2) The
layout revisions only became visible once a machine carried real entries — an argument for **building the
thin thing early rather than specifying harder.**

**Dependencies:** [Work Centers](work-centers.md) — a machine *is* a `work_centers` row, any of them now that
`kind` is dropped; no separate machine entity. The notes system and its read-back loop
([Operator View](operator-view.md#the-read-back-loop-attribution)). Station selection, the only entrance,
and the defect in it named in [§6](#6-phases-and-gates).

> **An entry is a `notes` row** — `subject_kind='work_center'`, `note_type='user'` — not a separate store,
> so entries appear on **My work** beside their author's job and part notes, the row naming the machine
> where a job note names its job number. The `notes` CHECK permits exactly one subject, so an entry carries
> no part, operation or job; before the machine name was put in that slot those rows rendered as a bare
> sentence saying nothing about what they concerned. **Anything that changes what an entry carries must be
> checked on My work too.**

---

## 1. Problem

The shop's most technical operator writes almost nothing on job travelers. Not reticence, not tap count: his
knowledge is machine-specific and every capture surface Jigged has built is shaped like a part or an
operation — the durable note is the one rooted at a part *and* a routing step, durable precisely because it
answers "how do you run this part here". He was offered a container that does not fit what he knows and
declined it, **which is the correct response to a container that does not fit.**

What operators still text a departed veteran about is how to maintain the equipment. He left a year ago;
none of it was written down. The record was replaced by one personal friendship — no owner, no backup, no
expiry warning; it decays quietly and nobody finds out on a good day.

Not a local eccentricity: contaminated coolant and missed lubrication are the leading causes of premature
bearing and ballscrew failure, and **roughly seven in ten spindle shutdowns trace to lubrication that was
missed *or not recorded*** (industry figures, not measured at the pilot shop). The second half of that
disjunction makes it a software problem — a shop can be doing the work and still be one departure from
losing the knowledge of what the work is.

The capture behaviour already exists (machinists photograph offsets at end of shift, and carry mental lists
for tomorrow), so this is a landing place for a habit rather than a new discipline. The canonical failure it
targets: the outgoing operator says the machine ran fine and does not mention the way cover that has started
to drag. Nothing in that sentence is a lie, and nothing in it is recoverable.

## 2. Hypothesis and kill criterion

**H:** machine-scoped knowledge is a container operators will fill, where part-operation-scoped knowledge was
not. The part-scoped container exists, is durable by design, and is close to empty — the prior result this
module argues with.

**The bar.** Phase 1 passes only if **at least five entries exist from at least three distinct non-founder
authors within four weeks**. *Four entries from four people is a kill. Eight entries from two people is a
kill; one enthusiast is a person, not a container.*

**The clock starts at the first organic entry**, not at ship date. Four weeks of silence after the flag goes
on is the kill result — on one condition: machine pages must have been opened during the window. A container
nobody filled and a container nobody reached look identical from outside, and [§8](#8-measurement) is what
tells them apart. **Near-zero page opens across the four weeks is recorded as *not yet tested*, not a kill**,
and the clock restarts once the door is demonstrably reachable and in use. Not a hypothetical escape hatch —
this launches into a surface not yet in daily use ([§6](#6-phases-and-gates)), so "not yet tested" is the
likeliest first result, and must not be quietly upgraded to a pass or downgraded to a kill.

**The clock stopped 2026-08-24**, with the bar not formally cleared: the flag was retired by product decision
([§9](#9-open-questions)), and `machine_page_opened` can no longer tell a pilot shop's opens from anyone
else's ([§8](#8-measurement)) — the exact reading the precondition above depends on. Whatever this section
concludes must be read from data up to that date. **The bar itself stands as written**, because a bar
rewritten after its result arrives is not a bar.

**No seeded corpus, at all.** No backfill, no transcription of the veteran's texts, no entry written on
anyone's behalf; anyone may write down knowledge they got from him, as themselves, but nobody writes as him.
**Why:** a pre-filled container cannot answer the only question Phase 1 asks, and **a demo corpus and an
evidence corpus cannot be the same rows.**

Reads are the earlier, cheaper signal — `viewer_count` moves before the fifth entry exists. Watch it; **do
not promote it to the gate**: a corpus read but not extended is still one person's knowledge with a wider
audience.

## 3. Who it's for

The design centre is the infrequent frontline user at a shop with no maintenance department: requester,
approver and technician are one person, at the machine, deciding in the moment whether what they noticed is
worth saying. **The pilot shop is roughly fifteen people.** There is no maintenance role in Jigged and none
is proposed — the frontline role is `operator`, and the operator is the technician.

This is where the module parts company with CMMS deliberately. CMMS products model a requester, an approving
manager and a performing technician, and their strongest mobile experiences split into two profiles for that
reason (infrequent reporter, continuous queue-dweller). Jigged builds only the first: the second person does
not exist at this size, and building the split adds three steps to a one-person action.

The frame is **autonomous maintenance, the first pillar of TPM** — operator-owned basic care (cleaning,
inspection, lubrication, retightening), not a work order routed to a department. Consequence
[§5](#5-what-it-is-not) leans on: there is nobody for a request to be sent *to*, so request/approval
workflows are rejected structurally, not as scope trimming.

## 4. What it is (Phase 1)

A logbook for a machine, reachable from the floor without a search, written by whoever is standing there.

### 4.1 One door

A **Maintenance tab**, available once a station is selected, opens the logbook for the machine the operator
is at. No picker: the station list is `work_centers` filtered to `kind='internal'`, so selecting a station
already answered the only question a picker would ask. Nothing to scan on the machine either — a shop at this
scale has few machines and the operator has already told the app which one they are standing at, so a posted
code would solve a navigation problem this product does not have. **The in-app path is the only entrance**, which
makes station selection a dependency of this module ([§6](#6-phases-and-gates)).

### 4.2 The timeline

Open items pinned above the log, then entries newest first, each attributed and dated. **Not grouped by
kind** — the reader's question on arriving is "what has happened lately", and any grouping pushes the recent
thing below the fold to answer a question nobody asked.

- **Withdrawn:** composer *below* the pinned items — wrong because a machine with several open items pushed
  it off the top of a phone. Writing does not queue behind however much is outstanding.
- **Withdrawn:** an open item rendering as a pinned *summary* **and** again in the log — wrong because it is
  one fact twice with different chrome, and the summary dropped the photo, which on "the way cover has
  started to drag" is most of the message.

**An entry appears exactly once.** Outstanding items are full cards in the pinned block; the moment somebody
logs the fix the entry drops into the log carrying its author. The log is one card of divider-separated rows,
matching [Operator View](operator-view.md), so a four-word entry no longer costs a whole card plus a gap.

### 4.3 Capture

Free text; dictation is the phone keyboard's dictation key, which operators already use — **no custom voice
capture is built or proposed**. Photos are optional and go through the native sheet, so the end-of-shift
offset photo already on the phone works. Alongside them one optional toggle: **Needs attention**, off by
default (most entries record work already done) and deselectable, because a person who is unsure must still
be able to write the sentence.

- **Withdrawn:** a five-value kind chip (cleaned, repaired, replaced, adjusted, noticed) — wrong because four
  of the five had no reader anywhere (nothing filtered, grouped, ranked or counted by kind, and §4.2 forbids
  grouping the timeline by it), which is four extra decisions asked of somebody in a container whose entire
  risk is that nobody writes in it; and because the list did not match the TPM frame [§3](#3-who-its-for)
  argues from — only *cleaned* appears in both, and **lubrication is missing entirely**, the category
  [§1](#1-problem) builds the case on. A taxonomy omitting the category its own evidence rests on was
  invented rather than observed.

Only `noticed` had a consumer — it pins the entry ([§4.4](#44-noticed-then-resolved)) — so that value
survives, labelled by condition rather than category. **The database CHECK keeps all five values**: widening
later is a migration, narrowing buys nothing, and if a real corpus argues for categories they return as a UI
change with a consumer attached.

**"Needs attention" notifies nobody** — there is no notification path in Phase 1 ([§9](#9-open-questions)),
and the wording avoids implying one. It keeps the entry pinned until somebody logs a fix, so the person who
meets it is the next operator standing there: precisely the handoff [§1](#1-problem) says goes wrong. Its only
exit is a second entry describing what was done — **no dismiss, no close** — so clearing the pin and recording
the knowledge are one act.

**Superseded mechanic, recorded because the replacement is narrower.** That guarantee used to rest on `notes`
being append-only. Since [#628](https://github.com/debola31/Jigged/issues/628) an entry's **body** is editable
by its author, and it rests instead on a column-scoped `GRANT UPDATE (body)` plus the
`notes_restrict_update_to_body()` guard trigger, leaving `maintenance_kind` and `resolves_note_id` immutable.
So an operator can fix the wording of what they noticed and can never un-notice it, and a fix can never be
re-pointed: the derived-open list stays trustworthy while the text stays correctable.

### 4.4 Noticed, then resolved

An open noticed item offers **"log the fix"**. No assignment, priority or due date — each needs a second
person to mean anything ([§3](#3-who-its-for)).

- **Withdrawn:** "the same composer with the resolution link already bound" — wrong because it makes resolving
  a **mode**, and modes fail in exactly the conditions this surface has: the announcing banner scrolls out of
  view, and somebody who walks away mid-thought comes back to a composer that looks ordinary and is not. And
  because starting a fix re-bound the composer while leaving whatever was half-typed in it, so a sentence
  about something else could silently become the fix for an item tapped afterwards.
- **Withdrawn:** a dedicated but **shared** reply composer whose draft was cleared only on a successful save —
  wrong because tapping "log the fix" on a second item moved the composer without moving the text: the second
  closed on a sentence written about something else and the first stayed outstanding forever. *Recorded
  because the wrong diagnosis survived a build, with a test pinning the half-fix.*
- **Withdrawn:** filing the fix as its own timeline entry with the link drawn in text ("Fixes: …" on the fix,
  "Fixed by …" on the observation) — wrong because it reads as two entries that happen to mention each other,
  and the quotation had to be truncated to one line, drawing the link by cutting off the text it pointed at.

**The lesson is where state lives, not how many composers there are: a draft must not outlive the thing it was
written about.** The draft lives **with the target** — the reply composer is mounted keyed by the item it
answers, so switching items destroys one and builds another and there is nothing to remember to reset. Same
reasoning as derived open state: *a rule enforced by structure does not depend on every future edit remembering
it.*

So the fix composer opens **beneath the item it answers**, and **the item's "log the fix" control is replaced
by it** — the ordinary reply gesture, where position carries the meaning and there is no state to remember.
The landed fix renders **nested under it**, indented beneath a left rule. Position carries the link, so neither
end needs a sentence explaining itself and nothing is truncated. The reply carries no flag of its own: a fix
resolves, and if the work uncovers a new problem that is a new entry.

**Threads sort by latest activity, not the root's age** — the one cost nesting carries, since an observation
from three weeks ago answered this morning would otherwise sit three weeks down a list §4.2 keeps newest-first.
Sorting on the thread rather than the root keeps that promise: resolving something old brings it back to the
top, which is also what the person who did the work would expect.

**Only resolutions nest.** Not general threaded discussion: a shop this size has no conversation to hold
([§3](#3-who-its-for)), and a reply affordance on every row would invite one this surface is not built to keep
readable.

**Open state is derived from the existence of a resolving entry and is never stored** — nothing to remember to
close, and no way for the open list to disagree with the timeline it is drawn from. Since #628 a misfiled fix
is **deleted and re-logged rather than re-pointed** (`resolves_note_id` is immutable), and deleting it returns
the item it wrongly closed to **Needs attention** with nothing stored to go stale; the delete dialog states
that consequence before the fact.

### 4.5 Zero required setup

Machine details (make, model, serial, year, purchase date) and manual attachments are **all optional; nothing
is gated on them and nothing prompts for them**. Asset data-entry time is a leading cause of CMMS abandonment:
the tool arrives, the shop is asked to describe its equipment before it can do anything, and the project dies
in the describing. The machines already exist as work centers, so this module starts with its asset list
complete and its asset detail empty.

The enforceable form: **no empty-state nudge, no completeness meter, no prompt to finish setting up a machine,
and no surface that renders one machine as less ready than another because somebody typed a serial number into
it.**

### 4.6 Attribution

Inherited from the notes system whole. The author is resolved server-side, so an entry is written as the person
writing it and cannot be attributed to anyone else — including by an admin, deliberately. Authors see named
views of their own entries; everyone else sees aggregates. One sentence, no role
branch: *you see who viewed your own notes; nobody sees who viewed anyone else's*
([Operator View](operator-view.md#the-read-back-loop-attribution)).

*(This doc previously said the work-center subject was modelled but "nothing in the app writes one today" —
true of the proposal, false since the build.)*

## 5. What it is not

Each is a real product that exists elsewhere, rejected for a stated reason rather than deferred by oversight.

| Not built | Why |
|---|---|
| Request and approval workflows | No second person for a request to reach ([§3](#3-who-its-for)) |
| MRO parts inventory | A second item master with a second counting ritual, while the first is still being learned ([Inventory](inventory.md)) |
| Criticality rankings, MTBF, MTTR, PM-compliance dashboards | All four are ratios over a corpus that does not exist yet |
| Downtime tracking | Actual time was deliberately removed from this product and is structurally unrepresentable ([Operator View](operator-view.md#surveillance-guardrail-non-negotiable)) |
| Lockout/tagout fields | A compliance artifact; Jigged is not the shop's compliance system of record |
| Bulk asset import | The machines are already in Jigged; an importer is a second door into a room that has one |
| Any per-operator maintenance scorecard or comparison, visible to anyone | The surveillance guardrail, below |
| Schedules and reminders | Deferred by sequence, not by taste ([§6](#6-phases-and-gates)) |

The surveillance guardrail extends here in full: *no operator-facing surface may reflect an operator's pace or
standing back at them* ([Operator View](operator-view.md#surveillance-guardrail-non-negotiable)). Concretely,
**no surface may show who logs how many entries, or how often a given operator files a noticed.**

**Decided, where that collides with a real design want:** the open-items list shows the observation, the date
and the photo — **not the author**. A list of open items with names against it is a list of who reports the most
problems, read straight down the column — the shape of every operator scorecard this product has already refused
to build. The cost of the alternative is that filing a noticed becomes an admission.

- **Withdrawn:** the author is "visible on the entry's own card, one tap away" — wrong because it relied on an
  open item also rendering in the log, and an entry now appears exactly once ([§4.2](#42-the-timeline)). The
  name is **deferred**: the entry carries its author from the moment the fix lands. While a thing is
  outstanding, who raised it is not the question; once dealt with, both names survive and neither is counted.

## 6. Phases and gates

Phase 1 shipped behind a per-tenant feature flag; **that flag was retired 2026-08-24 and the module is core
for every tenant**. There is no per-tenant switch any more, so scoping Phase 2 or 3 to a pilot means adding
one back.

Station selection is the only entrance ([§4.1](#41-one-door)), so one live defect in it became a prerequisite:
**the station picker leaked archived machines because it did not filter `deleted_at`.**

- **Withdrawn:** "it is being fixed independently" — wrong: no branch, issue or PR covered it, and
  `getStationOperationTypes` was the one work-center reader in the codebase without the filter. **Fixed as part
  of this module's work**, along with `getStationName`, which now answers null for an archived machine so the
  stored station clears itself rather than stranding an operator on a machine that no longer exists.

> **Operator adoption of the existing operator surface is currently near zero** — operators are not yet marking
> operations complete. This module launches into a surface not yet in daily use: a real risk to the four-week
> clock rather than a footnote to it, and why the clock in [§2](#2-hypothesis-and-kill-criterion) carries a
> precondition.

| Phase | Scope | Gate |
|---|---|---|
| **1 — the logbook** | Everything in [§4](#4-what-it-is-phase-1). ⚠ Planned "at one pilot shop"; **shipped to every tenant** once the flag was retired 2026-08-24, which is what stopped the clock rather than a result arriving ([§9](#9-open-questions)). | The bar in [§2](#2-hypothesis-and-kill-criterion) |
| **2 — standing procedures** | Design level only. Any good entry can be promoted to a standing procedure, **preserving the original author** — the person who knew the thing is the point. Completing a procedure writes an entry on the machine's timeline, so procedures do not become a parallel history. | **≥10 entries, ≥3 of them a repeatable how-to.** The count alone is not the gate: a procedure library is a distillation, and there is nothing to distil until entries repeat themselves. |
| **3 — schedules** | Two trigger kinds: calendar interval, plus **usage** = good pieces through the machine since the last entry satisfying the procedure. No sensor, meter reading or integration is needed, because the machine record and the job record are the same record: good pieces are already recorded against an operation, and that operation already names its work center ([§7](#7-competitive-position)). | Phase 2 procedures exist **and ≥3 shops have answered whether they run a separate CMMS or track maintenance in their ERP.** Only one shop is reachable today, so this gate is blocked on access rather than engineering — and should stay blocked rather than be reinterpreted downward. |

Schedules shipped before a corpus exists produce the nagging, surveillance-flavoured version: a machine page
telling an operator what he is late on, assembled out of nothing he wrote. That is the version frontline users
abandon, and it would make the §2 result unreadable in retrospect — a container nobody filled and a container
that started nagging on day one fail the same way from outside.

**Logs, then procedures, then schedules. That order is not negotiable.**

## 7. Competitive position

The category is validated and owned. **MaintainX was acquired by Autodesk in 2026 for a reported ~$3.6B**,
builds an AI knowledge base out of the completion notes technicians write on work orders, and holds the top
ease-of-use ratings in its category — the same insight this module rests on, executed with a decade of head
start and a sales motion aimed at exactly this buyer. **Jigged does not out-CMMS a CMMS, and any roadmap item
whose justification is parity with one is rejected on that basis alone.**

The wedge is not a feature: **maintenance data and job data are one system.** A usage trigger needs no sensor,
meter or integration, because Jigged already counts good pieces through the machine as a by-product of running
the shop. "The machine was down Thursday" and "that job ran long" become two readings of one record instead of
two systems reconciled by somebody who happens to remember both — which a dedicated CMMS cannot reach without
an integration a fifteen-person shop will never build. **Any design requiring maintenance data to live apart
from job data is wrong by definition.**

## 8. Measurement

The funnel is the primary instrument, structurally rather than by preference: with an empty starting corpus
every count-based surface is silent at launch, so without it "adoption was poor" is unreadable — the one
outcome that cannot be acted on. The existing capture funnel applies unchanged, in the form its own source
states it: *page opened but composer never focused* means the container does not fit; *composer focused but
nothing saved* means capture friction. **Four moments are instrumented: machine page opened, composer focused,
entry saved, noticed resolved** (`machine_page_opened` and `noticed_resolved` are new `operator_events` kinds;
the middle two are reused with `workCenterId` in context).

**Two limitations, known in advance and not bugs:**

1. A machine-entry read carries no job, and the per-job usage counter ignores the absent one, so **`usage_count`
   stays at zero here permanently**. The "used on N jobs" signal that ranks the part Playbook does not exist
   here and **must never be displayed here** — it is not even fetched, which is stronger than remembering not
   to render it.
2. Read logging dedupes per person, per entry, per job, treating the absent job as equal to itself, so **a
   person's repeat consultation of the same entry is recorded once, ever.** Somebody rereading the way-cover
   entry six months later is invisible — precisely the event a logbook would most want to see. `viewer_count`
   (distinct people) still works; it saturates near shop size, which is its meaning.

The consequence is a decision, not a complaint: **reads can tell us an entry was found; they cannot tell us it
is still true.** **Decided: Phase 1 ships no freshness signal, and accepts the gap.**

- **Withdrawn:** `confirmed` — a reaction kind that exists in the `note_reactions` CHECK alongside `helpful`,
  with no negative option by design, and has never had a UI — as the designated freshness signal, with building
  that UI called a prerequisite. Wrong because `confirmed` means "I did this and it still holds", needing a
  second person to re-perform the same maintenance and say so: at fifteen people, inside four weeks, against a
  bar of five entries, that will not happen, so it would ship as a control nobody taps. No product in the
  category offers one either: weak evidence, but not none.

So `helpful` is inherited unchanged and nothing else is built. Phase 1 can tell whether an entry was *found*,
not whether it is still *true*, and a corpus small enough to fail the §2 bar is far too small for staleness to
be worth solving. Revisit with real entries in hand if the corpus survives and ages. **None of this is the
gate. The gate is [§2](#2-hypothesis-and-kill-criterion).**

## 9. Open questions

**Closed, not reopened here:** classification is optional and is now one toggle rather than five verbs
([§4.3](#43-capture)); no seeded corpus ([§2](#2-hypothesis-and-kill-criterion)); open-items attribution
resolves in favour of the guardrail ([§5](#5-what-it-is-not)); the module is called Machine Maintenance.

**Does the Maintenance tab appear before a station is selected? Decided: no** — without a station the tab needs
a picker, the ceremony [§4.5](#45-zero-required-setup) refuses. Visible consequence: an operator who notices
something on a machine that is not their selected station **changes station first**. Acceptable at this machine
count; if it proves to be friction the answer is revisiting this question, **not reviving a code on the
machine**. Built that way — rendered only when a station is set, and deliberately *not* on the list of routes
that keep the nav visible before a station exists (unlike Inventory and My work). A station can be picked or
cleared mid-session, so the bar reflows mid-shift; that is now the only thing that changes its shape.

**Do machine details and manuals belong in Phase 1 at all, given nothing gates on them? Decided: both ship, and
nothing ever prompts for either.** A manual an operator can open on the floor is worth having on day one;
reading happens on the floor, filling either in happens in the office. The enforceable half is tested rather
than asserted: a machine with no details renders **nothing at all** — not an empty state, not a completeness
meter, not a prompt — and a machine with no manuals shows no manuals row.

**Can the office read a machine's log without an operator device? Decided: yes, read-only** — the work-center
page carries the same timeline with no composer. Not a question the proposal asked, and it needed answering
before build. "One door" ([§4.1](#41-one-door)) is a rule about the operator entrance and about pickers, not
against the founder watching whether the §2 corpus is forming. **An office composer is refused** for a different
reason: the bar counts non-founder authors, and the most convenient way to write entries must not be the one
seat that would invalidate the result.

**Still open — recommendations, not decisions:**

| Question | Recommendation |
|---|---|
| A machine's timeline when the machine is archived? | Entries survive and stay readable; the page stays reachable by direct link while dropping out of lists. Archiving hides a machine from pickers, not its knowledge, and **knowledge must not be destroyable as a side effect of tidying a list.** (The by-id detail read deliberately does not filter `deleted_at`; the manuals FK is `ON DELETE RESTRICT` to state the same rule.) |
| Can someone other than the filer resolve a noticed item? | Yes, and that is most of the point — the resolving entry carries its own author, so both names survive and neither is counted. **The open part is notification:** there is no operator notification path today, so the original author finds out by reading the timeline. State that limit rather than designing around it. |
| Does Phase 2 promotion leave the original entry on the timeline? | Yes, and mark it promoted. A log that loses rows stops being a log, and an unexplained near-duplicate is what makes people stop trusting one. |

- **Withdrawn:** retire the flag on the [Shipments](shipments.md) precedent (gated during rollout, then made
  core and the key removed) but **"only after a second shop clears the §2 bar, not the first"** — **that is
  not what happened.** The flag was retired 2026-08-24 by product decision, with no shop having formally
  cleared the bar. Mitigating, and the reason it was accepted: all three production companies already had it
  on, so removal exposed the module to nobody new. What it cost is measurement, not exposure —
  `machine_page_opened` ([§8](#8-measurement)) can no longer separate pilot shops from everyone else, so the
  §2 clock stops at that date and the pass/kill call has to be made on the data collected up to it.

---

## Where it is built

| Concern | Path |
|---|---|
| Operator logbook page · tab gate | `app/operator/[companyId]/maintenance/page.tsx` · `app/operator/[companyId]/layout.tsx` |
| Office read-only log + manuals management | `app/dashboard/[companyId]/work-centers/[workCenterId]/page.tsx` |
| UI — 8 components (log panel, composer, reply composer, entry, open items, details, manuals sheet/manager) | `components/maintenance/` |
| Access layer · `deriveOpenItems` · manuals | `utils/machineMaintenanceAccess.ts`, `utils/workCenterAttachmentsAccess.ts` |
| Station `deleted_at` filters · `updateNoteBody` | `utils/operatorAccess.ts` |
| Schema — `notes.maintenance_kind`/`resolves_note_id`, machine detail columns, `work_center_attachments`, two funnel event kinds | `supabase/migrations/20260730015344_machine_maintenance.sql` |
| Editable body + immutability guard (#628) | `supabase/migrations/20260801012019_notes_editable_body.sql` |

**Tests.** `__tests__/utils/machineMaintenanceAccess.test.ts` — `describe('deriveOpenItems')`,
`describe('getMachineLog')`, `describe('edited entries (#628)')`, `describe('addMachineNote')`,
`describe('addMachineNoteMedia')`. · `__tests__/components/maintenance/MachineLogPanel.test.tsx` —
`describe('MachineLogPanel')`, `describe('MachineLogPanel manuals')`. ·
`__tests__/components/maintenance/MachineOpenItems.test.tsx` — `describe('MachineOpenItems')`. ·
`__tests__/components/maintenance/MachineDetailsCard.test.tsx` — `describe('MachineDetailsCard')`. ·
`e2e/machine-maintenance.spec.ts` — `test.describe('Machine Maintenance')`. · Database subject/kind
constraints: `api/tests/integration/test_note_views_rls.py`. The tab's station gate is
*automation-pending ([#367](https://github.com/debola31/Jigged/issues/367))* at the layout level; the e2e spec
covers it from the operator entrance.
