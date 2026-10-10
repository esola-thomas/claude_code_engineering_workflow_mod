# Exploration - TASK-001: Find why average() returns the wrong value

Phase: DONE | Findings: 7 | Stale: 0

## F-001 - sum() starts its loop at index 1, so it never adds numbers[0]; this is the root cause.

- Confidence: high
- Source: ewm:repo-scout
- Verified at commit: 918b3d9bf837d71cb8f6a97a614b49e166163fae
- Recorded: 2026-10-10T00:54:37.288Z
- Evidence:
  - `src/sum.js:6-12` - for (let i = 1; ...) skips the first element
- Open questions: none

## F-002 - average() returns 0 for an empty list, otherwise sum(numbers) / numbers.length, so it inherits sum's error; average([2,4,6]) gives 10/3 instead of 4 (derived by reading, not executed).

- Confidence: high
- Source: ewm:repo-scout
- Verified at commit: 918b3d9bf837d71cb8f6a97a614b49e166163fae
- Recorded: 2026-10-10T00:54:38.521Z
- Evidence:
  - `src/average.js:7-12`
  - `src/sum.js:8-10`
- Open questions: none

## F-003 - average() is called only from its test file; no module under src/ uses it, and format.js only formats numbers.

- Confidence: high
- Source: ewm:repo-scout
- Verified at commit: 918b3d9bf837d71cb8f6a97a614b49e166163fae
- Recorded: 2026-10-10T00:54:39.522Z
- Evidence:
  - `test/average.test.js:4`
  - `src/format.js:6-8`
- Open questions: none

## F-004 - The tests already encode the correct behavior: average([2,4,6]) must be 4 and sum([1,2,3,4]) must be 10, so both fail on the current code; the empty-list tests pass.

- Confidence: medium
- Source: ewm:repo-scout
- Verified at commit: 918b3d9bf837d71cb8f6a97a614b49e166163fae
- Recorded: 2026-10-10T00:54:41.055Z
- Evidence:
  - `test/average.test.js:10-12`
  - `test/sum.test.js:6-8`
  - `src/sum.js:8-10`
- Open questions:
  - Hand-traced only; npm test has not been run.

## F-005 - docs/DESIGN.md invariants say sum(xs) adds every element including the first and average(xs)*length equals sum(xs); src/sum.js violates both, so the documentation confirms the code is wrong.

- Confidence: high
- Source: ewm:docs-scout
- Verified at commit: 918b3d9bf837d71cb8f6a97a614b49e166163fae
- Recorded: 2026-10-10T00:54:42.321Z
- Evidence:
  - `docs/DESIGN.md:11-12`
  - `src/sum.js:8-10`
- Open questions: none

## F-006 - npm test runs node --test test/*.test.js, which matches the README description and covers both test files.

- Confidence: high
- Source: ewm:docs-scout
- Verified at commit: 918b3d9bf837d71cb8f6a97a614b49e166163fae
- Recorded: 2026-10-10T00:54:43.254Z
- Evidence:
  - `package.json:5-7`
  - `README.md:13`
- Open questions: none

## F-007 - DESIGN.md requires sum to be the single place for list addition and average to reuse it, and average.js does; the fix therefore belongs in sum.js, with no change to average()'s signature.

- Confidence: high
- Source: lead
- Verified at commit: 918b3d9bf837d71cb8f6a97a614b49e166163fae
- Recorded: 2026-10-10T00:54:44.586Z
- Evidence:
  - `docs/DESIGN.md:5`
  - `src/average.js:2`
  - `README.md:7-8`
- Open questions: none
