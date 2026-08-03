# Inventory Discovery — Remote Script v1

> **Trimmed 2026-08-03** for [#634](https://github.com/debola31/Jigged/issues/634): **2,397 → 2,349 words**
> (`wc -w`) — near flat: a 30% trim, spent back almost entirely on the correction below and on the
> verification pass. This is a **live instrument**, not a record. [`inventory.md`](../modules/inventory.md) §10
> specifies the trim — *"vocabulary, bar rack, scanning, never a gate"* — so the probes its §9 already answers
> are gone, listed once below so nobody re-adds them. The companion `usability-test-script-v1.md` was a spent
> one-off and was deleted in the same pass; its Task 6 note on **how** to ask the whose-phone question was
> carried into probe 3 before it went.
>
> **Verification pass, same day.** The first trim cut three probes and one observation item *without*
> recording them — the exact failure the "already answered" table exists to prevent. They were not answered,
> only out of scope. Restored: the **timed find** (the instrument's only *observed* measurement), the **bar-end
> marking** confirm (J8 mirrors a habit currently sourced to a forum, not to this shop), Part 3's reason for
> existing (**the ten words came from generic warehouse research, not this shop**), and a table naming the
> three cut probes as still-unanswered.
>
> **Correction — Part 3 could not have been run as written.** *(It told the facilitator to screen-share the
> storage-type palette at `…/inventory/locations` → "Build visually" → step 1 and show "the seven cards".
> There is no such screen. `STORAGE_TYPES` **had 10 entries, not seven**, and it was
> **unreachable for its entire life** — the builder computes `subdividing = parentId !== null` and its only
> caller always passes a parent, so the top-level palette never rendered once. Both palettes were then deleted
> outright with the drawn board (commit `db58ae8`); see the "What used to be here" comment in
> [`storageTypes.tsx`](../../components/inventory/locations/builder/storageTypes.tsx) and
> [`inventory.md`](../modules/inventory.md) §5.5. Part 3 is now a paper card sort, which is what it always
> effectively was.)*
>
> **This session gates nothing.** No Phase 1–3 item waits on it. Run it when Shane or Johnny has 25 minutes.

**Type:** discovery (contextual inquiry), **not** a usability test — we are not testing screens.
**Format:** video call; the facilitator is **not** on the floor. That costs direct observation, compensated by
a **pre-call photo request** and a **guided camera walkthrough** where they carry the phone. Both need setting
up in advance.
**Participants:** Shane (owner) and/or Johnny (quoter), Contour Tool & Machine.
**Facilitator:** ______________ **Date:** ______________
**Plan:** ~25 min — 10 walkthrough, 10 probes, 5 card sort. *(The untrimmed v1 was 45: 15 / 25 / 5.)*

## Already answered — do not re-ask

Settled by the 2026-07-27 founder observation and the two legacy ERP exports; evidence and the decisions each
one drove are in [`inventory.md`](../modules/inventory.md) §9.

| Question | Answer |
|---|---|
| Certs / heat numbers / traceability | **No** — re-confirmed 2026-08-01; they do not want it. Phase 4 traceability cut |
| Staging vs grab-at-the-machine (§5.2, "is a job a place?") | **Grabbed at the machine.** Job ≠ place |
| Stock vs buy-per-job | **They stock**, for rush jobs — which is what J4 is for |
| Who moves material | The **operator** |
| Have they ever counted | **Yes, and it lapsed** — J9 rescues a practice rather than introducing one |
| How many distinct places | **~10 ±4** (22 genuine places in the export, 12–18 net of tooling sizes) |
| *"How would you record that you used material on a job?"* | Built as J7 |

**Cut for scope, and still unanswered — do not mistake these for answered.** The §10 trim is
*"vocabulary, bar rack, scanning"*, so three probes came out of v1 that nothing has since settled. They are
recorded here rather than deleted, because the table above means *answered* and these are not:

| Cut probe | Still owned by |
|---|---|
| *"Walk me through the last job, from 'we won it' to 'material on the machine'"* — the unsteered narrative that shows every point material is touched, and by whom | Nothing. §9's structure comes from the founder's model, not the shop's own telling |
| *"How do you find out you're short? What's the latest you've ever found out?"* — J4's urgency; a war story here outranks any feature request | J4 exists, but its *urgency* is unmeasured; §9 concedes frequency/pain ranking is out of reach of both observation and the exports |
| *"What happens when a delivery shows up — who touches it, what gets written down, is anything checked against the order?"* — whether the PRD's **Admin / Shipping Clerk** ([prd.md](../prd.md) §2, Users and Use Cases) is a real person at this shop or a fiction | [`inventory.md`](../modules/inventory.md) J6, which records the persona as having **no screen** but never asks whether the persona exists |

## Before the call

**Send the photo ask 2–3 days ahead.** It is the single biggest determinant of whether a remote session is
worth running — remote discovery without artefacts is just an interview.

> "Before we talk, could you send me photos of everywhere material is kept — racks, shelves, cabinets, the
> floor, outside, wherever it actually ends up? Phone snaps are perfect, no tidying."

Also ask **"can you walk around with your phone during the call, or should we stay at the desk?"** and have
both versions of Part 1 ready.

- [ ] **The ten storage-type words written on ten cards** (or ten lines in a shared doc) — see Part 3. There
      is no palette screen to share; do not go looking for one.
- [ ] **Ask permission to record.** On a remote call the recording *is* your field notes — you cannot scribble
      and drive at once.

**Ground rules.** Ask them to *show*, not describe: *"can you point the camera at it?"* is the remote
equivalent of walking over. Never correct them, never demo the product, never explain what Jigged *will* do;
drop any question that feels leading. Remote costs you peripheral vision, so ask **"what else is out of
frame?"** at every stop and treat their photo set, not the call, as the record of how many places exist.

## Part 1 — Camera walkthrough (10 min)

> "Could you carry me around on your phone and show me everywhere material lives?"

You are listening, not photographing. **Note what they *call* each place in their own words — that word
outranks any of our ten storage-type names.**

| Record | Why |
|---|---|
| **Their name for each place** | "The bar rack", "the shelf by the saw", "out back". Names that are spatial and informal mean a code scheme like `CAB1-R03-L` will never be used |
| **Is anything labelled today?** | Existing labels = they already believe in this. None = we are asking for a new habit |
| **A bar rack — is there one?** | **Withdrawn:** *"a bar rack is the defining storage object in a machine shop"* — wrong because Contour's 22 genuine exported places (`STOCK`, `SHELF`, `YARD`, `CABINET 3-10`) contain none ([`inventory.md`](../modules/inventory.md) §5.5, §9). Ask anyway, once, because they buy in feet: it is the last unsettled bit of vocabulary, and the kind stays out until a pilot shop asks for it |
| **Floor / corner / outside / bench?** | The three flat kinds exist *because* 118 of their 121 legacy locations were flat — structures-only forces "on the floor by the saw" into a cabinet. Ask directly; this is exactly what a camera misses |
| **Where do drops and offcuts go?** | J8. Dedicated remnant rack vs "back on the shelf" vs the scrap bin |

**One thing to actually watch them do.** *"Where's a piece of 4140? Can you go get it?"* — then **time it, and
listen for hesitation.** This is the only **observed** item in the whole instrument; everything else below is
self-demonstrated or self-reported, and the findings file makes you grade them apart for exactly that reason.
It **survives remote intact — arguably better, because you cannot accidentally point.** Same move whenever they
say *"we just know where it is"*: ask them to prove it by going and finding something. (J11.)

If they cannot walk around, screen-share their photo set instead and go image by image — *"what is this, what
is in it, what do you call it?"* Weaker; **record which mode you used**, it changes the weight of the finding.

## Part 2 — Probes (10 min)

1. **Scanning ten in a row.** *"Would anyone ever scan ten things one after another — counting a shelf,
   checking in a pallet?"* **Decides the entire native-app question** ([`inventory.md`](../modules/inventory.md)
   §5.10): one bin is about two taps either way; ten bins is ten camera-app round trips, and that is the only
   workflow a native app clearly wins. You cannot hand them your phone, so have them try it live on anything
   already carrying a QR code — a printed traveler, which they print daily: *"scan one, close it, scan
   another. What did that feel like? Would you do it thirty times to count a shelf?"* **Self-demonstrated,
   not observed — flag it as such.**
2. **Dead zones.** *"Does your phone drop signal anywhere in the building — at the material rack, in the
   stockroom?"* Self-reported, so weaker than a measurement; flag it. Decides PWA offline scope.
3. **Whose phones — and do they mind?** *"Whose phones would be used, and what are they?"* then *"would
   anyone mind using their own phone for work?"* The §5.10 scanner spike must run on the real handsets, not a
   simulator. Personal phones are already the decided auth model, so **do not ask this open-ended as though a
   shop tablet were still live** — the 2026-07-31 founder observation settled the device
   ([device model](../../CLAUDE.md#who-uses-what-on-what--the-device-model)); ask it to *confirm the phone* and
   spend the time on the half that is genuinely open, which [`inventory.md`](../modules/inventory.md) §9 names
   as *"whose phone, and whether operators mind."* (Carried over from the deleted
   `usability-test-script-v1.md`, whose Task 6 held the only note on how to ask this.)
4. **Label durability.** *"If you stuck a paper label on the end of that bar rack, what does it look like in
   a month? Where on each piece of storage would one survive?"* Decides label material, not the data model.
   A plastic sleeve is the cheap known answer; some spots may need a plate or engraved tag. While you are
   there, **confirm the marking habit**: *"is the material itself marked — do you write the alloy on the bar
   ends, and re-mark the cut end?"* Have them point the camera at a bar end. J8 is built on *mirroring* that
   habit rather than replacing it, and today that claim is sourced to a machinists' forum, **not to this
   shop** — so it is a hypothesis wearing a citation.
5. **Vocabulary check.** What do `ZAPP`, `SMD`, `SBS`, `DB BOX` and `0-5` mean? (One card sort.) And, carried
   over unasked from the 2026-03 script: *"What do you think 'Adjust' does versus 'Add' or 'Remove'?"*
6. **Wrap.** *"What's the one thing about material that costs you the most time or money right now?"* and
   *"Is there anything I should have asked and didn't?"*

## Part 3 — Storage-type card check (5 min)

PR #419 promised to *"usability-test the storage-type icon set with Johnny/Shane and lock it"* and never ran.
**A paper card sort, not a screen** — the palette that used to hold these was deleted (see the correction at
the top), so the vocabulary is now all there is to test, which is the only part that mattered.

**Why this part exists at all:** the ten storage words in the product **came from generic warehouse research,
not from this shop**. They have never been said back to a machinist. That is the whole reason a vocabulary
check outlived the screen it was written for.

**Forward:** read out the ten kinds — Cabinet, Shelving unit, Pallet rack, Drawer unit, Single shelf, Bins,
Aisle / zone, plus the three flat ones added because 118 of Contour's 121 legacy locations were flat: **floor
space, outside / yard, bench**. For each: *"Do you have one of these? What do you call it?"*

**Reverse:** share **their own pre-call photos** back, one at a time: *"which of these words is this?"* Using
their photos rather than your description is what makes this work remotely — it removes your vocabulary from
the question entirely. Record every photo with **no good word**; watch for *floor*, *outside* and *under the
bench* landing on the right kinds, and for anything the ten cannot name.

**Output:** a keep / cut / rename list plus the missing kinds.

## Recording findings

Fill `inventory-discovery-findings-v1.csv` from the recording the **same day**, quoting verbatim from playback
rather than paraphrasing live. One row per walkthrough bullet, probe and card. Archive their pre-call photos
alongside it — they are the record of how many places exist, and Part 3's reverse pass depends on them.

**Mark evidence strength** in the `Follow-up` column — *observed*, *self-demonstrated* or *self-reported* — so
nobody later treats a reported claim as a measured one. Remote weakens three in particular: dead zones, the
scanning round trip, and anything out of frame.

> **The findings file is deliberately not in git** — `.gitignore` keeps `docs/usability-tests/*findings*`
> local, because completed sessions contain user research. This script *is* tracked. If the template is
> missing, recreate it with:
>
> ```csv
> #,Part,Probe,Observation,Their words (verbatim),Severity,Decides,Photo,Follow-up
> ```

| Severity | Meaning |
|---|---|
| `blocker` | Contradicts a decision already made in [`inventory.md`](../modules/inventory.md) |
| `major` | Changes the shape of a journey |
| `minor` | Changes a detail or a label |
| `confirm` | Validates a hypothesis — record these too; it is how a hypothesis becomes a decision |

**Immediately after:** settle the bar-rack card; answer §5.10 from probes 1–3 and schedule the spike on their
handsets; update every journey still marked *hypothesis*; close **#541** and re-scope **#496** onto §6.
