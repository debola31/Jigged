# Inventory Discovery — Remote Script v1

> **Type:** Discovery (contextual inquiry), **not** a usability test. We are not testing
> screens. We are learning how the shop actually handles material, so we can stop guessing.
>
> **Format: video call.** The facilitator is **not** on the shop floor. That costs us direct
> observation, so this script compensates in two ways — a **pre-call photo request** and a
> **guided camera walkthrough** where they carry the phone. Both need setting up in advance;
> see [Before the call](#before-the-call).
>
> **Participants:** Shane (owner) and/or Johnny (quoter), Contour Tool & Machine.
> **Facilitator:** ______________ **Date:** ______________
> **Time:** 45 minutes. 15 on the walkthrough, 25 talking, 5 wrapping up.
>
> **Why this exists.** No user research on inventory has ever been run. The storage
> vocabulary in the product came from generic warehouse research, not from this shop. Every
> journey in [`docs/modules/inventory.md`](../modules/inventory.md) marked *hypothesis* is waiting
> on this conversation.

---

## Before the call

**Send this ask 2–3 days ahead.** It is the single biggest determinant of whether the session
is worth running — remote discovery without artefacts is just an interview.

> "Before we talk, could you send me photos of everywhere material is kept — racks, shelves,
> cabinets, the floor, outside, wherever it actually ends up? Phone snaps are perfect, no
> tidying. And if you have one handy, a photo of a material cert and of how a bar is marked."

Also ask: **"Will you be able to walk around with your phone during the call, or should we
stay at the desk?"** Their answer changes Part 1 — have both versions ready.

Facilitator setup:

- [ ] **Storage-type palette** open in your own browser, ready to **screen-share**
      (`/dashboard/{companyId}/inventory/locations` → **Build visually** → step 1). Step 1
      only — do **not** create anything. Confirm `inventory_locations` is enabled for the
      company you're pointed at, or the palette won't load.
- [ ] Screenshots of the seven cards saved as a **fallback**, in case screen-share fails or
      they're on a phone with no second screen.
- [ ] **Ask permission to record.** On a remote session the recording *is* your field notes —
      you cannot scribble and drive the call at once.
- [ ] Findings CSV open on a second screen.

**Ground rules.** Ask them to *show*, not describe — "can you point the camera at it?" is the
remote equivalent of walking over. When they say "we just know where it is," ask them to prove
it by going and finding something. Never correct them, never demo the product, never explain
what Jigged *will* do. If a question feels leading, drop it.

**What remote costs us, and how to compensate:** you lose peripheral vision — the clutter in
the corner, the thing behind the door, the label nobody mentioned. Counter it by explicitly
asking *"what else is out of frame?"* at every stop, and by treating their photo set, not the
call, as the record of how many places exist.

---

## Part 1 — Guided camera walkthrough (15 min)

> "Could you carry me around on your phone and show me everywhere material lives? Just talk me
> through it as you go."

You are watching and listening, not photographing — their pre-call photos are the visual
record. Note what they **call** each place in their own words; that word matters more than
anything in our palette.

**If they can't walk around** (bad signal, hands full, desk-bound): fall back to screen-sharing
their photo set and going through it one image at a time — *"what is this one, what's in it,
what do you call it?"* Weaker, but it still answers most of the table below. Record in the CSV
which mode you used; it changes how much weight the findings carry.

| Record | Why |
|---|---|
| **Count of distinct places material sits** | Our builder generates 16 locations from one wizard pass. Hypothesis: the real number is **6–10**, and they're heterogeneous. If it's 40, the hypothesis is wrong and the wizard is right. |
| **Their name for each** | "The bar rack", "the shelf by the saw", "out back". If names are spatial and informal, a code scheme like `CAB1-R03-L` will never be used. |
| **Is anything labelled today?** | Existing labels = they already believe in this. No labels = we're asking for a new habit. |
| **Where do the drops/offcuts go?** | J8. Watch for a dedicated remnant rack vs. "back on the shelf" vs. the scrap bin. |
| **Is material marked?** | Machinists commonly write the alloy on both bar ends and re-mark the cut end. Ask them to point the camera at a bar end. If they do this, the software should mirror the habit rather than replace it. |
| **Anything on the floor / in a corner / outside?** | Our palette has no card for "floor" or "outside". Ask directly — this is exactly what a camera misses. |

One thing to try live, and one you must now ask instead of observe:

- [ ] **Ask them to find one specific thing.** *"Where's a piece of 4140? Can you go get it?"*
      Time it, and listen for hesitation. This survives remote intact — arguably better,
      because you can't accidentally point.
- [ ] **Signal dead zones — now a question, not a measurement.** You cannot watch their bars.
      Ask: *"Does your phone drop signal anywhere in the building? What about right at the
      material rack, or in the stockroom?"* Self-reported, so treat it as weaker evidence and
      flag it as such in the CSV. *(Decides PWA offline scope.)*

---

## Part 2 — Journey probes (25 min)

Ask in this order. **Question 3 comes early because it can delete an entire phase of work.**

### 1. The last job, end to end
> "Walk me through the last job you ran, from 'we won it' to 'material was on the machine.'"

Let them talk. Do not steer. Note every point where material is touched, and by whom.

### 2. Stock vs. buy
> "What do you keep on hand, versus buy for a specific job?"

*Decides:* whether the job-shop hypothesis holds — that most material is bought per job and
only common sizes are stocked. If they stock heavily, J1 and J9 matter much more. If they
buy per job, J4–J7 are the whole product.

### 3. Certs and heat numbers — **ask this early**
> "Do you keep material certs? Which customers ask for them? What happens if one asks you to
> prove which heat went into a part you shipped last year?"

*Decides:* **whether Phase 4 exists at all.** If no customer demands traceability, we cut lots,
heats and certs, and re-justify remnants on material-cost grounds alone. If aerospace, defense
or medical is in the mix, traceability is not optional and moves up the plan.

Listen for: a paper folder, a shared drive, "the mill sends a PDF", "we've never been asked."

### 4. Knowing you're short
> "How do you find out you're short on material? What's the latest you've ever found out?"

*Decides:* J4's shape and urgency. A war story here is worth more than any feature request.

### 5. Material arriving
> "What happens when a delivery shows up? Who touches it, and what gets written down?"

*Decides:* J6, and whether the PRD's Admin / Shipping Clerk persona is a real person here or
a fiction. Ask specifically whether anything is checked against the order.

### 6. Staging — **this one decides an architecture question**
> "Once you know a job is running, does the material get pulled and set aside beforehand, or
> does someone grab it at the machine when they start?"

*Decides:* [`inventory.md`](../modules/inventory.md) §5.2 — whether **a job is a place**. If
they stage material against a job, modelling a job as a container gives us kitting and
shortage-at-kitting for free. If they grab it at the machine, J7 is a plain depletion with a
job id.

### 7. Counting
> "When did you last count anything? What triggered it?"

*Decides:* J9. The PRD promises "100% inventory accuracy within 3 months" and that is
unmeasurable without a counting ritual. If they have never counted, we are introducing a
practice, not digitising one — which is a much harder sell and should change how we pitch it.

### 8. Labels in the real world
> "If you stuck a paper label on the end of that bar rack, what does it look like in a month?"

*Decides:* label material, not the data model. A plastic sleeve is the cheap known answer;
some spots may need a plate or engraved tag. Also ask **where** on each piece of storage a
label would survive — and whether anything in the building is already labelled that way.

### 9. Scanning ten things in a row
> "Would anyone ever scan ten things one after another? Counting a shelf, or checking in a
> pallet?"

*Decides:* **the entire native-app question** ([`inventory.md`](../modules/inventory.md)
§5.10). Walking up to one bin is about two taps either way. Ten bins is ten camera-app round
trips, and that is the only workflow a native app clearly wins.

**Remote substitute for watching them do it.** You can't hand them your phone. Instead, ask
them to try it live on the call with anything already carrying a QR code — a printed traveler
works, and they print those daily:

> "Grab a traveler. Scan the QR with your camera app, then close it and scan another one.
> Talk me through what that felt like."

Listen for the round trip — open camera, wait, tap the banner, wait for the browser, back out,
repeat. Ask directly: *"Would you do that thirty times to count a shelf?"* This is
self-demonstrated rather than observed, so it is weaker than watching over their shoulder —
flag it in the CSV.

### 10. Whose phone
> "Whose phones would be used for this? What are they?"

*Decides:* the scanner spike has to run on the real handsets, not a simulator. Personal phones
are already the decided auth model.

### Carried over — never answered
Two questions from the 2026-03 script that were written and never asked:

> "If you needed to record that you used some material on a job, how would you do that?"

> "What do you think 'Adjust' does versus 'Add' or 'Remove'?"

---

## Part 3 — The storage-type card check (5 min)

The follow-up PR #419 promised (*"usability-test the storage-type icon set with Johnny/Shane
and lock it"*) and never ran. Two passes, **screen-sharing the real palette** (fall back to
the saved screenshots if sharing fails, or send them ahead and have them open the images).

