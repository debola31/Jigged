# Privacy policy v2: draft wording for showcase pilot requests

**Status: draft, not shipped, 2026-11-04.** Nothing under `public/legal/` or in
`public/legal/manifest.json` was touched. This is wording for review. Shipping it means
publishing it as a new version under [legal-acceptance.md](../modules/legal-acceptance.md)
§2: a new `privacy/v2.html` and a new manifest entry. v1 is frozen and stays readable.

## Does v1 cover the pilot request? No

The showcase form takes a part file plus an email (and, optionally, a name, company and note)
from **people without an account**, and uses them to make a walkthrough. Read against v1
(`public/legal/privacy/v1.html`, effective 2026-06-20):

| v1 says | Gap for a pilot request |
|---|---|
| §1 collects "names, phone numbers, email addresses, usernames, passwords" when you register or "express an interest" | Name and email are arguably covered. Company name, a free-text note and **an uploaded file** are not. |
| Its service description mentions "file attachments such as engineering drawings" | That describes shop data that **account holders** enter in their company workspace. It does not cover a file sent by a visitor to get a demo. |
| §2 purposes: accounts, support, feedback, improving services and marketing | It has no purpose like "make the walkthrough you asked for", and nothing limits the file to that one use. **The form promises exactly that limit.** |
| §7: "No purpose … will require us keeping your personal information for longer than … users have an account" | A visitor has no account, so retention is undefined. The form promises deletion on request. |
| §3 shares only for "Business Transfers"; Supabase, Vercel and Sentry are named only in the service description | The request passes through **Resend** (the team's notification email) and lands in the team mailbox. Neither is named. *(Already a gap before this feature: **PostHog** isn't named either.)* |
| §12 table: category I, "Business contact details …", marked **NO** | Company name, given alongside a business email, is a business contact detail. |
| §14 and the rights sections give the contact email | **The addresses don't work as served.** The Termly export carries Cloudflare email-protection links (`/cdn-cgi/l/email-protection#…`). Nothing in this repo decodes them, and Vercel serves no such path. The page most likely shows "[email protected]". Phone and post still work. That matters here because deletion on request is one of the form's three promises. |

## Proposed v2 wording

These are insertions into the Termly document at the sections named. Termly regenerates the
export, so the intended route is: add these through Termly, re-export, then ship.
**`[DECISION: …]`** marks a fact only you can confirm. Each one is a claim the policy would make
on your behalf.

### §1, a new subsection after "Personal information you disclose to us"

> **Part files and details you send for a walkthrough.** If you ask us for a walkthrough of one
> of your parts from our showcase page, you do not need an account. We collect your email
> address and, only if you choose to give them, your name, your company's name and a note about
> the part. We also collect the part file you upload (a CAD model such as a STEP, IGES,
> Parasolid or SolidWorks file, or a PDF drawing) and its file name. To stop the form being
> abused, we record a one-way, keyed hash of your IP address. We do not store the address
> itself.

### §2, a new purpose

> **To prepare the walkthrough you asked for.** We use a part file you send only to plan and
> render a walkthrough of that part for you. We use your contact details to send you the
> walkthrough and to ask whether a pilot of Jigged would be useful to your shop. Only the Jigged
> team opens your file. We do not share it with anyone except the service providers below that
> store and send it for us. We do not use it for any other purpose.

- `[DECISION: does the planning or rendering send the file, or anything derived from it, to any
  AI or other third-party service? If yes, name it here, and "only the Jigged team opens your
  file" needs qualifying, both here and on the form.]`
- `[DECISION: is the walkthrough at a private link sent only to them, or could it appear on the
  public showcase? If it could be public, that needs their separate consent. The form doesn't
  ask for it, and the sentence "we do not use it for any other purpose" would be false.]`

### §3, a new item

> **Service providers.** We share information with companies that process it for us under
> contract: Supabase (database and file storage), Vercel (website hosting), Resend (sending
> email), Sentry (error monitoring) and PostHog (product analytics). When you request a
> walkthrough, your file is stored only with Supabase. Your contact details and note are also
> emailed to our team through Resend.

`[DECISION: name the team mailbox's provider too (e.g. Google Workspace), since the
notification lands there.]`

### §7, a new paragraph

> **Walkthrough requests.** We keep a part file you send, and the details you sent with it,
> until you ask us to delete them `[DECISION: "or for 12 months after your request if you have
> not become a customer, whichever is sooner" — an automatic limit is better practice, but
> nothing enforces one today]`. Ask at any time by replying to any email from us, or by using
> the contact details in section 14. We will delete the file and your request `[DECISION:
> "within 30 days"]`. Copies in our backups expire on their normal schedule.

The backup sentence is there because a hard delete doesn't reach Supabase's backups straight
away. "Deleted when you ask" stays true for the live system only, and the policy should say so.

### §12, the categories table

- Category **I** (professional or employment-related information): change to **YES**, giving
  business contact details (company name) as the example.
- In the retention list under the table, add: "For a walkthrough request: as described in
  section 7."

### §14, and every contact email in the document

Re-export with the email addresses as plain `mailto:` links, not Cloudflare-protected ones (see
the last row of the table above).

## Shipping notes

- **`requires_reacceptance: false`** is the recommendation. The change adds a collection
  from people *without* accounts and names existing processors. It doesn't reduce what account
  holders were promised, and a blocking re-acceptance modal for every user would be the wrong
  cost. Your call.
- **Ship v2 before or with the form going live.** The form links to `/privacy`, which serves the
  current version, so until v2 ships that link leads to text that doesn't describe what the
  form does.
- The form's own promise, verbatim, so the policy can match it: *"Only the Jigged team opens
  your file. We use it only to make your walkthrough, and we delete it whenever you ask."*
  (`app/(marketing)/showcase/_components/PilotRequest.tsx`).
