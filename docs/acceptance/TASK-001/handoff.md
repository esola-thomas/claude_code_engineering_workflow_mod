# Handoff - TASK-001: Find why average() returns the wrong value

## Summary

- Final phase: DONE
- Diff review: no ewm:reviewer run was recorded for this task
- Plan: sum() skips numbers[0] because its loop starts at i = 1 (F-001), so average() is wrong through it. Change the loop start to 0 in src/sum.js, leaving average() and its signature untouched, then confirm with npm test.
- Steps done: 2 of 2
- Validation runs: 1 (1 passed)
- Findings: 7 (0 stale)
- Created: 2026-10-10T00:53:48.139Z; last update: 2026-10-10T00:56:58.860Z

## Goal

Problem: average() returns the wrong value (e.g. average([2,4,6]) should be 4 but returns something else). Goal: find why and fix it after plan approval.

## Success criteria

- Root cause of the wrong average() value is identified with path:line evidence
- npm test passes after the fix

## Decisions

- D-001 Scope: diagnose and fix: Diagnose the cause, then fix it after plan approval (Person stated: diagnosis plus a fix after plan approval)
- D-002 Keep average() signature: The average() signature must not change (Person stated constraint)

## Files changed

- `src/sum.js`

## Validation

- V-001 PASS: `npm test` (exit 0, 228 ms, commit 918b3d9bf837d71cb8f6a97a614b49e166163fae)

## Open questions

- Q-001: Should the fix also add regression tests, or are the existing average and sum tests enough?

## Follow-ups

None.
