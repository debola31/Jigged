# Terms of Service v1 — repairs to the Common Paper export

Every byte-level difference between Common Paper's export and the frozen
`public/legal/tos/v1.html`. **All five are markup repairs. Not one word of the
contract changed** — a claim this file does not merely assert, see *Verification*.

| | sha256 | bytes |
|---|---|---|
| Export, as extracted | `27ab3b5750300a2dca54b2990d1449cda38abbb35144271e15c15d4ae0596c24` | 4,898 |
| Frozen v1 | `26824e1103f9b8178e402f3417edf35e2be88151f86b29f48b9f321af1a2ca44` | 4,806 |

**Provenance.** `Jigged Common Paper TOS - 08182026 - HTML.docx`, whose document
*body is HTML markup*. Extracted by concatenating the `<w:t>` runs of
`word/document.xml` per `<w:p>`, with `<w:br/>` as a newline. The extraction is
archived verbatim at
[`docs/legal-archive/jigged-tos-v1-common-paper-export.raw.html`](jigged-tos-v1-common-paper-export.raw.html),
so every row below can be re-derived:

```bash
diff docs/legal-archive/jigged-tos-v1-common-paper-export.raw.html public/legal/tos/v1.html
```

---

## The five repairs

**1 — Drafting note removed** (line 9). A Common Paper instruction to the
drafter, not contract text, and it would have been served to every reader.

```diff
-<p> <!-- Note: Check to confirm this paragraph works for your company and
-    where your customers are located. -->If you are accessing or using…
+<p> If you are accessing or using…
```

**2 — Typographic quotes in the Standard Terms `href`** (line 15). Word had
smart-quoted the attribute delimiters, so the anchor was invalid and the link to
the incorporated Standard Terms was **not clickable**.

```diff
-<a href=”https://commonpaper.com/standards/cloud-service-agreement/2.1/”>
+<a href="https://commonpaper.com/standards/cloud-service-agreement/2.1/">
```

**3 — Markdown link syntax in an HTML document** (line 24, *Cloud Service Fees*).
Would have rendered as the literal text `[pricing page](https://…)`. The Fees
clause defines Fees by reference to that page, so it has to resolve.

```diff
-…available at Provider’s [pricing page](https://jigged.app/pricing).
+…available at Provider’s <a href="https://jigged.app/pricing">pricing page</a>.
```

**4 and 5 — Two amendments sharing one `<p>`** (lines 63–65, *Changes to the
Standard Terms*). *Data Rights* and *Support* were separated only by a blank
line, which HTML collapses to a space — they would have rendered as one run-on
paragraph. Closing and reopening the element is repair 4; repair 5 is the
sentence-final period the export was missing after "guaranteed".

```diff
-<p>Data Rights. …emailing hello@jigged.app.
-
-Support. Provider will…no specific response or resolution times are guaranteed</p>
+<p>Data Rights. …emailing hello@jigged.app.</p>
+
+<p>Support. Provider will…no specific response or resolution times are guaranteed.</p>
```

---

## Verification

`scripts/legalDocumentsCheck.ts` re-checks all of this on every CI run, so the
claim above cannot rot into a comfortable fiction:

| Check | Asserts |
|---|---|
| `export-hash-mismatch` | The archived export still hashes to the value in this table |
| `export-prose-differs` | The export and frozen v1 contain the **identical sequence of 658 words**, and the identical set of URLs. This is the load-bearing check: it is what makes "markup only, never a word" a verified fact rather than a sentence in a PR description |
| `export-repair-count-wrong` | The two files differ in exactly the **5** places recorded in `public/legal/manifest.json` — so a sixth, undocumented edit fails the build |

The word comparison is punctuation- and markup-insensitive by design: it
collapses a markdown link to its label text and strips tags, so repair 3 — which moves a
URL out of prose and into an attribute — is correctly seen as no change to the
words. URLs are therefore compared separately, so a repair cannot quietly
retarget a link.

**A published version is frozen.** Correcting anything here means publishing v2,
never editing v1 — `terms_acceptances` rows point at the hash above, and a hash
whose bytes cannot be produced is an assertion that cannot be substantiated.

## The incorporated Standard Terms

This document is a Cover Page. It incorporates the **Common Paper Cloud Service
Agreement Standard Terms v2.1** by reference, which lives on a third party's
site. A copy is archived at
[`common-paper-cloud-service-agreement-v2.1.html`](common-paper-cloud-service-agreement-v2.1.html)
— retrieved 2026-08-18 from the canonical URL, hashed in the manifest, and
frozen by the same guard — so the *complete* agreement stays producible if that
site changes or disappears. It is kept outside `public/` deliberately: the page
carries 12 external `<script src>` and 31 `<link href>` references, and serving
it from our own domain would pull third-party assets on a page loaded from
`jigged.app`. The ToS's own link still points at Common Paper's canonical URL,
which is the authoritative reference in the contract; the archive is for
producibility, not substitution.
