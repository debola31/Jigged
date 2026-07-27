# Inventory Discovery — Field Script v1

> **Type:** Discovery (contextual inquiry), **not** a usability test. We are not testing
> screens. We are learning how the shop actually handles material, so we can stop guessing.
>
> **Participants:** Shane (owner) and/or Johnny (quoter), Contour Tool & Machine.
> **Facilitator:** ______________ **Date:** ______________
> **Time:** 45 minutes. 15 on the floor, 25 talking, 5 wrapping up.
>
> **Why this exists.** No user research on inventory has ever been run. The storage
> vocabulary in the product came from generic warehouse research, not from this shop. Every
> journey in [`docs/inventory-flow.md`](../inventory-flow.md) marked *hypothesis* is waiting
> on this conversation.

---

## Before you go

- [ ] Phone or tablet charged, with the **storage-type palette** open and ready
      (`/dashboard/{companyId}/inventory/locations` → **Build visually** → step 1). You only
      need step 1 — do **not** create anything.
- [ ] Camera ready. You will photograph every place material sits.
- [ ] The findings CSV open, or printed. **Fill it in on the spot**, not from memory afterwards.
- [ ] Know which company id you're pointed at, and confirm `inventory_locations` is enabled
      for it — otherwise the palette won't load.

**Ground rules.** Ask them to show, not describe. When they say "we just know where it is,"
ask them to prove it by finding something. Never correct them, never demo the product, never
explain what Jigged *will* do. If a question feels like it's leading, drop it.

---

## Part 1 — The shop walk (15 min)

> "Before we sit down, can you walk me around and show me everywhere material lives?"

Photograph each place. Note what they **call** it in their own words — that word matters more
than anything in our palette.

| Record | Why |
|---|---|
| **Count of distinct places material sits** | Our builder generates 16 locations from one wizard pass. Hypothesis: the real number is **6–10**, and they're heterogeneous. If it's 40, the hypothesis is wrong and the wizard is right. |
| **Their name for each** | "The bar rack", "the shelf by the saw", "out back". If names are spatial and informal, a code scheme like `CAB1-R03-L` will never be used. |
| **Is anything labelled today?** | Existing labels = they already believe in this. No labels = we're asking for a new habit. |
| **Where do the drops/offcuts go?** | J8. Watch for a dedicated remnant rack vs. "back on the shelf" vs. the scrap bin. |
| **Is material marked?** | Machinists commonly write the alloy on both bar ends and re-mark the cut end. If they do this, the software should mirror the habit rather than replace it. |
| **Anything sitting on the floor / in a corner / outside?** | Our palette has no card for "floor" or "outside". If a lot of material lives there, the model is too tidy. |

Two things to physically try while walking:

- [ ] **Signal check.** Watch your own phone's bars at the bar rack, the stockroom, and
      wherever material gets received. Note dead zones. *(Decides PWA offline scope.)*
- [ ] **Ask them to find one specific thing.** "Where's a piece of 4140?" Time it. Watch
      whether they walk straight there or hunt.

---

## Part 2 — Journey probes (25 min)

Ask in this order. **Question 3 comes early because it can delete an entire phase of work.**

### 1. The last job, end to end
> "Walk me through the last job you ran, from 'we won it' to 'material was on the machine.'"

Let them talk. Do not steer. Note every point where material is touched, and by whom.

### 2. Stock vs. buy
> "What do you keep on hand, versus buy for a specific job?"

*Decides:* whether the job-shop hypothesis holds — that most material is bought per job and
only common sizes are stocked. If they stock heavily, J1 and J10 matter much more. If they
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

*Decides:* [`inventory-flow.md`](../inventory-flow.md) §5.2 — whether **a job is a place**. If
they stage material against a job, modelling a job as a container gives us kitting and
shortage-at-kitting for free. If they grab it at the machine, J7 is a plain depletion with a
job id.

### 7. Counting
> "When did you last count anything? What triggered it?"

*Decides:* J10. The PRD promises "100% inventory accuracy within 3 months" and that is
unmeasurable without a counting ritual. If they have never counted, we are introducing a
practice, not digitising one — which is a much harder sell and should change how we pitch it.

### 8. Labels in the real world
> "If I stuck a paper label on the end of that bar rack, what does it look like in a month?"

*Decides:* label material, not the data model. A plastic sleeve is the cheap known answer;
some spots may need a plate or engraved tag. Also ask **where** on each piece of storage a
label would survive.

### 9. Scanning ten things in a row
> "Would anyone ever scan ten things one after another? Counting a shelf, or checking in a
> pallet?"

*Decides:* **the entire native-app question** ([`inventory-flow.md`](../inventory-flow.md)
§5.10). Walking up to one bin is about two taps either way. Ten bins is ten camera-app round
trips, and that is the only workflow a native app clearly wins.

**Watch them do it, don't just ask.** Hand them your phone and have them scan two labels in
sequence using the camera app. The friction is obvious in the doing and invisible in the asking.

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
and lock it"*) and never ran. Two passes, on the tablet, using the real palette.

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
Using the photos from Part 1, show each real piece of storage: *"Which of these is this one?"*

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

Fill `inventory-discovery-findings-v1.csv` **in the shop**. One row per observation.

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
| `blocker` | Contradicts a decision already made in `inventory-flow.md` |
| `major` | Changes the shape of a journey |
| `minor` | Changes a detail or a label |
| `confirm` | Validates a hypothesis — record these too; they're how a hypothesis becomes a decision |

Photos go in a dated folder; reference the filename in the row.

### Immediately after

1. Answer the certs question in [`inventory-flow.md`](../inventory-flow.md) §8 and, if the
   answer is no, cut Phase 4's traceability half.
2. Decide §5.2 (job as place) from probe 6.
3. Update every journey still marked *hypothesis* to *validated* or *revised*.
4. Close issue **#541** with the answer. Re-scope **#496** from *"the use isn't validated"* to
   the phasing in §6.
