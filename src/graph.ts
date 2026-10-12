// Mermaid flowcharts without Mermaid: a strict subset of the flowchart syntax is
// parsed into a Graph, laid out in layers (cycle breaking, ranks, crossing
// reduction, orthogonal edge routing) on a grid of character cells, and drawn
// either as text (terminal) or as SVG (desktop, editor, mobile). Pure and
// deterministic: no Io, no DOM, no clock; the same source draws the same way.
//
// The subset is what the system map needs and what Mermaid itself accepts:
// `flowchart|graph [TD|TB|BT|LR|RL]`, node shapes [] () ([]) [[]] [()] (()) {} {{}} >],
// quoted or plain labels, edges --> --- -.-> ==> (with <, o and x ends, longer
// variants, `|label|` and `-- label -->` forms), `A & B --> C` chains,
// `subgraph id [label]` ... `end`, and `%%` comments. Styling statements
// (classDef, class, style, linkStyle, click, direction) are accepted and ignored.

export type Direction = 'TD' | 'BT' | 'LR' | 'RL'
export type NodeShape = 'rect' | 'round' | 'stadium' | 'subroutine' | 'cylinder' | 'circle' | 'diamond' | 'hexagon' | 'flag'
export type EdgeStyle = 'solid' | 'dotted' | 'thick'
export type GraphNode = { id: string; label: string; shape: NodeShape; subgraph: string | null }
/** `head`: an end marker at `to`; `tail`: one at `from` (`<-->`). */
export type GraphEdge = { from: string; to: string; label: string; style: EdgeStyle; head: boolean; tail: boolean }
export type Subgraph = { id: string; label: string; parent: string | null }
export type Graph = { direction: Direction; nodes: GraphNode[]; edges: GraphEdge[]; subgraphs: Subgraph[] }
export type ParseError = { line: number; column: number; message: string }
export type ParseResult = { ok: true; graph: Graph } | { ok: false; errors: ParseError[] }

/** Per-node overlays: `stale` marks a node whose evidence went stale; `note` is shown in its tooltip. */
export type NodeMark = { stale?: boolean; note?: string }
export type DrawOptions = {
  /** Cells available across; a drawing that does not fit is refused (null). */
  columns?: number
  /** Plain ASCII instead of box-drawing characters. */
  ascii?: boolean
  marks?: Readonly<Record<string, NodeMark>>
}

export const MAX_NODES = 300
export const MAX_EDGES = 600
/** Larger graphs are listed, not drawn: a drawing that big is unreadable in a pane, and its layout too slow to redo on every redraw. */
export const MAX_DRAWN_NODES = 80
/** The `Svg` element takes at most this many characters of markup. */
export const MAX_SVG_CHARS = 131072
const MAX_ERRORS = 8

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const OTHER_DIAGRAMS = /^(sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|quadrantChart|requirementDiagram|gitGraph|C4\w*|mindmap|timeline|sankey(?:-beta)?|xychart(?:-beta)?|block(?:-beta)?|packet(?:-beta)?|kanban|architecture(?:-beta)?|zenuml)\b/
const HEADER = /^(?:flowchart|graph)(?:\s+(TD|TB|BT|LR|RL))?$/i
const IGNORED = /^(?:classDef|class|style|linkStyle|click|accTitle|accDescr|direction)\b/
const ID = /^[A-Za-z0-9_À-￿](?:[A-Za-z0-9_.À-￿]|-(?=[A-Za-z0-9_]))*/u

type Opener = { open: string; close: readonly string[]; shape: NodeShape }
// Longest openers first, so "((" is not read as "(".
const OPENERS: readonly Opener[] = [
  { open: '(((', close: [')))'], shape: 'circle' },
  { open: '((', close: ['))'], shape: 'circle' },
  { open: '([', close: ['])'], shape: 'stadium' },
  { open: '[[', close: [']]'], shape: 'subroutine' },
  { open: '[(', close: [')]'], shape: 'cylinder' },
  { open: '[/', close: ['/]', '\\]'], shape: 'rect' },
  { open: '[\\', close: ['\\]', '/]'], shape: 'rect' },
  { open: '{{', close: ['}}'], shape: 'hexagon' },
  { open: '[', close: [']'], shape: 'rect' },
  { open: '(', close: [')'], shape: 'round' },
  { open: '{', close: ['}'], shape: 'diamond' },
  { open: '>', close: [']'], shape: 'flag' },
]

type Statement = { text: string; line: number; column: number }

class Fail extends Error {
  readonly at: number
  /** A limit was reached: later statements are not read. */
  readonly fatal: boolean
  constructor(at: number, message: string, fatal = false) {
    super(message)
    this.at = at
    this.fatal = fatal
  }
}

/** Mermaid labels: <br> becomes a space, other tags and markdown-string backticks go, #quot; style entities decode. */
function cleanLabel(raw: string): string {
  let text = raw.trim()
  if (text.startsWith('`') && text.endsWith('`') && text.length >= 2) text = text.slice(1, -1)
  return text
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/#quot;/g, '"')
    .replace(/#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Lines split into ';'-separated statements outside quotes, with their 1-based line and column. Full-line %% comments are dropped. */
function statementsOf(source: string): Statement[] {
  const out: Statement[] = []
  source.split(/\r?\n/).forEach((text, index) => {
    if (text.trim().startsWith('%%')) return
    let start = 0
    let quoted = false
    const push = (end: number) => {
      const piece = text.slice(start, end)
      const lead = piece.length - piece.trimStart().length
      if (piece.trim() !== '') out.push({ text: piece.trim(), line: index + 1, column: start + lead + 1 })
    }
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]
      if (ch === '"') quoted = !quoted
      else if (ch === ';' && !quoted) {
        push(i)
        start = i + 1
      }
    }
    push(text.length)
  })
  return out
}

type Link = { style: EdgeStyle | 'invisible'; head: boolean; tail: boolean; label: string }

class Parser {
  readonly nodes = new Map<string, GraphNode>()
  readonly edges: GraphEdge[] = []
  readonly subgraphs: Subgraph[] = []
  readonly stack: Subgraph[] = []
  private text = ''
  private pos = 0

  node(id: string, label?: string, shape?: NodeShape): void {
    const known = this.nodes.get(id)
    const group = this.stack[this.stack.length - 1]?.id ?? null
    if (known === undefined) {
      if (this.nodes.size >= MAX_NODES) throw new Fail(this.pos, `too many nodes (at most ${MAX_NODES}); keep the map to the parts that matter`, true)
      this.nodes.set(id, { id, label: label ?? id, shape: shape ?? 'rect', subgraph: group })
      return
    }
    if (label !== undefined) known.label = label
    if (shape !== undefined) known.shape = shape
    if (known.subgraph === null && group !== null) known.subgraph = group
  }

  statement(st: Statement): void {
    this.text = st.text
    this.pos = 0
    if (st.text === 'end') {
      if (this.stack.pop() === undefined) throw new Fail(0, '"end" without an open subgraph')
      return
    }
    const sub = /^subgraph(?:\s+(.*))?$/.exec(st.text)
    if (sub !== null) return this.subgraph(sub[1] ?? '')
    if (IGNORED.test(st.text)) return
    this.chain()
  }

