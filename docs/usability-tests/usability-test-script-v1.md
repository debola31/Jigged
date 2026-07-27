# Jigged Usability Test Script v1

**Participant:** Johnny (Salesperson, Contour Tool & Machine)
**Facilitator:** Debola
**Date:** _______________
**Duration:** ~50 minutes

---

## Session Setup (5 min)

### Opening Script

> "Thanks for taking the time, Johnny. I'm not testing you — I'm testing the software. There are no wrong answers. If something is confusing or doesn't make sense, that's exactly what I need to hear. I'm going to ask you to try a few things and I'd love for you to think out loud as you go — tell me what you're looking for, what you expect to happen, and if anything surprises you."

### Rules for Debola

- Don't help unless Johnny is completely stuck for 30+ seconds
- Don't explain how something works — if he can't figure it out, that's a finding
- Write down every moment of hesitation, confusion, or wrong click
- When he pauses, ask: **"What are you looking for?"** and **"What did you expect to happen?"**
- Note the exact time of each observation for cross-referencing later

---

## First Impression (1-2 min)

Log Johnny into the app and land him on the dashboard. Say nothing for 30 seconds, then:

> "Take a look around and tell me what you see."

### What to observe

- Where do his eyes go first? What does he click or hover over?
- What does he call things? (Does he say "sidebar," "menu," something else?)
- Does he notice the navigation items? Which ones does he read aloud or comment on?
- Does the dark theme register as professional or unusual?
- Does he try to click anything unprompted?

> **Observer reference:** Sidebar order is Dashboard, Quotes, Jobs, Operations, Inventory, Parts, Customers, Team, Settings. Header shows page title and welcome message. Dark theme throughout.

### Follow-up

> "If you had to guess, what do you think each of those menu items does?"

---

## Task Scenarios (30-35 min)

---

### Task 1: New Customer + Full Quoting Flow (~10 min)

#### Say to Johnny

> "A new customer just called — Alpine Toolshop. They need a quote for 50 custom aluminum brackets. Can you get that set up?"

#### What to observe

**Critical — navigation entry point:**
- Does Johnny go to **Customers** first to create Alpine Toolshop, or does he go straight to **Quotes**?
- This reveals whether his mental model is "set up the customer, then quote" or "start the quote, add the customer along the way."

**Customer creation path:**
- If he goes to Customers first: watch him use the `/customers/new` form (company name is the only required field). Then observe how he navigates to Quotes afterward.
- If he goes to Quotes first: watch whether he discovers the **"+ Create New Customer"** option inside the customer autocomplete dropdown on the quote form. Does he notice it? Does he hesitate?

**Quote form (`/quotes/new`):**
- Does the customer autocomplete make sense? Can he find Alpine Toolshop (or create it inline)?
- Part selection: does he pick an existing part or try to create one? Does he notice the **"+ Create New Part"** option in the part dropdown?
- **Pricing section:** Does he understand the Unit Price, Quantity, and Total fields? Does the **cost source chip** ("Part Routing" / "Manual Estimate" / "Estimate") make sense or cause confusion?
- If the part has a routing: does he click the cost source chip to see the **cost breakdown modal** (labor table + materials table with subtotals)? Does the breakdown make sense to him?
- If the part has no routing: does he know what to enter for Unit Price? Does the empty cost state confuse him?

**After saving:**
- Does he understand the quote lands as a **Draft**?
- Can he find and click **"Send for Approval"** on the quote detail page?
- Does the status change to "Pending Approval" register?

#### Follow-up questions

- "How did you decide where to start?"
- "What do you think 'cost source' means on that quote?"
- "If you needed to change the price, where would you go?"

---

### Task 2: Parts Management (~5 min)

#### Say to Johnny

> "Can you find the part you just used in that quote and check what we know about it? Then I'd like you to add a brand new part to the system — a stainless steel bushing, part number SS-BUSH-001."

#### What to observe

