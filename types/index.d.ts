export type SessionRow = {
  id: string
  title: string
  cwd: string
  tokens: number | null
  window: number
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
  total: number
  mtimeMs: number
  sessions: SessionRow[]
}

export type Snapshot = { at: number; projects: ProjectRow[] }

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
    }
  }
}
