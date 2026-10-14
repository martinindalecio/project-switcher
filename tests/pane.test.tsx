import { expect, mock, test } from 'claude-code/testing'

const now = Date.now()
// a session id as the scanner emits it: a UUID; the tag (hex) makes it readable in a key
const uid = (tag: string) => `00000000-0000-4000-8000-${tag.padStart(12, '0')}`
const row = (tag: string, tokens: number | null, isOpen = false) => ({
  id: uid(tag), title: `Session ${tag} with a fairly long title to clip`, cwd: '/tmp', tokens, window: 200_000,
  model: 'claude-opus-5-5', mtimeMs: now - 3_600_000, isOpen, isSelf: false, inDesktop: false,
})
const SNAP = {
  at: now,
  projects: Array.from({ length: 10 }, (_, i) => ({
    dir: `d${i}`, name: `proj${i}`, path: `/tmp/p${i}`, total: 7, mtimeMs: now,
    sessions: [row(`${i}a`, 170_000, i === 0), row(`${i}b`, 90_000), row(`${i}c`, null), row(`${i}d`, 10_000), row(`${i}e`, 5_000)],
  })),
}

test('pane draws and toggles on terminal and desktop', async ($, on) => {
  // stands for the scanner: the snapshot read answers with fixed data
  on('state.get', async (_$, e, next) =>
    e.plugin === 'project-switcher' && e.key === 'snapshot' ? { value: { value: SNAP, version: 1 } } : next(e))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'project-switcher', surface, component: 'Pane', requestId: 'project-switcher',
      props: { title: 'Projects', isFocused: false, bodyColumns: 50, placement: 'dock' } as never,
    })
    expect((await ui.find({ key: `o-${uid('0a')}` }))).toBeDefined()        // open-now row
    expect((await ui.find({ key: `p-${uid('0c')}` }))).toBeUndefined()      // no usage: hidden
    expect((await ui.find({ key: 'm-d0' }))?.props.label).toBe('+1 more')
    expect((await ui.find({ key: 'more-projects' }))?.props.label).toBe('Show 2 more projects')
    // proj5 starts collapsed; one press expands it
    expect(await ui.find({ key: `p-${uid('5a')}` })).toBeUndefined()
    await ui.press({ key: 't-d5' })
    expect(await ui.find({ key: `p-${uid('5a')}` })).toBeDefined()
    await ui.press({ key: 't-d5' })
    await ui.press({ key: 'more-projects' })
    expect(await ui.find({ key: 't-d9' })).toBeDefined()
    await ui.press({ key: 'more-projects' })
    await ui.unmount()
  }
})

test('settings change the limits', { options: { sessionsPerProject: 1, projectsShown: 3 } }, async ($, on) => {
  on('state.get', async (_$, e, next) =>
    e.plugin === 'project-switcher' && e.key === 'snapshot' ? { value: { value: SNAP, version: 1 } } : next(e))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'project-switcher', surface, component: 'Pane', requestId: 'project-switcher',
      props: { title: 'Projects', isFocused: false, bodyColumns: 50, placement: 'dock' } as never,
    })
    expect((await ui.find({ key: 'm-d0' }))?.props.label).toBe('+3 more')
    expect((await ui.find({ key: 'more-projects' }))?.props.label).toBe('Show 7 more projects')
    await ui.unmount()
  }
})

test('pressing a session opens it where the setting says', async ($, on) => {
  const ran: string[][] = []
  on('process.run', async (_$, e) => { ran.push([...e.argv]); return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } })
  on('state.get', async (_$, e, next) =>
    e.plugin === 'project-switcher' && e.key === 'snapshot' ? { value: { value: SNAP, version: 1 } } : next(e))
  const ui = await $.ui.mount({
    plugin: 'project-switcher', surface: 'desktop', component: 'Pane', requestId: 'project-switcher',
    props: { title: 'Projects', isFocused: false, bodyColumns: 50, placement: 'dock' } as never,
  })
  await ui.press({ key: `pr-${uid('0b')}` })
  expect(ran.at(-1)).toEqual(['open', `claude://resume?session=${uid('0b')}`])
  ran.length = 0
  await ui.press({ key: `or-${uid('0a')}` })   // open in a terminal: refused, nothing runs
  expect(ran.length).toBe(0)
  await ui.unmount()
})

