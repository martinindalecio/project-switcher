# project-switcher

**See every Claude Code session you have, grouped by project, with how full each context window is. Click one to jump back in.**

[![License: MIT](https://img.shields.io/badge/license-MIT-d97757.svg)](LICENSE)
![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-d97757)
![macOS](https://img.shields.io/badge/platform-macOS-lightgrey)

![The Projects pane](docs/hero.png)

<sub>Illustration of the pane. The real one draws with your terminal's or Claude Desktop's own colours.</sub>

When you run Claude Code in several repos at once, sessions are hard to keep track of. Which one was I in? Which one is about to hit the context limit? project-switcher adds a **Projects** pane that answers both questions, and one click resumes any session in Claude Desktop, Terminal or iTerm.

## Quick start

In a Claude Code terminal session, type:

```
/plugin install project-switcher --marketplace martinindalecio/project-switcher
```

Answer `y` to add the marketplace and press Enter for the user scope. Then type `/projects`, or press `p` on the `▤ Projects` launcher.

## What you get

Plain-text view of the same pane:

```
2 open · 1 near limit · 24 projects · now              ↻ ⚙

Open now
  ● Fix flaky auth test              ▰▰▰▰▰▰▰▱  86%  2m
  ● Landing page copy                ▰▰▰▱▱▱▱▱  38% now

Projects
▾ webapp ●2 31
  ● Fix flaky auth test              ▰▰▰▰▰▰▰▱  86%  2m
  ○ Migrate to the new router        ▰▰▰▰▱▱▱▱  52%  1d
    +2 more
▸ api 12
```

- Lists every project under `~/.claude/projects`, newest first.
- Each session row shows a context-fill bar, a percentage and when it was last active.
- `●` marks a session running right now, in Claude Desktop or a terminal.
- **Click a session** to open it in Claude Desktop (default), Terminal or iTerm.
- It refreshes when a message finishes in any session, so there is no UI polling.
- It runs in the terminal CLI and in the Claude Desktop Code tab.

## Requirements

- macOS. It uses `ps`, `lsof`, `open` and `osascript`.
- `python3` on your `PATH`.
- Claude Code with plugin hooks. Tested with version 2.1.295.

## Install

```
/plugin install project-switcher --marketplace martinindalecio/project-switcher
```

The command runs in a terminal session. Installed at the user scope, the plugin also loads in the Claude Desktop Code tab. Start a **new** Desktop session after installing or updating.

## Uninstall

```
/plugin uninstall project-switcher
```

## Use

Click **▤ Projects** above the prompt, or type `/projects`, to open the pane and rescan.

The pane follows you: once you open it, every other session you start or switch to in Claude Desktop opens it too. It stops when you close it by hand. The `▤ Projects` launcher shows only while the pane is closed.

- Click a project name to fold it or unfold it. When two projects share a folder name, the parent folder is shown too (`work/app`).
- `+N more` shows the rest of that project's recent sessions.
- `↻` rescans now.
- `⚙` shows the settings.

What a click on a session does:

| Session state | Open in **Desktop** | Open in **Terminal / iTerm** |
| --- | --- | --- |
| not running | Claude Desktop takes it over and shows it | a new window runs `cd <cwd> && claude --resume <id>` |
| running in Claude Desktop | switches to it | refused with a toast, so it doesn't get a second writer |
| running in a terminal | refused with a toast, so it doesn't get a second writer | refused with a toast |

Opening in Desktop uses the app's `claude://resume?session=<id>` link. The session then shows up in Desktop's sidebar.

## Keyboard shortcuts

| Key | Where | Does |
| --- | --- | --- |
| `p` | launcher above the prompt | opens the pane |
| `1`–`9` | pane | resumes the first nine sessions you can open |
| `r` | pane | rescans now |
| `s` | pane | shows or hides the settings |

Keys work while the launcher or the pane has focus.

## What you'll see in special cases

- **No sessions yet:** a short note explaining that sessions appear once you start Claude Code in any folder.
- **Not on macOS:** "Project switcher works on macOS for now." Nothing is scanned.
- **No python3:** a note to install the Xcode Command Line Tools (`xcode-select --install`).
- **A scan error:** a plain sentence, the raw error dimmed below it, and `r` to retry.
- **`~62%`:** an estimate. The model's context window wasn't known, so 200k was assumed. Once any of your sessions reports the window, it is remembered and the `~` goes away.
- **`path guessed`:** the transcript had no working folder, so the path was rebuilt from the folder name and may be wrong when it contains dashes.
- The launcher hides when the pane is open, or when no other session is open and none is near its limit.

## Settings

Change them from the pane's `⚙` section, or from `/config` in the terminal CLI. Each change takes effect at once.

| Setting | Default | What it does |
| --- | --- | --- |
| Open sessions in | `desktop` | `desktop`, `terminal` or `iterm` |
| Open the pane when a session starts | off | When on, it opens in every new session. When off, it reopens only while you left it open |
| Launcher above the prompt | on | Shows a `▤ Projects` button while the pane is closed |
| Sessions shown per project | 3 | Rows shown before `+N more` |
| Projects shown | 8 | Projects listed before `Show N more projects` |
| Context warning at | 60% | Fill at which a session turns yellow |
| Context danger at | 75% | Fill at which a session turns red and counts as "near limit" |

The values are stored in `~/.claude/settings.json` under `pluginConfigs`.

## How it works

| Path | What |
| --- | --- |
| `.claude-plugin/plugin.json` | Manifest, including the settings (`userConfig`) |
| `hooks/register.tsx` | Hooks for the pane render, `/projects`, the settings and the scanner lifecycle |
| `bin/scan.py` | Reads transcript heads and tails for title and token usage, and matches running `claude` processes. `once` prints one snapshot; `watch` prints a new one whenever a session's turn ends. |
| `types/index.d.ts` | Types for the plugin's state |
| `tests/pane.test.tsx` | Mount tests on the terminal and desktop surfaces |
| `tests/test_scan.py` | Scanner unit tests on sample transcripts |

Context fill is the last assistant message's input and cache tokens divided by the model's window. The window is 1M for `[1m]` models; otherwise it is the window learned from your own sessions (kept across sessions); otherwise 200k, shown as an estimate with `~`. Anything over 200k is treated as 1M.

The background scanner (`scan.py watch`) runs only while the pane is open. Otherwise the launcher's counts come from a single scan when a session starts and after each turn, at most once every 30 seconds. Only transcripts named with a session UUID are read, and a session id is checked again before it is used in a command.

## Known limitations

- macOS only.
- In Claude Desktop the pane reopens when you switch sessions only if the app raises the session-attach event on each switch. If it doesn't appear, type `/projects` or press `p`.
- Context windows are learned best-effort. Models none of your sessions has reported keep the `~` marker.

## Troubleshooting

- **The pane is blank or doesn't appear.** Run `/projects` in a new session. Panes opened by a command appear at any width.
- **Clicking a session does nothing.** Check the toast. For Desktop, Claude.app must be installed. For iTerm, macOS may ask you once to allow automation.
- **Debug log:** run `claude --debug` and look for lines starting with `project-switcher:`.

## Develop

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

```bash
python3 -m unittest tests/test_scan.py
```

To run your local copy instead of the installed one:

```bash
claude --plugin-dir .
```

Issues and pull requests are welcome. Linux support (it needs `/proc` instead of `lsof`, and another way to open a terminal) would be a good first contribution.

## License

[MIT](LICENSE)
