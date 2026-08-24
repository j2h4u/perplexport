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
