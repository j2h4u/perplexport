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

/** Max threads per list API call. Perplexity doesn't paginate these in practice. */
export const LIST_LIMIT = 1000;

/** Max entries per thread page (server-side limit is 100). */
export const THREAD_PAGE_SIZE = 100;
