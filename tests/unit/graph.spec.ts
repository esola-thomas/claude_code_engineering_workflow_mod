import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  adjacencyLines,
  displayWidth,
  drawLayout,
  drawSvg,
  drawText,
  fitLayout,
  formatParseErrors,
  layoutGraph,
  MAX_DRAWN_NODES,
  MAX_EDGES,
  MAX_NODES,
  parseFlowchart,
  splitMermaid,
  undrawnNote,
} from '../../src/graph.ts'
import type { Graph, Layout, ParseError } from '../../src/graph.ts'

function graphOf(source: string): Graph {
  const parsed = parseFlowchart(source)
  if (!parsed.ok) assert.fail(`expected ${JSON.stringify(source)} to parse: ${formatParseErrors(parsed.errors)}`)
  return parsed.graph
}

function errorsOf(source: string): ParseError[] {
  const parsed = parseFlowchart(source)
  if (parsed.ok) assert.fail(`expected ${JSON.stringify(source)} to be refused`)
  return parsed.errors
}

/** The TASK-001 map from docs/acceptance, verbatim. */
const TASK_001 = `flowchart LR
  AvgTest["test/average.test.js"] -->|calls| Avg["src/average.js"]
  SumTest["test/sum.test.js"] -->|calls| Sum["src/sum.js (bug: loop from i=1)"]
  Avg -->|calls| Sum
  Fmt["src/format.js"] -.->|independent| Avg
  Pkg["package.json npm test"] -->|runs| AvgTest
  Pkg -->|runs| SumTest
  Design["docs/DESIGN.md"] -->|specifies| Sum
  Readme["README.md"] -->|describes| Avg`

