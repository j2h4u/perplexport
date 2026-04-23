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
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

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

async function loginWithEmail(page: Page, email: string): Promise<void> {
  console.log("Logging in to Perplexity...");
  await page.goto("https://www.perplexity.ai/", { waitUntil: "load", timeout: 30000 });
  await page.waitForSelector("button::-p-text('Sign In')", { timeout: 10000 });
  await page.click("button::-p-text('Sign In')");
  await page.waitForSelector('input[type="email"]', { timeout: 10000 });
  await page.type('input[type="email"]', email);
  await page.click("button::-p-text('Continue with email')");
  await page.waitForNavigation({ waitUntil: "load", timeout: 15000 });
  await page.waitForSelector('input[inputmode="numeric"]', { timeout: 15000 });

  const code = await promptCode("Enter the 6-digit code from your email: ");

  const otpInputs = await page.$$('input[inputmode="numeric"]');
  for (let i = 0; i < otpInputs.length && i < code.length; i++) {
    await otpInputs[i].click();
    await otpInputs[i].type(code[i]);
    await sleep(50);
  }
  await page.click("button::-p-text('Confirm')");
  await page.waitForNavigation({ waitUntil: "load", timeout: 60000 });
  console.log("Logged in");
}

export async function loadOrLogin(
  browser: Browser,
  email: string,
  cookiesFile: string
): Promise<Page> {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  // Try saved cookies — load the page first (fresh Cloudflare state),
  // then inject only long-lived auth cookies, then reload
  try {
    const raw = await fs.readFile(cookiesFile, "utf8");
    const allCookies = JSON.parse(raw);
    const authCookies = allCookies.filter(
      (c: { name: string; expires?: number }) =>
        !SKIP_COOKIES.has(c.name) &&
        (c.expires === undefined || c.expires === -1 || c.expires * 1000 > Date.now())
    );

    // Load page first (fresh Cloudflare state), then inject auth cookies
    await page.goto("https://www.perplexity.ai/", { waitUntil: "load", timeout: 30000 });
    await page.setCookie(...authCookies);
    // No reload — cookies apply to subsequent requests immediately

    if (await isSessionValid(page)) {
      console.log("Using saved session");
      return page;
    }
    console.log("Saved session invalid, re-logging in...");
  } catch {
    // No cookies file yet
  }

  // Full email OTP login
  await loginWithEmail(page, email);

  const cookies = await page.cookies();
  await fs.writeFile(cookiesFile, JSON.stringify(cookies, null, 2));
  console.log(`Session saved to ${cookiesFile}`);

  return page;
}
