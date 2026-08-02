# Machine Maintenance Module

> **Status:** Phase 1 built, unreleased · **Date:** 2026-07-30 · **Pilot:** one shop, behind the
> `machine_maintenance` flag (off everywhere by default)
>
> **Purpose.** A machine-scoped maintenance logbook, and the condition under which it gets parked,
> stated in advance. The bet is written down together with its kill criterion
> ([§2](#2-hypothesis-and-kill-criterion)) so that the result cannot be renegotiated once it
> arrives.
>
> This document was committed as a proposal and then amended where building it changed an answer.
> Six sections carry a revision: [§4.2](#42-the-timeline) (an entry appears exactly once, and the
> composer sits above the outstanding items), [§4.3](#43-capture) (the five-verb kind chip is cut to
> one "Needs attention" toggle — four of the five had no reader and no research),
> [§4.4](#44-noticed-then-resolved) (the fix is an inline reply rather than a mode on the top
> composer, and stays nested under what it answers rather than being filed as its own entry),
> [§5](#5-what-it-is-not) (the withheld author is deferred rather than one tap away),
> [§6](#6-phases-and-gates) (the archived-machines defect was not being fixed elsewhere, so it is
> fixed here), [§8](#8-measurement) (`confirmed` is cut — Phase 1 ships no freshness signal and says
> why), and [§9](#9-open-questions) (details and manuals ship; the office gets a read-only view).
> Everything else is as proposed.
>
> Two patterns run through those. Several cut a control the proposal asked for, each for the same
> reason: a control whose answer changes nothing teaches operators this surface is decorative. The
> rest were written before there was anything on the screen — the layout ones only became visible
> once a machine carried real entries, which is an argument for building the thin thing early rather
> than specifying harder.

**Dependencies:** [Work Centers](work-centers.md), because a machine is a `work_centers` row with
`kind='internal'` and there is no separate machine entity. The notes system and its read-back loop
([Operator View](operator-view.md#the-read-back-loop-attribution)). Station selection, which is
the only entrance to this module, and the one live defect in it named in
[§6](#6-phases-and-gates).

> **An entry is a `notes` row**, `subject_kind='work_center'` with `note_type='user'` — not a
> separate store. So maintenance entries are part of the author's contribution and appear on
> **My work** beside their job and part notes, where the row names the machine in the slot a job
> note uses for its job number. The CHECK constraint on `notes` permits exactly one subject, so a
> maintenance entry carries no part, no operation and no job; before the machine name was
> selected there, those rows rendered as a bare sentence with nothing saying what they concerned.
> Anything that changes what an entry carries has to be checked on that surface too.

---

## 1. Problem

The shop's most technical operator writes almost nothing on job travelers. The reason is not
reticence and it is not tap count. His knowledge is machine-specific, and every capture surface
Jigged has built is shaped like a part or like an operation: the durable note is the one rooted at
a part and a routing step, durable precisely because it answers "how do you run this part here".
He has been offered a container that does not fit what he knows, and declined it, which is the
correct response to a container that does not fit.

What operators still text a departed veteran about is how to maintain the equipment. He left a
year ago. None of it was written down. The channel that replaced the record is one personal
friendship, which has no owner, no backup and no expiry warning; it decays quietly and nobody
finds out on a good day.

The industry picture says this is not a local eccentricity. Contaminated coolant and missed
lubrication are the leading causes of premature bearing and ballscrew failure, and roughly seven
in ten spindle shutdowns trace back to lubrication that was missed **or not recorded** (industry
figures, not measured at the pilot shop). The second half of that disjunction is the half that
makes it a software problem. A shop can be doing the work and still be one departure away from
losing the knowledge of what the work is.

The capture behavior already exists. Machinists photograph offsets at the end of a shift and carry
mental lists of things to look into tomorrow. That is a habit with nowhere to land, so this module
proposes a landing place rather than a new discipline. The canonical failure it targets is the
handoff where the outgoing operator says the machine ran fine and does not mention the way cover
that has started to drag. Nothing in that sentence is a lie, and nothing in it is recoverable.

## 2. Hypothesis and kill criterion

**H:** machine-scoped knowledge is a container operators will fill, where part-operation-scoped
knowledge was not. The part-scoped container exists, it is durable by design, and it is close to
empty. That is the prior result this module is arguing with.

**Decided:** Phase 1 passes only if at least five entries exist from at least three distinct
non-founder authors within four weeks. Four entries from four people is a kill. Eight entries from
two people is a kill; one enthusiast is a person, not a container.

The four weeks start at the **first organic entry**, not at ship date. If no organic entry appears
within four weeks of the flag going on, that silence is the kill result, but only on one
condition: machine pages have to have been opened during the window. A container nobody filled and
a container nobody reached both look like silence from outside, and [§8](#8-measurement) is what
tells them apart. If page opens are near zero across the four weeks, the result is recorded as
**not yet tested**, not as a kill, and the clock restarts once the door is demonstrably reachable
and in use.

That is not a hypothetical escape hatch. This module launches into an operator surface that is not
yet in daily use ([§6](#6-phases-and-gates)), so the likeliest first result is "not yet tested",
and that result must not be quietly upgraded to a pass or downgraded to a kill.

**Decided:** no seeded corpus, at all. No backfill, no transcription of the departed veteran's
texts, no entry written on anyone's behalf. Anyone may write down knowledge they got from him, as
themselves; nobody writes as him. **Why:** a container that arrives pre-filled cannot answer the
only question Phase 1 asks, and a demo corpus and an evidence corpus cannot be the same rows.

Reads are the earlier and cheaper signal. `viewer_count` moves the first time somebody opens an
entry, which will happen before the fifth entry exists. Watch it, and do not promote it to the
gate: a corpus that is read but not extended is still one person's knowledge with a wider
audience.

## 3. Who it's for

The design center is the infrequent frontline user at a shop with no maintenance department. The
requester, the approver and the technician are the same person, standing at the machine, deciding
in the moment whether the thing they just noticed is worth saying out loud. The pilot shop is
roughly fifteen people. There is no maintenance role in Jigged today and none is proposed; the
frontline role is `operator`, and the operator is the technician.

This is where the module parts company with the CMMS category deliberately. CMMS products model a
requester who raises a request, a manager who approves and assigns it, and a technician who
performs and closes it. Their strongest mobile experiences split into two profiles for exactly
that reason: an infrequent operator who reports, and a continuous technician who lives in the
queue. Jigged builds only the first profile, because the second person does not exist at a shop
this size. Building the split anyway would add three steps to a one-person action.

The frame is autonomous maintenance, the first pillar of TPM: operator-owned basic care, which is
cleaning, inspection, lubrication and retightening done by the person at the machine. It is not a
work order routed to a department. This has a consequence that [§5](#5-what-it-is-not) leans on:
there is nobody for a request to be sent *to*, so request and approval workflows are rejected on
structural grounds rather than as scope trimming.

## 4. What it is (Phase 1)

A logbook for a machine, reachable from the floor without a search, written by whoever is standing
there.

### 4.1 One door

A Maintenance tab, available once a station is selected, opens the logbook for the machine the
operator is standing at. There is no picker, because a station is a machine: the operator's
station list is `work_centers` filtered to `kind='internal'`, so selecting a station has already
answered the only question a picker would ask.

There is deliberately nothing to scan on the machine itself. A shop at this scale has few
machines, and the operator has already told the app which one they are standing at, so a code
posted on the machine would solve a navigation problem this product does not have. The in-app path
is the only entrance, which makes the health of station selection a dependency of this module
rather than a convenience ([§6](#6-phases-and-gates)).

### 4.2 The timeline

Open items sit pinned above the log, then entries newest first, each attributed and dated. Newest
first, and not grouped by kind, because the reader's question on arriving at a machine page is
almost always "what has happened to this machine lately". Any grouping answers a question nobody
asked, and pushes the recent thing below the fold.

**Revised at build time, on two points the running screen made obvious.**

*The composer sits above the pinned items, not below them.* With outstanding work first, a machine
carrying several open items pushed the composer off the top of a phone — the one thing this screen
exists to make easy became the thing you had to scroll to find. Writing does not queue behind
however much is outstanding.

*An entry appears exactly once.* An open item used to render as a pinned summary **and** again in
the log below, which was one fact twice with different chrome, and the summary dropped the entry's
photo — which on "the way cover has started to drag" is most of the message. Now an outstanding
item lives in the pinned block as a full card, and the moment somebody logs the fix it drops into
the log carrying its author. The log itself is one card of divider-separated rows, matching how the
[Operator View](operator-view.md) already renders notes: same content, same reading gesture, and a
four-word entry no longer costs a whole card plus a gap.

### 4.3 Capture

Free text. Dictation is the phone keyboard's dictation key, which operators already use; no custom
voice capture is built or proposed. Photos are optional and go through the native sheet, so an
existing camera-roll photo works: the end-of-shift offset photo is already on the phone. Alongside
them, one optional toggle: **Needs attention**.

**Decided (revised at build time): one toggle, not a taxonomy.** This section originally offered a
kind chip with five values — cleaned, repaired, replaced, adjusted, noticed — asserted in a single
sentence with nothing behind it. Two things were wrong with that list.

It did not match the frame this document itself argues from. [§3](#3-who-its-for) grounds the module
in autonomous maintenance, "cleaning, inspection, lubrication and retightening"; only *cleaned*
appears in both, and **lubrication is missing entirely** — the very thing
[§1](#1-problem) builds the case on ("roughly seven in ten spindle shutdowns trace back to
lubrication that was missed or not recorded"). A taxonomy that omits the category its own evidence
rests on was invented rather than observed.

And four of the five had no reader. Nothing in the product filtered, grouped, ranked or counted by
kind — [§4.2](#42-the-timeline) forbids grouping the timeline by it — so they were four extra
decisions asked of somebody in a container whose entire risk is that nobody writes in it at all.
Only `noticed` ever did anything: it is what pins an entry to the top of the machine
([§4.4](#44-noticed-then-resolved)).

So the one value with a consumer survives, under a label that says the condition rather than naming
a category. It is **off by default** — most entries record work already done — and deselectable,
because a person who is unsure must still be able to write the sentence. The database CHECK keeps
all five values: widening a constraint later is a migration, narrowing it buys nothing, and if a
real corpus ever argues for categories they come back as a UI change with a consumer attached.

**"Needs attention" notifies nobody.** There is no notification path in Phase 1
([§9](#9-open-questions)), and the wording is chosen not to imply one. What it does is keep the
entry pinned to that machine until somebody logs a fix — so the person who meets it is the next
operator standing at the machine, which is precisely the handoff [§1](#1-problem) says goes wrong.
Its only intended exit is a second entry describing what was done: there is no dismiss and no close,
so clearing the pin and recording the knowledge are the same act. That used to rest on `notes` being
append-only; since [#628](https://github.com/debola31/Jigged/issues/628) it rests on something
narrower and more durable — an entry's **body** is editable by its author, but `maintenance_kind` and
`resolves_note_id` are immutable under a database guard trigger. So an operator can fix the wording of
what they noticed and can never un-notice it, and a fix can never be re-pointed at a different item.
The derived-open list stays trustworthy while the text stays correctable.

### 4.4 Noticed, then resolved

An open noticed item offers "log the fix". There is no assignment, no priority and no due date,
because each of those needs a second person to mean anything ([§3](#3-who-its-for)).

**Revised at build time: the fix is an inline reply, not a mode.** This originally specified "the
same composer with the resolution link already bound", asserted in one sentence with no research
behind it — the doc has nothing on replies or resolution interfaces at all. Reusing the top composer
made resolving an item a MODE, announced by a banner, and modes fail in exactly the conditions this
surface has: the banner scrolls out of view, and somebody who walks away mid-thought comes back to a
composer that looks ordinary and is not.

It also had a real defect. Starting a fix left whatever was half-typed in that composer alone while
re-binding it to a resolution, so a sentence written about something else could silently become the
fix for an item tapped afterwards.

**And the first attempt at fixing that did not finish the job — worth recording, because the wrong
diagnosis survived a build.** Giving the reply its own composer stopped the MAIN composer
contaminating a reply, and a test pinned that. But there was still only one reply composer, shared by
every outstanding item, and its draft was cleared in exactly one place: a successful save. So
starting a fix on one item, typing, then tapping "log the fix" on a second item moved the composer
without moving the text — and submitting filed the first item's sentence as the second item's
resolution. The second closes on a sentence written about something else, the first stays
outstanding forever. When this was written the log was append-only and nobody could correct it, so the
only remedy was a second entry saying the first was misfiled. Since
[#628](https://github.com/debola31/Jigged/issues/628) the author can delete the misfiled fix outright,
which returns the item it wrongly closed to **Needs attention** — the open list is derived from the
absence of a resolver, so removing the resolver restores the state with nothing stored to go stale.
Note the shape of the remedy, because it is not "edit the link": `resolves_note_id` is immutable, so a
fix filed against the wrong item is deleted and re-logged rather than re-pointed. The prevention below
still matters more than the cure.

The lesson is about where state lives, not how many composers there are. A draft must not outlive the
thing it was written about, so the draft now lives **with the target**: the reply composer is mounted
keyed by the item it answers, and switching items destroys one and builds another. There is nothing
to remember to reset, which is the same reasoning that makes open state derived rather than stored —
a rule enforced by structure does not depend on every future edit remembering it.

So the fix composer opens **beneath the item it answers**, and the item's "log the fix" control is
replaced by it — the ordinary reply gesture, where position carries the meaning and there is no
state to remember. It offers no flag of its own: a fix resolves something, and if the work uncovers
a new problem that is a new entry rather than this one being both.

**And it stays a reply once it lands.** The first build filed the fix as its own entry on the
timeline and drew the link in text: the fix quoted the observation ("Fixes: …") and the observation
gained a "Fixed by …" line. That reads as two separate entries that happen to mention each other,
and the quotation had to be truncated to one line to fit — so the link was drawn by cutting off the
very text it was pointing at. Instead the fix renders **nested under what it answers**, indented
beneath a left rule, the way a reply reads on any messaging surface. Position carries the link, so
neither end needs a sentence explaining itself, and nothing has to be truncated to fit.

Threads sort by **latest activity**, not by the root's age. This is the one cost nesting carries: an
observation from three weeks ago, answered this morning, would otherwise sit three weeks down a list
that [§4.2](#42-the-timeline) keeps newest-first precisely because the reader is asking what has
happened lately. Sorting on the thread rather than the root keeps that promise — resolving something
old brings it back to the top, which is also what the person who did the work would expect.

Only resolutions nest. This is not general threaded discussion: an ordinary entry cannot be replied
to, because a shop this size has no conversation to hold ([§3](#3-who-its-for)) and a reply affordance
on every row would invite one this surface is not built to keep readable.

Open state is derived from the existence of a resolving entry and is never stored. So there is no
state anyone has to remember to close, and no way for the open list to disagree with the timeline
it is drawn from.

### 4.5 Zero required setup

Machine details (make, model, serial, year, purchase date) and manual attachments are all
optional. Nothing is gated on any of them, and nothing prompts for them. Asset data-entry time is
a leading cause of CMMS abandonment: the tool arrives, the shop is asked to describe its equipment
before it can do anything, and the project dies in the describing. The machines already exist in
Jigged as work centers, so this module starts with its asset list complete and its asset detail
empty, which is the right way round.

The enforceable form of that principle: no empty-state nudge, no completeness meter, no prompt to
finish setting up a machine, and no surface that renders one machine as less ready than another
because somebody typed a serial number into it.

### 4.6 Attribution

Inherited from the notes system whole, not redesigned. The author is resolved server-side, so an
entry is written as the person writing it and cannot be attributed to anyone else. Authors see
named views of their own entries; everyone else sees aggregates. The rule is one sentence with no
role branch: *you see who viewed your own notes; nobody sees who viewed anyone else's*
([Operator View](operator-view.md#the-read-back-loop-attribution)).

The container is already modelled. The notes system carries a work-center subject end to end, and
nothing in the app writes one today.

## 5. What it is not

Each of these is a real product that exists elsewhere and is rejected here for a stated reason,
not deferred by oversight.

- **Request and approval workflows.** There is no second person for a request to reach
  ([§3](#3-who-its-for)).
- **MRO parts inventory.** A second item master with a second counting ritual, while the first one
  is still being learned ([Inventory](inventory.md)).
- **Criticality rankings, MTBF, MTTR, PM-compliance dashboards.** All four are ratios computed
  over a corpus that does not exist yet.
- **Downtime tracking.** Actual time was deliberately removed from this product and is
  structurally unrepresentable ([Operator View](operator-view.md#surveillance-guardrail-non-negotiable)).
- **Lockout/tagout fields.** A compliance artifact, and Jigged is not the shop's compliance system
  of record.
- **Bulk asset import.** The machines are already in Jigged; an importer would be a second door
  into a room that has one.
- **Any per-operator maintenance scorecard or comparison, visible to anyone.**
- **Schedules and reminders.** Deferred by sequence, not by taste ([§6](#6-phases-and-gates)).

The surveillance guardrail extends here in full: *no operator-facing surface may reflect an
operator's pace or standing back at them*
([Operator View](operator-view.md#surveillance-guardrail-non-negotiable)). Concretely, no surface
may show who logs how many entries, or how often a given operator files a noticed.

That collides with a real design want, and the collision resolves in one direction. **Decided:**
the open-items list shows the observation, the date and the photo — but not the author. A list of
open items with names against it is a list of who reports the most problems, read straight down the
column, and that is the shape of every operator scorecard this product has already refused to
build. The cost of the alternative is that filing a noticed becomes an admission.

**Amended at build time.** This originally said the author was "visible on the entry's own card, one
tap away", because an open item also rendered in the log below. It no longer does — an entry appears
exactly once ([§4.2](#42-the-timeline)) — so the name is not one tap away, it is **deferred**: the
entry carries its author from the moment somebody logs the fix and it drops into the log. That is a
better version of the same trade rather than a weaker one. While a thing is outstanding, who raised
it is not the question; once it is dealt with, both names survive on the record and neither is
counted.

## 6. Phases and gates

Phase 1 ships behind a per-tenant feature flag (flags live in `companies.settings.features` and
are registered in `lib/featureFlags.ts`; turning one on for a pilot tenant is a single update).
Before the clock in [§2](#2-hypothesis-and-kill-criterion) can mean anything, an operator has to
be able to reach a machine page at all, and what stands in the way is not this module's work.

Station selection is the only entrance ([§4.1](#41-one-door)), so one live defect in it becomes a
prerequisite here: the station picker leaked archived machines because it did not filter on
`deleted_at`. This draft said it "is being fixed independently"; it was not — no branch, issue or PR
covered it, and `getStationOperationTypes` was the one work-center reader in the codebase without
the filter. **It is fixed as part of this module's work**, along with the matching gap in
`getStationName`, which now answers null for an archived machine so the stored station clears itself
rather than stranding an operator on a machine that no longer exists. One further fact about the
floor belongs here rather than in a retrospective:

> Operator adoption of the existing operator surface is currently near zero: operators are not yet
> marking operations complete. This module launches into a surface that is not yet in daily use,
> which is a real risk to the four-week clock rather than a footnote to it, and it is why the
> clock in [§2](#2-hypothesis-and-kill-criterion) carries a precondition.

**Phase 1: the logbook.** Everything in [§4](#4-what-it-is-phase-1), at one pilot shop.
**Gate:** the bar in [§2](#2-hypothesis-and-kill-criterion).

**Phase 2: standing procedures.** Described at design level only. Any good entry can be promoted
to a standing procedure, and the original author is preserved on the promotion, because the person
who knew the thing is the point. Completing a procedure writes an entry on the machine's timeline,
so the log remains the single record of what happened to the machine and procedures do not become
a parallel history. **Gate:** at least ten entries, of which at least three describe a repeatable
how-to. The count alone is not the gate: a procedure library is a distillation, and there is
nothing to distil until entries start repeating themselves.

**Phase 3: schedules.** Two trigger kinds: a calendar interval, and usage, where usage is measured
good pieces through the machine since the last entry that satisfied the procedure. This trigger
needs no sensor, no meter reading and no integration, because the machine record and the job
record are the same record: good pieces are already recorded against an operation, and that
operation already names its work center. **Gate:** Phase 2 procedures exist, **and** at least
three shops have answered whether they run a separate CMMS or track maintenance in their ERP. Only
one shop is reachable today, so this gate is blocked on access rather than on engineering, and it
should stay blocked rather than be reinterpreted downward.

Schedules shipped before a corpus exists produce the nagging, surveillance-flavored version of
this product: a machine page that tells an operator what he is late on, assembled out of nothing
he wrote. That is the version of a CMMS frontline users abandon, and it would also make the
[§2](#2-hypothesis-and-kill-criterion) result unreadable in retrospect, because a container nobody
filled and a container that started nagging on day one fail the same way from outside.

Logs, then procedures, then schedules. That order is not negotiable.

## 7. Competitive position

The category is validated and it is owned. MaintainX was acquired by Autodesk in 2026 for a
reported figure of roughly $3.6B, builds an AI knowledge base out of the completion notes
technicians write on work orders, and holds the top ease-of-use ratings in its category. That is
the same insight this module rests on, executed by a company with a decade of head start and a
sales motion aimed at exactly this buyer. Jigged does not out-CMMS a CMMS, and any roadmap item
whose justification is parity with one is rejected on that basis alone.

The wedge is not a feature. It is that maintenance data and job data are one system. A usage
trigger needs no sensor, no meter reading and no integration, because Jigged already counts good
pieces through the machine as a by-product of running the shop. "The machine was down Thursday"
and "that job ran long" become two readings of one record instead of two systems reconciled by
somebody who happens to remember both. A dedicated CMMS cannot reach that without an integration
that a fifteen-person shop will never build. Any design choice that requires maintenance data to
live apart from job data is wrong by definition.

## 8. Measurement

The funnel is the primary instrument, and for a structural reason rather than a preference: with
an empty starting corpus, every count-based surface is silent at launch. The existing capture
funnel was built to make exactly this distinction and applies here unchanged, in the form its own
source states it: page opened but composer never focused means the container does not fit, and
composer focused but nothing saved means capture friction. Without those, "adoption was poor" is
unreadable, and unreadable is the one outcome that cannot be acted on. Four moments need
instrumenting on this path: the machine page opened, the composer focused, an entry saved, and a
noticed resolved.

Two limitations are known in advance and are not bugs. First, a machine-entry read carries no job
context, and the per-job usage counter counts distinct jobs and ignores the absent one, so it
stays at zero for this module permanently. The "used on N jobs" signal that ranks the part
Playbook does not exist here and must never be displayed here. Second, read logging dedupes per
person, per entry, per job, and treats the absent job as equal to itself, so a person's repeat
consultation of the same entry is recorded once, ever. Somebody rereading the way-cover entry six
months later is invisible, and that reread is precisely the event a maintenance logbook would most
want to see. `viewer_count`, distinct people, still works; it saturates near shop size, which is
its meaning.

The consequence is a decision rather than a complaint. Reads can tell us an entry was found; they
cannot tell us it is still true.

**Decided (revised at build time): Phase 1 ships no freshness signal, and accepts the gap.** An
earlier draft of this section named `confirmed` — a reaction kind that exists in the database
alongside `helpful`, with no negative option by design, and has never had a UI — as the designated
freshness signal for this module, and called building that UI a prerequisite. It is not one, and the
argument against it is the argument this module makes everywhere else. `confirmed` means "I did this
and it still holds", which needs a second person to re-perform the same maintenance and then say so.
At a fifteen-person shop, inside a four-week window, against a bar of five entries, that will not
happen. It would ship as a control nobody taps — which makes the surface look busier than it is and
teaches operators that some buttons here are decorative, the exact opposite of what a container
being filled for the first time needs. No product in the category offers one either, which is weak
evidence but not none.

So `helpful` is inherited unchanged and nothing else is built. The honest position is that Phase 1
can tell whether an entry was *found* and not whether it is still *true*, and that a corpus small
enough to fail the [§2](#2-hypothesis-and-kill-criterion) bar is also far too small for staleness to
be the problem worth solving. If the corpus survives and starts to age, revisit this with real
entries in hand. None of this is the gate. The gate is [§2](#2-hypothesis-and-kill-criterion).

## 9. Open questions

Four questions are closed and are not reopened here: classification is optional — and, since
[§4.3](#43-capture) was revised, is one toggle rather than five verbs; there is no seeded corpus
([§2](#2-hypothesis-and-kill-criterion)), open-items attribution resolves in favor of the guardrail
([§5](#5-what-it-is-not)), and the module is called Machine Maintenance.

**Does the Maintenance tab appear before a station is selected? Decided: no.** Without a station the
tab needs a picker, and a picker is the ceremony [§4.5](#45-zero-required-setup) refuses. Station
selection already answers the question a picker would ask. This is load-bearing now that the tab is
the only entrance, and it has a visible consequence: an operator who notices something on a machine
that is not their selected station changes station first, using the selector that already exists. At
this machine count that is acceptable. If it proves to be friction, the answer is revisiting this
question, not reviving a code on the machine. Built exactly this way: the tab is rendered only when
a flag is on **and** a station is set, and unlike the Inventory and My work tabs it is deliberately
not on the list of routes that keep the nav visible before a station exists.

**Do machine details and manual attachments belong in Phase 1 at all, given nothing gates on them?
Decided: both ship, and nothing ever prompts for either.** A manual an operator can open on the
floor is worth having on day one. Reading happens on the floor; filling either one in happens in the
office, where somebody with a spec sheet is doing paperwork on purpose. The enforceable half is
tested rather than merely asserted: a machine with no details renders nothing at all — not an empty
state, not a completeness meter, not a prompt — and a machine with no manuals shows no manuals row.

**Can the office read a machine's log without an operator device? Decided: yes, read-only.** Not a
question this draft asked, and it needed answering before build. The work-center page in the
dashboard carries the same timeline with no composer. "One door" ([§4.1](#41-one-door)) is a rule
about the operator entrance and about pickers, not a rule against the founder being able to watch
whether the [§2](#2-hypothesis-and-kill-criterion) corpus is forming. An office **composer** is
refused for a different reason: the bar counts non-founder authors, and the most convenient way to
write entries must not be the one seat that would invalidate the result.

**Is the flag retired after the pilot, or kept?** Recommendation: retired, on the precedent
[Shipments](shipments.md) set (gated during rollout, then made core and the key removed), but only
after a second shop clears the [§2](#2-hypothesis-and-kill-criterion) bar rather than after the
first one.

**What happens to a machine's timeline when the machine is archived?** Recommendation: the entries
survive and stay readable, and the page stays reachable by direct link while dropping out of
lists. Archiving hides a machine from pickers, not its knowledge, and knowledge must not be
destroyable as a side effect of tidying a list.

**Can a noticed item be resolved by someone other than the person who filed it?** Recommendation:
yes, and that is most of the point. The resolving entry carries its own author, so both names
survive and neither is counted. The open part is notification: there is no operator notification
path today, so in Phase 1 the original author finds out by reading the timeline. State that limit
rather than designing around it.

**Does Phase 2 promotion leave the original entry on the timeline?** Recommendation: yes, and mark
it as promoted. A log that loses rows stops being a log, and an unexplained near-duplicate is what
makes people stop trusting one.
