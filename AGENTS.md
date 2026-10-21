# Perplexport Agent Notes

This tool normally syncs without login:

```bash
node dist/cli.js
```

If that says the saved session is invalid, the Perplexity login is not OAuth and has no callback URL. It is browser login.

There are three cases:

1. Valid cookies: `node dist/cli.js` syncs immediately, no one-time code.
2. Expired/missing cookies: Perplexity sends a 6-digit one-time code to email.
3. TOTP enabled: after the email code, Perplexity also asks for the authenticator-app code.

Expired-session flow:

1. Open Perplexity in Puppeteer.
2. Enter the account email: `ccc911.ngs.ru@gmail.com`.
3. Enter the 6-digit email code.
4. Enter the TOTP/authenticator code.
5. Save refreshed cookies to `session-cookies.json`.

For this account, use headful login under Xvfb when refreshing cookies because Cloudflare Turnstile can block the TOTP page in headless Chrome:

```bash
xvfb-run -a node dist/cli.js -e ccc911.ngs.ru@gmail.com --headful
```

If Codex will type the email/TOTP codes into the running process, start the command with `tty=true`. Do not start OTP login through a non-TTY `exec_command`: it may print the prompt but close stdin, so the code cannot be submitted.

The Puppeteer Chrome cache is disposable; reinstall it with `npx puppeteer browsers install chrome` if it is missing.

## Thread files (`--files`)

`node dist/cli.js --files` also downloads each thread's uploaded context files and
generated result files into `conversations/_files/<thread-uuid>/`, plus a
`manifest.json` per thread (status, size, sha256, source entry).

Non-obvious details worth knowing before changing `src/fetchAttachments.ts`:

- **Generated files come from `/rest/thread/<uuid>/entry-metadata`**, not from the
  thread body. That response has `artifact_entries[].assets[]`, where `asset_type`
  selects the payload field (`PDF_FILE` → `pdf_file`, `XLSX_FILE` → `xlsx_file`, …).
  Its CloudFront URLs are signed fresh for ~7 days.
- **Don't try to scrape asset URLs out of `/rest/thread/<uuid>`.** They exist there,
  buried inside the JSON-encoded `entry.text` strings, but each carries the signature
  minted when the file was generated — already expired for any older thread. This is
  why a naive JSON walk over the thread body finds URLs that all return 403.
- **Uploaded files** are plain URLs in `entry.attachments[]`, re-signed per request
  but valid only ~10 minutes, so they must be downloaded in the same run that read
  the thread. Perplexity also prunes old uploads: an older thread returns
  `404 NoSuchKey` with a valid signature. That's upstream deletion, recorded as
  `gone` in the manifest rather than `failed`.
- **Only `/rest/` calls need the browser.** The S3/CloudFront URLs are pre-signed and
  sit outside Cloudflare, so downloads use plain node `fetch`. The reverse — a node
  `fetch` to `/rest/` — gets a 403 challenge (see `fetchThread` in
  `src/ConversationSaver.ts`).
- File failures never abort an export or stop a thread being marked processed;
  conversation text is the primary artifact.

Space-level files (documents attached to a Space rather than a thread) are still not
exported — `list_collection_files` and similar guesses all 404, and no test account
with `file_count > 0` was available to probe.

## Library enumeration

`/rest/thread/list_recent` is **hard-capped at 20 threads** and silently ignores
`limit`, `offset`, `cursor`, `page` and `before`. Don't try to page it — it can't be.

The full library comes from the GraphQL endpoint the Library page uses
(`src/listLibrary.ts`), via `POST /rest/perplexity_ask/graphql` with *persisted*
queries. Two operations are needed, and they are not interchangeable:

| Page | operationName | Paging variables |
|------|---------------|------------------|
| first | `LibraryItemsRelayQuery` | none (filters only) |
| rest | `LibraryRecentItemsPaginationQuery` | `count`, `cursor` |

Sending `after`/`cursor` to the *first-page* operation returns HTTP 200 but the
variable is dropped, so the same 25 rows come back on every request — an easy way to
conclude an account has thousands of threads when it has 55. Always switch operations
after page one, and treat "a page added nothing new" as the end of the walk.

The real thread UUID is `node.object.slug`. `node.object.id` is an opaque Relay id
(`TH:…`) and `contextUUID` is a different identifier; neither works against
`/rest/thread/<uuid>`. `node.object.mode === "COMPUTER"` means the thread lives at
`/computer/tasks/<uuid>` rather than `/search/<uuid>`.

The `sha256Hash` values are pinned to a frontend build and will eventually rotate. When
they do the server returns `PersistedQueryNotFound`, and `getConversations` logs a
warning and falls back to the 20-thread REST endpoint rather than failing the run. To
refresh them, open the Library, scroll to trigger a second page, and copy
`operationName` + `extensions.persistedQuery.sha256Hash` from the GraphQL requests into
`src/config.ts`.