Ask them to read the cards aloud as they go — on a shared screen you can't see where their
eyes land, so their narration is the only signal you get about which cards register.

**Forward — do you own this?**
Show the seven cards. For each: *"Do you have one of these? What do you call it?"*

| Card (our label) | Own it? | Their word for it |
|---|---|---|
| Cabinet | | |
| Shelving unit | | |
| Pallet rack | | |
| Drawer unit | | |
| Single shelf | | |
| Bins | | |
| Aisle / zone | | |

**Reverse — which card is this?**
Share **their own pre-call photos** back at them, one at a time: *"Which of these cards is
this?"* Using their photos rather than your description is what makes this pass work remotely
— it removes your vocabulary from the question entirely.

Record every photo that has **no good card**. Standing hypothesis: the **bar rack / vertical
material rack** — the defining storage object in a machine shop — has no card at all. Also
watch for *floor*, *outside* and *under the bench*.

**Output:** a keep / cut / rename list, plus the missing types.

---

## Part 4 — Wrap-up (5 min)

> "If inventory in Jigged worked perfectly tomorrow, what would be different about your week?"

> "What's the one thing about material that costs you the most time or money right now?"

> "Is there anything I should have asked about and didn't?"

---

## Recording findings

**Record the call** (with permission) and fill `inventory-discovery-findings-v1.csv` from the
recording immediately afterwards — same day, while the tone is still fresh. On a remote session
you cannot both drive the conversation and take usable notes, so capture verbatim quotes from
the playback rather than paraphrasing live. One row per observation.

