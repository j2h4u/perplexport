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
  _files/            ← only with --files
    <uuid>/
      manifest.json  ← what was found, sizes, sha256
      Report.pdf     ← generated results + uploaded context files
done.json            ← progress log; safe to resume after interruption
```

## Prerequisites

- **Node.js and npm** — [nodejs.org](https://nodejs.org)
- **Puppeteer Chrome** — if Chrome is missing, install it with `npx puppeteer browsers install chrome`.
- **Chrome system libraries** (Linux only) — minimal systems may need shared libraries:
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

Enter the 6-digit code sent to your email (**valid ~5 minutes** — request a new run if it expires). The session is saved to `session-cookies.json` and lasts ~30 days; during that time the routine sync above works without `-e`.

### Downloading thread files

Threads often carry files: documents you uploaded as context, and files the assistant
generated (PDFs, spreadsheets, Word docs). `--files` saves both:

```bash
node dist/cli.js --files
```

Files land in `conversations/_files/<thread-uuid>/`, alongside a `manifest.json`
recording each file's kind (`upload` or `generated`), size, sha256, and status.
Re-running skips files already on disk, so this is safe to add to an existing export;
`--refetch-files` forces a re-download.

Two caveats, both upstream behaviour rather than tool limitations:

- Perplexity **prunes uploaded files** after a while. For older threads the upload is
  gone server-side and is recorded as `gone` in the manifest. Generated results are
  retained and still download fine.
- A file downloads only if it is still reachable at export time, so a thread's
  attachments are best captured by syncing regularly rather than years later.

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
| `--files` | off | Also download each thread's files: uploaded context files and generated results (PDF/XLSX/DOCX/MD/…) |
| `--refetch-files` | off | With `--files`, re-download files that already exist on disk |
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

## Why a real browser?

Perplexity's REST API sits behind **Cloudflare bot management**, and a valid session cookie isn't enough on its own: Cloudflare binds its `cf_clearance` cookie to the **TLS/JA3 fingerprint** of the browser that earned it. A plain Node `fetch` carrying the *exact same* cookies gets a `403 "Just a moment…"` challenge — the fingerprint doesn't match.

So every `/rest/` call is issued from inside the Puppeteer page (`page.evaluate(() => fetch(...))`). The browser is the Cloudflare-passing client, not an HTML renderer — the data itself is plain JSON. That's why a browser is needed on **every** run, not only at login. Going browserless would require a TLS-impersonating HTTP client (e.g. curl-impersonate) to spoof the JA3 fingerprint — an arms race against Cloudflare that isn't worth it for a backup tool.

## How the thread list is fetched (and when it can break)

`/rest/thread/list_recent` is **hard-capped at 20 threads** and ignores `limit`,
`offset`, `cursor`, `page` and `before` — so it cannot enumerate a library of any size.
The full list comes from the same GraphQL endpoint the Library page uses, which pages
properly.

That endpoint takes *persisted* queries: the query text lives server-side and the
client references it by `sha256Hash`. **Those hashes are tied to a Perplexity frontend
build and will eventually change.** When that happens:

- the export does **not** fail — it falls back to `list_recent`
- but the fallback only sees the **20 most recent threads**, so the export becomes
  incomplete
- three warnings are printed, naming the constant to update

```
  LibraryItemsRelayQuery: persisted query not recognised by the server (hash needs refreshing)
  Falling back to list_recent — only the 20 most recent threads.
  See LIBRARY_FIRST_PAGE_QUERY in src/config.ts for how to refresh.
```

**If you run this unattended, check the output for those warnings** — a scheduled backup
would otherwise keep succeeding while quietly capturing only the newest 20 threads.

To refresh the hashes: open [perplexity.ai/library](https://www.perplexity.ai/library),
scroll down far enough to load a second page, and in devtools copy `operationName` and
`extensions.persistedQuery.sha256Hash` from the `POST /rest/perplexity_ask/graphql`
requests into `LIBRARY_FIRST_PAGE_QUERY` / `LIBRARY_NEXT_PAGE_QUERY` in
[src/config.ts](src/config.ts). There are two: the first page and the pagination query.

## Notes

- Full library listing via GraphQL — `list_recent` only returns 20 threads (see above)
- Incremental sync: re-running skips unchanged threads, picks up new ones, and refreshes changed ones
- Main library chats are checked with a lightweight latest-entry request before any full re-export
- Space chats are checked via remote `last_query_datetime`
- Crash-safe: each file written atomically; progress saved after every thread
- **Thread files:** `--files` saves uploaded context files and generated results (PDFs, spreadsheets, documents) to `conversations/_files/<uuid>/`
- **Not exported:** files attached to a *Space* itself rather than to a thread — that API endpoint has not been discovered yet
- Perplexity prunes uploaded files after a while; for older threads these are gone upstream and recorded as `gone` in the manifest (generated results keep working)
- If Chrome doesn't launch: `npx puppeteer browsers install chrome`

---

> Fork of [leonid-shevtsov/perplexport](https://github.com/leonid-shevtsov/perplexport) — substantially rewritten. The original UI scraping no longer works with the current Perplexity interface.
