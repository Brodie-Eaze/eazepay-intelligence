# Eaze Intelligence — voice + copy reference

One page. Read it before you write any UI string.

## Voice in one line

Precise, calm, technical-but-human. Stripe meets Linear. We're talking
to operators and analysts, not consumers — they're literate, busy, and
they don't need to be flattered.

## Principles

1. **Direct.** State the thing. No throat-clearing.
   - "Export ready" not "Your export has been generated"
   - "12 customers added this week" not "Your business is growing"
2. **Calm.** No exclamations. No "Awesome!". No emojis in UI.
3. **Specific.** Numbers, IDs, time windows. Never vague.
4. **Active voice.** Subject-verb-object. "Lender returned 422" not
   "A 422 was returned by the lender."
5. **Sentence case for titles.** Even page titles. "Data exports", not
   "Data Exports". The only exceptions are acronyms (MFA, API, MiCamp,
   HighSale) and proper nouns.
6. **No "please".** Don't beg. Instructions are instructions:
   "Enter the 6-digit code" not "Please enter the 6-digit code".
7. **Numerals when functional.** "12 rows", "7 days", "5 minutes" —
   not "twelve rows". Spell out numbers only when they're not data
   ("one pane of glass").
8. **Brand:** first reference per page is "Eaze Intelligence", then
   "Eaze". On the marketing/login surface only, "EazePay Intelligence"
   is the legacy lockup and stays.

## Microcopy rules

- **Buttons:** verb-first, sentence case, no trailing punctuation.
  - "Save schedule", "Issue token", "Revoke", "Run now".
- **Loading states:** `Loading…` (one word + ellipsis). For specific
  in-flight verbs use `Saving…`, `Queueing…`, `Sending…`, `Verifying…`.
- **Empty states:** state the fact, then (only if useful) tell the
  operator the smallest next action. "No tokens yet." (period). If you
  add a CTA, lead with the verb: "Issue one to get started."
- **Errors:** lead with the failure, then the recovery if any.
  - Good: "Couldn't load reconciliation. Retry."
  - Bad: "Oops! Something went wrong while we were trying to load…"
- **Toasts / inline confirmations:** past tense, terse.
  - "Token revoked." / "Schedule saved." / "Invitation sent."
- **Destructive confirms:** state the irreversible thing in one
  sentence + the consequence. No "Are you sure?".
  - "Revoke token. Calls using it start failing immediately."
- **Time:** `12s ago`, `3m ago`, `4h ago`, `Feb 12`. UTC only in raw
  timestamps where the operator needs an exact value.
- **Money:** always with currency code or symbol. "A$1,200", not "1200".

## Reusable strings

Use `apps/web/src/lib/strings.ts`. Don't inline a button label that
appears in three places.

## Before / after — drawn from the app

| Before                                                     | After                                                       | Why                                                 |
| ---------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------- |
| Welcome back                                               | Sign in                                                     | No greetings. State the action.                     |
| Failed to verify MFA. Try again.                           | Couldn't verify the code. Try again.                        | "Couldn't" is calmer than "Failed".                 |
| Please enter the 6-digit code from your authenticator app. | Enter the 6-digit code from your authenticator app.         | No "please".                                        |
| Your export has been generated                             | Export ready                                                | Direct, past-tense fact.                            |
| MFA step-up required                                       | MFA required                                                | "Step-up" is jargon — operators say "MFA required". |
| No tokens yet. Issue one to get started.                   | No tokens yet. Issue one to get started.                    | Already correct — keep.                             |
| Issue a new token                                          | New token                                                   | Title is a noun phrase, not a sentence.             |
| Token issued — copy now                                    | Token issued. Copy it now.                                  | One sentence per idea.                              |
| Signing secret — copy now                                  | Signing secret. Copy it now.                                | Same.                                               |
| Are you sure you want to delete?                           | Delete tag. Removes all assignments.                        | State the action + consequence.                     |
| Delete subscription? In-flight retries continue.           | Delete subscription. In-flight retries continue.            | Statement, not question.                            |
| Recurring exports → Slack / email / webhook · cron-driven  | Recurring exports to Slack, email, or webhook. Cron-driven. | Plain prose for subtitles.                          |
| Active sessions                                            | Active sessions                                             | Already correct.                                    |
| No active sessions.                                        | No active sessions.                                         | Already correct.                                    |
| Twelve customers added this week                           | 12 customers added this week                                | Numerals for data.                                  |
| Oops, something went wrong                                 | Couldn't load this view. Retry.                             | Specific + actionable.                              |

## What you don't change

- Engineering-reference page (already polished — leave it alone).
- Status pills / taxonomy labels (owned by taxonomy.ts).
- Empty-state component copy (owned by EmptyState\*).
- Status / changelog / security pages.
- Mock-data prose.
- Comments. Voice is for user-visible copy only.

## When unsure

If a string only appears once and reads cleanly, leave it. The bar is
"would a senior PM at Stripe ship this?" — not "could I make this
shorter?". Don't churn copy for the sake of it.