/** A small deterministic generator, so the random graphs are the same on every run. */
function randomGraphSource(seed: number, nodes: number, edges: number, direction = 'TD'): string {
  let state = seed
  const next = () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648
  const lines = [`flowchart ${direction}`]
  for (let i = 0; i < edges; i++) {
    const a = Math.floor(next() * nodes)
    const b = Math.floor(next() * nodes)
    const label = next() < 0.4 ? `|rel${i % 5}|` : ''
    lines.push(`  N${a}["node ${a}"] -->${label} N${b}`)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

describe('parseFlowchart', () => {
  it('reads the header direction (TB is TD; graph is flowchart; no direction is TD)', () => {
    assert.equal(graphOf('flowchart LR').direction, 'LR')
    assert.equal(graphOf('graph TB').direction, 'TD')
    assert.equal(graphOf('flowchart bt').direction, 'BT')
    assert.equal(graphOf('graph RL').direction, 'RL')
    assert.equal(graphOf('flowchart').direction, 'TD')
  })

  it('reads the TASK-001 map: nodes in order of appearance, labels, edge labels and styles', () => {
    const graph = graphOf(TASK_001)
    assert.deepEqual(
      graph.nodes.map(node => node.id),
      ['AvgTest', 'Avg', 'SumTest', 'Sum', 'Fmt', 'Pkg', 'Design', 'Readme'],
    )
    assert.equal(graph.nodes[3]?.label, 'src/sum.js (bug: loop from i=1)')
    assert.equal(graph.edges.length, 8)
    assert.deepEqual(graph.edges[3], { from: 'Fmt', to: 'Avg', label: 'independent', style: 'dotted', head: true, tail: false })
  })

  it('splits statements on semicolons outside quotes', () => {
    const graph = graphOf('graph TD; A-->B; B["x; y"] --> C;')
    assert.deepEqual(graph.nodes.map(node => node.label), ['A', 'x; y', 'C'])
    assert.equal(graph.edges.length, 2)
  })

  it('reads every node shape', () => {
    const graph = graphOf('flowchart LR\n a[r] --> b(o) --> c([s]) --> d[[sub]] --> e[(db)] --> f((c)) --> g{d} --> h{{x}} --> i>f] --> j[/p/] --> k(((dc)))')
    assert.deepEqual(
      graph.nodes.map(node => node.shape),
      ['rect', 'round', 'stadium', 'subroutine', 'cylinder', 'circle', 'diamond', 'hexagon', 'flag', 'rect', 'circle'],
    )
    assert.deepEqual(graph.nodes.map(node => node.label), ['r', 'o', 's', 'sub', 'db', 'c', 'd', 'x', 'f', 'p', 'dc'])
  })

  it('reads every link form', () => {
    const graph = graphOf(
      'flowchart LR\n A-->B\n A---B\n A-.->B\n A-.-B\n A==>B\n A===B\n A<-->B\n A--->B\n A-->|x|B\n A-- y -->B\n A-. z .->B\n A== w ==>B\n A--oB\n A--xB\n A~~~B',
    )
    const shown = graph.edges.map(edge => `${edge.style}:${edge.head ? 'h' : ''}${edge.tail ? 't' : ''}:${edge.label}`)
    assert.deepEqual(shown, [
      'solid:h:', 'solid::', 'dotted:h:', 'dotted::', 'thick:h:', 'thick::', 'solid:ht:', 'solid:h:',
      'solid:h:x', 'solid:h:y', 'dotted:h:z', 'thick:h:w', 'solid:h:', 'solid:h:',
    ])
  })

  it('expands & on both sides and chains', () => {
    const graph = graphOf('flowchart LR\n A & B --> C & D --> E')
    assert.deepEqual(
      graph.edges.map(edge => `${edge.from}${edge.to}`),
      ['AC', 'AD', 'BC', 'BD', 'CE', 'DE'],
    )
  })

  it('keeps a later label, and a first shape, for a node seen twice', () => {
    const graph = graphOf('flowchart LR\n A --> B\n A["Alpha"] --> C')
    assert.equal(graph.nodes[0]?.label, 'Alpha')
    assert.equal(graph.nodes.length, 3)
  })

  it('cleans labels: <br>, tags, markdown backticks, entities, whitespace', () => {
    const graph = graphOf('flowchart LR\n A["one<br/>two <b>bold</b>"] --> B["`**md**`"] --> C["say #quot;hi#quot; #35;"]')
    assert.deepEqual(graph.nodes.map(node => node.label), ['one two bold', '**md**', 'say "hi" #'])
  })

  it('reads subgraphs, nested, with and without labels; members belong to the innermost', () => {
    const graph = graphOf('flowchart LR\n subgraph api [API layer]\n  A --> B\n  subgraph inner\n   C\n  end\n end\n subgraph "Quoted name"\n  D\n end\n A --> D')
    assert.deepEqual(graph.subgraphs, [
      { id: 'api', label: 'API layer', parent: null },
      { id: 'inner', label: 'inner', parent: 'api' },
      { id: 'subgraph_3', label: 'Quoted name', parent: null },
    ])
    assert.deepEqual(graph.nodes.map(node => [node.id, node.subgraph]), [['A', 'api'], ['B', 'api'], ['C', 'inner'], ['D', 'subgraph_3']])
  })

  it('ignores comments, directives, styling statements and front matter', () => {
    const graph = graphOf('---\ntitle: Map\n---\n%%{init: {"theme": "dark"}}%%\nflowchart LR\n %% a comment\n A --> B:::hot\n classDef hot fill:#f00\n class A hot\n style B stroke:#333\n linkStyle 0 stroke:red\n click A "https://example.com"')
    assert.equal(graph.nodes.length, 2)
    assert.equal(graph.edges.length, 1)
  })

  it('accepts an empty flowchart (header only)', () => {
    const graph = graphOf('flowchart LR')
    assert.deepEqual([graph.nodes, graph.edges], [[], []])
  })

  it('refuses other diagram types and a missing header, naming what to write', () => {
    assert.match(errorsOf('sequenceDiagram\n A->>B: hi')[0]?.message ?? '', /"sequenceDiagram" diagrams are not supported/)
    assert.match(errorsOf('classDiagram')[0]?.message ?? '', /not supported/)
    assert.match(errorsOf('A --> B')[0]?.message ?? '', /expected "flowchart LR"/)
    assert.match(errorsOf('   \n\n')[0]?.message ?? '', /empty diagram/)
  })

  it('reports syntax errors with line and column, and keeps reading other statements', () => {
    const errors = errorsOf('flowchart LR\n  A --> B\n  B -> C\n  C[open --> D\n  end')
    assert.deepEqual(errors.map(error => [error.line, error.column]), [[3, 5], [4, 4], [5, 3]])
    assert.match(errors[0]?.message ?? '', /expected an arrow/)
    assert.match(errors[1]?.message ?? '', /unclosed node label/)
    assert.match(errors[2]?.message ?? '', /"end" without an open subgraph/)
    assert.match(formatParseErrors(errors), /^line 3, column 5: /)
  })

  it('refuses an unclosed subgraph, a keyword as id, and unclosed edge text', () => {
    assert.match(errorsOf('flowchart LR\n subgraph api\n A')[0]?.message ?? '', /subgraph "api" is not closed/)
    assert.match(errorsOf('flowchart LR\n A --> end')[0]?.message ?? '', /keyword/)
    assert.match(errorsOf('flowchart LR\n A -- text B')[0]?.message ?? '', /edge text is not closed/)
    assert.match(errorsOf('flowchart LR\n A["x --> B')[0]?.message ?? '', /unclosed quote/)
  })

  it('stops at the node and edge limits with one error', () => {
    const nodes = ['flowchart LR', ...Array.from({ length: MAX_NODES + 5 }, (_, i) => `  N${i}`)].join('\n')
    const nodeErrors = errorsOf(nodes)
    assert.equal(nodeErrors.length, 1)
    assert.match(nodeErrors[0]?.message ?? '', /too many nodes/)
    const edges = ['flowchart LR', ...Array.from({ length: MAX_EDGES + 5 }, () => '  A --> B')].join('\n')
    assert.equal(errorsOf(edges).length, 1)
  })

  it('caps the number of errors reported', () => {
    const source = ['flowchart LR', ...Array.from({ length: 20 }, () => '  A -> B')].join('\n')
    assert.equal(errorsOf(source).length, 8)
  })

  it('strips control characters from labels', () => {
    const graph = graphOf('flowchart LR\n A["evil\u001b[31m red\u0007"] --> B')
    assert.doesNotMatch(graph.nodes[0]?.label ?? '', /[\u0000-\u001f]/)
  })
})

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

describe('adjacencyLines', () => {
  it('spells each edge as Mermaid does, then unlinked nodes, then groups', () => {
    const graph = graphOf('flowchart LR\n subgraph g [Group]\n A\n end\n A -->|calls| B\n B -.-> C\n C <==> D\n D --- A\n E')
    assert.deepEqual(adjacencyLines(graph), ['A --calls--> B', 'B -.-> C', 'C <==> D', 'D --- A', 'E (no links)', 'Group Group: A'])
  })
})

// ---------------------------------------------------------------------------
// Layout and text drawing
// ---------------------------------------------------------------------------

function overlaps(a: Layout['boxes'][number], b: Layout['boxes'][number]): boolean {
  return a.left <= b.right && b.left <= a.right && a.top <= b.bottom && b.top <= a.bottom
}

function checkLayout(layout: Layout, graph: Graph): void {
  // No two boxes touch or overlap.
  for (let i = 0; i < layout.boxes.length; i++) {
    for (let j = i + 1; j < layout.boxes.length; j++) {
      assert.ok(!overlaps(layout.boxes[i]!, layout.boxes[j]!), `boxes ${layout.boxes[i]!.id} and ${layout.boxes[j]!.id} overlap`)
    }
  }
  const inside = (row: number, col: number) => layout.boxes.some(box => row >= box.top && row <= box.bottom && col >= box.left && col <= box.right)
  for (const { points, edge } of layout.edges) {
    assert.ok(points.length >= 2, `edge ${edge.from}->${edge.to} has a path`)
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i]!
      const b = points[i + 1]!
      assert.ok(a.row === b.row || a.col === b.col, 'every segment is horizontal or vertical')
      // No cell of a path is inside a box.
      for (let r = Math.min(a.row, b.row); r <= Math.max(a.row, b.row); r++) {
        for (let c = Math.min(a.col, b.col); c <= Math.max(a.col, b.col); c++) assert.ok(!inside(r, c), `edge ${edge.from}->${edge.to} crosses a box at ${r},${c}`)
      }
    }
    // Both ends sit next to the boxes of the edge's nodes (in either order: cycle edges are drawn reversed).
    const box = (id: string) => layout.boxes.find(b => b.id === id)!
    const touches = (p: { row: number; col: number }, id: string) => {
      const b = box(id)
      return (p.row === b.top - 1 || p.row === b.bottom + 1) && p.col > b.left && p.col < b.right
        || (p.col === b.left - 1 || p.col === b.right + 1) && p.row > b.top && p.row < b.bottom
    }
    const first = points[0]!
    const last = points[points.length - 1]!
    assert.ok(
      (touches(first, edge.from) && touches(last, edge.to)) || (touches(first, edge.to) && touches(last, edge.from)),
      `edge ${edge.from}->${edge.to} ends at its boxes`,
    )
  }
  assert.equal(layout.boxes.length, graph.nodes.length)
}

