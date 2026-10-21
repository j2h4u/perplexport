import { Page } from "puppeteer";
import { ThreadListItem } from "./types/conversation";
import { listLibraryThreads, PersistedQueryUnavailable, threadUrl } from "./listLibrary";
import { sleep } from "./utils";
import {
  SPACE_REQUEST_DELAY_MS,
  RATE_LIMIT_BACKOFF_BASE_MS,
  LIST_FETCH_RETRIES,
  LIST_LIMIT,
} from "./config";

export interface Space {
  slug: string;
  title: string;
  uuid: string;
  instructions?: string;
  description?: string;
}

export interface Conversation {
  uuid: string;
  title: string;
  url: string;
  lastQueryDatetime?: string;
  space?: Space;
}

async function fetchJson<T>(page: Page, path: string): Promise<T> {
  for (let attempt = 0; attempt < LIST_FETCH_RETRIES; attempt++) {
    // In-page fetch (not node HTTP) is deliberate — Cloudflare binds cf_clearance
    // to the browser's TLS/JA3 fingerprint; a node request with the same cookies
    // gets a 403 challenge. See fetchThread in ConversationSaver.ts for the full why.
    const result = await page.evaluate(async (p: string) => {
      const r = await fetch(p);
      return r.json();
    }, path);
    if ((result as any)?.error_code === "RATE_LIMITED") {
      const wait = RATE_LIMIT_BACKOFF_BASE_MS * (attempt + 1);
      console.log(`  Rate limited, retrying in ${wait / 1000}s...`);
      await sleep(wait);
      continue;
    }
    return result as T;
  }
  throw new Error(`Rate limited after ${LIST_FETCH_RETRIES} retries: ${path}`);
}

export async function getConversations(page: Page): Promise<Conversation[]> {
  const seen = new Set<string>();
  const all: Conversation[] = [];

  // 1. Main library — every thread, via the paginated GraphQL connection.
  //    list_recent is capped at 20 and ignores every paging parameter, so it is
  //    only a fallback for when the persisted-query hashes rotate.
  //
  //    The library connection also returns threads that live in a Space, so these
  //    are collected but not claimed until after the Space pass below — otherwise
  //    whichever pass ran first would win and a Space thread would be filed at the
  //    output root with no `space`, losing its folder and its _space.md entry.
  const deferredLibraryThreads: Conversation[] = [];
  console.log("Fetching main library...");
  try {
    const libraryThreads = await listLibraryThreads(page);
    libraryThreads.forEach((t) => {
      deferredLibraryThreads.push({ uuid: t.uuid, title: t.title, url: threadUrl(t) });
    });
    console.log(`  ${libraryThreads.length} threads in library`);
  } catch (err) {
    const reason = (err as Error).message;
    if (err instanceof PersistedQueryUnavailable) {
      console.warn(`  ${reason}`);
      console.warn("  Falling back to list_recent — only the 20 most recent threads.");
      console.warn("  See LIBRARY_FIRST_PAGE_QUERY in src/config.ts for how to refresh.");
    } else {
      console.warn(`  Library listing failed (${reason}); falling back to list_recent.`);
    }

    const recent = await fetchJson<ThreadListItem[]>(
      page,
      `/rest/thread/list_recent?limit=${LIST_LIMIT}`,
    );
    recent.forEach((t) => {
      deferredLibraryThreads.push({
        uuid: t.uuid,
        title: t.title ?? t.uuid,
        url: `https://www.perplexity.ai${t.link ?? `/search/${t.uuid}`}`,
      });
    });
    console.log(`  ${recent.length} threads in library (fallback)`);
  }

  // 2. Spaces — fetch full collection metadata (includes instructions) then threads
  console.log("Fetching spaces...");
  type CollectionItem = {
    uuid: string;
    slug: string;
    title: string;
    instructions?: string;
    description?: string;
  };
  const collectionsData = await fetchJson<CollectionItem[]>(
    page,
    "/rest/collections/list_user_collections",
  );
  const collectionBySlug = new Map(collectionsData.map((c) => [c.slug, c]));

  type SpacesV2 = {
    sections: { main: { items: Array<{ slug: string; title: string; uuid: string }> } };
  };
  const spacesData = await fetchJson<SpacesV2>(page, "/rest/spaces/landing/v2");
  const spaces = spacesData.sections?.main?.items ?? [];
  console.log(`  ${spaces.length} spaces found`);

  for (const spaceItem of spaces) {
    if (!spaceItem.slug) continue;
    await sleep(SPACE_REQUEST_DELAY_MS);

    const col = collectionBySlug.get(spaceItem.slug);
    const space: Space = {
      slug: spaceItem.slug,
      title: spaceItem.title,
      uuid: spaceItem.uuid,
      instructions: col?.instructions,
      description: col?.description,
    };

    const threads = await fetchJson<unknown>(
      page,
      `/rest/collections/list_collection_threads?collection_slug=${space.slug}&limit=${LIST_LIMIT}`,
    );
    if (!Array.isArray(threads)) {
      console.log(`  "${space.title}": unexpected response`);
      continue;
    }
    const typedThreads = threads as Array<{
      uuid: string;
      title: string;
      slug: string;
      last_query_datetime?: string;
    }>;
    typedThreads.forEach((t) => {
      if (seen.has(t.uuid)) return;
      seen.add(t.uuid);
      all.push({
        uuid: t.uuid,
        title: t.title ?? t.uuid,
        url: `https://www.perplexity.ai/search/${t.slug ?? t.uuid}`,
        lastQueryDatetime: t.last_query_datetime,
        space,
      });
    });
    console.log(`  "${space.title}": ${typedThreads.length} threads`);

    // TODO: Space-level files (documents attached to the Space itself, not to a
    // thread) — endpoint still not discovered. list_collection_files and several
    // variants all return 404; list_user_collections does expose a file_count, so
    // some endpoint exists. Note this is only about Space-level files: files
    // belonging to a thread are handled by src/fetchAttachments.ts (--files).
    // The Space object already carries the uuid/slug such a call would need.
  }

  // Anything the Space pass didn't claim is a plain library thread.
  for (const conversation of deferredLibraryThreads) {
    if (seen.has(conversation.uuid)) continue;
    seen.add(conversation.uuid);
    all.push(conversation);
  }

  console.log(`Total unique threads: ${all.length}`);
  return all;
}