  private subgraph(rest: string): void {
    const offset = this.text.length - rest.length
    const body = rest.trim()
    if (body === '') throw new Fail(offset, 'subgraph needs a name, e.g. subgraph api [API layer]')
    let id: string
    let label: string
    const quoted = /^"([^"]*)"$/.exec(body)
    const withLabel = /^([^\s[]+)\s*\[(?:"([^"]*)"|([^\]]*))\]$/.exec(body)
    if (quoted !== null) {
      label = cleanLabel(quoted[1] ?? '')
      id = `subgraph_${this.subgraphs.length + 1}`
    } else if (withLabel !== null) {
      id = withLabel[1] ?? body
      label = cleanLabel(withLabel[2] ?? withLabel[3] ?? id)
    } else {
      id = body
      label = cleanLabel(body)
    }
    const group: Subgraph = { id, label, parent: this.stack[this.stack.length - 1]?.id ?? null }
    this.subgraphs.push(group)
    this.stack.push(group)
  }

  private skipSpace(): void {
    while (this.pos < this.text.length && /\s/.test(this.text[this.pos] ?? '')) this.pos++
  }

  private chain(): void {
    let previous = this.group()
    for (;;) {
      this.skipSpace()
      if (this.pos >= this.text.length) return
      const link = this.link()
      if (link === null) throw new Fail(this.pos, `expected an arrow such as --> or the end of the statement, found "${this.text.slice(this.pos, this.pos + 12)}"`)
      const next = this.group()
      if (link.style !== 'invisible') {
        for (const from of previous) {
          for (const to of next) {
            if (this.edges.length >= MAX_EDGES) throw new Fail(this.pos, `too many edges (at most ${MAX_EDGES})`, true)
            this.edges.push({ from, to, label: link.label, style: link.style, head: link.head, tail: link.tail })
          }
        }
      }
      previous = next
    }
  }

  /** node ('&' node)* */
  private group(): string[] {
    const ids = [this.nodeRef()]
    for (;;) {
      this.skipSpace()
      if (this.text[this.pos] !== '&') return ids
      this.pos++
      ids.push(this.nodeRef())
    }
  }

  private nodeRef(): string {
    this.skipSpace()
    const match = ID.exec(this.text.slice(this.pos))
    if (match === null) throw new Fail(this.pos, `expected a node id (letters, digits, _), found "${this.text.slice(this.pos, this.pos + 12) || 'end of statement'}"`)
    const id = match[0]
    if (id === 'end' || id === 'subgraph') throw new Fail(this.pos, `"${id}" is a keyword and cannot be a node id; use another id with a label, e.g. ${id}_node["${id}"]`)
    this.pos += id.length
    const shaped = this.shape()
    if (shaped === null) this.node(id)
    else this.node(id, shaped.label === '' ? id : shaped.label, shaped.shape)
    const cls = /^:::[\w-]+/.exec(this.text.slice(this.pos))
    if (cls !== null) this.pos += cls[0].length
    return id
  }

  private shape(): { label: string; shape: NodeShape } | null {
    const rest = this.text.slice(this.pos)
    const opener = OPENERS.find(o => rest.startsWith(o.open))
    if (opener === undefined) return null
    const start = this.pos
    let at = this.pos + opener.open.length
    while (at < this.text.length && this.text[at] === ' ') at++
    let label: string
    if (this.text[at] === '"') {
      const end = this.text.indexOf('"', at + 1)
      if (end < 0) throw new Fail(at, 'unclosed quote in a node label')
      label = this.text.slice(at + 1, end)
      at = end + 1
      while (at < this.text.length && this.text[at] === ' ') at++
      const close = opener.close.find(c => this.text.startsWith(c, at))
      if (close === undefined) throw new Fail(at, `expected "${opener.close[0]}" after the quoted label`)
      this.pos = at + close.length
    } else {
      let best = -1
      let closeLength = 0
      for (const close of opener.close) {
        const found = this.text.indexOf(close, at)
        if (found >= 0 && (best < 0 || found < best)) {
          best = found
          closeLength = close.length
        }
      }
      if (best < 0) throw new Fail(start, `unclosed node label: expected "${opener.close[0]}"`)
      label = this.text.slice(at, best)
      this.pos = best + closeLength
    }
    return { label: cleanLabel(label), shape: opener.shape }
  }

  private link(): Link | null {
    const rest = this.text.slice(this.pos)
    // Text forms: "-- text -->", "-. text .->", "== text ==>".
    const textForms: { open: RegExp; close: RegExp; style: EdgeStyle }[] = [
      { open: /^(<?)--\s+/, close: /(-{2,})([>ox])|-{3,}/, style: 'solid' },
      { open: /^(<?)-\.\s+/, close: /\.-+([>ox])?/, style: 'dotted' },
      { open: /^(<?)==\s+/, close: /(={2,})([>ox])|={3,}/, style: 'thick' },
    ]
    for (const form of textForms) {
      const open = form.open.exec(rest)
      if (open === null) continue
      const after = rest.slice(open[0].length)
      const close = form.close.exec(after)
      if (close === null) throw new Fail(this.pos, 'edge text is not closed: write "-- text -->" or "-->|text|"')
      const head = form.style === 'dotted' ? close[1] !== undefined : close[2] !== undefined
      this.pos += open[0].length + close.index + close[0].length
      return { style: form.style, head, tail: open[1] === '<', label: cleanLabel(after.slice(0, close.index)) }
    }
    const plain: { re: RegExp; style: Link['style'] }[] = [
      { re: /^(<?)-{2,}([>ox])/, style: 'solid' },
      { re: /^(<?)-{3,}()/, style: 'solid' },
      { re: /^(<?)-\.+-([>ox])?/, style: 'dotted' },
      { re: /^(<?)={2,}([>ox])/, style: 'thick' },
      { re: /^(<?)={3,}()/, style: 'thick' },
      { re: /^()~{3,}()/, style: 'invisible' },
    ]
    for (const { re, style } of plain) {
      const match = re.exec(rest)
      if (match === null) continue
      this.pos += match[0].length
      let label = ''
      const pipe = /^\s*\|([^|]*)\|/.exec(this.text.slice(this.pos))
      if (pipe !== null) {
        label = cleanLabel(pipe[1] ?? '')
        this.pos += pipe[0].length
      }
      return { style, head: (match[2] ?? '') !== '', tail: match[1] === '<', label }
    }
    return null
  }
}

/** A leading YAML block (---, title: ..., ---) is blanked, keeping line numbers. */
function withoutFrontmatter(source: string): string {
  const lines = source.split(/\r?\n/)
  const first = lines.findIndex(line => line.trim() !== '')
  if (first < 0 || lines[first]?.trim() !== '---') return source
  const end = lines.findIndex((line, i) => i > first && line.trim() === '---')
  if (end < 0) return source
  return lines.map((line, i) => (i >= first && i <= end ? '' : line)).join('\n')
}

/** Parses a Mermaid flowchart. Errors carry 1-based line and column and say what to write instead. */
export function parseFlowchart(source: string): ParseResult {
  const statements = statementsOf(withoutFrontmatter(source))
  const first = statements[0]
  if (first === undefined) return { ok: false, errors: [{ line: 1, column: 1, message: 'empty diagram: start with "flowchart LR" or "flowchart TD"' }] }
  const header = HEADER.exec(first.text)
  if (header === null) {
    const other = OTHER_DIAGRAMS.exec(first.text)
    const message = other !== null
      ? `"${other[1]}" diagrams are not supported here: the map is a flowchart. Start with "flowchart LR" or "flowchart TD"`
      : `expected "flowchart LR" or "flowchart TD" (also graph, TB, BT, RL) as the first line, found "${first.text.slice(0, 30)}"`
    return { ok: false, errors: [{ line: first.line, column: first.column, message }] }
  }
  const dir = (header[1] ?? 'TD').toUpperCase()
  const direction: Direction = dir === 'TB' ? 'TD' : (dir as Direction)
  const parser = new Parser()
  const errors: ParseError[] = []
  for (const st of statements.slice(1)) {
    try {
      parser.statement(st)
    } catch (error) {
      if (!(error instanceof Fail)) throw error
      errors.push({ line: st.line, column: st.column + error.at, message: error.message })
      if (errors.length >= MAX_ERRORS || error.fatal) break
    }
  }
  const last = statements[statements.length - 1]
  for (const open of parser.stack) {
    errors.push({ line: last?.line ?? 1, column: 1, message: `subgraph "${open.id}" is not closed: add "end"` })
  }
  if (errors.length > 0) return { ok: false, errors: errors.slice(0, MAX_ERRORS) }
  return { ok: true, graph: { direction, nodes: [...parser.nodes.values()], edges: parser.edges, subgraphs: parser.subgraphs } }
}

