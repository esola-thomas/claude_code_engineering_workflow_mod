# Decisions - TASK-001: Find why average() returns the wrong value

Phase: DONE

## Goal

Problem: average([2,4,6]) should return 4 but returns a different value. Goal: find the root cause of the wrong average() value and fix it.

## Success criteria

- Root cause identified with path:line evidence
- npm test passes after the fix

## Constraints

- Read-only until the plan is approved
- Keep the average() signature unchanged

## Decisions

- D-001 Scope: diagnosis plus fix (INTAKE, by model, 2026-10-09T23:29:52.069Z)
  - Choice: Diagnose the root cause, then fix it after plan approval
  - Rationale: Person stated: diagnosis plus a fix after plan approval

## Approvals

- plan_approval: approved via command at 2026-10-09T23:33:28.267Z
- done_acceptance: approved via command at 2026-10-09T23:33:55.026Z

## Transitions

- INTAKE -> EXPLORE by model at 2026-10-09T23:29:53.457Z: intake confirmed
- EXPLORE -> UNDERSTAND by model at 2026-10-09T23:30:39.270Z: Seven sourced findings establish that sum() skips the first element, which makes average() wrong; the map is written.
- UNDERSTAND -> PLAN by model at 2026-10-09T23:31:26.581Z: Person asked to proceed to the fix; the root cause (F-001) was explained and the affected area is small and fully mapped.
- PLAN -> PAUSED by user at 2026-10-09T23:31:46.549Z: paused by the person
- PAUSED -> PLAN by user at 2026-10-09T23:31:55.803Z: resumed
- PLAN -> PAUSED by user at 2026-10-09T23:32:21.533Z: paused by the person
- PAUSED -> PLAN by user at 2026-10-09T23:32:24.084Z: resumed
- PLAN -> PAUSED by user at 2026-10-09T23:33:01.799Z: paused by the person
- PAUSED -> PLAN by user at 2026-10-09T23:33:04.262Z: resumed
- PLAN -> IMPLEMENT by user at 2026-10-09T23:33:28.267Z: plan_approval approved
- IMPLEMENT -> VALIDATE by model at 2026-10-09T23:33:36.723Z: S-1 done; S-2 (npm test) is run in VALIDATE via run_validation
- VALIDATE -> DONE by user at 2026-10-09T23:33:55.026Z: done_acceptance approved
