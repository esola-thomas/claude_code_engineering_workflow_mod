# Handoff - TASK-001: Find why average() returns the wrong value

## Summary

- Final phase: DONE
- Plan: Fix the root cause in sum(): start the loop at index 0 so the first element is included. average() is correct and needs no change, and its signature stays the same. Existing tests already cover the behaviour.
- Steps done: 2 of 2
- Validation runs: 1 (1 passed)
- Findings: 7 (0 stale)
- Created: 2026-10-09T23:29:32.046Z; last update: 2026-10-09T23:33:55.026Z

## Goal

Problem: average([2,4,6]) should return 4 but returns a different value. Goal: find the root cause of the wrong average() value and fix it.

## Success criteria

- Root cause identified with path:line evidence
- npm test passes after the fix

## Decisions

- D-001 Scope: diagnosis plus fix: Diagnose the root cause, then fix it after plan approval (Person stated: diagnosis plus a fix after plan approval)

## Files changed

- `src/sum.js`

## Validation

- V-001 PASS: `npm test` (exit 0, 306 ms, commit a6558709a38078de799273851ae162d4d9a0599e)

## Open questions

- Q-001: Should the fix also add a regression test (for example, sum where the first element is non-zero), or is fixing the loop start in sum.js enough?

## Follow-ups

None.