export function formatParseErrors(errors: readonly ParseError[]): string {
  return errors.map(error => `line ${error.line}, column ${error.column}: ${error.message}`).join('; ')
}

// ---------------------------------------------------------------------------
// Text forms that need no layout
// ---------------------------------------------------------------------------

const PLAIN_ARROWS: Record<EdgeStyle, [string, string]> = { solid: ['-->', '---'], dotted: ['-.->', '-.-'], thick: ['==>', '==='] }
const LABEL_ARROWS: Record<EdgeStyle, [string, string]> = { solid: ['--', '-->'], dotted: ['-.', '.->'], thick: ['==', '==>'] }

/** "a --calls--> b", "a -.-> b", "a <==> b": Mermaid's own arrow spelling. */
function arrowText(edge: GraphEdge): string {
  const tail = edge.tail ? '<' : ''
  if (edge.label === '') {
    const [head, open] = PLAIN_ARROWS[edge.style]
    return tail + (edge.head ? head : open)
  }
  const [start, end] = LABEL_ARROWS[edge.style]
  return `${tail}${start}${edge.label}${edge.head ? end : end.slice(0, -1) + end[end.length - 2]}`
}

/** One line per edge ("a --calls--> b"), then unlinked nodes, then groups: the list the drawing falls back to, and its alt text. */
export function adjacencyLines(graph: Graph): string[] {
  const label = new Map(graph.nodes.map(node => [node.id, node.label]))
  const name = (id: string) => label.get(id) ?? id
  const lines = graph.edges.map(edge => `${name(edge.from)} ${arrowText(edge)} ${name(edge.to)}`)
  const linked = new Set(graph.edges.flatMap(edge => [edge.from, edge.to]))
  for (const node of graph.nodes) if (!linked.has(node.id)) lines.push(`${node.label} (no links)`)
  for (const group of graph.subgraphs) {
    const members = graph.nodes.filter(node => node.subgraph === group.id).map(node => node.label)
    if (members.length > 0) lines.push(`Group ${group.label}: ${members.join(', ')}`)
  }
  return lines
}

// ---------------------------------------------------------------------------
// Display width (wide CJK and emoji take two cells)
// ---------------------------------------------------------------------------

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  )
}

export function displayWidth(text: string): number {
  let width = 0
  for (const ch of text) width += isWide(ch.codePointAt(0) ?? 0) ? 2 : 1
  return width
}

/** At most `max` cells, with an ellipsis when cut. */
function clip(text: string, max: number, ascii: boolean): string {
  if (displayWidth(text) <= max) return text
  const dots = ascii ? '...' : '…'
  let out = ''
  for (const ch of text) {
    if (displayWidth(out + ch) + displayWidth(dots) > max) break
    out += ch
  }
  return out + dots
}

/** Words wrapped to `width` cells, at most `maxLines` lines (the last one clipped). Long words break. */
function wrap(text: string, width: number, maxLines: number, ascii: boolean): string[] {
  const lines: string[] = []
  let current = ''
  for (const word of text.split(' ').filter(w => w !== '')) {
    let piece = word
    while (displayWidth(piece) > width) {
      if (current !== '') {
        lines.push(current)
        current = ''
      }
      let head = ''
      for (const ch of piece) {
        if (displayWidth(head + ch) > width) break
        head += ch
      }
      // Paths break after a separator when one is near the end: "test/" + "sum.test.js", not "test/sum.tes" + "t.js".
      const cut = Math.max(head.lastIndexOf('/'), head.lastIndexOf('.'), head.lastIndexOf('-'), head.lastIndexOf('_'))
      if (cut >= Math.floor(head.length / 3) && cut < head.length - 1) head = head.slice(0, cut + 1)
      lines.push(head)
      piece = piece.slice(head.length)
    }
    if (current === '') current = piece
    else if (displayWidth(`${current} ${piece}`) <= width) current = `${current} ${piece}`
    else {
      lines.push(current)
      current = piece
    }
  }
  if (current !== '' || lines.length === 0) lines.push(current)
  if (lines.length <= maxLines) return lines
  const kept = lines.slice(0, maxLines)
  kept[maxLines - 1] = clip(`${kept[maxLines - 1] ?? ''} ${lines.slice(maxLines).join(' ')}`, width, ascii)
  return kept
}

// ---------------------------------------------------------------------------
// Layered layout on a cell grid
// ---------------------------------------------------------------------------

type LNode = {
  key: number
  node: GraphNode | null // null: a dummy point of a long edge
  lines: string[]
  rank: number
  /** Size along the cross axis (TD: columns; LR: rows) and along the main axis. */
  cross: number
  main: number
  pos: number // cross coordinate of the first cell
  mainPos: number // main coordinate of the first cell
}
type Chain = { edge: GraphEdge; keys: number[]; reversed: boolean }

type Point = { row: number; col: number }
export type LayoutBox = { id: string; label: string[]; shape: NodeShape; top: number; left: number; bottom: number; right: number; subgraph: string | null }
export type LayoutEdge = { edge: GraphEdge; points: Point[]; headAtEnd: boolean; headAtStart: boolean }
export type LayoutLabel = { text: string; row: number; col: number }
export type Layout = {
  rows: number
  cols: number
  boxes: LayoutBox[]
  edges: LayoutEdge[]
  labels: LayoutLabel[]
  /** Edge labels that found no room in the drawing ("a --calls--> b"). */
  unplaced: string[]
  /** Self-loops are listed, not drawn. */
  loops: string[]
}

type LayoutOptions = { direction: Direction; labelWidth: number; ascii: boolean }

function edgeKey(a: number, b: number): string {
  return `${a}>${b}`
}

