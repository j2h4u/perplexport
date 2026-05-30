import { Browser, Page } from "puppeteer";
import { promises as fs } from "fs";
import * as readline from "readline";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Short-lived cookies that must NOT be pre-loaded (browser generates fresh ones)
const SKIP_COOKIES = new Set([
  "__cf_bm",
  "pplx.session-id",
  "pplx.edge-sid",
  "next-auth.csrf-token",
  "pplx.visitor-region",
  "pplx.visitor-country",
]);

function promptCode(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

const OTP_EMAIL_TIMEOUT_MS = 5 * 60 * 1000; // emailed code is valid ~5 min; no point waiting longer

// Read a code from the named pipe. fs.readFile on a FIFO blocks until something is written,
// so without a deadline the process waits indefinitely — correct for the TOTP step (the
// authenticator code refreshes every ~30s and never expires), but the emailed code dies
// after ~5 min, so that wait is time-boxed with a logged countdown.
async function readPipeCode(path: string, label: string, timeoutMs?: number): Promise<string> {
  if (!timeoutMs) {
    return (await fs.readFile(path, "utf8")).trim();
  }
  const deadline = Date.now() + timeoutMs;
  const countdown = setInterval(() => {
    const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    console.log(`  still waiting for ${label} code — ${left}s left`);
  }, 60000);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Timed out after 5 min waiting for the ${label} code.`)),
      timeoutMs,
    );
  });
  try {
    const data = await Promise.race([fs.readFile(path, "utf8"), timeout]);
    return (data as string).trim();
  } finally {
    clearInterval(countdown);
    if (timer) clearTimeout(timer);
  }
}

// Obtain a verification code. With --otp-fifo, read it from a named pipe so a non-interactive
// caller (e.g. an agent) can deliver it mid-run via `echo 123456 > <path>`; otherwise prompt.
async function getCode(
  otpFifo: string | undefined,
  label: string,
  timeoutMs?: number,
): Promise<string> {
  if (otpFifo) {
    const bound = timeoutMs ? "times out in 5 min" : "no timeout (code refreshes every ~30s)";
    console.log(`Waiting for ${label} code at ${otpFifo} (echo 123456 > ${otpFifo}); ${bound}`);
    return readPipeCode(otpFifo, label, timeoutMs);
  }
  return promptCode(`Enter the ${label} code: `);
}

// Without this cookie the session is anonymous; Perplexity then serves a logged-out
// library (HTTP 200 + empty list) that an HTTP-status-only check mistakes for a valid
// session. Checking the cookie up front catches the common expiry case before any request.
const REQUIRED_AUTH_COOKIE = "__Secure-next-auth.session-token";

interface StoredCookie {
  name: string;
  expires?: number;
}

// A saved session is only usable if the auth cookie is present and not expired.
export function hasValidAuthCookie(cookies: StoredCookie[], now: number = Date.now()): boolean {
  return cookies.some(
    (c) =>
      c.name === REQUIRED_AUTH_COOKIE &&
      (c.expires === undefined || c.expires === -1 || c.expires * 1000 > now),
  );
}

// Best-effort liveness check for a non-expired cookie that may have been revoked
// server-side. Anonymous requests also return 200, so this is backed up by
// hasValidAuthCookie (above) and the empty-library guard in exportLibrary.
async function isSessionValid(page: Page): Promise<boolean> {
  try {
    const status = await page.evaluate(async () => {
      const r = await fetch("/rest/thread/list_recent?limit=1");
      return r.status;
    });
    return status === 200;
  } catch {
    return false;
  }
}

// Code screens vary: the email step uses six per-digit numeric boxes; the TOTP step may
// use a single one-time-code field. Match all common shapes.
const CODE_INPUT_SELECTOR =
  'input[inputmode="numeric"], input[autocomplete="one-time-code"], input[type="tel"]';

// The TOTP challenge renders one bare <input> (no type/inputmode/name attributes) and submits
// via "Verify". Match any non-hidden input — this catches the bare field while still excluding
// the hidden cf-turnstile-response element on the Cloudflare interstitial.
const TOTP_INPUT_SELECTOR = 'input:not([type="hidden"])';

// Capture a screenshot plus the page's inputs and visible text — enough to tell a selector
// mismatch from a Cloudflare interstitial without another login round.
async function dumpPageDiagnostics(page: Page, name: string): Promise<void> {
  const shot = `${name}.png`;
  await page.screenshot({ path: `${name}.png`, fullPage: true }).catch(() => {});
  const info = await page
    .evaluate(() => ({
      url: location.href,
      title: document.title,
      bodyText: document.body?.innerText?.slice(0, 300),
      inputs: Array.from(document.querySelectorAll("input")).map((i) => ({
        type: i.type,
        inputmode: i.getAttribute("inputmode"),
        autocomplete: i.autocomplete,
        name: i.name,
      })),
    }))
    .catch(() => null);
  console.log(`Diagnostics (${shot}): ${JSON.stringify(info)}`);
}

// Wait for a usable code input, but fail fast with a clear message if the page is stuck on a
// Cloudflare Turnstile interstitial — otherwise we'd wait the full timeout for an opaque error.
async function waitForCodeInput(page: Page, selector: string, label: string): Promise<void> {
  const start = Date.now();
  let blockedSince: number | null = null;
  while (Date.now() - start < 90000) {
    for (const handle of await page.$$(selector)) {
      const usable = await handle
        .evaluate((el) => {
          const input = el as HTMLInputElement;
          // getClientRects (not offsetParent) — the latter is null inside position:fixed modals.
          return input.type !== "hidden" && el.getClientRects().length > 0;
        })
        .catch(() => false);
      if (usable) return;
    }
    const onCloudflare = await page
      .evaluate(
        () =>
          document.title.trim() === "Just a moment..." ||
          !!document.body?.innerText?.includes("Performing security verification"),
      )
      .catch(() => false);
    if (onCloudflare) {
      blockedSince ??= Date.now();
      if (Date.now() - blockedSince > 20000) {
        await dumpPageDiagnostics(page, `${label}-debug`);
        throw new Error(
          `Cloudflare Turnstile is blocking the ${label} page and did not clear. ` +
            `Re-run headful under a virtual display: xvfb-run -a node dist/cli.js ... --headful`,
        );
      }
    } else {
      blockedSince = null;
    }
    await sleep(1000);
  }
  await dumpPageDiagnostics(page, `${label}-debug`);
  throw new Error(`Timed out waiting for the ${label} code input.`);
}

// Code forms label their submit button "Confirm" (email) or "Verify" (TOTP); fall back to Enter.
async function clickSubmit(page: Page): Promise<void> {
  for (const label of ["Confirm", "Verify", "Continue", "Submit"]) {
    const btn = await page.$(`button::-p-text('${label}')`);
    if (btn) {
      await btn.click();
      return;
    }
  }
  await page.keyboard.press("Enter");
}

// Type a code into the OTP field(s) and submit. Handles both a single combined input and
// per-digit boxes, and falls back to Enter when there is no explicit submit button.
async function enterCode(page: Page, code: string, selector = CODE_INPUT_SELECTOR): Promise<void> {
  const inputs = await page.$$(selector);
  if (inputs.length <= 1) {
    const field = inputs[0];
    if (!field) throw new Error(`No code input matched ${selector}`);
    await field.click();
    await field.type(code);
  } else {
    for (let i = 0; i < inputs.length && i < code.length; i++) {
      await inputs[i].click();
      await inputs[i].type(code[i]);
      await sleep(50);
    }
  }
  await clickSubmit(page);
  await page.waitForNavigation({ waitUntil: "load", timeout: 60000 }).catch(() => {});
}

async function loginWithEmail(page: Page, email: string, otpFifo?: string): Promise<void> {
  console.log("Logging in to Perplexity...");
  await page.goto("https://www.perplexity.ai/", { waitUntil: "load", timeout: 30000 });
  await page.waitForSelector("button::-p-text('Sign In')", { timeout: 20000 });
  await page.click("button::-p-text('Sign In')");
  await page.waitForSelector('input[type="email"]', { timeout: 20000 });
  await page.type('input[type="email"]', email);
  await page.click("button::-p-text('Continue with email')");
  // Perplexity renders the code screen client-side; wait for the input (fail fast on Cloudflare).
  await waitForCodeInput(page, CODE_INPUT_SELECTOR, "email");
  await enterCode(page, await getCode(otpFifo, "email", OTP_EMAIL_TIMEOUT_MS));
  console.log("Email code submitted");

  // Second factor: only accounts with 2FA land on the TOTP challenge. Detect it by URL so
  // accounts without 2FA skip straight through. The authenticator code never expires, so
  // the wait for the user's code is unbounded; only finding the input element is bounded.
  if (page.url().includes("totp-challenge")) {
    console.log("2FA enabled — authenticator (TOTP) code required");
    await waitForCodeInput(page, TOTP_INPUT_SELECTOR, "TOTP");
    await enterCode(page, await getCode(otpFifo, "TOTP/authenticator"), TOTP_INPUT_SELECTOR);
    console.log("TOTP code submitted");
  }
}

export async function loadOrLogin(
  browser: Browser,
  email: string | undefined,
  cookiesFile: string,
  otpFifo?: string,
): Promise<Page> {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  // Try saved cookies — load the page first (fresh Cloudflare state),
  // then inject only long-lived auth cookies, then reload
  try {
    const raw = await fs.readFile(cookiesFile, "utf8");
    const allCookies = JSON.parse(raw);

    if (hasValidAuthCookie(allCookies)) {
      const authCookies = allCookies.filter(
        (c: { name: string; expires?: number }) =>
          !SKIP_COOKIES.has(c.name) &&
          (c.expires === undefined || c.expires === -1 || c.expires * 1000 > Date.now()),
      );

      // Load page first (fresh Cloudflare state), then inject auth cookies
      await page.goto("https://www.perplexity.ai/", { waitUntil: "load", timeout: 30000 });
      await page.setCookie(...authCookies);
      // No reload — cookies apply to subsequent requests immediately

      if (await isSessionValid(page)) {
        console.log("Using saved session");
        return page;
      }
    }
    console.log("Saved session invalid or expired, re-logging in...");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`Could not load cookies from ${cookiesFile}: ${(err as Error).message}`);
    }
  }

  // Full email OTP login
  if (!email) {
    throw new Error(
      "Saved session is missing or invalid. Re-run with -e, --email <email> to log in.",
    );
  }

  await loginWithEmail(page, email, otpFifo);

  // Confirm the OTP actually produced an authenticated session before trusting it —
  // a wrong/expired code or an extra verification gate leaves an anonymous page that
  // would otherwise be saved as a valid session and then sync zero conversations.
  const cookies = await page.cookies();
  if (!hasValidAuthCookie(cookies)) {
    const shot = "login-debug.png";
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    throw new Error(
      `Login did not produce an auth session (no ${REQUIRED_AUTH_COOKIE}). The code may be ` +
        `wrong or expired, or an extra verification step is required. Saved a screenshot to ` +
        `${shot} (landed on ${page.url()}).`,
    );
  }

  await fs.writeFile(cookiesFile, JSON.stringify(cookies, null, 2));
  console.log(`Session saved to ${cookiesFile}`);

  return page;
}
