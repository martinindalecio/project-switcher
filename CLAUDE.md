# project-switcher

Claude Code mod. Hooks in `hooks/register.tsx`, scanner in `bin/scan.py`. Validate with `claude plugin validate .`.
Load it with `--plugin-dir .` or `CLAUDE_CODE_PLUGIN_DIRS`. New sessions pick up edits. Tests: `claude plugin test .`.

## Portfolio sync

`.portfolio.json` drives this project's card on martingalaz.com. On push to `main` that changes it,
`.github/workflows/portfolio-sync.yml` upserts the Airtable row (key: `name`). Needs repo secrets
`AIRTABLE_TOKEN` and `AIRTABLE_BASE_ID`.
