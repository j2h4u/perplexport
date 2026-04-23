import { Page } from "puppeteer";
import { ThreadListItem } from "./types/conversation";
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
  space?: Space;
}

async function fetchJson<T>(page: Page, path: string): Promise<T> {
  for (let attempt = 0; attempt < LIST_FETCH_RETRIES; attempt++) {
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

export async function getConversations(
  page: Page
): Promise<Conversation[]> {
  const seen = new Set<string>();
  const all: Conversation[] = [];

  // 1. Main library — threads not assigned to any space
  console.log("Fetching main library...");
  const libraryThreads = await fetchJson<ThreadListItem[]>(
    page,
    `/rest/thread/list_recent?limit=${LIST_LIMIT}`
  );
  libraryThreads.forEach((t) => {
    if (seen.has(t.uuid)) return;
    seen.add(t.uuid);
    all.push({
      uuid: t.uuid,
      title: t.title ?? t.uuid,
      url: `https://www.perplexity.ai${t.link ?? `/search/${t.uuid}`}`,
    });
  });
  console.log(`  ${libraryThreads.length} threads in library`);

  // 2. Spaces — fetch full collection metadata (includes instructions) then threads
  console.log("Fetching spaces...");
  type CollectionItem = {
    uuid: string; slug: string; title: string;
    instructions?: string; description?: string;
  };
  const collectionsData = await fetchJson<CollectionItem[]>(
    page,
    "/rest/collections/list_user_collections"
  );
  const collectionBySlug = new Map(collectionsData.map((c) => [c.slug, c]));

  type SpacesV2 = { sections: { main: { items: Array<{ slug: string; title: string; uuid: string }> } } };
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
      `/rest/collections/list_collection_threads?collection_slug=${space.slug}&limit=${LIST_LIMIT}`
    );
    if (!Array.isArray(threads)) {
      console.log(`  "${space.title}": unexpected response`);
      continue;
    }
    const typedThreads = threads as Array<{ uuid: string; title: string; slug: string }>;
    typedThreads.forEach((t) => {
      if (seen.has(t.uuid)) return;
      seen.add(t.uuid);
      all.push({
        uuid: t.uuid,
        title: t.title ?? t.uuid,
        url: `https://www.perplexity.ai/search/${t.slug ?? t.uuid}`,
        space,
      });
    });
    console.log(`  "${space.title}": ${typedThreads.length} threads`);

    // TODO: Space files (uploaded documents/images) — API endpoint not yet discovered.
    // When phone-verification gate is resolved:
    //   GET /rest/collections/list_collection_files?collection_slug=<slug>
    //   or similar endpoint (file_count field exists in list_user_collections response).
    // The Space object already carries uuid/slug needed to make this call.
  }

  console.log(`Total unique threads: ${all.length}`);
  return all;
}
