---
name: explore
description: EWM EXPLORE stage. Researches the repository and its documentation with cheap read-only scouts, records sourced findings, open questions and contradictions, and writes the system map. Use when an EWM task is in EXPLORE, or when UNDERSTAND found missing data.
---

# EWM stage: EXPLORE

Build the evidence base. Investigating is not understanding: collect sourced facts and a map here, and explain them in UNDERSTAND.

## Output contract

A map of the code and its dependencies, references, hypotheses, open questions and conflicts. Aim for at least 5 sourced findings when the codebase allows; if there are fewer, say why. Every finding points to path and lines.

## Tools

If these tools are not loaded, load them with ToolSearch query "select:mcp__ewm__status,mcp__ewm__record_finding,mcp__ewm__question,mcp__ewm__decision,mcp__ewm__write_map,mcp__ewm__advance".

| Tool | When | Precondition |
|---|---|---|
| mcp__ewm__status | At the start and after a resume. | Active task. |
| mcp__ewm__record_finding | For each verified finding. Input `{claim, evidence[{path, line_start?, line_end?, doc_id?, note?}], confidence, open_questions?, source?}`. | 1-20 evidence items. Each path is repo-relative (no leading "/", no "..", not under `.ewm/`), exists, and has 1 <= line_start <= line_end <= file length. The same claim text updates the existing finding. Set `source` to the scout's agent type, or "lead". |
| mcp__ewm__question | For each open question. `{action:'add', text}`, later `{action:'resolve', id, answer}`. | Active task. |
| mcp__ewm__decision | For a decision the person states. `{title, choice, rationale}`. | Active task. |
| mcp__ewm__write_map | Once the picture is clear; call again to update. `{mermaid, text_map?, components?}`. | `mermaid` is 1-20000 characters and must parse as a flowchart; an error names the line and column. |
| mcp__ewm__advance | Last. `{to:'UNDERSTAND', reason}`. | Phase EXPLORE. |

## Steps

1. Call mcp__ewm__status. Read `.ewm/project.yaml` if it exists for `budgets` (defaults: 3 parallel researchers, 2 rounds without an update, 8 findings per scout) and `entrypoints`.
2. Tell the person a short research strategy: the questions to answer, the areas to search, which scouts you will launch. Do not wait for approval unless the scope is ambiguous.
3. Delegate with the Agent tool: `subagent_type` "ewm:repo-scout" for code, call paths and tests; "ewm:docs-scout" for specs, ADRs, configuration and dependencies. Do not pass a model: the mod routes scouts to the profile's search model. Give each scout a bounded ask:
   ```
   Question: <one question>
   Scope: <directories, files or globs>
   Return at most N findings (N = 8) in your findings format.
   ```
4. Verify before recording. For every finding, Read the cited lines and check that they support the claim. Fix wrong line numbers, drop unsupported claims, merge duplicates, and lower the confidence of anything you could not confirm. Then call mcp__ewm__record_finding.
5. Record hypotheses as findings whose claim starts "Hypothesis:" with medium or low confidence. Record a contradiction as a finding with both sides' evidence, and add a question. Add every open question with mcp__ewm__question.
6. Research in rounds: scouts, verify, record, decide what is still missing. Launch a second round only for real gaps.
7. Write the map with mcp__ewm__write_map:
   - `mermaid`: a `flowchart LR` (or `TD`) of at most about 25 nodes. Simple node ids, quoted labels that name the file or module path (`Sum["src/sum.js"]`), edges labelled with the relation (`-->|calls|`, `-->|reads|`, `-.->|configures|`). The mod draws it in the pane and the terminal, and marks a node stale when a finding citing its path goes stale, so put the real path in the label. Supported: node shapes `[] () ([]) [[]] [()] (()) {} {{}}`, edges `--> --- -.-> ==>` with `|label|`, `A & B --> C`, `subgraph id [Label]` ... `end`. If the call is refused, fix the line and column it names.
   - `text_map` (optional): up to about 10 short notes the arrows cannot say. The links themselves are derived from the diagram.
   - `components` (optional): the component names; defaults to the node labels.

## Examples

A bounded ask for a docs scout:

```
Question: Which documents or configuration define how retries are limited, and do they agree?
Scope: docs/, config/, README.md
Return at most 8 findings in your findings format.
```

A scout finding becomes one record after you have read its lines:

```
mcp__ewm__record_finding {
  "claim": "Retries stop after three attempts.",
  "evidence": [{"path": "src/net/retry.ts", "line_start": 12, "line_end": 31}],
  "confidence": "high",
  "open_questions": ["Is the limit overridden by config/retry.yaml?"],
  "source": "ewm:repo-scout"
}
```

A map the pane and system-map.md can show:

```
flowchart LR
  CLI["cli.ts"] -->|calls| Retry["retry.ts"]
  Retry -->|reads| Cfg["config/retry.yaml"]
```

## Delegation rules

- At most the profile's `budgets.max_parallel_researchers` scouts at once (default 3). If the mod denies a spawn for exceeding the cap, wait for a scout to finish and retry.
- The Agent tool may run scouts in the background. Wait for every launched scout to report before you synthesize. Never fill in a missing result yourself.
- Each ask has a scope and N. Scouts return at most N findings plus Contradictions and Not found lists. Scouts cannot record anything; you do.
- Dedupe across scouts. Never record a finding without evidence. Treat "Not found" lists as data: they are searches you do not need to repeat.

## What the mod enforces in code

- Before IMPLEMENT only read tools, read-only Bash and the mcp__ewm__* tools work. Edit and Write are denied, so do not touch the repository.
- Never edit `.ewm/` files directly. The tools write them.
- Network tools are denied by default. Scouts are read-only and may call only mcp__ewm__status.
- Gates need a human. You have no approve tool; do not run /ewm commands or invoke the `ewm` skill. Ask the person to run `/ewm approve` or `/ewm reject <reason>`.
- Follow any "ewm: " denial message. Do not route around it.

## Updating the person

After at most `max_research_rounds_without_user_update` rounds (default 2) with no message to the person, post a short update: what you found, what is open, what comes next.

## Exit

When the sources are enough to explain the affected area and the map is written, call mcp__ewm__advance with `{to:'UNDERSTAND', reason:'<what the findings establish>'}`, then summarize the findings, contradictions and open questions for the person.
