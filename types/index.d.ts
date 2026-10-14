export type SessionRow = {
  id: string
  title: string
  cwd: string
  tokens: number | null
  window: number
  // false when the window is a guess (the model's window was never reported by a local session)
  windowKnown?: boolean
  model: string | null
  mtimeMs: number
  isOpen: boolean
  isSelf: boolean
  // held by a Claude Desktop process rather than a terminal one
  inDesktop: boolean
}

export type ProjectRow = {
  dir: string
  name: string
  path: string
  // false when no transcript carried a cwd and the path was rebuilt from the folder name
  pathKnown?: boolean
  total: number
  mtimeMs: number
  sessions: SessionRow[]
}

// `at` is when the listed data last changed: a scan that finds the same projects keeps the earlier snapshot
export type Snapshot = { at: number; projects: ProjectRow[]; windows?: Record<string, number> }

// what the preflight found: 'ok' to scan, or the reason the pane shows instead
export type Env = 'ok' | 'unsupported' | 'no-python'

declare module 'claude-code' {
  interface PluginState {
    'project-switcher': {
      snapshot: Snapshot | null
      toggled: string[]
      error: string | null
      showAll: string[]
      showAllProjects: boolean
      settingsOpen: boolean
      paneUp: boolean
      env: Env | null
      // bumped once a minute while the pane is up, so the ages it draws stay true
      tick: number
    }
  }
}