test('openIn terminal resumes with claude --resume in Terminal', { options: { openIn: 'terminal' } }, async ($, on) => {
  const ran: string[][] = []
  on('process.run', async (_$, e) => { ran.push([...e.argv]); return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } })
  on('state.get', async (_$, e, next) =>
    e.plugin === 'project-switcher' && e.key === 'snapshot' ? { value: { value: SNAP, version: 1 } } : next(e))
  const ui = await $.ui.mount({
    plugin: 'project-switcher', surface: 'terminal', component: 'Pane', requestId: 'project-switcher',
    props: { title: 'Projects', isFocused: false, bodyColumns: 50, placement: 'dock' } as never,
  })
  await ui.press({ key: `pr-${uid('1b')}` })
  expect(ran.at(-1)?.[0]).toBe('osascript')
  expect(ran.at(-1)?.[2]).toBe(`tell application "Terminal" to do script "cd '/tmp' && claude --resume ${uid('1b')}"`)
  await ui.unmount()
})

test('the settings section writes userConfig through $.config.set', async ($, on) => {
  const sets: unknown[] = []
  on('config.set', async (_$, e) => { sets.push([e.key, e.value]); return { value: e.value } })
  // stands for the menu: one row per userConfig field, keyed as the engine keys a plugin's fields
  on('config.list', async () => ({
    value: ['openIn', 'autoOpen', 'showLauncher', 'sessionsPerProject', 'projectsShown', 'warnAt', 'dangerAt']
      .map(f => ({ key: `project-switcher.${f}`, label: f })) as never,
  }))
  on('state.get', async (_$, e, next) =>
    e.plugin === 'project-switcher' && e.key === 'snapshot' ? { value: { value: SNAP, version: 1 } } : next(e))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'project-switcher', surface, component: 'Pane', requestId: 'project-switcher',
      props: { title: 'Projects', isFocused: false, bodyColumns: 50, placement: 'dock' } as never,
    })
    expect(await ui.find({ key: 'set-open-terminal' })).toBeUndefined()
    await ui.press({ key: 'settings' })
    await ui.press({ key: 'set-open-terminal' })
    await ui.press({ key: 'set-rows-inc' })
    await ui.press({ key: 'settings' })
    await ui.unmount()
  }
  expect(sets[0]).toEqual([expect.stringMatching(/^project-switcher.*\.openIn$/), 'terminal'])
  expect(sets[1]).toEqual([expect.stringMatching(/^project-switcher.*\.sessionsPerProject$/), 4])
})

// ---- launcher above the prompt, and the pane remembered across sessions ----

const SURFACES = ['terminal', 'desktop'] as const
const mountLauncher = ($: any, surface: 'terminal' | 'desktop') =>
  $.ui.mount({
    plugin: 'project-switcher', surface, component: 'AbovePrompt', requestId: 'launcher',
    props: { hasSurvey: false } as never,
  })

