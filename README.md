# Perplexity Conversation Exporter

Perplexity suddenly started demanding phone verification for all account access, with a 30-day countdown before your data is deleted. Not everyone can or wants to comply: many countries aren't supported, your subscription may not match any number you own, or you simply don't want to hand over your phone number. This tool exports your full history — library and all Spaces — before the deadline, bypassing the phone verification gate entirely via direct API calls.

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
node dist/cli.js -e your@email.com -o ./conversations
```

First run: enter the 6-digit code sent to your email. Session is saved to `session-cookies.json` — subsequent runs need no code.

## Options

| Flag | Default | Description |
|------|---------|-------------|
| `-e` | required | Perplexity account email |
| `-o` | `.` | Output directory |
| `-c` | `session-cookies.json` | Session file |
| `-d` | `done.json` | Progress file |
| `--backup` | off | Rename existing output dir to `.backup` before running |

## Notes

- Idempotent: re-running skips already-exported threads and picks up new ones
- Crash-safe: each file written atomically; progress saved after every thread
- If Chrome doesn't launch: `npx puppeteer browsers install chrome`
- Requires Node.js ≥ 16

---

> Fork of [leonid-shevtsov/perplexort](https://github.com/leonid-shevtsov/perplexort) — completely rewritten. The original UI scraping no longer works with the current Perplexity interface.
