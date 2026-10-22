---
name: morning-digest
description: Build the owner's one-page morning digest — spend, leads, CPL, speed to lead, calls, bookings, paid, top ad, top deal, open escalations. Use once per day or when the owner asks "how did yesterday go".
---

# morning-digest: one-page daily summary

Owner: `growth-director`. Workflow: `workflows/morning-digest.ts`.

## Layout (one page, in this order)

1. **Headline line:** yesterday's spend, booked jobs, and revenue attributed.
2. **KPI row:**
   - Spend
   - Leads
   - Cost Per Lead
   - Speed to Lead (median seconds)
   - Calls
   - Bookings
   - Booked & Paid
3. **Top ad:** the variant with the best CPL. Show its numbers.
4. **Top deal:** the highest-value appointment or lead, and its source ad.
5. **Waiting on you:** the count of pending approvals, with the oldest first.
6. **Open escalations:** any interrupts still unresolved.
7. **Run cost vs revenue:** estimated software and API cost next to
   attributed revenue.

## Rules

- Every number must reconcile with the database by hand. No estimates
  presented as facts.
- Leads with no attribution are reported as **"unknown source"**. Never force
  a match.
