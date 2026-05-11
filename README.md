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

## Notes

- Incremental sync: re-running skips unchanged threads, picks up new ones, and refreshes changed ones
- Main library chats are checked with a lightweight latest-entry request before any full re-export
- Space chats are checked via remote `last_query_datetime`
- Crash-safe: each file written atomically; progress saved after every thread
- If Chrome doesn't launch: `npx puppeteer browsers install chrome`
- Requires Node.js ≥ 16

---

> Fork of [leonid-shevtsov/perplexort](https://github.com/leonid-shevtsov/perplexort) — completely rewritten. The original UI scraping no longer works with the current Perplexity interface.
