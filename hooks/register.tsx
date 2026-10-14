import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { Env, ProjectRow, SessionRow, Snapshot } from '../types'

const PANE = 'project-switcher'
const TITLE = 'Projects'
const snapshot = atom({ plugin: 'project-switcher', key: 'snapshot' } as const, null as Snapshot | null)
// projects whose open/closed state differs from the default (open when it has an open session, or is in the top 3)
const toggled = atom({ plugin: 'project-switcher', key: 'toggled' } as const, [] as string[])
const error = atom({ plugin: 'project-switcher', key: 'error' } as const, null as string | null)
// projects showing every scanned session rather than the first few
const showAll = atom({ plugin: 'project-switcher', key: 'showAll' } as const, [] as string[])
const showAllProjects = atom({ plugin: 'project-switcher', key: 'showAllProjects' } as const, false)
const settingsOpen = atom({ plugin: 'project-switcher', key: 'settingsOpen' } as const, false)
// whether this session draws the pane now; the launcher above the prompt shows while it doesn't
const paneUp = atom({ plugin: 'project-switcher', key: 'paneUp' } as const, false)
// the preflight's answer: null until it ran
const env = atom({ plugin: 'project-switcher', key: 'env' } as const, null as Env | null)
// bumped once a minute while the pane is up, so the ages drawn from Date.now() redraw
const tick = atom({ plugin: 'project-switcher', key: 'tick' } as const, 0)
// kept across sessions in $.store: true from an open the person asked for until they close the pane by hand
const WANTED = 'paneWanted'
// kept across sessions in $.store: { model: window tokens } learned from sessions that reported their window
const WINDOWS = 'windows'

const BAR = 8
// the band's count refresh, outside the pane: at most one scan per this long
const RESCAN_EVERY_MS = 30_000
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const MSG_UNSUPPORTED = 'Project switcher works on macOS for now.'
const MSG_NO_PYTHON = 'Needs python3 — install the Xcode Command Line Tools (xcode-select --install).'
const MSG_EMPTY = 'No sessions yet — start Claude Code in any folder and it will appear here.'
const MSG_SCAN_FAILED = "Couldn't read your sessions."

type OpenIn = 'desktop' | 'terminal' | 'iterm'
type Settings = {
  openIn: OpenIn
  autoOpen: boolean
  launcher: boolean
  rowsPerProject: number
  projectsShown: number
  warn: number
  danger: number
}

// the bounds settingsOf clamps to; the ⚙ steppers use the same ones
const BOUNDS = {
  rowsPerProject: [1, 20],
  projectsShown: [1, 100],
  warn: [1, 99],
  danger: [2, 100],
} as const

// the manifest's userConfig, defaults filled in by the engine; held here so a bad stored number cannot break the pane
function settingsOf(options: PluginOptions): Settings {
  const num = (v: unknown, fallback: number, [min, max]: readonly [number, number]) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback
  const openIn = options.openIn === 'terminal' || options.openIn === 'iterm' ? options.openIn : 'desktop'
  const warn = num(options.warnAt, 60, BOUNDS.warn)
  return {
    openIn,
    autoOpen: options.autoOpen === true,
    launcher: options.showLauncher !== false,
    rowsPerProject: num(options.sessionsPerProject, 3, BOUNDS.rowsPerProject),
    projectsShown: num(options.projectsShown, 8, BOUNDS.projectsShown),
    warn,
    danger: Math.max(warn + 1, num(options.dangerAt, 75, BOUNDS.danger)),
  }
}

let cfg: Settings = settingsOf({})

