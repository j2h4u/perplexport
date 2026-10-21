// Timing constants — tune these if you hit Cloudflare challenges or rate limits

/** Pause between exporting individual threads (ms).
 *  Too fast → Cloudflare challenges; too slow → long export time.
 *  500ms has been observed to trigger Cloudflare after ~55 threads. */
export const THREAD_EXPORT_DELAY_MS = 1200;

/** Pause between fetching thread lists for consecutive spaces (ms).
 *  Perplexity rate-limits rapid list requests. */
export const SPACE_REQUEST_DELAY_MS = 800;

/** Base wait time when a Cloudflare challenge is detected (ms).
 *  Actual wait = CLOUDFLARE_BACKOFF_BASE_MS * (attempt + 1). */
export const CLOUDFLARE_BACKOFF_BASE_MS = 5000;

/** Base wait time when a RATE_LIMITED response is received (ms).
 *  Actual wait = RATE_LIMIT_BACKOFF_BASE_MS * (attempt + 1). */
export const RATE_LIMIT_BACKOFF_BASE_MS = 3000;

/** How many times to retry a thread fetch before giving up. */
export const THREAD_FETCH_RETRIES = 4;

/** How many times to retry a list API call before giving up. */
export const LIST_FETCH_RETRIES = 3;

/** Max threads per list API call.
 *  Note: /rest/thread/list_recent ignores this (and offset/cursor/page) and always
 *  returns at most 20 threads, which is why the library is enumerated over GraphQL
 *  instead — see src/listLibrary.ts. This limit still applies to the Space
 *  thread lists, which do honour it. */
export const LIST_LIMIT = 1000;

/** Max entries per thread page (server-side limit is 100). */
export const THREAD_PAGE_SIZE = 100;

/** How many files to download concurrently per thread.
 *  Kept low: the CDN is fine with it, but uploads carry a 10-minute
 *  pre-signed URL, so finishing a thread quickly matters more than raw speed. */
export const FILE_DOWNLOAD_CONCURRENCY = 4;

/** How many times to retry a single file download before giving up. */
export const FILE_DOWNLOAD_RETRIES = 3;

/** Base wait between file download retries (ms); multiplied by the attempt number. */
export const FILE_RETRY_BACKOFF_MS = 1000;

/** Give up on one file after this long (ms). Guards against a hung CDN connection. */
export const FILE_DOWNLOAD_TIMEOUT_MS = 120000;

/** Threads per page when walking the library via GraphQL.
 *  The server caps the first page at 25 regardless; later pages honour this. */
export const LIBRARY_PAGE_SIZE = 100;

/** Safety cap on library pages, so a cursor that stops advancing can't loop forever. */
export const LIBRARY_MAX_PAGES = 400;

/** Persisted-query hashes for the library listing.
 *
 *  Perplexity's web app sends GraphQL *persisted* queries: the query text lives
 *  server-side and the client references it by sha256. These hashes are tied to a
 *  frontend build and will eventually change — when they do, the server answers
 *  PersistedQueryNotFound and getConversations falls back to /rest/thread/list_recent
 *  (which returns only the 20 most recent threads).
 *
 *  To refresh: open the Library in a browser, scroll to trigger a second page, and
 *  copy operationName + extensions.persistedQuery.sha256Hash from the
 *  POST /rest/perplexity_ask/graphql requests. */
export const LIBRARY_FIRST_PAGE_QUERY = {
  operationName: "LibraryItemsRelayQuery",
  sha256Hash: "d7649c5560327f8b9dc7e69c7a59f00f4c323d0a592441ff1eac6f7e6b1d0bf9",
};

/** The *next* pages use a different operation and hash, with count/cursor
 *  variables instead of the first page's first/after. */
export const LIBRARY_NEXT_PAGE_QUERY = {
  operationName: "LibraryRecentItemsPaginationQuery",
  sha256Hash: "0306e8d9669f65a32f496ef70581533c6b5e327aef16b953004b9935f7d22c43",
};