describe('layoutGraph', () => {
  it('keeps its invariants on the TASK-001 map in every direction', () => {
    for (const direction of ['TD', 'BT', 'LR', 'RL'] as const) {
      const graph = { ...graphOf(TASK_001), direction }
      checkLayout(layoutGraph(graph, { direction, labelWidth: 22, ascii: false }), graph)
    }
  })

  it('keeps its invariants on random graphs, cycles and self-loops included', () => {
    for (let seed = 1; seed <= 30; seed++) {
      for (const direction of ['TD', 'LR'] as const) {
        const graph = graphOf(randomGraphSource(seed, 3 + (seed % 12), 2 + seed, direction))
        const layout = layoutGraph(graph, { direction, labelWidth: 14, ascii: false })
        checkLayout(layout, graph)
        assert.equal(layout.edges.length + layout.loops.length, graph.edges.length)
      }
    }
  })

  it('ranks along the edges: in TD every forward edge goes down', () => {
    const graph = graphOf('flowchart TD\n A --> B --> C\n A --> C')
    const layout = layoutGraph(graph, { direction: 'TD', labelWidth: 22, ascii: false })
    const row = (id: string) => layout.boxes.find(box => box.id === id)!.top
    assert.ok(row('A') < row('B') && row('B') < row('C'))
  })

  it('lists self-loops instead of drawing them', () => {
    const layout = layoutGraph(graphOf('flowchart LR\n A -->|retry| A --> B'), { direction: 'LR', labelWidth: 22, ascii: false })
    assert.deepEqual(layout.loops, ['A loops to itself (retry)'])
    assert.equal(layout.edges.length, 1)
  })

  it('is deterministic', () => {
    const graph = graphOf(randomGraphSource(7, 12, 20))
    assert.deepEqual(drawText(graph), drawText(graph))
    assert.equal(drawSvg(graph), drawSvg(graph))
  })
})

