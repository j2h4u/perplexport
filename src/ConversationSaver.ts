import { Page } from "puppeteer";
import { ConversationResponse, ConversationEntry } from "./types/conversation";
import { sleep } from "./utils";
import {
  CLOUDFLARE_BACKOFF_BASE_MS,
  RATE_LIMIT_BACKOFF_BASE_MS,
  THREAD_FETCH_RETRIES,
  THREAD_PAGE_SIZE,
} from "./config";

async function fetchThread(page: Page, url: string): Promise<ConversationResponse> {
  for (let attempt = 0; attempt < THREAD_FETCH_RETRIES; attempt++) {
    const result = await page.evaluate(async (u: string) => {
      try {
        const r = await fetch(u);
        const text = await r.text();
        return { ok: r.ok, status: r.status, text };
      } catch (e) {
        return { ok: false, status: -1, text: String(e) };
      }
    }, url);

    if (!result.ok || result.text.startsWith("<!DOCTYPE")) {
      const wait = CLOUDFLARE_BACKOFF_BASE_MS * (attempt + 1);
      console.log(`  Cloudflare challenge, waiting ${wait / 1000}s...`);
      await sleep(wait);
      continue;
    }

    try {
      const data = JSON.parse(result.text) as ConversationResponse;
      if ((data as any)?.error_code === "RATE_LIMITED") {
        const wait = RATE_LIMIT_BACKOFF_BASE_MS * (attempt + 1);
        console.log(`  Rate limited, retrying in ${wait / 1000}s...`);
        await sleep(wait);
        continue;
      }
      return data;
    } catch {
      const wait = RATE_LIMIT_BACKOFF_BASE_MS * (attempt + 1);
      console.log(`  Bad JSON, retrying in ${wait / 1000}s...`);
      await sleep(wait);
    }
  }
  throw new Error(`Failed to fetch thread after ${THREAD_FETCH_RETRIES} attempts: ${url}`);
}

export async function loadThread(
  page: Page,
  uuid: string
): Promise<{ id: string; conversation: ConversationResponse }> {
  let entries: ConversationEntry[] = [];
  let cursor: string | null = null;

  do {
    const url = cursor
      ? `/rest/thread/${uuid}?limit=${THREAD_PAGE_SIZE}&cursor=${encodeURIComponent(cursor)}`
      : `/rest/thread/${uuid}?limit=${THREAD_PAGE_SIZE}`;

    const data = await fetchThread(page, url);
    entries = entries.concat(data.entries);
    cursor = data.has_next_page ? data.next_cursor : null;
  } while (cursor);

  return {
    id: uuid,
    conversation: { status: "completed", entries, has_next_page: false, next_cursor: null },
  };
}
