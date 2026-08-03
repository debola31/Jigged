# Inventory Discovery — Remote Script v1

> **Trimmed 2026-08-03** for [#634](https://github.com/debola31/Jigged/issues/634): **2,397 → 1,512 words**
> (`wc -w`).
> This is a **live instrument**, not a record. [`inventory.md`](../modules/inventory.md) §10 specifies the
> trim — *"vocabulary, bar rack, scanning, never a gate"* — so the probes its §9 already answers are gone,
> listed once below so nobody re-adds them. The companion `usability-test-script-v1.md` was a spent one-off
> and was deleted in the same pass.
>
> **This session gates nothing.** No Phase 1–3 item waits on it. Run it when Shane or Johnny has 25 minutes.

**Type:** discovery (contextual inquiry), **not** a usability test — we are not testing screens.
**Format:** video call; the facilitator is **not** on the floor. That costs direct observation, compensated by
a **pre-call photo request** and a **guided camera walkthrough** where they carry the phone. Both need setting
up in advance.
**Participants:** Shane (owner) and/or Johnny (quoter), Contour Tool & Machine.
**Facilitator:** ______________ **Date:** ______________
**Plan:** ~25 min — 10 walkthrough, 10 probes, 5 cards. *(The untrimmed v1 was 45: 15 / 25 / 5.)*

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

## Before the call

**Send the photo ask 2–3 days ahead.** It is the single biggest determinant of whether a remote session is
worth running — remote discovery without artefacts is just an interview.

> "Before we talk, could you send me photos of everywhere material is kept — racks, shelves, cabinets, the
> floor, outside, wherever it actually ends up? Phone snaps are perfect, no tidying."

Also ask **"can you walk around with your phone during the call, or should we stay at the desk?"** and have
both versions of Part 1 ready.

- [ ] **Storage-type palette** open to screen-share: `/dashboard/{companyId}/inventory/locations` → **Build
      visually** → step 1 only, creating nothing. Confirm `inventory_locations` is enabled for that company or
      the palette will not load. Save screenshots of the seven cards as a fallback.
- [ ] **Ask permission to record.** On a remote call the recording *is* your field notes — you cannot scribble
      and drive at once.

**Ground rules.** Ask them to *show*, not describe: *"can you point the camera at it?"* is the remote
equivalent of walking over. Never correct them, never demo the product, never explain what Jigged *will* do;
drop any question that feels leading. Remote costs you peripheral vision, so ask **"what else is out of
frame?"** at every stop and treat their photo set, not the call, as the record of how many places exist.

## Part 1 — Camera walkthrough (10 min)

> "Could you carry me around on your phone and show me everywhere material lives?"

You are listening, not photographing. **Note what they *call* each place in their own words — that word
outranks anything in our palette.**

| Record | Why |
|---|---|
| **Their name for each place** | "The bar rack", "the shelf by the saw", "out back". Names that are spatial and informal mean a code scheme like `CAB1-R03-L` will never be used |
| **Is anything labelled today?** | Existing labels = they already believe in this. None = we are asking for a new habit |
| **A bar rack — is there one?** | The defining storage object in a machine shop, and our palette has no card for it. Their 22 exported places (`STOCK`, `SHELF`, `YARD`, `CABINET 3-10`) hold none, so it is **weakly refuted** — but they buy in feet. Shipped without the card; reasoning is in a `storageTypes.tsx` comment |
| **Floor / corner / outside?** | The palette has no card for either. Ask directly — this is exactly what a camera misses |
| **Where do drops and offcuts go?** | J8. Dedicated remnant rack vs "back on the shelf" vs the scrap bin |

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
3. **Whose phones.** *"Whose phones would be used, and what are they?"* The §5.10 scanner spike must run on
   the real handsets, not a simulator. Personal phones are already the decided auth model.
4. **Label durability.** *"If you stuck a paper label on the end of that bar rack, what does it look like in
   a month? Where on each piece of storage would one survive?"* Decides label material, not the data model.
   A plastic sleeve is the cheap known answer; some spots may need a plate or engraved tag.
5. **Vocabulary check.** What do `ZAPP`, `SMD`, `SBS`, `DB BOX` and `0-5` mean? (One card sort.) And, carried
   over unasked from the 2026-03 script: *"What do you think 'Adjust' does versus 'Add' or 'Remove'?"*
6. **Wrap.** *"What's the one thing about material that costs you the most time or money right now?"* and
   *"Is there anything I should have asked and didn't?"*

## Part 3 — Storage-type card check (5 min)

PR #419 promised to *"usability-test the storage-type icon set with Johnny/Shane and lock it"* and never ran.
Screen-share the real palette (fall back to the saved screenshots). Ask them to **read the cards aloud** — on
a shared screen their narration is the only signal you get about which cards register.

**Forward:** show the seven cards — Cabinet, Shelving unit, Pallet rack, Drawer unit, Single shelf, Bins,
Aisle / zone. For each: *"Do you have one of these? What do you call it?"*

**Reverse:** share **their own pre-call photos** back, one at a time: *"which of these cards is this?"* Using
their photos rather than your description is what makes this pass work remotely — it removes your vocabulary
from the question entirely. Record every photo with **no good card**; watch for the bar rack, *floor*,
*outside* and *under the bench*.

**Output:** a keep / cut / rename list plus the missing types.

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