// stands for the engine's store and state: store.get/set go to a map, state.get answers paneUp
function stubEngine(on: any, opts: { wanted?: unknown; snapshot?: unknown } = {}) {
  const store = new Map<string, unknown>()
  if (opts.wanted !== undefined) store.set('paneWanted', opts.wanted)
  const opened: unknown[] = []
  const closed: unknown[] = []
  on('store.get', async (_$: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', async (_$: any, e: any) => { store.set(e.key, e.value); return { value: undefined } })
  on('ui.log', async () => ({ value: undefined }))
  on('session.start', async (_$: any, e: any) => ({ cwd: e.cwd }))
  on('session.attach', async (_$: any, e: any) => ({ clientId: e.clientId }))
  on('session.usage', async () => ({ value: { context: { window: 200_000 } } as never }))
  on('session.id', async () => ({ value: 'test-session' }))
  on('command.register', async () => ({ value: undefined }))
  // the preflight finds macOS with python3; a scan answers with SNAP
  const ran: string[][] = []
  on('process.run', async (_$: any, e: any) => {
    ran.push([...e.argv])
    const stdout = e.argv[0] === 'uname' ? 'Darwin\n' : e.argv[0] === 'python3' ? JSON.stringify(SNAP) : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  // the engine's record of panes: an open places it, a close takes it away
  const panes = new Map<string, unknown>()
  on('ui.panes', async () => ({ value: [...panes.values()] }))
  on('ui.open', async (_$: any, e: any) => {
    opened.push(e)
    panes.set(e.id, { id: e.id, title: e.title, isShown: true, isFocused: false, isPlaced: true })
    return { value: { isPlaced: true } }
  })
  on('ui.close', async (_$: any, e: any) => { closed.push(e); panes.delete(e.id); return { value: undefined } })
  // stands for the engine's own drawing, which a pass-through falls to
  on('ui.render', async () => ({ type: 'Text', props: {}, children: ['stock'] } as never))
  on('state.get', async (_$: any, e: any, next: any) => {
    if (e.plugin !== 'project-switcher') return next(e)
    if (e.key === 'snapshot') return { value: { value: opts.snapshot ?? SNAP, version: 1 } }
    return next(e)
  })
  return { store, opened, closed, panes, ran }
}

for (const surface of SURFACES) {
  test(`the launcher draws while the pane is closed (${surface})`, async ($, on) => {
    stubEngine(on)
    const ui = await mountLauncher($, surface)
    expect((await ui.find({ key: 'launch' }))?.props.label).toBe('▤ Projects')
    await ui.unmount()
  })

  test(`the launcher goes once the pane is up (${surface})`, async ($, on) => {
    stubEngine(on)
    const first = await mountLauncher($, surface)
    await first.press({ key: 'launch' })   // ui.open answers placed: paneUp turns true
    await first.unmount()
    const ui = await mountLauncher($, surface)
    expect(await ui.find({ key: 'launch' })).toBeUndefined()
    await ui.unmount()
  })

  test(`showLauncher false removes the launcher (${surface})`, { options: { showLauncher: false } }, async ($, on) => {
    stubEngine(on)
    const ui = await mountLauncher($, surface)
    expect(await ui.find({ key: 'launch' })).toBeUndefined()
    await ui.unmount()
  })

  test(`pressing the launcher remembers the pane and opens it (${surface})`, async ($, on) => {
    const { store, opened } = stubEngine(on)
    expect(store.get('paneWanted')).toBeUndefined()
    const ui = await mountLauncher($, surface)
    await ui.press({ key: 'launch' })
    expect(store.get('paneWanted')).toBe(true)
    expect(opened).toEqual([expect.objectContaining({ id: 'project-switcher' })])
    await ui.unmount()
  })
}

// restorePane runs unawaited from the hook: let it and its engine calls settle
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => (globalThis as any).setTimeout(r, 0)) }

test('session.start and session.attach reopen the pane only when it was left open', async ($, on) => {
  const { opened, panes } = stubEngine(on, { wanted: true })
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as never)
  await settle()
  expect(opened.length).toBe(1)
  expect(opened[0]).toEqual(expect.objectContaining({ id: 'project-switcher' }))
  opened.length = 0
  // a pane still up is left alone
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default', viewport: { isFullscreen: true } } as never)
  await settle()
  expect(opened.length).toBe(0)
  // a switch that took it away gets it back
  panes.clear()
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default', viewport: { isFullscreen: true } } as never)
  await settle()
  expect(opened.length).toBe(1)
})

for (const wanted of [false, undefined]) {
  test(`session.start and session.attach leave the pane shut when paneWanted is ${wanted}`, async ($, on) => {
    const { opened } = stubEngine(on, { wanted })
    await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as never)
    await $.session.attach({ surface: 'desktop', clientId: 'desktop:default', viewport: { isFullscreen: true } } as never)
    await settle()
    expect(opened.length).toBe(0)
  })
}


