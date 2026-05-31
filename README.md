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
```

**Routine sync** — no flags, no login. Uses the saved 30-day session, runs headless, and exports only new or changed threads:

```bash
node dist/cli.js
```

**First run / expired session** — pass your email to log in once:

```bash
node dist/cli.js -e your@email.com
```

Enter the 6-digit code sent to your email (**valid ~5 minutes** — request a new run if it expires). The session is saved to `session-cookies.json` and lasts ~30 days, after which the routine sync above works without `-e`.

### Two-factor accounts (TOTP)

If your account has an authenticator-app second factor, the login flow asks for the TOTP code after the email code. The 2FA page is protected by **Cloudflare Turnstile, which blocks headless Chrome** — so on a server you must run the login **headful under a virtual display**:

```bash
xvfb-run -a node dist/cli.js -e your@email.com --headful
```

Accounts without 2FA don't need `--headful`; the flow detects the TOTP challenge by URL and skips it when absent. Once the session is saved, routine incremental syncs work headless again (Turnstile only guards the login page).

### Non-interactive / automated login

`--otp-fifo <path>` reads each code from a named pipe instead of prompting, so a script or agent can deliver codes mid-run:

```bash
mkfifo /tmp/otp
xvfb-run -a node dist/cli.js -e your@email.com --headful --otp-fifo /tmp/otp &
# when prompted, write the email code, then (if 2FA) the authenticator code:
echo 123456 > /tmp/otp
```

The emailed code wait times out after 5 minutes; the TOTP wait does not (the authenticator code refreshes every ~30s).

## Options

| Flag | Default | Description |
|------|---------|-------------|
| `-e` | only when cookies are missing or invalid | Perplexity account email |
| `-o` | `./conversations` | Output directory |
| `-c` | `session-cookies.json` | Session file |
| `-d` | `done.json` | Progress file |
| `--backup` | off | Rename existing output dir to `.backup` before running |
| `--headful` | off | Run a visible browser (use with `xvfb-run`) — needed to pass Cloudflare on the 2FA page |
| `--otp-fifo <path>` | off | Read the email/TOTP codes from a named pipe instead of prompting |

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

> Fork of [leonid-shevtsov/perplexport](https://github.com/leonid-shevtsov/perplexport) — substantially rewritten. The original UI scraping no longer works with the current Perplexity interface.
