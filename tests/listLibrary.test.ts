import { describe, it, expect, vi } from "vitest";
import type { Page } from "puppeteer";
import { listLibraryThreads, PersistedQueryUnavailable, threadUrl } from "../src/listLibrary";
import { LIBRARY_FIRST_PAGE_QUERY, LIBRARY_NEXT_PAGE_QUERY } from "../src/config";

/** Build a library connection response. */
function connection(
  slugs: Array<{ slug: string; name?: string; mode?: string }>,
  pageInfo: { hasNextPage: boolean; endCursor?: string | null },
) {
  return JSON.stringify({
    data: {
      viewer: {
        recentGroup: {
          items: {
            edges: slugs.map((s) => ({
              node: {
                title: s.name,
                object: { __typename: "Thread", slug: s.slug, name: s.name, mode: s.mode },
              },
            })),
            pageInfo,
          },
        },
      },
    },
  });
}

/** Fake page recording which persisted operation each call used.
 *  `pages` is consumed in order, one per GraphQL request. */
function fakePage(pages: Array<{ status?: number; body: string }>) {
  const calls: Array<{ operationName: string; variables: Record<string, unknown> }> = [];
  const page = {
    evaluate: vi.fn(
      async (
        _fn: unknown,
        operationName: string,
        _hash: string,
        variables: Record<string, unknown>,
      ) => {
        calls.push({ operationName, variables });
        const next = pages.shift();
        if (!next) throw new Error("unexpected extra GraphQL call");
        return { status: next.status ?? 200, body: next.body };
      },
    ),
  } as unknown as Page;
  return { page, calls };
}

describe("listLibraryThreads", () => {
  it("returns the first page when there is nothing more", async () => {
    const { page, calls } = fakePage([
      { body: connection([{ slug: "a", name: "First" }], { hasNextPage: false }) },
    ]);

    const threads = await listLibraryThreads(page);

    expect(threads).toEqual([
      { uuid: "a", title: "First", mode: undefined, updatedAt: undefined, spaceSlug: undefined },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0].operationName).toBe(LIBRARY_FIRST_PAGE_QUERY.operationName);
  });

  it("follows the cursor using the pagination operation, not the first-page one", async () => {
    const { page, calls } = fakePage([
      { body: connection([{ slug: "a" }], { hasNextPage: true, endCursor: "CUR1" }) },
      { body: connection([{ slug: "b" }], { hasNextPage: true, endCursor: "CUR2" }) },
      { body: connection([{ slug: "c" }], { hasNextPage: false }) },
    ]);

    const threads = await listLibraryThreads(page);

    expect(threads.map((t) => t.uuid)).toEqual(["a", "b", "c"]);
    // Page 2+ must switch operation — sending a cursor to the first-page query
    // is silently ignored by the server and loops the same rows forever.
    expect(calls.map((c) => c.operationName)).toEqual([
      LIBRARY_FIRST_PAGE_QUERY.operationName,
      LIBRARY_NEXT_PAGE_QUERY.operationName,
      LIBRARY_NEXT_PAGE_QUERY.operationName,
    ]);
    expect(calls[1].variables.cursor).toBe("CUR1");
    expect(calls[2].variables.cursor).toBe("CUR2");
  });

  it("stops when the cursor stops advancing instead of looping", async () => {
    // Same row repeated with hasNextPage forever — the real failure mode when a
    // cursor is ignored. Must terminate rather than spin to the safety cap.
    const repeated = () => ({
      body: connection([{ slug: "a" }], { hasNextPage: true, endCursor: "SAME" }),
    });
    const { page } = fakePage([repeated(), repeated(), repeated()]);

    const threads = await listLibraryThreads(page);

    expect(threads.map((t) => t.uuid)).toEqual(["a"]);
  });

  it("deduplicates threads repeated across pages", async () => {
    const { page } = fakePage([
      { body: connection([{ slug: "a" }, { slug: "b" }], { hasNextPage: true, endCursor: "C" }) },
      { body: connection([{ slug: "b" }, { slug: "c" }], { hasNextPage: false }) },
    ]);

    const threads = await listLibraryThreads(page);
    expect(threads.map((t) => t.uuid)).toEqual(["a", "b", "c"]);
  });

  it("ignores rows with no usable uuid", async () => {
    const body = JSON.stringify({
      data: {
        viewer: {
          recentGroup: {
            items: {
              edges: [
                { node: { title: "no object" } },
                { node: { object: { id: "TH:opaque" } } },
                { node: { object: { slug: "good", name: "Keep" } } },
                null,
              ],
              pageInfo: { hasNextPage: false },
            },
          },
        },
      },
    });
    const { page } = fakePage([{ body }]);

    const threads = await listLibraryThreads(page);
    expect(threads.map((t) => t.uuid)).toEqual(["good"]);
  });

  it("flags a rotated persisted query so the caller can fall back", async () => {
    const { page } = fakePage([
      { status: 400, body: JSON.stringify({ errors: [{ message: "PersistedQueryNotFound" }] }) },
    ]);

    await expect(listLibraryThreads(page)).rejects.toThrow(PersistedQueryUnavailable);
  });

  it("surfaces GraphQL errors returned with HTTP 200", async () => {
    const { page } = fakePage([
      { body: JSON.stringify({ errors: [{ message: "forbidden" }] }) },
    ]);

    await expect(listLibraryThreads(page)).rejects.toThrow(/forbidden/);
  });

  it("falls back to node.title when the object has no name", async () => {
    const body = JSON.stringify({
      data: {
        viewer: {
          recentGroup: {
            items: {
              edges: [{ node: { title: "Outer Title", object: { slug: "x" } } }],
              pageInfo: { hasNextPage: false },
            },
          },
        },
      },
    });
    const { page } = fakePage([{ body }]);

    const threads = await listLibraryThreads(page);
    expect(threads[0].title).toBe("Outer Title");
  });
});

describe("threadUrl", () => {
  it("uses the computer task path for agentic threads", () => {
    expect(threadUrl({ uuid: "u1", title: "t", mode: "COMPUTER" })).toBe(
      "https://www.perplexity.ai/computer/tasks/u1",
    );
  });

  it("uses the search path otherwise", () => {
    expect(threadUrl({ uuid: "u2", title: "t", mode: "SEARCH" })).toBe(
      "https://www.perplexity.ai/search/u2",
    );
    expect(threadUrl({ uuid: "u3", title: "t" })).toBe("https://www.perplexity.ai/search/u3");
  });
});
