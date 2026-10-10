# Validation - TASK-001: Find why average() returns the wrong value

Phase: DONE | Runs: 1 (1 passed, 0 failed)

## V-001 - PASS

- Command: `npm test`
- Exit code: 0
- Result: ok
- Duration: 228 ms
- Commit: 918b3d9bf837d71cb8f6a97a614b49e166163fae
- At: 2026-10-10T00:56:48.009Z

Output tail:

```text

> fixture@1.0.0 test
> node --test test/*.test.js

TAP version 13
# Subtest: average of an empty list is zero
ok 1 - average of an empty list is zero
  ---
  duration_ms: 0.591087
  type: 'test'
  ...
# Subtest: average of 2, 4, 6 is 4
ok 2 - average of 2, 4, 6 is 4
  ---
  duration_ms: 0.113035
  type: 'test'
  ...
# Subtest: sum of several numbers
ok 3 - sum of several numbers
  ---
  duration_ms: 0.655886
  type: 'test'
  ...
# Subtest: sum of empty list is zero
ok 4 - sum of empty list is zero
  ---
  duration_ms: 0.108312
  type: 'test'
  ...
1..4
# tests 4
# suites 0
# pass 4
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 62.59103
```