// Writes one userConfig field through the settings menu's own path, which reloads the module with the new value.
// The row's key is `<plugin>.<field>`, the plugin named as loaded (`project-switcher` or `project-switcher@inline`).
async function setOption($: EngineInterface, field: string, value: string | number | boolean): Promise<void> {
  const row = (await $.config.list()).find(r => r.key.startsWith('project-switcher') && r.key.endsWith(`.${field}`))
  if (!row) {
    $.ui.toast(`Setting ${field} not found`)
    return
  }
  const result = await $.config.set({ key: row.key, value })
  if ('deny' in result && result.deny) $.ui.toast(`Couldn't change ${field}: ${result.deny}`)
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

// /Users/me/repo -> ~/repo (the plugin is macOS-only; /home covers a Linux checkout reading the same data)
function tildePath(p: string): string {
  return p.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~') || p
}

function fillColor(pct: number): string {
  return pct >= cfg.danger ? 'red' : pct >= cfg.warn ? 'yellow' : 'green'
}

function pctOf(s: SessionRow): number {
  return Math.min(100, Math.round(((s.tokens ?? 0) / s.window) * 100))
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`
}

// the rows worth listing: not this session, and with usage to show
function visible(p: ProjectRow): SessionRow[] {
  return p.sessions.filter(s => !s.isSelf && s.tokens != null)
}

function isExpanded(p: ProjectRow, index: number, flipped: string[]): boolean {
  const byDefault = index < 3 || p.sessions.some(s => s.isOpen && !s.isSelf)
  return flipped.includes(p.dir) ? !byDefault : byDefault
}

// a press would launch something: not a live terminal session, and a live Desktop one only when opening in Desktop
function isResumable(s: SessionRow): boolean {
  return UUID_RE.test(s.id) && (!s.isOpen || (s.inDesktop && cfg.openIn === 'desktop'))
}

const APP_NAME: Record<OpenIn, string> = { desktop: 'Claude', terminal: 'Terminal', iterm: 'iTerm' }

// the osascript argv that runs `claude --resume` in a new Terminal or iTerm window; null for an id that is no UUID
function terminalArgv(app: 'terminal' | 'iterm', cwd: string, id: string): string[] | null {
  if (!UUID_RE.test(id)) return null
  const shellPath = `'${cwd.replaceAll("'", "'\\''")}'`
  const cmd = `cd ${shellPath} && claude --resume ${id}`
  const lit = `"${cmd.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
  if (app === 'terminal') {
    return ['osascript', '-e', `tell application "Terminal" to do script ${lit}`, '-e', 'tell application "Terminal" to activate']
  }
  return [
    'osascript',
    '-e', 'tell application "iTerm"',
    '-e', 'activate',
    '-e', 'set w to (create window with default profile)',
    '-e', `tell current session of w to write text ${lit}`,
    '-e', 'end tell',
  ]
}

// Desktop's own deep link: it adopts the CLI transcript (or finds the session it already has) and shows it
function resumeArgv(openIn: OpenIn, s: SessionRow): string[] | null {
  if (!UUID_RE.test(s.id)) return null
  return openIn === 'desktop'
    ? ['open', `claude://resume?session=${encodeURIComponent(s.id)}`]
    : terminalArgv(openIn, s.cwd, s.id)
}

// ---- preflight ----

// macOS with a working python3. A python3 that is Apple's stub (no Command Line Tools) is not run: it would raise
// the "install developer tools" dialog in every session.
const PYTHON_PROBE =
  'p=$(command -v python3) || exit 3; ' +
  'if [ "$p" = /usr/bin/python3 ] && ! /usr/bin/xcode-select -p >/dev/null 2>&1; then exit 4; fi; ' +
  'exec "$p" -c 1'

async function probe($: EngineInterface): Promise<Env> {
  try {
    const { exitCode, stdout } = await $.process.run(['uname', '-s'], { timeoutMs: 5000 })
    if (exitCode !== 0 || stdout.trim() !== 'Darwin') return 'unsupported'
  } catch {
    return 'unsupported'
  }
  try {
    const { exitCode } = await $.process.run(['/bin/sh', '-c', PYTHON_PROBE], { timeoutMs: 10_000 })
    return exitCode === 0 ? 'ok' : 'no-python'
  } catch {
    return 'no-python'
  }
}

let envCheck: Promise<Env> | null = null

// the preflight, once per module: also reached by a scan in a session that started before the plugin was installed
async function ensureEnv($: EngineInterface): Promise<Env> {
  const known = await read($, env)
  if (known) return known
  envCheck ??= (async () => {
    const found = await probe($)
    await update($, env, () => found)
    $.ui.log(`preflight: ${found}`, { to: 'debug' })
    return found
  })()
  return envCheck
}

// ---- scanning ----

async function storedWindows($: EngineInterface): Promise<Record<string, number>> {
  const raw = await $.store.get(WINDOWS)
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isInteger(v) && v > 0) out[k] = v
  }
  return out
}

