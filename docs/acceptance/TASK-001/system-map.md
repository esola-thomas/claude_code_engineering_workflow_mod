# System map - TASK-001: Find why average() returns the wrong value

Updated: 2026-10-09T23:30:37.823Z

## Text map

```text
average.js -> calls sum.js for the addition, then divides by length
sum.js: loop starts at i=1, so numbers[0] is skipped (root cause)
test/average.test.js and test/sum.test.js both call into this code
docs/DESIGN.md: sum must include the first element; average*length == sum
README.md: documents the modules and npm test
package.json: npm test = node --test test/*.test.js
format.js: independent, presentation only
```

## Components

- src/average.js
- src/sum.js
- src/format.js
- test/average.test.js
- test/sum.test.js
- docs/DESIGN.md
- README.md
- package.json

## Diagram

```mermaid
flowchart LR
  Test_avg["test/average.test.js"] -->|calls| Avg["src/average.js"]
  Avg -->|calls| Sum["src/sum.js (loop starts at i=1: BUG)"]
  Test_sum["test/sum.test.js"] -->|calls| Sum
  Design["docs/DESIGN.md"] -->|specifies invariants of| Sum
  Readme["README.md"] -->|describes| Avg
  Pkg["package.json npm test"] -->|runs| Test_avg
  Pkg -->|runs| Test_sum
  Fmt["src/format.js"]
```