// ---- states, safety and the watcher's lifecycle ----

const mountPane = ($: any, surface: 'terminal' | 'desktop') =>
  $.ui.mount({
    plugin: 'project-switcher', surface, component: 'Pane', requestId: 'project-switcher',
    props: { title: 'Projects', isFocused: false, bodyColumns: 50, placement: 'dock' } as never,
  })

// answers the plugin's state reads from a fixed map; anything else falls to the kit's own state
function stubState(on: any, values: Record<string, unknown>) {
  on('state.get', async (_$: any, e: any, next: any) =>
    e.plugin === 'project-switcher' && e.key in values ? { value: { value: values[e.key], version: 1 } } : next(e))
}

for (const surface of SURFACES) {
  test(`no sessions draws the empty state (${surface})`, async ($, on) => {
    stubState(on, { snapshot: { at: now, projects: [] } })
    const ui = await mountPane($, surface)
    // the kit keeps keys on Buttons only, so Text is found by what it says
    expect(await ui.find({ text: /^No sessions yet/ })).toBeDefined()
    await ui.unmount()
  })

  test(`an unsupported platform says so (${surface})`, async ($, on) => {
    stubState(on, { env: 'unsupported', snapshot: SNAP })
    const ui = await mountPane($, surface)
    expect(await ui.find({ key: 'refresh' })).toBeUndefined()
    expect(await ui.find({ text: 'Project switcher works on macOS for now.' })).toBeDefined()
    await ui.unmount()
  })

  test(`a missing python3 says how to get it (${surface})`, async ($, on) => {
    stubState(on, { env: 'no-python', snapshot: SNAP })
    const ui = await mountPane($, surface)
    expect(await ui.find({ text: /Needs python3 .*xcode-select --install/ })).toBeDefined()
    expect(await ui.find({ key: 'refresh' })).toBeUndefined()
    await ui.unmount()
  })

  test(`a guessed window is marked ~ (${surface})`, async ($, on) => {
    const est = { ...row('fa', 150_000), windowKnown: false }
    const known = { ...row('fb', 150_000), windowKnown: true }
    stubState(on, { snapshot: { at: now, projects: [{ dir: 'dx', name: 'x', path: '/tmp/x', pathKnown: false, total: 2, mtimeMs: now, sessions: [est, known] }] } })
    const ui = await mountPane($, surface)
    const pcts = (await ui.findAll({ type: 'Text', text: /%$/ })).map((t: any) => t.text)
    expect(pcts).toEqual(['  ~75%', '   75%'])
    expect(await ui.find({ text: ' · path guessed' })).toBeDefined()
    await ui.unmount()
  })

  test(`the launcher hides when nothing else is open (${surface})`, async ($, on) => {
    const quiet = { at: now, projects: [{ ...SNAP.projects[1]!, sessions: [row('aa', 190_000)] }] }
    stubEngine(on, { snapshot: quiet })
    const ui = await mountLauncher($, surface)
    expect(await ui.find({ key: 'launch' })).toBeUndefined()
    await ui.unmount()
  })

  test(`the launcher has hotkey p and counts what is open (${surface})`, async ($, on) => {
    stubEngine(on)
    const ui = await mountLauncher($, surface)
    const launch = await ui.find({ key: 'launch' })
    expect(launch?.props.hotkey).toBe('p')
    expect(await ui.find({ text: ' 1' })).toBeDefined()
    expect(await ui.find({ text: ' · 1 near limit' })).toBeDefined()
    await ui.unmount()
  })

  for (const openIn of ['desktop', 'terminal', 'iterm'] as const) {
    test(`an id that is no UUID launches nothing (${surface}, ${openIn})`, { options: { openIn } }, async ($, on) => {
      const ran: string[][] = []
      on('process.run', async (_$: any, e: any) => { ran.push([...e.argv]); return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } })
      const toasts: string[] = []
      on('ui.toast', async (_$: any, e: any) => { toasts.push(e.text); return { value: undefined } })
      const bad = { ...row('ab', 10_000), id: `x'; touch /tmp/pwned; '` }
      stubState(on, { snapshot: { at: now, projects: [{ dir: 'dz', name: 'z', path: '/tmp/z', total: 1, mtimeMs: now, sessions: [bad] }] } })
      const ui = await mountPane($, surface)
      await ui.press({ key: `pr-${bad.id}` })
      await ui.unmount()
      expect(ran.length).toBe(0)
      expect(toasts.at(-1)).toContain("Can't resume")
    })
  }
}