// keeps every window a scan reported, so a model learned in one session counts as known in all of them
async function learnWindows($: EngineInterface, found: Record<string, number> | undefined): Promise<void> {
  if (!found || Object.keys(found).length === 0) return
  const prev = await storedWindows($)
  const merged = { ...prev, ...found }
  if (JSON.stringify(merged) !== JSON.stringify(prev)) await $.store.set(WINDOWS, merged)
}

async function scanArgs($: EngineInterface): Promise<string[]> {
  const self = await $.session.id()
  const { context } = await $.session.usage()
  // scan a couple past what a project shows, so "+N more" has rows to reveal
  const per = Math.max(5, cfg.rowsPerProject + 2)
  const argv = ['--self', self, '--self-window', String(context.window ?? 0), '--per-project', String(per)]
  const windows = await storedWindows($)
  if (Object.keys(windows).length > 0) argv.push('--windows', JSON.stringify(windows))
  return argv
}

// Writes only on change: every write redraws the pane, and a redraw under the pointer swallows a click.
// So `at` stays the time the listed data last changed.
async function setSnapshot($: EngineInterface, snap: Snapshot): Promise<void> {
  const prev = await read($, snapshot)
  const same = prev != null && JSON.stringify(prev.projects) === JSON.stringify(snap.projects)
  if (!same) await update($, snapshot, () => ({ at: snap.at, projects: snap.projects }))
}

async function setError($: EngineInterface, msg: string | null): Promise<void> {
  if ((await read($, error)) !== msg) await update($, error, () => msg)
}

// one line of scanner output: a snapshot, or `{"error": "..."}`
async function takeLine($: EngineInterface, line: string): Promise<void> {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return
  }
  if (!parsed || typeof parsed !== 'object') return
  if ('error' in parsed) {
    await setError($, String((parsed as { error: unknown }).error))
    return
  }
  const snap = parsed as Snapshot
  if (!Array.isArray(snap.projects)) return
  await setSnapshot($, snap)
  await setError($, null)
  await learnWindows($, snap.windows)
}

let lastScan = 0

// One scan. `throttled`: the band's background refresh, skipped while a watcher runs or within RESCAN_EVERY_MS.
async function rescan($: EngineInterface, throttled = false): Promise<void> {
  if (throttled && (watcher || Date.now() - lastScan < RESCAN_EVERY_MS)) return
  lastScan = Date.now()
  if ((await ensureEnv($)) !== 'ok') return
  try {
    const argv = ['python3', `${$.plugin.root}/bin/scan.py`, 'once', ...(await scanArgs($))]
    const { exitCode, stdout, stderr } = await $.process.run(argv)
    if (exitCode !== 0) {
      await setError($, stderr.trim().split('\n').at(-1) || `scanner exited with ${exitCode}`)
      return
    }
    await takeLine($, stdout.trim().split('\n').at(-1) ?? '')
  } catch (err) {
    await setError($, `scanner did not run: ${String(err)}`)
  }
}

async function paneExists($: EngineInterface): Promise<boolean> {
  try {
    return (await $.ui.panes()).some(p => p.id === PANE)
  } catch {
    return true
  }
}

type Watcher = { stop: () => void }
// the one `scan.py watch` child of this session, alive only while the pane is up
let watcher: Watcher | null = null

function stopWatch(): void {
  watcher?.stop()
  watcher = null
}

