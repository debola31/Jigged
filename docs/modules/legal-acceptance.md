# Legal acceptance (clickwrap)

Proving that a specific person agreed to a specific document, at a specific
time, from a specific address — and being able to produce that document years
later.

Before this, Jigged had **browsewrap**: passive footer links under every auth
card ([AuthLayout.tsx](../../components/auth/AuthLayout.tsx)) and prose *below*
the submit button on a dormant form. Nobody affirmatively agreed, nothing was
recorded, and neither document carried a version.

---

## 1. Where consent is actually captured

There are four ways an account comes into being, and **two of them show no form
at all**. That is why the login-time gate is the primary mechanism rather than a
safety net.

| Path | Where | Consent captured |
|---|---|---|
| Admin invites a team member | [accept-invite](../../app/accept-invite/[invitationId]/page.tsx) | **Checkbox on the form.** The live signup in this product |
| System admin creates a company + owner | [admin_routes.py](../../api/routes/admin_routes.py) | Lands on accept-invite |
| Operator provisioned by an admin | [operators_routes.py](../../api/routes/operators_routes.py) | **No form exists** — an admin types their password. Gate only |
| Self-serve signup | [SignUp.tsx](../../components/auth/SignUp.tsx) | Checkbox gates submit, **records nothing** — see below |

**`app/signup/page.tsx` redirects to `/login`.** `SignUp.tsx` is orphaned. Its
checkbox is there so the screen is correct if revived, and it records nothing on
purpose: at `auth.signUp` there is no session, so the only way to write an
acceptance would be an unauthenticated endpoint keyed on a returned user id — a
forgeable legal record, which is precisely what §3 exists to prevent.

## 2. The documents

Both live under `public/legal/`, versioned, with a SHA-256 committed in
`public/legal/manifest.json` and recomputed from the bytes on every CI run by
[`scripts/legalDocumentsCheck.ts`](../../scripts/legalDocumentsCheck.ts).

- **`version` is a monotonic integer**, not semver and not a date. Total order,
  no parser, and no `"1.10" < "1.9"`.
- **`effective_date` lives inside the document body too**, and the guard asserts
  the two agree — so the page cannot state a date the contract does not.
- **`enforcement_starts_on`** is the operator grace clock's floor. Distinct from
  `effective_date`, which for an imported document may already be past — and a
  past date would put every operator instantly beyond the 14-day cap.
- **`requires_reacceptance`** exists because the Termly privacy export
  regenerates on Termly's cadence, not ours. A sub-processor-list refresh must
  not push the whole customer base through a blocking modal. Defaults `true`.

**A shipped version is frozen.** Editing means publishing a new version, and no
version file is ever deleted — a `document_sha256` you cannot produce bytes for
is an assertion you cannot substantiate. Every published version stays readable
at `/terms/v1`, and its raw bytes at `/legal/tos/v1.html`.

> **The freeze guard is a PR-time control.** Tier 2 compares against the pull
> request's base ref; on a direct push to `main` there is nothing to compare
> against and it skips with a warning. `main` is not branch-protected, so the
> freeze rests on the PR workflow being used at all.

**The ToS is a Common Paper Cover Page** that incorporates the Common Paper Cloud
Service Agreement **Standard Terms v2.1** by reference. That reference is
version-pinned, and a copy is archived at
[`docs/legal-archive/`](../legal-archive/common-paper-cloud-service-agreement-v2.1.html)
so the *complete* agreement stays producible if that third-party site changes.
It is kept outside `public/` deliberately: the page carries 12 external
`<script src>` and 31 `<link href>` references, and serving it from our own
domain would pull third-party assets onto a `jigged.app` URL.

The five markup repairs applied to the vendor's export — and the machine-checked
proof that none of them changed a word — are in
[tos-v1-export-repairs.md](../legal-archive/tos-v1-export-repairs.md).

## 3. The record

`terms_acceptances` is **append-only and service-role-write only**. The browser
may `SELECT` its own rows and nothing else.

An audit trail the browser can `INSERT` into is one the browser can forge, and
the entire evidentiary value of this table is that it could not have been
produced by the party it is evidence against. So:

- No `INSERT` grant or policy for `anon`/`authenticated`.
- `service_role` gets `SELECT, INSERT` — **not `ALL`**, since every backend path
  runs as it.
- Two triggers make append-only true even against a role that holds the grants:
  one `BEFORE UPDATE OR DELETE` row trigger, and a **second statement-level
  `BEFORE TRUNCATE`** one, because row triggers do not fire on `TRUNCATE`.

> **The default-privilege trap.** `20260716025048` revoked only the DML half of
> the permissive Data API default. A brand-new public table still arrives with
> `anon=Dxtm`, `authenticated=Dxtm` and `service_role=Dxtm` — TRUNCATE,
> REFERENCES, TRIGGER, MAINTAIN. TRUNCATE is the dangerous one: it bypasses RLS
> **and** does not fire row triggers, so a browser role holding it could empty
> the whole record in one statement. `CLAUDE.md`'s "do not REVOKE down from ALL"
> holds for INSERT/UPDATE/DELETE and is **misleading for these four**. Revoke
> explicitly. This was caught by `terms_acceptance_write_leaks()` on its first
> run against a replayed database.

The SELECT policy keys on `user_id = auth.uid()`, **not** on company membership —
the only non-company-scoped policy in this schema. Assent is personal (a signup
row has no company at all), and a colleague has no business reading someone's IP
address and browser string. A compliance export is a service-role report.

