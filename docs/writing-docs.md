# Writing docs: the concision standard

**As-built, verified 2026-08-03.** This is the standard the whole `docs/` tree is now written to,
established by the [#634](https://github.com/debola31/Jigged/issues/634) condensation that cut the
tree down doc by doc. Each condensed doc records its own before/after in its opening line — which
is the only place a number like that belongs, next to the thing it measures.

**Most information in the fewest words, losing none of it.** The test is whether a reader gets the
same decisions and constraints in a fraction of the reading.

**The core rule: a claim no build can falsify will rot.** That is not a slogan, it is what the
audit measured. Update frequency did not predict accuracy — the two most-edited module docs both
rotted while the two least-edited stayed correct. Being edited in the same commit as the code did
not predict it either. What predicted it was whether a red build would have caught the claim being
wrong.

**What earns its tokens:** pitfalls; rationale; conventions that differ from tool defaults;
**withdrawn arguments**; measured numbers; "why not the obvious alternative"; named gaps.

**What does not:** anything derivable by reading the code — directory layouts, dependency lists,
architecture overviews, file-by-file descriptions, prose restating a function — and **counts of
anything**. Put a count next to the thing that enforces it, or do not write it. Every count in
[testing/](testing/) was wrong by 3–6× for ten weeks while `vitest.config.ts` carried the true
numbers on the same line as the enforcement.

**Form.** Decision plus a one-line why. Superseded reasoning becomes one line
(`**Withdrawn:** <claim> — wrong because <reason>`) — never deleted, never expanded, because
recording that a reason was *wrong* is what stops the next person rebuilding on it. Prose becomes
a table when the content is really rows. Say it once and link the rest. Cite migration IDs and
file paths, never test titles. Use as-built framing with a verification date. **If you are
tempted to add length, add it as a table row.**

**Cite tests as file + `describe`, with an `it` count — never a nested `describe > 'it title'`
string, and never truncated with an ellipsis.** A title is free text nothing checks; one audited
section had 15 of 23 citations dangling. Every path a doc cites must exist.

**The failure mode to hunt for**, found in five of six docs condensed by hand: **a superseded
mechanic left standing beside its replacement**, usually within 100 lines, with nothing saying the
first one is dead. Deleting the dead half is the cheapest, highest-value edit available.

**Deletion is a first-class edit.** Every doc PR should say what it removes; an add-only change
needs a reason. Context files grow by accretion and are almost never pruned — that is how the tree
got big enough to need #634 in the first place.

**Exemplars:** [modules/inventory.md](modules/inventory.md) (journey/decision),
[modules/customers.md](modules/customers.md) (reference), [modules/billing.md](modules/billing.md)
(invariant — as-built framing, a truth table, the load-bearing *why*, and an invariant named
against the CI test that enforces it).

## What a build now falsifies

Two of this standard's conventions are machine-checkable, and
[`scripts/docLinkCheck.ts`](../scripts/docLinkCheck.ts) ([#686](https://github.com/debola31/Jigged/issues/686))
checks them:

| Check | Why it exists |
|---|---|
| **Every path a doc cites exists on disk** | Deleting one file rots citations in docs nobody is editing. Commit `b6b912a` deleted the prod schema snapshot and left ten citations dangling across nine docs at once — caught by hand during a merge, which is not a process. |
| **Relative links and heading anchors resolve** | **A heading another doc links to is an interface.** `#stations-work-centers`, `#surveillance-guardrail-non-negotiable` and friends are load-bearing; renaming the heading breaks the inbound link silently. |

**Anchor slugs, the trap:** GitHub lowercases, strips punctuation except hyphen and underscore, and
replaces **each space individually** — so an em dash surrounded by spaces leaves a *double* hyphen
(`## Foo — bar` → `#foo--bar`). Collapsing the whitespace produces a wrong slug that looks right;
that bug cost real time during #634.

**Still not mechanical:** nothing checks that a doc's copy of a list still matches the code. That
gap produced the one security-boundary error the condensation found —
[modules/ai-insights.md](modules/ai-insights.md) stated a table count that disagreed with its own
list, and its `SENSITIVE_TABLES` denylist was short the entry holding customer carrier-account
numbers, against `api/tools/schema_context.py`. **Both are fixed**; the doc
records the correction as history and still names the missing guard under its Known gaps. A test
asserting a doc's lists against the frozensets is the shape that would close it, alongside the
guards this repo already runs (`function_execute_leaks()`, `tenant_tables_missing_write_gate()`,
[`scripts/schemaEmbedCheck.ts`](../scripts/schemaEmbedCheck.ts)).

**Known scope limit:** the path check reads Markdown, so a citation living in a `COMMENT ON
FUNCTION` or a pytest docstring still rots unseen — exactly [#685](https://github.com/debola31/Jigged/issues/685).
Extending it to `.sql` and `.py` comments is the natural next step; the Markdown pass is the cheap
80%.