// Starts the scanner's watch loop for as long as the pane is up: it ends on ui.close, when the pane is found gone,
// or with the module. The child prints a snapshot at start and whenever a session's message ends.
function startWatch($: EngineInterface): void {
  if (watcher) return
  const ac = new AbortController()
  let stream: ReturnType<EngineInterface['process']['spawn']> | null = null
  const self: Watcher = {
    stop: () => {
      if (ac.signal.aborted) return
      ac.abort()
      void stream?.return(undefined as never)?.catch(() => {})
    },
  }
  watcher = self
  const done = () => {
    if (watcher === self) watcher = null
    self.stop()
  }

  // the age ticker: a redraw a minute, and a check that the pane is still there
  void (async () => {
    while (!ac.signal.aborted) {
      try {
        await $.clock.sleep(60_000, { signal: ac.signal })
      } catch {
        return
      }
      if (!(await paneExists($))) return done()
      await update($, tick, n => n + 1)
    }
  })()

  void (async () => {
    try {
      if ((await ensureEnv($)) !== 'ok' || ac.signal.aborted) return
      const argv = ['python3', `${$.plugin.root}/bin/scan.py`, 'watch', ...(await scanArgs($))]
      if (ac.signal.aborted) return
      stream = $.process.spawn({ argv })
      $.ui.log('watch: started', { to: 'debug' })
      let buf = ''
      for await (const piece of stream) {
        if (ac.signal.aborted || !('stream' in piece)) break
        if (piece.stream === 'stderr') {
          await setError($, piece.text.trim().split('\n').at(-1) || null)
          continue
        }
        buf += piece.text
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl)
          buf = buf.slice(nl + 1)
          await takeLine($, line)
        }
        if (!(await paneExists($))) break
      }
    } catch (err) {
      if (!ac.signal.aborted) await setError($, `scanner stopped: ${String(err)}`)
    } finally {
      $.ui.log('watch: stopped', { to: 'debug' })
      done()
    }
  })()
}

// ---- the pane's lifecycle ----

// An open the person asked for (/projects, the launcher): placed at any width, and remembered for other sessions.
async function openPane($: EngineInterface): Promise<string> {
  const before = await $.ui.panes()
  const stale = before.find(p => p.id === PANE && !p.isPlaced)
  if (stale) await $.ui.close({ id: PANE })
  const result = await $.ui.open({ id: PANE, title: TITLE })
  await update($, paneUp, () => result.isPlaced)
  await $.store.set(WANTED, true)
  $.ui.log(`open: ${JSON.stringify(result)} before=${JSON.stringify(before)}`, { to: 'debug' })
  if (result.isPlaced) startWatch($)
  return result.isPlaced ? 'Projects pane opened.' : `Projects pane not placed: ${result.reason}`
}

// Reopens the pane in a session that starts or that a surface attaches to (switching sessions in Desktop),
// when the person left it open elsewhere or turned on auto-open. Unasked, so a narrow window may hold it undrawn.
async function restorePane($: EngineInterface): Promise<void> {
  const mine = (await $.ui.panes()).find(p => p.id === PANE)
  if (mine) {
    await update($, paneUp, () => mine.isPlaced)
    if (mine.isPlaced) startWatch($)
    return
  }
  if (!cfg.autoOpen && (await $.store.get(WANTED)) !== true) return
  const result = await $.ui.open({ id: PANE, title: TITLE })
  await update($, paneUp, () => result.isPlaced)
  $.ui.log(`restore: ${JSON.stringify(result)}`, { to: 'debug' })
  if (result.isPlaced) startWatch($)
}