Archive their pre-call photos alongside the findings; they are the record of how many storage
places exist, and Part 3's reverse pass depends on them.

**Mark evidence strength.** Remote weakens three findings in particular — signal dead zones,
the scanning round trip, and anything out of camera frame. Note in the `Follow-up` column
whether each was *observed*, *self-demonstrated*, or *self-reported*, so nobody later treats a
reported claim as a measured one.

> **The findings file is deliberately not in git** — `.gitignore` keeps anything matching
> `docs/usability-tests/*findings*` local, because completed sessions contain user research.
> This script *is* tracked. If the template is missing, recreate it with this header:
>
> ```csv
> #,Part,Probe,Observation,Their words (verbatim),Severity,Decides,Photo,Follow-up
> ```
>
> One row per bullet in Part 1, one per probe in Part 2, one per card in Part 3, one per
> wrap-up question.

Severity:

| Severity | Meaning |
|---|---|
| `blocker` | Contradicts a decision already made in `docs/modules/inventory.md` |
| `major` | Changes the shape of a journey |
| `minor` | Changes a detail or a label |
| `confirm` | Validates a hypothesis — record these too; they're how a hypothesis becomes a decision |

Photos go in a dated folder; reference the filename in the row.

### Immediately after

1. Answer the certs question in [`inventory.md`](../modules/inventory.md) §9 and, if the
   answer is no, cut Phase 4's traceability half.
2. Decide §5.2 (job as place) from probe 6.
3. Update every journey still marked *hypothesis* to *validated* or *revised*.
4. Close issue **#541** with the answer. Re-scope **#496** from *"the use isn't validated"* to
   the phasing in §6.
