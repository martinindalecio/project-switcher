import { expect, test } from 'claude-code/testing'

const now = Date.now()
const row = (id: string, tokens: number | null, isOpen = false) => ({
  id, title: `Session ${id} with a fairly long title to clip`, cwd: '/tmp', tokens, window: 200_000,
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
    expect((await ui.find({ key: 'o-0a' }))).toBeDefined()        // open-now row
    expect((await ui.find({ key: 'p-0c' }))).toBeUndefined()      // no usage: hidden
    expect((await ui.find({ key: 'm-d0' }))?.props.label).toBe('+1 more')
    expect((await ui.find({ key: 'more-projects' }))?.props.label).toBe('Show 2 more projects')
    // proj5 starts collapsed; one press expands it
    expect(await ui.find({ key: 'p-5a' })).toBeUndefined()
    await ui.press({ key: 't-d5' })
    expect(await ui.find({ key: 'p-5a' })).toBeDefined()
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
  on('process.run', async (_$, e) => { ran.push([...e.argv]); return { value: { exitCode: 0, stdout: '', stderr: '' } } })
  on('state.get', async (_$, e, next) =>
    e.plugin === 'project-switcher' && e.key === 'snapshot' ? { value: { value: SNAP, version: 1 } } : next(e))
  const ui = await $.ui.mount({
    plugin: 'project-switcher', surface: 'desktop', component: 'Pane', requestId: 'project-switcher',
    props: { title: 'Projects', isFocused: false, bodyColumns: 50, placement: 'dock' } as never,
  })
  await ui.press({ key: 'pr-0b' })
  expect(ran.at(-1)).toEqual(['open', 'claude://resume?session=0b'])
  ran.length = 0
  await ui.press({ key: 'or-0a' })   // open in a terminal: refused, nothing runs
  expect(ran.length).toBe(0)
  await ui.unmount()
})

test('openIn terminal resumes with claude --resume in Terminal', { options: { openIn: 'terminal' } }, async ($, on) => {
  const ran: string[][] = []
  on('process.run', async (_$, e) => { ran.push([...e.argv]); return { value: { exitCode: 0, stdout: '', stderr: '' } } })
  on('state.get', async (_$, e, next) =>
    e.plugin === 'project-switcher' && e.key === 'snapshot' ? { value: { value: SNAP, version: 1 } } : next(e))
  const ui = await $.ui.mount({
    plugin: 'project-switcher', surface: 'terminal', component: 'Pane', requestId: 'project-switcher',
    props: { title: 'Projects', isFocused: false, bodyColumns: 50, placement: 'dock' } as never,
  })
  await ui.press({ key: 'pr-1b' })
  expect(ran.at(-1)?.[0]).toBe('osascript')
  expect(ran.at(-1)?.[2]).toBe(`tell application "Terminal" to do script "cd '/tmp' && claude --resume 1b"`)
  await ui.unmount()
})

test('the settings section writes userConfig through $.config.set', async ($, on) => {
  const sets: unknown[] = []
  on('config.set', async (_$, e) => { sets.push([e.key, e.value]); return { value: e.value } })
  // stands for the menu: one row per userConfig field, keyed as the engine keys a plugin's fields
  on('config.list', async () => ({
    value: ['openIn', 'autoOpen', 'sessionsPerProject', 'projectsShown', 'warnAt', 'dangerAt']
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
