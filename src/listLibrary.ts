import { Page } from "puppeteer";
import {
  LIBRARY_FIRST_PAGE_QUERY,
  LIBRARY_MAX_PAGES,
  LIBRARY_NEXT_PAGE_QUERY,
  LIBRARY_PAGE_SIZE,
} from "./config";

// Why this exists: /rest/thread/list_recent is hard-capped at 20 threads and ignores
// limit, offset, cursor and page entirely, so it can only ever see the 20 most recent
// conversations. The Library page doesn't use it — it uses a GraphQL connection that
// pages properly, which is the only way to enumerate an entire account.
//
// Two operations are involved, and they are not interchangeable:
//   - the first page takes the filter variables alone
//   - later pages use a DIFFERENT operation/hash, with `count` + `cursor`
// Sending `after` to the first-page operation looks like it works (HTTP 200) but the
// variable is silently dropped and the same 25 rows come back forever, so paging must
// switch operations after page one.

/** One row of the library connection. */
export interface LibraryThread {
  /** Thread UUID — the value the /rest/thread/<uuid> endpoints expect. */
  uuid: string;
  title: string;
  /** "SEARCH", "COMPUTER", … — decides which URL shape the thread uses. */
  mode?: string;
  updatedAt?: string;
  spaceSlug?: string;
}

/** Variables shared by both operations; mirrors what the web app sends. */
function filterVariables() {
  return {
    includeSearchPreview: false,
    searchTerm: null,
    sortOrder: "NEWEST",
    statuses: null,
    threadTypes: null,
    sources: null,
    includeTemporary: null,
    itemTypes: ["THREAD", "AUTOMATION"],
    includeFirstMessagePreview: false,
    viewerState: null,
  };
}

interface GraphQLResult {
  status: number;
  body: string;
}

/** POST a persisted GraphQL query from inside the page.
 *  In-page like every other /rest/ call: Cloudflare binds cf_clearance to the
 *  browser's TLS fingerprint (see fetchThread in ConversationSaver.ts). */
async function postPersisted(
  page: Page,
  operationName: string,
  sha256Hash: string,
  variables: Record<string, unknown>,
): Promise<GraphQLResult> {
  return page.evaluate(
    async (op: string, hash: string, vars: Record<string, unknown>) => {
      try {
        const r = await fetch("/rest/perplexity_ask/graphql", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            operationName: op,
            variables: vars,
            extensions: { persistedQuery: { version: 1, sha256Hash: hash } },
          }),
        });
        return { status: r.status, body: await r.text() };
      } catch (e) {
        return { status: -1, body: String(e) };
      }
    },
    operationName,
    sha256Hash,
    variables,
  );
}

interface Connection {
  edges?: Array<{ node?: { title?: string; object?: Record<string, unknown> } | null } | null>;
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
}

/** The connection sits at viewer.recentGroup.items in both operations' responses. */
function readConnection(body: string, operationName: string): Connection {
  const parsed = JSON.parse(body) as {
    data?: { viewer?: { recentGroup?: { items?: Connection } } };
    errors?: Array<{ message?: string }>;
  };

  if (parsed.errors?.length) {
    const message = parsed.errors
      .map((e) => e?.message)
      .filter(Boolean)
      .join("; ");
    throw new Error(`${operationName}: ${message || "GraphQL error"}`);
  }

  const items = parsed.data?.viewer?.recentGroup?.items;
  if (!items) throw new Error(`${operationName}: unexpected response shape`);
  return items;
}

function toThread(node: {
  title?: string;
  object?: Record<string, unknown>;
}): LibraryThread | null {
  const object = node.object ?? {};
  // `slug` carries the real UUID. `id` is an opaque Relay id ("TH:…") and
  // contextUUID is a different identifier, so neither can be used here.
  const uuid = typeof object.slug === "string" ? object.slug : undefined;
  if (!uuid) return null;

  const space = object.space as { slug?: string } | null | undefined;

  return {
    uuid,
    title: (typeof object.name === "string" && object.name) || node.title || uuid,
    mode: typeof object.mode === "string" ? object.mode : undefined,
    updatedAt: typeof object.updatedAt === "string" ? object.updatedAt : undefined,
    spaceSlug: typeof space?.slug === "string" ? space.slug : undefined,
  };
}

/** Raised when the persisted-query hashes no longer match the deployed frontend. */
export class PersistedQueryUnavailable extends Error {}

function assertUsable(result: GraphQLResult, operationName: string): void {
  if (result.status === 200) return;
  // 4xx with this marker means the stored query is gone — a hash refresh is needed.
  if (result.body.includes("PersistedQueryNotFound")) {
    throw new PersistedQueryUnavailable(
      `${operationName}: persisted query not recognised by the server (hash needs refreshing)`,
    );
  }
  throw new Error(`${operationName}: HTTP ${result.status}`);
}

/** Enumerate every thread in the library, following the connection to the end.
 *
 *  Throws PersistedQueryUnavailable if the stored queries have rotated, so the
 *  caller can fall back to the 20-thread REST endpoint rather than failing. */
export async function listLibraryThreads(page: Page): Promise<LibraryThread[]> {
  const threads: LibraryThread[] = [];
  const seen = new Set<string>();

  const first = await postPersisted(
    page,
    LIBRARY_FIRST_PAGE_QUERY.operationName,
    LIBRARY_FIRST_PAGE_QUERY.sha256Hash,
    filterVariables(),
  );
  assertUsable(first, LIBRARY_FIRST_PAGE_QUERY.operationName);

  let connection = readConnection(first.body, LIBRARY_FIRST_PAGE_QUERY.operationName);
  let pages = 1;

  for (;;) {
    let added = 0;
    for (const edge of connection.edges ?? []) {
      const node = edge?.node;
      if (!node) continue;
      const thread = toThread(node);
      if (!thread || seen.has(thread.uuid)) continue;
      seen.add(thread.uuid);
      threads.push(thread);
      added++;
    }

    const cursor = connection.pageInfo?.endCursor;
    if (!connection.pageInfo?.hasNextPage || !cursor) break;

    // A page that advances the cursor but yields nothing new means the cursor has
    // stopped moving; stop rather than spin. (The first-page operation behaves this
    // way if it is ever sent a cursor, which is the bug this module exists to avoid.)
    if (added === 0 && pages > 1) break;

    if (pages >= LIBRARY_MAX_PAGES) {
      console.warn(`  stopped after ${pages} library pages (safety cap)`);
      break;
    }

    const next = await postPersisted(
      page,
      LIBRARY_NEXT_PAGE_QUERY.operationName,
      LIBRARY_NEXT_PAGE_QUERY.sha256Hash,
      { ...filterVariables(), count: LIBRARY_PAGE_SIZE, cursor },
    );
    assertUsable(next, LIBRARY_NEXT_PAGE_QUERY.operationName);
    connection = readConnection(next.body, LIBRARY_NEXT_PAGE_QUERY.operationName);
    pages++;
  }

  return threads;
}

/** Thread URL. Agentic ("computer") threads live under a different path, and the
 *  done.json key is this URL, so the shape has to match what was recorded before. */
export function threadUrl(thread: LibraryThread): string {
  const path =
    thread.mode === "COMPUTER" ? `/computer/tasks/${thread.uuid}` : `/search/${thread.uuid}`;
  return `https://www.perplexity.ai${path}`;
}