describe('drawText', () => {
  it('draws two boxes and an arrow, left to right', () => {
    assert.deepEqual(drawText(graphOf('flowchart LR\n A --> B')), ['┌───┐  ┌───┐', '│ A │─▶│ B │', '└───┘  └───┘'])
  })

  it('draws top to bottom with the edge label beside the line', () => {
    assert.deepEqual(drawText(graphOf('flowchart TD\n A -->|calls| B')), ['┌───┐', '│ A │', '└───┘', '  │', '  │calls', '  ▼', '┌───┐', '│ B │', '└───┘'])
  })

  it('draws the edge label on the horizontal run in LR', () => {
    const lines = drawText(graphOf('flowchart LR\n A -->|calls| B'))!
    assert.equal(lines[1], '│ A │──calls─▶│ B │')
  })

  it('points the arrow up in BT and left in RL', () => {
    assert.ok(drawText(graphOf('flowchart BT\n A --> B'))!.some(line => line.includes('▲')))
    assert.ok(drawText(graphOf('flowchart RL\n A --> B'))!.some(line => line.includes('◀')))
  })

  it('draws dotted and thick edges with their own lines, and both ends of <-->', () => {
    assert.match(drawText(graphOf('flowchart LR\n A -.-> B'))!.join('\n'), /┄▶/)
    assert.match(drawText(graphOf('flowchart LR\n A ==> B'))!.join('\n'), /━▶/)
    assert.match(drawText(graphOf('flowchart LR\n A <--> B'))!.join('\n'), /◀▶/)
  })

  it('draws shapes with their own corners', () => {
    const text = drawText(graphOf('flowchart LR\n A(round) --> B{choice} --> C[[sub]]'))!.join('\n')
    assert.match(text, /╭─+╮/)
    assert.match(text, /╱─+╲/)
    assert.match(text, /╔═+╗/)
  })

  it('stays inside the columns given: switches direction, narrows labels, else gives up', () => {
    const graph = graphOf(TASK_001)
    for (const columns of [200, 120, 100, 80, 60]) {
      const lines = drawText(graph, { columns })
      if (lines === null) continue
      for (const line of lines) assert.ok(displayWidth(line) <= columns, `a line of ${displayWidth(line)} cells is wider than ${columns}`)
    }
    assert.ok(drawText(graph, { columns: 80 }) !== null, 'the TASK-001 map fits 80 columns')
    assert.equal(drawText(graph, { columns: 10 }), null)
    assert.equal(fitLayout(graph, { columns: 10 }), null)
  })

  it('wraps long labels at path separators', () => {
    const lines = drawText(graphOf('flowchart LR\n A["test/integration/average.test.js"] --> B'))!
    assert.ok(lines.some(line => line.includes('test/integration/')))
  })

  it('marks stale nodes with a heavy box and a legend', () => {
    const lines = drawText(graphOf('flowchart LR\n A --> B'), { marks: { B: { stale: true } } })!
    assert.match(lines.join('\n'), /┏━━━┓/)
    assert.match(lines[lines.length - 1] ?? '', /evidence went stale/)
  })

  it('draws plain ASCII on request', () => {
    const lines = drawText(graphOf('flowchart TD\n A -->|x| B\n B -.-> C'), { ascii: true })!
    for (const line of lines) assert.match(line, /^[\x20-\x7e]*$/)
  })

  it('counts wide characters as two cells', () => {
    const lines = drawText(graphOf('flowchart LR\n A["数据"] --> B'))!
    assert.equal(displayWidth(lines[0]!), displayWidth(lines[1]!))
  })

  it('lists edge labels it could not place and self-loops under the drawing', () => {
    const lines = drawText(graphOf('flowchart TD\n A -->|a-long-label-here| B\n A -->|another-long-label| C\n A -->|third-long-label| D\n A --> A'))!
    const text = lines.join('\n')
    assert.match(text, /A loops to itself/)
    // Every label is either drawn or listed.
    for (const label of ['a-long-label-here', 'another-long-label', 'third-long-label']) assert.ok(text.includes(label), label)
  })

  it('draws an empty diagram as a note and refuses graphs too large to read', () => {
    assert.deepEqual(drawText(graphOf('flowchart LR')), ['(empty diagram)'])
    const big = graphOf(['flowchart LR', ...Array.from({ length: MAX_DRAWN_NODES + 1 }, (_, i) => `  N${i}`)].join('\n'))
    assert.equal(drawText(big), null)
    assert.match(undrawnNote(big, 80), /too many to draw/)
    assert.match(undrawnNote(graphOf('flowchart LR\n A'), 80), /wider than 80 columns/)
  })

  it('drawLayout fills exactly the layout grid', () => {
    const graph = graphOf(TASK_001)
    const layout = layoutGraph(graph, { direction: 'TD', labelWidth: 22, ascii: false })
    const lines = drawLayout(layout)
    assert.equal(lines.length, layout.rows)
    for (const line of lines) assert.ok(displayWidth(line) <= layout.cols)
  })
})