**Finding a part:**
- Does he use the **search bar** on the parts list, or scroll/browse?
- Does the AG Grid table make sense? Can he identify the columns (Part Number, Description, Category, Routing checkmark, Cost)?

**Part detail page (`/parts/[partId]`):**
- Does he notice the **Cost Information card** with the cost breakdown accordion (labor + materials)?
- Does the **Routing card** make sense? Does he understand what "Edit Routing" or "Create Routing" means?
- Does the **Related card** (quotes count, jobs count) register?

**Creating a new part (`/parts/new`):**
- Can he find the "New Part" button on the parts list toolbar?
- Does he fill in part number and description without confusion?
- Does the **Category dropdown** make sense? Does the helper text ("categories set default markup for quoting") clarify or confuse?
- Does he try to set a **Manual Cost**? Does the cost field label make sense?

#### Follow-up questions

- "What's the difference between the cost on this page and the price on a quote?"
- "If you wanted to see how this part gets made step by step, where would you look?"

---

### Task 3: Job Tracking (~5 min)

#### Say to Johnny

> "Good news — that Alpine Toolshop quote got approved. Can you turn it into a job and get it moving?"

#### What to observe

**Finding the quote:**
- Does he navigate back to the quotes list? Does he use the **status filter** to find approved quotes?
- Can he find Alpine Toolshop's quote in the list?

**Converting to job:**
- Does he find the **"Convert to Job"** button on the approved quote's detail page?
- The **ConvertToJobModal** checks if the part has a routing. Does the modal message make sense (routing found vs. routing missing)?
- If routing is missing: does the warning with the "Create Routing" link make sense?
- After conversion: does he notice the redirect to the **job detail page**?

**Job detail and status:**
- Can he tell the job is in **Pending** status?
- Does he find and click the **"Start Job"** button?
- Does the **timeline card** (Created, Started, Completed, Shipped) make sense?
- Does the **operations panel** (list of routing operations with status) register?

**Jobs list glance test:**
- Navigate to the jobs list. Ask: *"Can you tell me what stage each of these jobs is in?"*
- Watch whether the **status chips** (color-coded) and **Current Op column** give him enough information at a glance.

#### Follow-up questions

- "If a job was on hold, how would you know? How would you get it moving again?"
- "What does the QR code on the job page do, in your opinion?"

---

### Task 4: Inventory (~5 min)

#### Say to Johnny

> "Before that job kicks off, can you check if we have enough aluminum bar stock on hand? And then add 20 units to our supply."

#### What to observe

**Finding inventory:**
- Does he go to **Inventory** in the sidebar without hesitation?
- Can he use the **search bar** to find aluminum bar stock?
- Does the list grid make sense? Does the **Quantity column** give him the answer quickly?

**Item detail (`/inventory/[itemId]`):**
- Does the large **"Current Stock"** display register immediately?
- Does the **cost per unit** in the details card make sense?

**Adding stock:**
- Does he find the **"Add Stock"** button (green, with + icon)?
- In the **transaction modal**: does he understand the quantity field, unit selector, and notes field?
- Does the **"New Quantity" preview** at the bottom make sense?
- Does the **unit dropdown** (primary unit, standard conversions, custom conversions) confuse him or is it clear?
- After confirming: does the stock number update? Does he notice the transaction in the **history table**?

#### Follow-up questions

- "If you needed to record that you used some material on a job, how would you do that?"
- "What do you think 'Adjust' does versus 'Add' or 'Remove'?"

---

### Task 5: Quote Approval Flow (~5 min)

#### Say to Johnny

> "Let's say Shane needs to review a quote before it goes to the customer. Can you walk me through how that would work?"

#### What to observe

**Understanding the workflow:**
- Can Johnny articulate the flow (Draft → Send for Approval → Pending → Approve/Reject) without help?
- Does he navigate to a draft quote and find **"Send for Approval"**?