test('hotkeys: r rescans, s settings, digits on resumable rows only', async ($, on) => {
  stubState(on, { snapshot: SNAP })
  const ui = await mountPane($, 'desktop')
  expect((await ui.find({ key: 'refresh' }))?.props.hotkey).toBe('r')
  expect((await ui.find({ key: 'settings' }))?.props.hotkey).toBe('s')
  // 0a is open in a terminal: no digit; 0b is the first resumable row
  expect((await ui.find({ key: `or-${uid('0a')}` }))?.props.hotkey).toBeUndefined()
  expect((await ui.find({ key: `pr-${uid('0b')}` }))?.props.hotkey).toBe('1')
  const digits = (await ui.findAll({ type: 'Button' })).map((b: any) => b.props.hotkey).filter((h: any) => typeof h === 'string' && /^\d$/.test(h))
  // numbered in drawing order, gap-free, at most nine (here the expanded projects hold eight)
  expect(digits).toEqual(digits.map((_: unknown, i: number) => String(i + 1)))
  expect(digits.length).toBeGreaterThan(1)
  expect(digits.length).toBeLessThanOrEqual(9)
  await ui.unmount()
})

// stands for `scan.py watch`: one snapshot, then a blank line each mocked second until the plugin ends the loop.
// It waits on the mocked clock, which the kit's acts don't wait for, so a press that starts it returns.
function stubWatch(on: any, clock: { sleep: (ms: number) => Promise<void> }) {
  const spawned: string[][] = []
  const live = { count: 0 }
  on('process.spawn', async function* (_$: any, e: any) {
    spawned.push([...e.argv])
    live.count++
    try {
      yield { stream: 'stdout', text: JSON.stringify(SNAP) + '\n' }
      for (;;) {
        await clock.sleep(1_000)
        yield { stream: 'stdout', text: '\n' }
      }
      return { code: 0, signal: null }
    } finally {
      live.count--
    }
  })
  return { spawned, live }
}

test('the watcher runs only while the pane is up', async ($, on) => {
  const { ran } = stubEngine(on)
  const clock = mock.clock(on, { now })
  const { spawned, live } = stubWatch(on, clock)
  on('session.detach', async (_$: any, e: any) => ({ clientId: e.clientId }))
  on('session.surfaces', async () => ({ value: [] }))
  // a session start scans once for the band; it starts no watcher
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as never)
  await settle()
  expect(spawned.length).toBe(0)
  expect(ran.some(a => a[0] === 'python3' && a.includes('once'))).toBe(true)
  // opening the pane starts it
  const band = await mountLauncher($, 'desktop')
  await band.press({ key: 'launch' })
  await band.unmount()
  await settle()
  expect(spawned.length).toBe(1)
  expect(spawned[0]).toContain('watch')
  expect(live.count).toBe(1)
  // stopping on close needs a live check: the test kit cannot raise ui.close
  // switching away in Desktop (the last surface detaches) ends it
  await $.session.detach({ surface: 'desktop', clientId: 'desktop:default', reason: 'detach' } as never)
  await clock.advance(1_000)
  await settle()
  expect(live.count).toBe(0)
  expect(spawned.length).toBe(1)
})

