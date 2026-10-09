# Plan - TASK-001: Find why average() returns the wrong value

Phase: DONE | Approval: approved

## Summary

Fix the root cause in sum(): start the loop at index 0 so the first element is included. average() is correct and needs no change, and its signature stays the same. Existing tests already cover the behaviour.

## Steps

- S-1 [done] In sum(), change the loop start from `let i = 1` to `let i = 0` (src/sum.js:8).
  - Files: `src/sum.js`
- S-2 [done] Run npm test and confirm all suites pass, including 'average of 2, 4, 6 is 4' and 'sum of several numbers'.

## Risks

- Only average.js imports sum, so the blast radius is small.
- No test has a non-zero first element where a skipped value would be hidden (e.g. [0,...]); the existing tests do catch this bug, so no new test is planned unless you want one (Q-001).

## Tests

- npm test (node --test test/*.test.js) passes, including average([2,4,6]) === 4 and sum([1,2,3,4]) === 10.

## Alternatives

- Change average() to compensate for sum(): rejected, it leaves sum() wrong and violates docs/DESIGN.md:11.
- Replace the loop with numbers.reduce(...): rejected, a larger change than the bug needs.

Updated: 2026-10-09T23:33:39.298Z
