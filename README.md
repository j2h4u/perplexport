# Perplexity Conversation Exporter

Export and regularly sync your Perplexity history — both main library threads and Spaces — into local Markdown and JSON files.

The first run exports the available history. Later runs are incremental: the tool skips unchanged threads, picks up new conversations, and refreshes existing conversations only when the remote state changed. That makes it suitable for scheduled backups, not just a one-time emergency export.

## Output

```
conversations/
  Space Name/
    _space.md        ← space title + system instructions
    <uuid>.md
    <uuid>.json
  <uuid>.md          ← library threads (no space)
  <uuid>.json
done.json            ← progress log; safe to resume after interruption
```

## Prerequisites

- **Node.js ≥ 16** — [nodejs.org](https://nodejs.org)
- **Chrome system libraries** (Linux only) — Puppeteer downloads a bundled Chrome on `npm install`, but it requires shared libraries that may be missing on minimal systems:
  ```bash
  sudo apt-get install -y libglib2.0-0 libnss3 libatk1.0-0 libatk-bridge2.0-0 \
    libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libxkbcommon0 libasound2
  ```
  On macOS and Windows, no extra steps are needed.

## Install & run

```bash
git clone https://github.com/j2h4u/perplexport.git
cd perplexport
npm install && npm run build
node dist/cli.js -e your@email.com
```

First run: enter the 6-digit code sent to your email. Session is saved to `session-cookies.json` — subsequent sync runs can use just `node dist/cli.js`.

## Options

| Flag | Default | Description |
|------|---------|-------------|
| `-e` | only when cookies are missing or invalid | Perplexity account email |
| `-o` | `./conversations` | Output directory |
| `-c` | `session-cookies.json` | Session file |
| `-d` | `done.json` | Progress file |
| `--backup` | off | Rename existing output dir to `.backup` before running |

## Development

```bash
npm run check       # type-check without emitting (tsc --noEmit)
npm run lint        # oxlint
npm run format      # oxfmt (auto-fix)
npm run format:check  # oxfmt (CI mode, exits non-zero on diff)
npm run build       # tsc → dist/
npm run dev         # run from source via ts-node (no build step)
```

## Notes

- Incremental sync: re-running skips unchanged threads, picks up new ones, and refreshes changed ones
- Main library chats are checked with a lightweight latest-entry request before any full re-export
- Space chats are checked via remote `last_query_datetime`
- Crash-safe: each file written atomically; progress saved after every thread
- **Not exported:** uploaded files and images attached to Spaces — the API endpoint for Space files has not been discovered yet
- If Chrome doesn't launch: `npx puppeteer browsers install chrome`

---

> Fork of [leonid-shevtsov/perplexort](https://github.com/leonid-shevtsov/perplexort) — completely rewritten. The original UI scraping no longer works with the current Perplexity interface.