export const register: Register = (on, options) => {
  cfg = settingsOf(options)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'projects', description: 'Show all projects and sessions with context fill' })
    // a terminal session shows the pane inline, over the transcript, so it reopens there only with auto-open on;
    // a Desktop session (no surface yet at start) gets it docked beside the transcript
    if (e.surface !== 'terminal' || cfg.autoOpen) void restorePane($)
    // the band's first count; the preflight runs inside it
    void rescan($, true)
    return started
  })

  on('command.run', { command: 'projects' }, async $ => {
    const text = await openPane($)
    void rescan($)
    return { text }
  })

  // a Desktop session switch attaches the app to this session: seat the pane there too
  on('session.attach', async ($, e, next) => {
    const done = await next(e)
    if (e.surface !== 'mobile' && e.viewport?.isFullscreen !== false) void restorePane($)
    return done
  })

  // switched away in Desktop: nothing draws the pane here, so the watcher waits for the next attach
  on('session.detach', async ($, e, next) => {
    const done = await next(e)
    const left = (await $.session.surfaces()).filter(s => s !== 'mobile')
    $.ui.log(`detach: ${e.surface} reason=${e.reason} left=${JSON.stringify(left)}`, { to: 'debug' })
    if (left.length === 0) stopWatch()
    return done
  })

  on('ui.close', async ($, e, next) => {
    if (e.id !== PANE) return next(e)
    $.ui.log(`close: origin=${e.origin.kind}`, { to: 'debug' })
    const done = await next(e)
    // a hook beneath may have kept it open
    if ((await $.ui.panes()).some(p => p.id === PANE)) return done
    stopWatch()
    await update($, paneUp, () => false)
    // closed by hand: stop reopening it in other sessions
    if (e.origin.kind === 'person') await $.store.set(WANTED, false)
    return done
  })

  // the launcher: one press opens the pane, so it needs no command
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!cfg.launcher || e.props.hasSurvey) return next(e)
    // the engine's record catches a pane placed later (a widened terminal, a surface attaching); the flag is the fallback
    let isUp = await read($, paneUp)
    try {
      isUp = (await $.ui.panes()).some(p => p.id === PANE && p.isPlaced)
    } catch {}
    if (isUp) return next(e)
    const where = await read($, env)
    const snap = await read($, snapshot)
    const rows = snap ? snap.projects.flatMap(visible).filter(s => s.isOpen) : []
    const near = rows.filter(s => pctOf(s) >= cfg.danger).length
    const blocked = where === 'unsupported' ? 'macOS only for now' : where === 'no-python' ? 'needs python3' : null
    // nothing else open and nothing to warn about: the band stays the engine's
    if (!blocked && rows.length === 0) return next(e)
    // what draws beneath (another plugin's band) stays, under the launcher
    const below = await next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Button key="launch" plain hotkey="p" label="▤ Projects" onPress={async () => { await openPane($); void rescan($) }} />
          {blocked ? <Text dimColor>{` · ${blocked}`}</Text> : <Text dimColor>{` ${rows.length}`}</Text>}
          {near > 0 && <Text color="red">{` · ${near} near limit`}</Text>}
        </Box>
        {below}
      </Box>
    )
  })

  // this session's own message ending: refresh the band's count, throttled; the pane's watcher covers the rest
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) void rescan($, true)
    return done
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const where = await read($, env)
    if (where === 'unsupported' || where === 'no-python') {
      return (
        <Box flexDirection="column" paddingX={1}>
          <Text>{where === 'unsupported' ? MSG_UNSUPPORTED : MSG_NO_PYTHON}</Text>
        </Box>
      )
    }
    const snap = await read($, snapshot)
    const flipped = await read($, toggled)
    const err = await read($, error)
    const full = await read($, showAll)
    const allProjects = await read($, showAllProjects)
    const settingsShown = await read($, settingsOpen)
    // subscribes the pane to the minute ticker, so ages redraw while nothing else changes
    await read($, tick)
    // title gets what the hotkey, bar, percent and age leave of the row
    const titleWidth = Math.max(12, Math.min(40, (e.props.bodyColumns ?? 48) - BAR - 18))

    const retry = <Button key="refresh" plain hotkey="r" label="↻ " onPress={() => void rescan($)} />
    const errorBlock = err && (
      <Box flexDirection="column">
        <Text color="red">{MSG_SCAN_FAILED}</Text>
        <Text dimColor>{err}</Text>
      </Box>
    )

    if (!snap) {
      return (
        <Box flexDirection="column" paddingX={1}>
          {err ? (
            <Box flexDirection="row" justifyContent="space-between">
              {errorBlock}
              {retry}
            </Box>
          ) : (
            <Text dimColor>Scanning ~/.claude/projects…</Text>
          )}
        </Box>
      )
    }

    const resume = (s: SessionRow) => async () => {
      const name = `“${clip(s.title, 40)}”`
      // a live terminal session gets no second writer; a live Desktop one is only switched to
      if (s.isOpen && !(s.inDesktop && cfg.openIn === 'desktop')) {
        $.ui.toast(s.inDesktop ? `${name} is already open in Claude Desktop` : `Already running in a terminal in ${tildePath(s.cwd)}`)
        return
      }
      const argv = resumeArgv(cfg.openIn, s)
      if (!argv) {
        $.ui.toast(`Can't resume ${name}: its session id isn't one Claude Code wrote`)
        return
      }
      const app = APP_NAME[cfg.openIn]
      const { exitCode, stderr } = await $.process.run(argv)
      $.ui.toast(exitCode === 0 ? `${s.isOpen ? 'Switching to' : 'Resuming'} ${name} in ${app}` : `Couldn't open ${app}: ${stderr.trim()}`)
    }

    const flipIn = (list: string[], dir: string) => (list.includes(dir) ? list.filter(d => d !== dir) : [...list, dir])
    const toggle = (dir: string) => () => update($, toggled, list => flipIn(list, dir))
    const toggleAll = (dir: string) => () => update($, showAll, list => flipIn(list, dir))

    // 1–9 go to the first nine resumable rows in drawing order, each session once
    const hotkeys = new Map<string, string>()
    const hotkeyFor = (s: SessionRow): string | undefined => {
      if (hotkeys.has(s.id)) return undefined
      if (!isResumable(s) || hotkeys.size >= 9) return undefined
      const key = String(hotkeys.size + 1)
      hotkeys.set(s.id, key)
      return key
    }

    const sessionRow = (s: SessionRow, prefix: string) => {
      const pct = pctOf(s)
      const filled = Math.round((pct / 100) * BAR)
      const pctText = s.windowKnown === false ? `~${pct}` : String(pct)
      const hotkey = hotkeyFor(s)
      return (
        <Box key={`${prefix}-${s.id}`} flexDirection="row" justifyContent="space-between" paddingLeft={2}>
          <Box flexDirection="row">
            <Text color={s.isOpen ? 'green' : undefined} dimColor={!s.isOpen}>{s.isOpen ? '● ' : '○ '}</Text>
            {hotkey ? (
              <Button key={`${prefix}r-${s.id}`} plain hotkey={hotkey} label={clip(s.title, titleWidth)} onPress={resume(s)} />
            ) : (
              <Button key={`${prefix}r-${s.id}`} plain label={clip(s.title, titleWidth)} onPress={resume(s)} />
            )}
          </Box>
          <Box flexDirection="row" flexShrink={0}>
            <Text color={fillColor(pct)}>{' ' + '▰'.repeat(filled)}</Text>
            <Text dimColor>{'▱'.repeat(BAR - filled)}</Text>
            <Text key={`${prefix}pct-${s.id}`} color={pct >= cfg.warn ? fillColor(pct) : undefined}>{` ${pctText.padStart(4)}%`}</Text>
            <Text dimColor>{` ${ago(s.mtimeMs).padStart(3)}`}</Text>
          </Box>
        </Box>
      )
    }

    const projectBlock = (p: ProjectRow, i: number) => {
      const rows = visible(p)
      const open = isExpanded(p, i, flipped)
      const openCount = rows.filter(s => s.isOpen).length
      const shown = full.includes(p.dir) ? rows : rows.slice(0, cfg.rowsPerProject)
      const hidden = rows.length - shown.length
      const older = p.total - p.sessions.length
      return (
        <Box key={p.dir} flexDirection="column">
          <Box flexDirection="row">
            {/* a Button takes only a string label; the rest of the header sits beside it */}
            <Button key={`t-${p.dir}`} plain label={`${open ? '▾' : '▸'} ${p.name}`} onPress={toggle(p.dir)} />
            {openCount > 0 && <Text color="green">{` ●${openCount}`}</Text>}
            <Text dimColor>{` ${p.total}`}</Text>
            {p.pathKnown === false && <Text key={`g-${p.dir}`} dimColor>{' · path guessed'}</Text>}
          </Box>
          {open && shown.map(s => sessionRow(s, 'p'))}
          {open && rows.length === 0 && <Text dimColor>{'    no sessions with usage'}</Text>}
          {open && hidden > 0 && (
            <Box paddingLeft={4}>
              <Button key={`m-${p.dir}`} plain dimColor label={`+${hidden} more`} onPress={toggleAll(p.dir)} />
            </Box>
          )}
          {open && hidden === 0 && full.includes(p.dir) && rows.length > cfg.rowsPerProject && (
            <Box paddingLeft={4}>
              <Button key={`m-${p.dir}`} plain dimColor label="show less" onPress={toggleAll(p.dir)} />
            </Box>
          )}
          {open && hidden === 0 && older > 0 && <Text dimColor>{`    +${older} older`}</Text>}
        </Box>
      )
    }

    const stepper = (key: string, label: string, value: number, step: number, field: string, [min, max]: readonly [number, number], unit = '') => (
      <Box key={key} flexDirection="row" paddingLeft={2}>
        <Text dimColor>{`${label} `}</Text>
        <Button key={`${key}-dec`} plain label="−" onPress={() => setOption($, field, Math.max(min, value - step))} />
        <Text>{` ${value}${unit} `}</Text>
        <Button key={`${key}-inc`} plain label="+" onPress={() => setOption($, field, Math.min(max, value + step))} />
      </Box>
    )

    const settings = (
      <Box flexDirection="column">
        <Text> </Text>
        <Text bold>Settings</Text>
        <Box flexDirection="row" paddingLeft={2}>
          <Text dimColor>{'Open in '}</Text>
          {(['desktop', 'terminal', 'iterm'] as const).map(where => (
            <Button
              key={`set-open-${where}`}
              plain
              dimColor={cfg.openIn !== where}
              label={`${cfg.openIn === where ? '◉' : '○'} ${APP_NAME[where]} `}
              onPress={() => setOption($, 'openIn', where)}
            />
          ))}
        </Box>
        <Box flexDirection="row" paddingLeft={2}>
          <Text dimColor>{'Open pane on start '}</Text>
          <Button key="set-auto" plain label={cfg.autoOpen ? '◉ on' : '○ off'} onPress={() => setOption($, 'autoOpen', !cfg.autoOpen)} />
        </Box>
        <Box flexDirection="row" paddingLeft={2}>
          <Text dimColor>{'Launcher above prompt '}</Text>
          <Button key="set-launcher" plain label={cfg.launcher ? '◉ on' : '○ off'} onPress={() => setOption($, 'showLauncher', !cfg.launcher)} />
        </Box>
        {stepper('set-rows', 'Sessions per project', cfg.rowsPerProject, 1, 'sessionsPerProject', BOUNDS.rowsPerProject)}
        {stepper('set-projects', 'Projects shown', cfg.projectsShown, 1, 'projectsShown', BOUNDS.projectsShown)}
        {/* settingsOf lifts red above yellow, so yellow takes its full range */}
        {stepper('set-warn', 'Yellow from', cfg.warn, 5, 'warnAt', BOUNDS.warn, '%')}
        {stepper('set-danger', 'Red from', cfg.danger, 5, 'dangerAt', [cfg.warn + 1, BOUNDS.danger[1]], '%')}
      </Box>
    )

    const live = snap.projects.flatMap(visible).filter(s => s.isOpen).sort((a, b) => pctOf(b) - pctOf(a))
    const near = live.filter(s => pctOf(s) >= cfg.danger).length
    const projects = allProjects ? snap.projects : snap.projects.slice(0, cfg.projectsShown)
    const more = snap.projects.length - projects.length
    const isEmpty = snap.projects.every(p => visible(p).length === 0)

    return (
      <Box flexDirection="column" paddingX={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Box flexDirection="row">
            <Text color="green">{`${live.length} open`}</Text>
            {near > 0 && <Text color="red">{` · ${near} near limit`}</Text>}
            <Text key="age" dimColor>{` · ${snap.projects.length} projects · changed ${ago(snap.at)}`}</Text>
          </Box>
          <Box flexDirection="row">
            {retry}
            <Button key="settings" plain hotkey="s" dimColor={!settingsShown} label="⚙" onPress={() => update($, settingsOpen, v => !v)} />
          </Box>
        </Box>
        {errorBlock}
        {settingsShown && settings}
        {isEmpty ? (
          <Box flexDirection="column">
            <Text> </Text>
            <Text key="empty" dimColor>{MSG_EMPTY}</Text>
          </Box>
        ) : (
          <Box flexDirection="column">
            {live.length > 0 && <Text> </Text>}
            {live.length > 0 && <Text bold>Open now</Text>}
            {live.map(s => sessionRow(s, 'o'))}
            <Text> </Text>
            <Text bold>Projects</Text>
            {projects.map(projectBlock)}
            {snap.projects.length > cfg.projectsShown && (
              <Button
                key="more-projects"
                plain
                dimColor
                label={allProjects ? 'Show fewer projects' : `Show ${more} more projects`}
                onPress={() => update($, showAllProjects, v => !v)}
              />
            )}
          </Box>
        )}
      </Box>
    )
  })
}
