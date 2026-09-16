# Agent Plan lifecycle repair

## Problem

`update_plan` stores one durable `sessions/<id>/plan.json`. The renderer previously treated every
nonempty unfinished document as permanently active, so a model that stopped calling `update_plan`
could leave an old `2 / 6` plan above the composer after the actual turn had completed and later
user prompts had started.

## Change

- Plan documents now carry a small lifecycle projection owned by the session store.
- A durable `turn_end` with outcome `completed` pauses an unfinished displayed plan without
  changing any step status or deleting the document, so stale counts are no longer shown as live.
- The existing app-authored false-completion repair can reactivate that exact turn's plan.
- A normal later user turn does not silently resurrect a paused plan; a later `update_plan`
  explicitly reactivates/replaces it.
- App-authored follow-ups carry the unresolved plan in hidden model context, and the first owned
  Core tool result in a turn offers the same bounded reconciliation reminder. The model must update
  continuing work or explicitly clear work that was actually finished/superseded.
- An accepted `update_plan` marks reconciliation consumed even if `activeTurnId` has not arrived
  from the browser yet, so the tool result itself cannot immediately re-offer the same reminder.
- Semantically identical `update_plan` calls are idempotent. A paused identical plan may reactivate
  lifecycle state once, but its `updatedAt` revision is preserved; repeating it while active is a
  true no-op. This prevents the observed `update_plan -> reminder -> update_plan` feedback loop.
- Legacy plan files remain readable and derive pause state from recorded lifecycle boundaries.
- `session_finish` keeps its existing hold when a plan still contains unfinished steps and
  tells the executor to reconcile it with `update_plan` first.
- The renderer hides paused progress; handoffs retain an unresolved-plan notice so legitimate
  multi-turn/Compact & Resume work is not lost.

## Verification

Focused Agent Plan, finish and prompt tests cover lifecycle persistence and idempotency. The real
MCP HTTP test reproduces late `activeTurnId` and verifies that one reconciliation update suppresses
later reminders without minting another semantic revision. Full project verification and production
build are required before publishing the branch.
