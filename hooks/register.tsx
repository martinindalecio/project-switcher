import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { ProjectRow, SessionRow, Snapshot } from '../types'

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

const BAR = 8

type OpenIn = 'desktop' | 'terminal' | 'iterm'
type Settings = {
  openIn: OpenIn
  autoOpen: boolean
  rowsPerProject: number
  projectsShown: number
  warn: number
  danger: number
}

// the manifest's userConfig, defaults filled in by the engine; held here so a bad stored number cannot break the pane
function settingsOf(options: PluginOptions): Settings {
  const num = (v: unknown, fallback: number, min: number, max: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback
  const openIn = options.openIn === 'terminal' || options.openIn === 'iterm' ? options.openIn : 'desktop'
  const warn = num(options.warnAt, 60, 1, 99)
  return {
    openIn,
    autoOpen: options.autoOpen === true,
    rowsPerProject: num(options.sessionsPerProject, 3, 1, 20),
    projectsShown: num(options.projectsShown, 8, 1, 100),
    warn,
    danger: Math.max(warn + 1, num(options.dangerAt, 75, 2, 100)),
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

const APP_NAME: Record<OpenIn, string> = { desktop: 'Claude', terminal: 'Terminal', iterm: 'iTerm' }

// the osascript argv that runs `claude --resume` in a new Terminal or iTerm window
function terminalArgv(app: 'terminal' | 'iterm', cwd: string, id: string): string[] {
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
function resumeArgv(openIn: OpenIn, s: SessionRow): string[] {
  return openIn === 'desktop'
    ? ['open', `claude://resume?session=${encodeURIComponent(s.id)}`]
    : terminalArgv(openIn, s.cwd, s.id)
}

async function scanArgs($: EngineInterface): Promise<string[]> {
  const self = await $.session.id()
  const { context } = await $.session.usage()
  // scan a couple past what a project shows, so "+N more" has rows to reveal
  const per = Math.max(5, cfg.rowsPerProject + 2)
  return ['--self', self, '--self-window', String(context.window ?? 0), '--per-project', String(per)]
}

// Writes only on change: every write redraws the pane, and a redraw under the pointer swallows a click.
async function setSnapshot($: EngineInterface, snap: Snapshot): Promise<void> {
  const prev = await read($, snapshot)
  const same = prev != null && JSON.stringify(prev.projects) === JSON.stringify(snap.projects)
  if (!same) await update($, snapshot, () => snap)
}

async function setError($: EngineInterface, msg: string | null): Promise<void> {
  if ((await read($, error)) !== msg) await update($, error, () => msg)
}

async function rescan($: EngineInterface): Promise<void> {
  const argv = ['python3', `${$.plugin.root}/bin/scan.py`, 'once', ...(await scanArgs($))]
  const { exitCode, stdout, stderr } = await $.process.run(argv)
  if (exitCode !== 0) {
    await setError($, stderr.trim().split('\n').at(-1) ?? 'scan failed')
    return
  }
  await setSnapshot($, JSON.parse(stdout) as Snapshot)
  await setError($, null)
}

async function openPane($: EngineInterface): Promise<string> {
  const before = await $.ui.panes()
  const stale = before.find(p => p.id === PANE && !p.isPlaced)
  if (stale) await $.ui.close({ id: PANE })
  const result = await $.ui.open({ id: PANE, title: TITLE })
  $.ui.log(`open: ${JSON.stringify(result)} before=${JSON.stringify(before)} after=${JSON.stringify(await $.ui.panes())}`, { to: 'debug' })
  return result.isPlaced ? 'Projects pane opened.' : `Projects pane not placed: ${result.reason}`
}

export const register: Register = (on, options) => {
  cfg = settingsOf(options)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'projects', description: 'Show all projects and sessions with context fill' })
    // off by default: opening unasked in every session made the pane reappear after a close
    if (cfg.autoOpen) void openPane($)

    // The scanner prints a snapshot at start and whenever a session's message ends.
    void (async () => {
      const argv = ['python3', `${$.plugin.root}/bin/scan.py`, 'watch', ...(await scanArgs($))]
      let buf = ''
      try {
        for await (const piece of $.process.spawn({ argv })) {
          if (!('stream' in piece)) break
          if (piece.stream === 'stderr') {
            await setError($, piece.text.trim().split('\n').at(-1) ?? null)
            continue
          }
          buf += piece.text
          let nl: number
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl)
            buf = buf.slice(nl + 1)
            try {
              await setSnapshot($, JSON.parse(line) as Snapshot)
              await setError($, null)
            } catch {}
          }
        }
      } catch (err) {
        await setError($, `scanner stopped: ${String(err)}`)
      }
    })()

    return started
  })

  on('command.run', { command: 'projects' }, async $ => {
    const text = await openPane($)
    void rescan($)
    return { text }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) $.ui.log(`close: origin=${e.origin}`, { to: 'debug' })
    return next(e)
  })

  // this session's own message ending: refresh at once rather than waiting on the scanner's tick
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) void rescan($)
    return done
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const snap = await read($, snapshot)
    const flipped = await read($, toggled)
    const err = await read($, error)
    const full = await read($, showAll)
    const allProjects = await read($, showAllProjects)
    const settingsShown = await read($, settingsOpen)
    // title gets what the bar, percent and age leave of the row
    const titleWidth = Math.max(12, Math.min(40, (e.props.bodyColumns ?? 48) - BAR - 14))

    const resume = (s: SessionRow) => async () => {
      const name = `“${clip(s.title, 40)}”`
      // a live terminal session gets no second writer; a live Desktop one is only switched to
      if (s.isOpen && !(s.inDesktop && cfg.openIn === 'desktop')) {
        $.ui.toast(`${name} is already open in ${s.inDesktop ? 'Claude Desktop' : 'a terminal'}`)
        return
      }
      const app = APP_NAME[cfg.openIn]
      const { exitCode, stderr } = await $.process.run(resumeArgv(cfg.openIn, s))
      $.ui.toast(exitCode === 0 ? `${s.isOpen ? 'Switching to' : 'Resuming'} ${name} in ${app}` : `Couldn't open ${app}: ${stderr.trim()}`)
    }

    const flipIn = (list: string[], dir: string) => (list.includes(dir) ? list.filter(d => d !== dir) : [...list, dir])
    const toggle = (dir: string) => () => update($, toggled, list => flipIn(list, dir))
    const toggleAll = (dir: string) => () => update($, showAll, list => flipIn(list, dir))

    const sessionRow = (s: SessionRow, prefix: string) => {
      const pct = pctOf(s)
      const filled = Math.round((pct / 100) * BAR)
      return (
        <Box key={`${prefix}-${s.id}`} flexDirection="row" justifyContent="space-between" paddingLeft={2}>
          <Box flexDirection="row">
            <Text color={s.isOpen ? 'green' : undefined} dimColor={!s.isOpen}>{s.isOpen ? '● ' : '○ '}</Text>
            <Button key={`${prefix}r-${s.id}`} plain label={clip(s.title, titleWidth)} onPress={resume(s)} />
          </Box>
          <Box flexDirection="row" flexShrink={0}>
            <Text color={fillColor(pct)}>{' ' + '▰'.repeat(filled)}</Text>
            <Text dimColor>{'▱'.repeat(BAR - filled)}</Text>
            <Text color={pct >= cfg.warn ? fillColor(pct) : undefined}>{` ${String(pct).padStart(3)}%`}</Text>
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

    const stepper = (key: string, label: string, value: number, step: number, field: string, min: number, max: number, unit = '') => (
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
              bold={cfg.openIn === where}
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
        {stepper('set-rows', 'Sessions per project', cfg.rowsPerProject, 1, 'sessionsPerProject', 1, 20)}
        {stepper('set-projects', 'Projects shown', cfg.projectsShown, 1, 'projectsShown', 1, 100)}
        {stepper('set-warn', 'Yellow from', cfg.warn, 5, 'warnAt', 5, cfg.danger - 1, '%')}
        {stepper('set-danger', 'Red from', cfg.danger, 5, 'dangerAt', cfg.warn + 1, 100, '%')}
      </Box>
    )

    if (!snap) {
      return (
        <Box flexDirection="column" paddingX={1}>
          <Text dimColor>Scanning ~/.claude/projects…</Text>
          {err && <Text color="red">{err}</Text>}
        </Box>
      )
    }

    const live = snap.projects.flatMap(visible).filter(s => s.isOpen).sort((a, b) => pctOf(b) - pctOf(a))
    const near = snap.projects.flatMap(visible).filter(s => s.isOpen && pctOf(s) >= cfg.danger).length
    const projects = allProjects ? snap.projects : snap.projects.slice(0, cfg.projectsShown)
    const more = snap.projects.length - projects.length

    return (
      <Box flexDirection="column" paddingX={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Box flexDirection="row">
            <Text color="green">{`${live.length} open`}</Text>
            {near > 0 && <Text color="red">{` · ${near} near limit`}</Text>}
            <Text dimColor>{` · ${snap.projects.length} projects · ${ago(snap.at)}`}</Text>
          </Box>
          <Box flexDirection="row">
            <Button key="refresh" plain label="↻ " onPress={() => void rescan($)} />
            <Button key="settings" plain dimColor={!settingsShown} label="⚙" onPress={() => update($, settingsOpen, v => !v)} />
          </Box>
        </Box>
        {err && <Text color="red">{err}</Text>}
        {settingsShown && settings}
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
    )
  })
}