/** Lays the graph out on a grid of cells. Row and column 0 are the top-left; boxes include their border cells. */
export function layoutGraph(graph: Graph, options: LayoutOptions): Layout {
  const vertical = options.direction === 'TD' || options.direction === 'BT'
  const index = new Map(graph.nodes.map((node, i) => [node.id, i]))
  const lnodes: LNode[] = graph.nodes.map((node, key) => ({
    key,
    node,
    lines: wrap(node.label, options.labelWidth, 3, options.ascii),
    rank: 0,
    cross: 0,
    main: 0,
    pos: 0,
    mainPos: 0,
  }))
  const loops: string[] = []
  const drawn: GraphEdge[] = []
  for (const edge of graph.edges) {
    if (edge.from === edge.to) loops.push(`${lnodes[index.get(edge.from) ?? 0]?.node?.label ?? edge.from} loops to itself${edge.label === '' ? '' : ` (${edge.label})`}`)
    else drawn.push(edge)
  }

  // 1. Cycle breaking: DFS in declaration order; an edge to a node on the stack is reversed.
  const out = new Map<number, number[]>()
  for (const edge of drawn) {
    const a = index.get(edge.from) ?? 0
    const b = index.get(edge.to) ?? 0
    out.set(a, [...(out.get(a) ?? []), b])
  }
  const reversed = new Set<string>()
  const state = new Array<number>(lnodes.length).fill(0)
  const visit = (start: number) => {
    const stack: { v: number; i: number }[] = [{ v: start, i: 0 }]
    state[start] = 1
    while (stack.length > 0) {
      const top = stack[stack.length - 1]
      if (top === undefined) break
      const next = out.get(top.v)?.[top.i]
      if (next === undefined) {
        state[top.v] = 2
        stack.pop()
        continue
      }
      top.i++
      if (state[next] === 1) reversed.add(edgeKey(top.v, next))
      else if (state[next] === 0) {
        state[next] = 1
        stack.push({ v: next, i: 0 })
      }
    }
  }
  for (let v = 0; v < lnodes.length; v++) if (state[v] === 0) visit(v)

  const dag: [number, number][] = drawn.map(edge => {
    const a = index.get(edge.from) ?? 0
    const b = index.get(edge.to) ?? 0
    return reversed.has(edgeKey(a, b)) ? [b, a] : [a, b]
  })

  // 2. Ranks: longest path from the sources, then sources pulled down next to their first successor.
  const preds = new Map<number, number[]>()
  const succs = new Map<number, number[]>()
  for (const [a, b] of dag) {
    preds.set(b, [...(preds.get(b) ?? []), a])
    succs.set(a, [...(succs.get(a) ?? []), b])
  }
  const indegree = lnodes.map(n => preds.get(n.key)?.length ?? 0)
  const queue = lnodes.filter(n => indegree[n.key] === 0).map(n => n.key)
  const topo: number[] = []
  while (queue.length > 0) {
    const v = queue.shift() as number
    topo.push(v)
    for (const w of succs.get(v) ?? []) {
      const node = lnodes[w] as LNode
      node.rank = Math.max(node.rank, (lnodes[v] as LNode).rank + 1)
      indegree[w] = (indegree[w] ?? 0) - 1
      if (indegree[w] === 0) queue.push(w)
    }
  }
  for (const v of [...topo].reverse()) {
    const node = lnodes[v] as LNode
    const next = succs.get(v) ?? []
    if ((preds.get(v)?.length ?? 0) === 0 && next.length > 0) {
      node.rank = Math.min(...next.map(w => (lnodes[w] as LNode).rank)) - 1
    }
  }

  // 3. Long edges get a dummy node per rank they cross.
  const all: LNode[] = [...lnodes]
  const chains: Chain[] = drawn.map((edge, i) => {
    const [a, b] = dag[i] as [number, number]
    const keys = [a]
    for (let r = (lnodes[a] as LNode).rank + 1; r < (lnodes[b] as LNode).rank; r++) {
      const dummy: LNode = { key: all.length, node: null, lines: [], rank: r, cross: 1, main: 0, pos: 0, mainPos: 0 }
      all.push(dummy)
      keys.push(dummy.key)
    }
    keys.push(b)
    return { edge, keys, reversed: a !== (index.get(edge.from) ?? 0) }
  })
  const maxRank = Math.max(0, ...all.map(n => n.rank))
  const layers: number[][] = Array.from({ length: maxRank + 1 }, () => [])
  for (const n of all) (layers[n.rank] as number[]).push(n.key)

  const up = new Map<number, number[]>()
  const down = new Map<number, number[]>()
  for (const chain of chains) {
    for (let i = 0; i + 1 < chain.keys.length; i++) {
      const a = chain.keys[i] as number
      const b = chain.keys[i + 1] as number
      down.set(a, [...(down.get(a) ?? []), b])
      up.set(b, [...(up.get(b) ?? []), a])
    }
  }

  // 4. Ordering: barycenter sweeps, subgraph members kept together, best crossing count wins.
  const order = new Map<number, number>()
  const setOrder = () => layers.forEach(layer => layer.forEach((k, i) => order.set(k, i)))
  setOrder()
  const crossings = (): number => {
    let total = 0
    for (let r = 0; r < maxRank; r++) {
      const segs: [number, number][] = []
      for (const a of layers[r] ?? []) for (const b of down.get(a) ?? []) segs.push([order.get(a) ?? 0, order.get(b) ?? 0])
      for (let i = 0; i < segs.length; i++) {
        for (let j = i + 1; j < segs.length; j++) {
          const [a1, b1] = segs[i] as [number, number]
          const [a2, b2] = segs[j] as [number, number]
          if ((a1 - a2) * (b1 - b2) < 0) total++
        }
      }
    }
    return total
  }
  const groupOf = (k: number) => all[k]?.node?.subgraph ?? null
  let best = layers.map(layer => [...layer])
  let bestCount = crossings()
  const sweeps = down.size + all.length > 400 ? 4 : 12
  for (let iter = 0; iter < sweeps && bestCount > 0; iter++) {
    const downward = iter % 2 === 0
    const range = downward ? [...Array(maxRank).keys()].map(i => i + 1) : [...Array(maxRank).keys()].reverse()
    for (const r of range) {
      const layer = layers[r] as number[]
      const ref = downward ? up : down
      const bary = new Map<number, number>()
      for (const k of layer) {
        const ns = ref.get(k) ?? []
        bary.set(k, ns.length === 0 ? (order.get(k) ?? 0) : ns.reduce((s, n) => s + (order.get(n) ?? 0), 0) / ns.length)
      }
      const groupMean = new Map<string, number>()
      for (const k of layer) {
        const g = groupOf(k)
        if (g === null || groupMean.has(g)) continue
        const members = layer.filter(m => groupOf(m) === g)
        groupMean.set(g, members.reduce((s, m) => s + (bary.get(m) ?? 0), 0) / members.length)
      }
      const sortKey = (k: number) => {
        const g = groupOf(k)
        return g === null ? (bary.get(k) ?? 0) : (groupMean.get(g) ?? 0) + (bary.get(k) ?? 0) * 1e-6
      }
      layer.sort((a, b) => sortKey(a) - sortKey(b) || (order.get(a) ?? 0) - (order.get(b) ?? 0))
      layer.forEach((k, i) => order.set(k, i))
    }
    const count = crossings()
    if (count < bestCount) {
      bestCount = count
      best = layers.map(layer => [...layer])
    }
  }
  best.forEach((layer, r) => (layers[r] = layer))
  setOrder()

  // 5. Ports: each node's out-edges and in-edges get distinct cross positions, sorted by the far end.
  const outPorts = new Map<number, number[]>() // key -> successor keys in port order
  const inPorts = new Map<number, number[]>()
  for (const [k, list] of down) outPorts.set(k, [...list])
  for (const [k, list] of up) inPorts.set(k, [...list])
  const labelOf = (a: number, b: number) => chains.find(c => c.keys[0] === a && c.keys[1] === b)?.edge.label ?? ''

  // Sizes. TD: cross = width, main = height. LR: cross = height, main = width.
  for (const n of all) {
    if (n.node === null) continue
    const textWidth = Math.max(...n.lines.map(displayWidth))
    const outs = outPorts.get(n.key)?.length ?? 0
    const ins = inPorts.get(n.key)?.length ?? 0
    if (vertical) {
      n.cross = Math.max(textWidth + 4, 2 * Math.max(outs, ins) + 1)
      n.main = n.lines.length + 2
    } else {
      n.cross = Math.max(n.lines.length, outs) + 2
      n.main = textWidth + 4
    }
  }

  // 6. Cross coordinates: centre each node on its neighbours, then push apart.
  const gap = vertical ? 2 : 1
  const center = (k: number) => {
    const n = all[k] as LNode
    return n.pos + (n.cross - 1) / 2
  }
  for (const layer of layers) {
    let at = 0
    for (const k of layer) {
      const n = all[k] as LNode
      n.pos = at
      at += n.cross + gap
    }
  }
  const place = (layer: number[], desired: Map<number, number>) => {
    for (const k of layer) {
      const n = all[k] as LNode
      n.pos = Math.round((desired.get(k) ?? center(k)) - (n.cross - 1) / 2)
    }
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 1; i < layer.length; i++) {
        const prev = all[layer[i - 1] as number] as LNode
        const n = all[layer[i] as number] as LNode
        n.pos = Math.max(n.pos, prev.pos + prev.cross + gap)
      }
      if (pass === 0) {
        for (let i = layer.length - 2; i >= 0; i--) {
          const next = all[layer[i + 1] as number] as LNode
          const n = all[layer[i] as number] as LNode
          n.pos = Math.min(n.pos, next.pos - gap - n.cross)
        }
      }
    }
  }
  for (let iter = 0; iter < 8; iter++) {
    const downward = iter % 2 === 0
    const range = downward ? [...Array(maxRank + 1).keys()] : [...Array(maxRank + 1).keys()].reverse()
    for (const r of range) {
      const layer = layers[r] as number[]
      const desired = new Map<number, number>()
      for (const k of layer) {
        const ns = [...(up.get(k) ?? []), ...(down.get(k) ?? [])]
        if (ns.length > 0) desired.set(k, ns.reduce((s, m) => s + center(m), 0) / ns.length)
      }
      place(layer, desired)
    }
  }
  const minPos = Math.min(...all.map(n => n.pos))
  for (const n of all) n.pos -= minPos

  const portsOn = (k: number, side: 'out' | 'in'): Map<number, number> => {
    const n = all[k] as LNode
    const list = [...((side === 'out' ? outPorts : inPorts).get(k) ?? [])].sort((a, b) => center(a) - center(b))
    const result = new Map<number, number>()
    if (n.node === null) {
      for (const other of list) result.set(other, n.pos)
      return result
    }
    const inner = n.cross - 2
    list.forEach((other, i) => {
      const offset = list.length === 1 ? Math.floor((inner - 1) / 2) : Math.min(inner - 1, Math.floor((i * inner) / list.length + inner / (2 * list.length)))
      result.set(other, n.pos + 1 + Math.max(0, offset))
    })
    return result
  }
  const outPos = new Map<number, Map<number, number>>()
  const inPos = new Map<number, Map<number, number>>()
  for (const n of all) {
    outPos.set(n.key, portsOn(n.key, 'out'))
    inPos.set(n.key, portsOn(n.key, 'in'))
  }

  // 7. Main coordinates: bands of ranks with routing channels between them.
  type Seg = { a: number; b: number; from: number; to: number; track: number; label: string }
  const channels: Seg[][] = []
  for (let r = 0; r < maxRank; r++) {
    const segs: Seg[] = []
    for (const a of layers[r] ?? []) {
      for (const b of down.get(a) ?? []) {
        const label = all[a]?.node !== null ? labelOf(a, b) : ''
        segs.push({ a: outPos.get(a)?.get(b) ?? 0, b: inPos.get(b)?.get(a) ?? 0, from: a, to: b, track: -1, label })
      }
    }
    // Interval colouring: a bent segment takes the first track free over its span (plus one cell of air).
    const ends: number[] = []
    for (const seg of segs.filter(s => s.a !== s.b).sort((x, y) => Math.min(x.a, x.b) - Math.min(y.a, y.b) || x.b - y.b)) {
      const lo = Math.min(seg.a, seg.b)
      const hi = Math.max(seg.a, seg.b)
      let t = ends.findIndex(end => end < lo - 1)
      if (t < 0) {
        t = ends.length
        ends.push(hi)
      } else ends[t] = hi
      seg.track = t
    }
    channels.push(segs)
  }
  const bandSize = layers.map(layer => Math.max(1, ...layer.map(k => (all[k] as LNode).main)))
  const labelZone = channels.map(segs => {
    const widest = Math.max(0, ...segs.map(s => (s.label === '' ? 0 : displayWidth(clip(s.label, 16, options.ascii)))))
    if (widest === 0) return 0
    return vertical ? 1 : widest + 2
  })
  const trackCount = channels.map(segs => Math.max(0, ...segs.map(s => s.track + 1)))
  const bandStart: number[] = []
  let cursor = 0
  for (let r = 0; r <= maxRank; r++) {
    bandStart.push(cursor)
    cursor += bandSize[r] ?? 1
    if (r < maxRank) cursor += 1 + (labelZone[r] ?? 0) + (trackCount[r] ?? 0) + 1
  }
  const mainTotal = cursor
  for (const n of all) {
    const start = bandStart[n.rank] ?? 0
    const size = bandSize[n.rank] ?? 1
    if (n.node === null) {
      n.mainPos = start
      n.main = size
    } else n.mainPos = start + Math.floor((size - n.main) / 2)
  }
  const crossTotal = Math.max(1, ...all.map(n => n.pos + n.cross))

  // Main/cross to row/col, mirrored for BT and RL.
  const mirror = options.direction === 'BT' || options.direction === 'RL'
  const toPoint = (main: number, cross: number): Point => {
    const m = mirror ? mainTotal - 1 - main : main
    return vertical ? { row: m, col: cross } : { row: cross, col: m }
  }

  // 8. Edge paths, one polyline per chain, from the cell next to the first box to the cell next to the last.
  const edges: LayoutEdge[] = []
  const labels: LayoutLabel[] = []
  const unplaced: string[] = []
  const taken: { row: number; from: number; to: number }[] = []
  const pending: { seg: Seg; r: number }[] = []
  for (const chain of chains) {
    const points: Point[] = []
    const push = (main: number, cross: number) => {
      const p = toPoint(main, cross)
      const last = points[points.length - 1]
      if (last === undefined || last.row !== p.row || last.col !== p.col) points.push(p)
    }
    for (let i = 0; i + 1 < chain.keys.length; i++) {
      const a = all[chain.keys[i] as number] as LNode
      const b = all[chain.keys[i + 1] as number] as LNode
      const r = a.rank
      const seg = (channels[r] ?? []).find(s => s.from === a.key && s.to === b.key) as Seg
      const startMain = a.node === null ? a.mainPos : a.mainPos + a.main
      if (i === 0) push(startMain, seg.a)
      const channelStart = (bandStart[r] ?? 0) + (bandSize[r] ?? 1)
      const trackMain = channelStart + 1 + (labelZone[r] ?? 0) + seg.track
      if (seg.a !== seg.b) {
        push(trackMain, seg.a)
        push(trackMain, seg.b)
      }
      const endMain = b.node === null ? b.mainPos + b.main - 1 : b.mainPos - 1
      push(endMain, seg.b)
      if (i === 0 && seg.label !== '') pending.push({ seg, r })
    }
    const startsAtFrom = !chain.reversed
    const headAtEnd = startsAtFrom ? chain.edge.head : chain.edge.tail
    const headAtStart = startsAtFrom ? chain.edge.tail : chain.edge.head
    edges.push({ edge: chain.edge, points, headAtEnd, headAtStart })
  }

  // 9. Edge labels: LR on the first horizontal run (always room by construction); TD on the label row, if free.
  for (const { seg, r } of pending) {
    const text = clip(seg.label, 16, options.ascii)
    const width = displayWidth(text)
    const channelStart = (bandStart[r] ?? 0) + (bandSize[r] ?? 1)
    if (!vertical) {
      const p = toPoint(channelStart + 1 + Math.floor(((labelZone[r] ?? 0) - width) / 2), seg.a)
      labels.push({ text, row: p.row, col: mirror ? p.col - width + 1 : p.col })
      continue
    }
    const labelMain = channelStart + 1
    const p = toPoint(labelMain, seg.a)
    const lines = (channels[r] ?? []).map(s => s.a)
    // Beside the line (right, then left), else over it; never over another edge's line or label.
    const overlay = seg.a - Math.floor(width / 2)
    const fits = (from: number) => {
      const to = from + width - 1
      if (from < 0) return false
      if (lines.some(x => x >= from && x <= to && (x !== seg.a || from !== overlay))) return false
      return !taken.some(t => t.row === p.row && !(to < t.from - 1 || from > t.to + 1))
    }
    const from = [seg.a + 1, seg.a - width, overlay].find(fits)
    if (from === undefined) {
      const chain = chains.find(c => c.keys[0] === seg.from && c.keys[1] === seg.to)
      const name = (id: string | undefined) => graph.nodes.find(n => n.id === id)?.label ?? id ?? ''
      unplaced.push(`${name(chain?.edge.from)} --${seg.label}--> ${name(chain?.edge.to)}`)
      continue
    }
    taken.push({ row: p.row, from, to: from + width - 1 })
    labels.push({ text, row: p.row, col: from })
  }

  const boxes: LayoutBox[] = []
  for (const n of all) {
    if (n.node === null) continue
    const a = toPoint(n.mainPos, n.pos)
    const b = toPoint(n.mainPos + n.main - 1, n.pos + n.cross - 1)
    boxes.push({
      id: n.node.id,
      label: n.lines,
      shape: n.node.shape,
      top: Math.min(a.row, b.row),
      bottom: Math.max(a.row, b.row),
      left: Math.min(a.col, b.col),
      right: Math.max(a.col, b.col),
      subgraph: n.node.subgraph,
    })
  }
  const rows = vertical ? mainTotal : crossTotal
  const labelRight = Math.max(0, ...labels.map(l => l.col + displayWidth(l.text)))
  const cols = Math.max(vertical ? crossTotal : mainTotal, labelRight)
  return { rows, cols, boxes, edges, labels, unplaced, loops }
}

