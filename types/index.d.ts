// State contract of the ewm mod: session values held by the host in $.state.
// Self-contained on purpose (no imports): the PaneModel shape is mirrored from
// src/types.ts and must be kept in sync with it.

export type EwmPaneSection = 'overview' | 'map' | 'questions'

export type EwmPaneView = {
  project: string
  task_id: string
  title: string
  phase: string
  paused_from: string | null
  rail: { label: string; state: 'done' | 'current' | 'todo' }[]
  counts: { components: number; sources: number; open_questions: number; risks: number; findings: number; stale: number }
  models: string[]
  pending_gate: string | null
  next_action: string
  map_lines: string[]
  question_lines: string[]
}

declare module 'claude-code' {
  interface PluginState {
    ewm: {
      /** What the pane draws; null when no task is active. */
      view: EwmPaneView | null
      /** Which section of the pane is shown. */
      section: EwmPaneSection
      /** Notice line under the pane (last action result). */
      notice: string | null
      /** The absolute workspace root pinned at session.start; lets a hot reload keep it. */
      root: string | null
    }
  }
}
