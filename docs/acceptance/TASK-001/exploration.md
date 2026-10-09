# Exploration - TASK-001: Find why average() returns the wrong value

Phase: PLAN | Findings: 7 | Stale: 0

## F-001 - sum() starts its loop at index 1, so it skips numbers[0]; this is the root cause (sum([2,4,6]) returns 10, not 12).

- Confidence: high
- Source: ewm:repo-scout
- Verified at commit: a6558709a38078de799273851ae162d4d9a0599e
- Recorded: 2026-10-09T23:30:25.955Z
- Evidence:
  - `src/sum.js:6-12` - for (let i = 1; ...) skips the first element
- Open questions: none

## F-002 - average() returns 0 for an empty list and otherwise computes sum(numbers) / numbers.length, so it inherits sum()'s error: average([2,4,6]) evaluates to 10/3 (about 3.33) instead of 4.

- Confidence: high
- Source: ewm:repo-scout
- Verified at commit: a6558709a38078de799273851ae162d4d9a0599e
- Recorded: 2026-10-09T23:30:27.317Z
- Evidence:
  - `src/average.js:7-12` - delegates addition to sum
  - `src/sum.js:8-10`
- Open questions: none

## F-003 - The design note requires sum(xs) to add every element including the first, and average(xs) * xs.length to equal sum(xs); the current sum violates both.

- Confidence: high
- Source: ewm:docs-scout
- Verified at commit: a6558709a38078de799273851ae162d4d9a0599e
- Recorded: 2026-10-09T23:30:28.451Z
- Evidence:
  - `docs/DESIGN.md:9-12` - invariants
  - `src/sum.js:8-9`
- Open questions: none

## F-004 - The test 'average of 2, 4, 6 is 4' expects 4 and the sum test expects sum([1,2,3,4]) to be 10; by reading, both fail against the current sum (10/3 and 9). Not run yet.

- Confidence: medium
- Source: lead
- Verified at commit: a6558709a38078de799273851ae162d4d9a0599e
- Recorded: 2026-10-09T23:30:29.950Z
- Evidence:
  - `test/average.test.js:10-12`
  - `test/sum.test.js:6-8`
  - `src/sum.js:8-9`
- Open questions:
  - What does npm test actually report on the current commit?

## F-005 - The empty-list behaviour is consistent: DESIGN.md fixes average([]) at 0, the code guards for it, and a test asserts it.

- Confidence: high
- Source: ewm:docs-scout
- Verified at commit: a6558709a38078de799273851ae162d4d9a0599e
- Recorded: 2026-10-09T23:30:31.184Z
- Evidence:
  - `docs/DESIGN.md:6`
  - `src/average.js:8-10`
  - `test/average.test.js:6-8`
- Open questions: none

## F-006 - average.js is the only module importing sum, and the only in-repo caller of average is its test; format.js is independent (presentation only), so a fix in sum.js has a small blast radius.

- Confidence: high
- Source: ewm:repo-scout
- Verified at commit: a6558709a38078de799273851ae162d4d9a0599e
- Recorded: 2026-10-09T23:30:32.418Z
- Evidence:
  - `src/average.js:2`
  - `test/average.test.js:4`
  - `src/format.js:6-8`
- Open questions: none

## F-007 - npm test runs `node --test test/*.test.js`; the README documents it and it matches package.json.

- Confidence: high
- Source: ewm:docs-scout
- Verified at commit: a6558709a38078de799273851ae162d4d9a0599e
- Recorded: 2026-10-09T23:30:33.288Z
- Evidence:
  - `package.json:5-7`
  - `README.md:11-13`
- Open questions: none