// ---------------------------------------------------------------------------
// Text drawing
// ---------------------------------------------------------------------------

const N = 1
const E = 2
const S = 4
const W = 8

type Glyphs = { lines: Record<EdgeStyle, Record<number, string>>; arrows: Record<'up' | 'down' | 'left' | 'right', string> }

function lineSet(v: string, h: string, corners: string, tees: string, all: string): Record<number, string> {
  const [ne, nw, se, sw] = [...corners] as [string, string, string, string]
  const [nse, nsw, ews, ewn] = [...tees] as [string, string, string, string]
  return {
    [N]: v, [S]: v, [N | S]: v, [E]: h, [W]: h, [E | W]: h,
    [N | E]: ne, [N | W]: nw, [S | E]: se, [S | W]: sw,
    [N | S | E]: nse, [N | S | W]: nsw, [E | W | S]: ews, [E | W | N]: ewn, [N | E | S | W]: all,
  }
}

const UNICODE: Glyphs = {
  lines: {
    solid: lineSet('│', '─', '╰╯╭╮', '├┤┬┴', '┼'),
    dotted: lineSet('┊', '┄', '╰╯╭╮', '├┤┬┴', '┼'),
    thick: lineSet('┃', '━', '┗┛┏┓', '┣┫┳┻', '╋'),
  },
  arrows: { up: '▲', down: '▼', left: '◀', right: '▶' },
}

