# Plan - TASK-001: Find why average() returns the wrong value

Phase: DONE | Approval: approved

## Summary

sum() skips numbers[0] because its loop starts at i = 1 (F-001), so average() is wrong through it. Change the loop start to 0 in src/sum.js, leaving average() and its signature untouched, then confirm with npm test.

## Steps

- S-1 [done] In src/sum.js line 8, change the loop initializer from `let i = 1` to `let i = 0` so every element is added. No other change.
  - Files: `src/sum.js`
- S-2 [done] Run npm test through the validation tool. The existing tests should now pass: sum([1,2,3,4]) = 10, average([2,4,6]) = 4, and both empty-list cases.

## Risks

- Another test or caller might depend on the buggy behavior. Searches found no other callers and the only tests expect the correct values; npm test would show any such failure.
- Scope creep: the plan changes one line only and does not touch average.js, format.js or the docs.

## Tests

- npm test (the profile's validation command): all tests in test/average.test.js and test/sum.test.js must pass
- No new tests added: the existing sum and average tests already cover the bug (open question Q-001; say so if you want a regression test for a single-element list)

## Alternatives

- Fix in average.js by adding numbers[0] back: rejected, it leaves sum() broken and breaks the design rule that sum is the single place for addition (docs/DESIGN.md:5, 11).
- Replace the loop with numbers.reduce((a, b) => a + b, 0): also correct but a larger diff than a one-character fix, with no benefit here.
- Add a single-element regression test: optional, not in this plan unless you ask.

Updated: 2026-10-10T00:56:48.030Z