**Approval side (Shane's perspective):**
- On a pending quote: does he notice the **Approve** and **Reject** buttons?
- Does the **inline markup editor** make sense? (Only visible in Pending Approval status — lets the approver adjust markup % with live unit price recalculation.)
- Does bidirectional editing (change markup → price updates, or change price → markup updates) make sense or cause confusion?

**Status chips:**
- Do the color-coded status chips (Draft=gray, Pending=orange, Approved=green, Rejected=red) communicate clearly?
- Can he tell at a glance on the quotes list which quotes need attention?

#### Follow-up questions

- "If Shane rejected a quote, what would you do next?"
- "Is there anything missing from this approval process that you'd need in real life?"

---

### Task 6: Operator View — Mobile (if time, ~5 min)

#### Say to Johnny

> "Last thing — imagine you're out on the shop floor with your phone. Can you pull up Jigged and try to start working on a job?"

*Give Johnny the operator login URL on his phone.*

#### What to observe

**Login:**
- Can he log in on the mobile form without trouble?
- Is the text large enough? Are the touch targets comfortable?

**Station selection:**
- Does the **station selector** make sense? Does he understand he needs to pick a workstation before seeing jobs?
- Does the orange station indicator in the top bar register?

**Working a job:**
- Can he find a job in the list and tap into it?
- Does the **"Start Work"** button (large, green) make sense?
- Does the **live timer** register? Does he understand he's "on the clock"?
- Can he find **"Mark Complete"** when done?
- In the **completion modal**: does the elapsed time display, pre-filled materials list, and notes field make sense?

**General mobile feel:**
- Does the bottom navigation (Jobs / Profile tabs) feel natural?
- Any squinting, mis-taps, or frustration with element sizes?
- Does the dark theme work under the shop's lighting?

#### Follow-up questions

- "Would you actually use this on the floor, or would you rather use a tablet or computer?"
- "Anything too small or hard to tap?"

---

## Post-Task Interview (10 min)

Ask these questions in order. Let Johnny talk — don't cut him off or correct him.

1. **"What was the most confusing part of what you just did?"**

2. **"If you had to do quoting in Jigged vs. however you do it today, which would be faster? What's missing?"**

3. **"Is there anything you expected to be able to do that you couldn't?"**

4. **"What would make you actually want to use this every day?"**

5. **"If Shane asked you whether the shop should switch to Jigged, what would you tell him?"**

---

## Findings Template

Fill this in during and after the session. One row per distinct observation.

| # | Task | What Happened | Severity | Notes |
|---|------|---------------|----------|-------|
| 1 | First Impression | | | |
| 2 | First Impression | | | |
| 3 | Task 1: Customer + Quote | | | |
| 4 | Task 1: Customer + Quote | | | |
| 5 | Task 1: Customer + Quote | | | |
| 6 | Task 2: Parts | | | |
| 7 | Task 2: Parts | | | |
| 8 | Task 3: Jobs | | | |
| 9 | Task 3: Jobs | | | |
| 10 | Task 4: Inventory | | | |
| 11 | Task 4: Inventory | | | |
| 12 | Task 5: Approval Flow | | | |
| 13 | Task 5: Approval Flow | | | |
| 14 | Task 6: Operator View | | | |
| 15 | Task 6: Operator View | | | |
| | | | | |
| | | | | |
| | | | | |

**Severity guide:**
- **Critical** — Johnny couldn't complete the task, or completed it incorrectly without realizing
- **Major** — Johnny completed the task but with significant confusion, wrong turns, or frustration
- **Minor** — Brief hesitation or a comment about something being unclear, but recovered quickly

---

## Session Notes

**Key quotes from Johnny:**

1. _______________________________________________________________
2. _______________________________________________________________
3. _______________________________________________________________
4. _______________________________________________________________
5. _______________________________________________________________

**Top 3 findings (fill in after session):**

1. _________________________________________________________________
2. _________________________________________________________________
3. _________________________________________________________________

**Immediate action items:**

- [ ] _________________________________________________________________
- [ ] _________________________________________________________________
- [ ] _________________________________________________________________