const ASCII: Glyphs = {
  lines: {
    solid: lineSet('|', '-', '++++', '++++', '+'),
    dotted: lineSet(':', '.', '++++', '++++', '+'),
    thick: lineSet('H', '=', '++++', '++++', '+'),
  },
  arrows: { up: '^', down: 'v', left: '<', right: '>' },
}

type BoxGlyphs = { tl: string; tr: string; bl: string; br: string; h: string; v: string }
function boxGlyphs(shape: NodeShape, stale: boolean, ascii: boolean): BoxGlyphs {
  if (ascii) {
    if (shape === 'diamond' || shape === 'hexagon' || shape === 'flag') return { tl: '/', tr: '\\', bl: '\\', br: '/', h: '-', v: '|' }
    if (stale) return { tl: '#', tr: '#', bl: '#', br: '#', h: '=', v: '#' }
    return shape === 'rect' ? { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|' } : { tl: '(', tr: ')', bl: '(', br: ')', h: '-', v: '|' }
  }
  if (stale) return { tl: '┏', tr: '┓', bl: '┗', br: '┛', h: '━', v: '┃' }
  switch (shape) {
    case 'round':
    case 'stadium':
    case 'circle':
      return { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' }
    case 'diamond':
    case 'hexagon':
    case 'flag':
      return { tl: '╱', tr: '╲', bl: '╲', br: '╱', h: '─', v: '│' }
    case 'subroutine':
    case 'cylinder':
      return { tl: '╔', tr: '╗', bl: '╚', br: '╝', h: '═', v: '║' }
    default:
      return { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│' }
  }
}

type Cell = { ch: string; mask: number; style: EdgeStyle | null; fixed: boolean }

/** The direction of travel from a to b, one axis at a time. */
function dirOf(a: Point, b: Point): 'up' | 'down' | 'left' | 'right' {
  if (b.row > a.row) return 'down'
  if (b.row < a.row) return 'up'
  return b.col > a.col ? 'right' : 'left'
}
const OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left' } as const

/** Draws a laid-out graph as lines of text; trailing spaces trimmed. */
export function drawLayout(layout: Layout, options: { ascii?: boolean; marks?: Readonly<Record<string, NodeMark>> } = {}): string[] {
  const ascii = options.ascii === true
  const glyphs = ascii ? ASCII : UNICODE
  const grid: Cell[][] = Array.from({ length: layout.rows }, () => Array.from({ length: layout.cols }, () => ({ ch: ' ', mask: 0, style: null, fixed: false })))
  const cell = (p: Point) => grid[p.row]?.[p.col]
  const put = (row: number, col: number, ch: string) => {
    const c = grid[row]?.[col]
    if (c === undefined) return
    c.ch = ch
    c.fixed = true
  }

  for (const { edge, points } of layout.edges) {
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i] as Point
      const b = points[i + 1] as Point
      const dRow = Math.sign(b.row - a.row)
      const dCol = Math.sign(b.col - a.col)
      const forward = dRow > 0 ? S : dRow < 0 ? N : dCol > 0 ? E : W
      const back = forward === S ? N : forward === N ? S : forward === E ? W : E
      let p = a
      for (;;) {
        const c = cell(p)
        const atEnd = p.row === b.row && p.col === b.col
        if (c !== undefined && !c.fixed) {
          c.mask |= atEnd ? back : p === a ? forward : forward | back
          if (atEnd && p !== a) c.mask |= back
          c.style ??= edge.style
        }
        if (atEnd) break
        p = { row: p.row + dRow, col: p.col + dCol }
      }
    }
    if (points.length === 1) {
      const c = cell(points[0] as Point)
      if (c !== undefined) {
        c.mask |= N | S | E | W
        c.style ??= edge.style
      }
    }
  }
  for (const row of grid) {
    for (const c of row) {
      if (c.mask !== 0 && !c.fixed) {
        const set = glyphs.lines[c.style ?? 'solid']
        c.ch = set[c.mask] ?? set[c.mask & (N | S)] ?? set[E | W] ?? '+'
      }
    }
  }
  // Arrowheads point into the box they reach.
  for (const { points, headAtEnd, headAtStart } of layout.edges) {
    const first = points[0]
    const last = points[points.length - 1]
    if (first === undefined || last === undefined) continue
    const lead = points.length > 1 ? dirOf(points[points.length - 2] as Point, last) : 'down'
    const tail = points.length > 1 ? OPPOSITE[dirOf(first, points[1] as Point)] : 'up'
    if (headAtEnd) put(last.row, last.col, glyphs.arrows[lead])
    if (headAtStart) put(first.row, first.col, glyphs.arrows[tail])
  }
  for (const label of layout.labels) {
    let col = label.col
    for (const ch of label.text) {
      put(label.row, col, ch)
      if (isWide(ch.codePointAt(0) ?? 0)) put(label.row, col + 1, '')
      col += isWide(ch.codePointAt(0) ?? 0) ? 2 : 1
    }
  }
  for (const box of layout.boxes) {
    const stale = options.marks?.[box.id]?.stale === true
    const g = boxGlyphs(box.shape, stale, ascii)
    for (let c = box.left + 1; c < box.right; c++) {
      put(box.top, c, g.h)
      put(box.bottom, c, g.h)
    }
    for (let r = box.top + 1; r < box.bottom; r++) {
      put(r, box.left, g.v)
      put(r, box.right, g.v)
      for (let c = box.left + 1; c < box.right; c++) put(r, c, ' ')
    }
    put(box.top, box.left, g.tl)
    put(box.top, box.right, g.tr)
    put(box.bottom, box.left, g.bl)
    put(box.bottom, box.right, g.br)
    const inner = box.right - box.left - 1
    const height = box.bottom - box.top - 1
    const firstRow = box.top + 1 + Math.floor((height - box.label.length) / 2)
    box.label.forEach((line, i) => {
      let col = box.left + 1 + Math.floor((inner - displayWidth(line)) / 2)
      for (const ch of line) {
        put(firstRow + i, col, ch)
        if (isWide(ch.codePointAt(0) ?? 0)) put(firstRow + i, col + 1, '')
        col += isWide(ch.codePointAt(0) ?? 0) ? 2 : 1
      }
    })
  }
  return grid.map(row => row.map(c => c.ch).join('').trimEnd())
}

const FALLBACK_DIRECTION: Record<Direction, Direction> = { LR: 'TD', RL: 'BT', TD: 'LR', BT: 'RL' }

/** The best layout that fits `columns`: the declared direction, then the other axis, then narrower labels. Null when none fits. */
export function fitLayout(graph: Graph, options: DrawOptions = {}): Layout | null {
  const ascii = options.ascii === true
  const limit = options.columns ?? Number.POSITIVE_INFINITY
  const attempts: { direction: Direction; labelWidth: number }[] = [
    { direction: graph.direction, labelWidth: 22 },
    { direction: FALLBACK_DIRECTION[graph.direction], labelWidth: 22 },
    { direction: graph.direction, labelWidth: 16 },
    { direction: FALLBACK_DIRECTION[graph.direction], labelWidth: 16 },
    { direction: FALLBACK_DIRECTION[graph.direction], labelWidth: 12 },
    { direction: FALLBACK_DIRECTION[graph.direction], labelWidth: 9 },
  ]
  for (const attempt of attempts) {
    const layout = layoutGraph(graph, { ...attempt, ascii })
    if (layout.cols <= limit) return layout
  }
  return null
}

/** The diagram as text lines that fit `columns`, with notes for labels and loops it could not draw; null when it cannot fit. */
export function drawText(graph: Graph, options: DrawOptions = {}): string[] | null {
  if (graph.nodes.length === 0) return ['(empty diagram)']
  if (graph.nodes.length > MAX_DRAWN_NODES) return null
  const layout = fitLayout(graph, options)
  if (layout === null) return null
  const lines = drawLayout(layout, options)
  const notes = [...layout.unplaced.map(text => `  ${text}`), ...layout.loops.map(text => `  ${text}`)]
  if (notes.length > 0) lines.push('', 'Not drawn:', ...notes)
  if (options.marks !== undefined && Object.values(options.marks).some(mark => mark.stale === true)) {
    lines.push('', options.ascii === true ? '#==# box: its evidence went stale' : '┏━┓ box: its evidence went stale')
  }
  return lines
}

/** Why drawText returned null, as the line above the list of links that replaces the drawing. */
export function undrawnNote(graph: Graph, columns: number): string {
  return graph.nodes.length > MAX_DRAWN_NODES
    ? `${graph.nodes.length} nodes are too many to draw (at most ${MAX_DRAWN_NODES}); the links:`
    : `The diagram is wider than ${columns} columns; the links:`
}

// ---------------------------------------------------------------------------
// SVG drawing
// ---------------------------------------------------------------------------

const CELL_W = 8
const CELL_H = 18

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

const SVG_STYLE = [
  'svg{--fg:#1f2328;--muted:#59636e;--line:#6e7781;--node:#f6f8fa;--edge-bg:#ffffff;--stale:#cf222e;--group:#d0d7de}',
  '@media (prefers-color-scheme: dark){svg{--fg:#e6edf3;--muted:#9198a1;--line:#8b949e;--node:#161b22;--edge-bg:#0d1117;--stale:#ff7b72;--group:#30363d}}',
  'text{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;fill:var(--fg)}',
  '.node{fill:var(--node);stroke:var(--line);stroke-width:1.2}',
  '.node.stale{stroke:var(--stale);stroke-width:2}',
  '.edge{fill:none;stroke:var(--line);stroke-width:1.4;stroke-linejoin:round}',
  '.edge.dotted{stroke-dasharray:4 3}',
  '.edge.thick{stroke-width:2.6}',
  '.elabel{fill:var(--muted);font-size:11px}',
  '.elabel-bg{fill:var(--edge-bg)}',
  '.group{fill:none;stroke:var(--group);stroke-dasharray:6 4;stroke-width:1}',
  '.glabel{fill:var(--muted);font-size:11px}',
  '.head{fill:var(--line)}',
  'g.n:hover .node{stroke-width:2.2}',
].join('')

/** The diagram as a standalone SVG document (themed for light and dark); null when the graph is empty, too large to draw, or the markup exceeds MAX_SVG_CHARS. */
export function drawSvg(graph: Graph, options: { marks?: Readonly<Record<string, NodeMark>>; title?: string } = {}): string | null {
  if (graph.nodes.length === 0 || graph.nodes.length > MAX_DRAWN_NODES) return null
  const layout = layoutGraph(graph, { direction: graph.direction, labelWidth: 22, ascii: false })
  const pad = 12
  const width = layout.cols * CELL_W + pad * 2
  const height = layout.rows * CELL_H + pad * 2
  const x = (col: number) => pad + (col + 0.5) * CELL_W
  const y = (row: number) => pad + (row + 0.5) * CELL_H
  const parts: string[] = []
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img">`)
  parts.push(`<title>${escapeXml(options.title ?? 'System map')}</title>`)
  parts.push(`<style>${SVG_STYLE}</style>`)
  parts.push('<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="head" d="M0,0 L10,5 L0,10 z"/></marker></defs>')

  // Groups: a dashed frame around the members, when no other node falls inside it.
  for (const group of graph.subgraphs) {
    const members = layout.boxes.filter(box => box.subgraph === group.id)
    if (members.length === 0) continue
    const top = Math.min(...members.map(b => b.top)) - 1
    const bottom = Math.max(...members.map(b => b.bottom)) + 1
    const left = Math.min(...members.map(b => b.left)) - 1
    const right = Math.max(...members.map(b => b.right)) + 1
    const intruder = layout.boxes.some(b => b.subgraph !== group.id && b.left <= right && b.right >= left && b.top <= bottom && b.bottom >= top)
    if (intruder) continue
    const gx = x(left) - CELL_W / 2
    const gy = y(top) - CELL_H / 2
    parts.push(`<rect class="group" x="${gx}" y="${gy - 12}" width="${(right - left + 1) * CELL_W}" height="${(bottom - top + 1) * CELL_H + 12}" rx="8"/>`)
    parts.push(`<text class="glabel" x="${gx + 6}" y="${gy + 1}">${escapeXml(group.label)}</text>`)
  }

  const boxOf = new Map(layout.boxes.map(box => [box.id, box]))
  // Edges: from box border to box border.
  for (const { edge, points, headAtEnd, headAtStart } of layout.edges) {
    if (points.length === 0) continue
    const coords = points.map(p => ({ x: x(p.col), y: y(p.row) }))
    const extend = (from: { x: number; y: number }, to: { x: number; y: number }) => {
      const dx = Math.sign(to.x - from.x)
      const dy = Math.sign(to.y - from.y)
      return { x: to.x + dx * (CELL_W / 2), y: to.y + dy * (CELL_H / 2) }
    }
    if (coords.length >= 2) {
      coords[coords.length - 1] = extend(coords[coords.length - 2] as { x: number; y: number }, coords[coords.length - 1] as { x: number; y: number })
      coords[0] = extend(coords[1] as { x: number; y: number }, coords[0] as { x: number; y: number })
    }
    const d = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ')
    const markers = `${headAtEnd ? ' marker-end="url(#arrow)"' : ''}${headAtStart ? ' marker-start="url(#arrow)"' : ''}`
    const title = `${boxOf.get(edge.from)?.label.join(' ') ?? edge.from} -> ${boxOf.get(edge.to)?.label.join(' ') ?? edge.to}${edge.label === '' ? '' : `: ${edge.label}`}`
    parts.push(`<path class="edge ${edge.style}" d="${d}"${markers}><title>${escapeXml(title)}</title></path>`)
  }
  for (const label of layout.labels) {
    const w = displayWidth(label.text) * CELL_W
    const lx = pad + label.col * CELL_W
    const ly = y(label.row)
    parts.push(`<rect class="elabel-bg" x="${lx - 2}" y="${ly - 8}" width="${w + 4}" height="16" rx="3"/>`)
    parts.push(`<text class="elabel" x="${lx + w / 2}" y="${ly + 4}" text-anchor="middle">${escapeXml(label.text)}</text>`)
  }
  for (const box of layout.boxes) {
    const mark = options.marks?.[box.id]
    const bx = x(box.left)
    const by = y(box.top)
    const bw = (box.right - box.left) * CELL_W
    const bh = (box.bottom - box.top) * CELL_H
    const cls = `node${mark?.stale === true ? ' stale' : ''}`
    const node = graph.nodes.find(n => n.id === box.id)
    const tip = [node?.label ?? box.id, mark?.note].filter(t => t !== undefined && t !== '').join('\n')
    parts.push(`<g class="n"><title>${escapeXml(tip)}</title>`)
    switch (box.shape) {
      case 'diamond':
      case 'hexagon':
      case 'flag': {
        const k = Math.min(14, bh / 2)
        const pts = [[bx, by + bh / 2], [bx + k, by], [bx + bw - k, by], [bx + bw, by + bh / 2], [bx + bw - k, by + bh], [bx + k, by + bh]]
        parts.push(`<polygon class="${cls}" points="${pts.map(([px, py]) => `${(px as number).toFixed(1)},${(py as number).toFixed(1)}`).join(' ')}"/>`)
        break
      }
      case 'stadium':
      case 'circle':
        parts.push(`<rect class="${cls}" x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="${bh / 2}"/>`)
        break
      case 'round':
        parts.push(`<rect class="${cls}" x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="10"/>`)
        break
      case 'subroutine':
        parts.push(`<rect class="${cls}" x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="2"/>`)
        parts.push(`<path class="edge" d="M${bx + 6},${by} V${by + bh} M${bx + bw - 6},${by} V${by + bh}"/>`)
        break
      case 'cylinder':
        parts.push(`<rect class="${cls}" x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="6"/>`)
        parts.push(`<path class="edge" d="M${bx},${by + 7} Q${bx + bw / 2},${by + 14} ${bx + bw},${by + 7}"/>`)
        break
      default:
        parts.push(`<rect class="${cls}" x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="3"/>`)
    }
    const cx = bx + bw / 2
    const firstY = by + bh / 2 - ((box.label.length - 1) * 15) / 2 + 4
    box.label.forEach((line, i) => {
      parts.push(`<text x="${cx}" y="${(firstY + i * 15).toFixed(1)}" text-anchor="middle">${escapeXml(line)}</text>`)
    })
    parts.push('</g>')
  }
  parts.push('</svg>')
  const svg = parts.join('')
  return svg.length > MAX_SVG_CHARS ? null : svg
}

// ---------------------------------------------------------------------------
// Markdown with Mermaid fences
// ---------------------------------------------------------------------------

export type DocSegment = { kind: 'markdown'; text: string } | { kind: 'mermaid'; source: string }

/** Splits markdown into runs of plain markdown and ```mermaid fenced blocks (backtick or tilde fences of any length). */
export function splitMermaid(markdown: string): DocSegment[] {
  const lines = markdown.split('\n')
  const segments: DocSegment[] = []
  let buffer: string[] = []
  const flush = () => {
    const text = buffer.join('\n')
    if (text.trim() !== '') segments.push({ kind: 'markdown', text })
    buffer = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    const open = /^ {0,3}(`{3,}|~{3,})\s*mermaid\s*$/i.exec(line)
    if (open === null) {
      // Any other fence is copied whole, so a "```mermaid" line inside it stays text.
      const other = /^ {0,3}(`{3,}|~{3,})/.exec(line)
      if (other !== null) {
        const marks = other[1] as string
        buffer.push(line)
        for (i++; i < lines.length; i++) {
          const inner = lines[i] as string
          buffer.push(inner)
          if (new RegExp(`^ {0,3}${marks[0] === '`' ? '`' : '~'}{${marks.length},}\\s*$`).test(inner)) break
        }
        continue
      }
      buffer.push(line)
      continue
    }
    const marks = open[1] as string
    const close = new RegExp(`^ {0,3}${marks[0] === '`' ? '`' : '~'}{${marks.length},}\\s*$`)
    const body: string[] = []
    let closed = false
    for (i++; i < lines.length; i++) {
      const inner = lines[i] as string
      if (close.test(inner)) {
        closed = true
        break
      }
      body.push(inner)
    }
    if (!closed) {
      buffer.push(line, ...body)
      continue
    }
    flush()
    segments.push({ kind: 'mermaid', source: body.join('\n') })
  }
  flush()
  return segments
}
