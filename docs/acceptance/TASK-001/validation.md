# Validation - TASK-001: Find why average() returns the wrong value

Phase: VALIDATE | Runs: 1 (1 passed, 0 failed)

## V-001 - PASS

- Command: `npm test`
- Exit code: 0
- Result: ok
- Duration: 306 ms
- Commit: a6558709a38078de799273851ae162d4d9a0599e
- At: 2026-10-09T23:33:38.312Z

Output tail:

```text

> fixture@1.0.0 test
> node --test test/*.test.js

TAP version 13
# Subtest: average of an empty list is zero
ok 1 - average of an empty list is zero
  ---
  duration_ms: 0.841865
  type: 'test'
  ...
# Subtest: average of 2, 4, 6 is 4
ok 2 - average of 2, 4, 6 is 4
  ---
  duration_ms: 0.173356
  type: 'test'
  ...
# Subtest: sum of several numbers
ok 3 - sum of several numbers
  ---
  duration_ms: 0.824169
  type: 'test'
  ...
# Subtest: sum of empty list is zero
ok 4 - sum of empty list is zero
  ---
  duration_ms: 0.162199
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
# duration_ms 93.007459
```
