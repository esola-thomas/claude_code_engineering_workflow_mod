# Decisions - TASK-001: Find why average() returns the wrong value

Phase: DONE

## Goal

Problem: average() returns the wrong value (e.g. average([2,4,6]) should be 4 but returns something else). Goal: find why and fix it after plan approval.

## Success criteria

- Root cause of the wrong average() value is identified with path:line evidence
- npm test passes after the fix

## Constraints

- Read-only until the plan is approved
- Keep the average() signature unchanged

## Decisions

- D-001 Scope: diagnose and fix (INTAKE, by model, 2026-10-10T00:54:08.185Z)
  - Choice: Diagnose the cause, then fix it after plan approval
  - Rationale: Person stated: diagnosis plus a fix after plan approval
- D-002 Keep average() signature (INTAKE, by model, 2026-10-10T00:54:08.710Z)
  - Choice: The average() signature must not change
  - Rationale: Person stated constraint

## Approvals

- plan_approval: approved via command at 2026-10-10T00:56:34.829Z
- done_acceptance: approved via command at 2026-10-10T00:56:58.860Z

## Transitions

- INTAKE -> EXPLORE by model at 2026-10-10T00:54:09.778Z: intake confirmed
- EXPLORE -> UNDERSTAND by model at 2026-10-10T00:54:49.116Z: Seven verified findings show the root cause is the loop in src/sum.js starting at index 1; the map is written.
- UNDERSTAND -> PLAN by user at 2026-10-10T00:55:39.837Z: the person asked to plan
- PLAN -> PAUSED by user at 2026-10-10T00:56:04.392Z: paused by the person
- PAUSED -> PLAN by user at 2026-10-10T00:56:09.072Z: resumed
- PLAN -> IMPLEMENT by user at 2026-10-10T00:56:34.829Z: plan_approval approved
- IMPLEMENT -> VALIDATE by model at 2026-10-10T00:56:46.616Z: S-1 implemented: sum loop now starts at index 0.
- VALIDATE -> DONE by user at 2026-10-10T00:56:58.860Z: done_acceptance approved