// ---------------------------------------------------------------------------
// SVG
// ---------------------------------------------------------------------------

describe('drawSvg', () => {
  it('draws a themed, self-contained SVG with one group per node and one path per edge', () => {
    const svg = drawSvg(graphOf(TASK_001), { title: 'TASK-001' })!
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 \d+ \d+"/)
    assert.match(svg, /<\/svg>$/)
    assert.match(svg, /<title>TASK-001<\/title>/)
    assert.match(svg, /prefers-color-scheme: dark/)
    assert.equal(svg.match(/<g class="n">/g)?.length, 8)
    assert.equal(svg.match(/<path class="edge (solid|dotted|thick)"/g)?.length, 8)
    assert.equal(svg.match(/class="edge dotted"/g)?.length, 1)
    assert.doesNotMatch(svg, /<script|on\w+=/i)
  })

  it('escapes labels and puts the node note in its tooltip; stale nodes get the stale class', () => {
    const svg = drawSvg(graphOf('flowchart LR\n A["a < b & c > d"] --> B["<img src=x onerror=alert(1)>tag"]'), { marks: { A: { stale: true, note: 'F-001 [STALE]: <b>' } } })!
    assert.doesNotMatch(svg, /<img|<b>|onerror/)
    assert.match(svg, />a &lt; b &amp; c &gt; d</)
    assert.match(svg, /F-001 \[STALE\]: &lt;b&gt;/)
    assert.match(svg, /class="node stale"/)
  })

  it('frames subgraph members with the group label', () => {
    const svg = drawSvg(graphOf('flowchart LR\n subgraph api [API]\n  A --> B\n end\n B --> C'))!
    assert.match(svg, /<rect class="group"/)
    assert.match(svg, /<text class="glabel"[^>]*>API<\/text>/)
  })

  it('returns null for an empty graph and for one too large to draw', () => {
    assert.equal(drawSvg(graphOf('flowchart LR')), null)
    assert.equal(drawSvg(graphOf(['flowchart LR', ...Array.from({ length: MAX_DRAWN_NODES + 1 }, (_, i) => `  N${i}`)].join('\n'))), null)
  })
})