`company_id` is nullable and is **context, not a scope key**. No policy reads it.

There is deliberately **no `UNIQUE (user_id, document_type, version)`**: every
tick is a separate act of assent with its own time and address, collapsing two
destroys evidence, and a UNIQUE would turn a benign double-submit into a `23505`
mid-signup. This is the opposite call from `note_views` — do not tidy it up.

## 4. The write path

[`app/legal/accept/route.ts`](../../app/legal/accept/route.ts) is the only writer.
A Next Route Handler rather than FastAPI — see
[architecture.md §8.1](../architecture.md#81-when-to-use-fastapi-backend).

What the client may influence, exhaustively: which documents, which surface, a
company id the server then verifies against `user_company_access`, and the
versions it believes it displayed. **There is no parameter for version, hash, IP,
user agent or timestamp** — the strongest form of "do not trust a client-supplied
version" is to have nowhere to put one.

- **IP** comes from `x-real-ip`, else the `X-Forwarded-For` entry counted from
  the **right**. Leftmost is correct only if the terminating proxy *replaces* the
  header; if it appends, leftmost is whatever the caller typed. Absent headers
  store `NULL` with `ip_source = 'unavailable'` — **never a sentinel**, because
  `0.0.0.0` would be a fabricated fact inside a legal record.
- **A stale tab gets 409**, never a silent upgrade. Recording a tick against text
  the user never saw is the failure this whole feature exists to prevent.
- **Same-origin is asserted.** There is no `middleware.ts` and Next's
  Server-Action origin check does not cover Route Handlers, so `SameSite=Lax`
  would otherwise be the only thing between a third-party page and a silently
  recorded acceptance.

## 5. The gate

[`TermsGate`](../../components/legal/TermsGate.tsx) is mounted **once**, in
`app/layout.tsx` inside `AuthProvider` — a system-admin-created owner passes
through `/`, `/launch` and `/select-company` before reaching `AuthGuard`.

| Surface | Behaviour |
|---|---|
| `/dashboard`, `/admin` | **Blocking.** The contract binds the shop, and the shop is bound by its admin's acceptance |
| Everything else, incl. `/operator` | **Deferrable** — "Remind me later", capped at **14 days or 5 dismissals** |

The default direction is deliberate: keying on `/operator/` alone would
hard-block an operator on `/launch`, `/select-company`, `/no-access` and the scan
stubs, which is the mid-shift interruption the deferral exists to prevent.

**The dismissal count is never rendered.** Across every deferral the operator
sees the same screen and the same button; the only visible change is the escape
hatch disappearing at the end. A disappearing affordance is not a read-back of
behaviour, and a number would be — see
[operator-view.md](operator-view.md#surveillance-guardrail-non-negotiable). It is
also deliberately **not** routed through `operator_events`.

The 14-day deadline counts from the **earlier** of the manifest's
`enforcement_starts_on` and the device's first prompt, so clearing browser
storage cannot hand someone a fresh window indefinitely. The 5-dismissal budget
is a courtesy and lives in `localStorage`; clearing it buys five more taps inside
a window the date has already closed.

### Failing in the right direction

The status is three-state — `loading | unknown | resolved` — and never a boolean.
`unknown` is a distinct answer from "compliant", and the two surfaces resolve it
**oppositely, on purpose**:

- **On the gate**, unknown renders *nothing*. There is nothing the user needs
  from this check, so proceeding is right and the next navigation retries free.
  "Couldn't check" is never "denied".
- **On accept-invite**, unknown *shows* the checkbox. An extra row in an
  append-only table costs nothing; a missing one costs the record.

### No backfill

Every user who existed before this shipped has zero acceptance rows, and that is
**not** papered over. You cannot manufacture assent, and a row asserting an
affirmative act that never happened is exactly the weakness this feature removes
— worse in discovery than an absent record. So everyone meets the prompt once, at
their next login, and accepts through the same path as everyone else.

## 6. Acceptance criteria

| File | `describe` | Count |
|---|---|---|
| [`__tests__/standards/legalDocuments.test.ts`](../../__tests__/standards/legalDocuments.test.ts) | *the repo is clean*, *Tier 1 catches real breakage*, *export repairs are markup only* | 23 |
| [`__tests__/app/legal/acceptRoute.test.ts`](../../__tests__/app/legal/acceptRoute.test.ts) | *the client cannot supply the IP*, *refusals* | 13 |
| [`__tests__/lib/clientIp.test.ts`](../../__tests__/lib/clientIp.test.ts) | *source preference*, *absent or hostile input* | 17 |
| [`__tests__/lib/termsGate.test.ts`](../../__tests__/lib/termsGate.test.ts) | *routes the prompt must never cover*, *the cap* | 15 |
| [`__tests__/utils/termsAccess.test.ts`](../../__tests__/utils/termsAccess.test.ts) | *who still has to accept* | 8 |
| [`__tests__/components/legal/TermsGate.test.tsx`](../../__tests__/components/legal/TermsGate.test.tsx) | *when it blocks*, *the operator surface* | 12 |
| [`api/tests/integration/test_terms_acceptances_rls.py`](../../api/tests/integration/test_terms_acceptances_rls.py) | RLS, append-only, cross-user isolation | 12 |
| [`e2e/terms-acceptance.spec.ts`](../../e2e/terms-acceptance.spec.ts) | the whole chain, once, for real | 1 |