// ---------------------------------------------------------------------------
// Markdown with Mermaid fences
// ---------------------------------------------------------------------------

describe('splitMermaid', () => {
  it('splits markdown around mermaid fences of any length and either fence character', () => {
    const md = '# Title\n\nText\n\n```mermaid\nflowchart LR\n A --> B\n```\n\nMore\n\n~~~~ Mermaid\ngraph TD\n~~~~\n'
    assert.deepEqual(splitMermaid(md), [
      { kind: 'markdown', text: '# Title\n\nText\n' },
      { kind: 'mermaid', source: 'flowchart LR\n A --> B' },
      { kind: 'markdown', text: '\nMore\n' },
      { kind: 'mermaid', source: 'graph TD' },
    ])
  })

  it('leaves other fences alone, including a mermaid line inside one', () => {
    const md = '````md\n```mermaid\nflowchart LR\n```\n````\n'
    assert.deepEqual(splitMermaid(md), [{ kind: 'markdown', text: md }])
  })

  it('keeps an unclosed mermaid fence as text', () => {
    const md = 'intro\n```mermaid\nflowchart LR'
    assert.deepEqual(splitMermaid(md), [{ kind: 'markdown', text: md }])
  })

  it('a fence closes only on a run at least as long as its opener', () => {
    const segments = splitMermaid('````mermaid\nflowchart LR\n```\n A --> B\n````')
    assert.deepEqual(segments, [{ kind: 'mermaid', source: 'flowchart LR\n```\n A --> B' }])
  })
})
