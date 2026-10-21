import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import type { Page } from "puppeteer";
import {
  assetToFile,
  collectGeneratedFiles,
  collectUploadedFiles,
  fetchThreadFiles,
  uniqueName,
} from "../src/fetchAttachments";
import { Asset, ConversationResponse } from "../src/types/conversation";

/** Shapes here mirror real /rest/thread/<uuid>/entry-metadata responses. */
function pdfAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    uuid: "asset-1",
    asset_type: "PDF_FILE",
    pdf_file: {
      name: "Quarterly Report",
      filename: "Quarterly Report.pdf",
      url: "https://cdn.example.net/x/Quarterly%20Report.pdf?Policy=abc",
      file_size: 1234,
    },
    ...overrides,
  } as Asset;
}

describe("assetToFile", () => {
  it("prefers download_info over the payload url", () => {
    const file = assetToFile(
      pdfAsset({
        download_info: [
          { filename: "Report.pdf", url: "https://cdn.example.net/dl/Report.pdf", size: 99 },
        ],
      }),
    );
    expect(file?.url).toBe("https://cdn.example.net/dl/Report.pdf");
    expect(file?.filename).toBe("Report.pdf");
    expect(file?.size).toBe(99);
  });

  it("maps asset_type to its payload field", () => {
    const xlsx = assetToFile({
      uuid: "a",
      asset_type: "XLSX_FILE",
      xlsx_file: { filename: "Log.xlsx", url: "https://cdn.example.net/Log.xlsx" },
    } as Asset);
    expect(xlsx?.filename).toBe("Log.xlsx");
    expect(xlsx?.assetType).toBe("XLSX_FILE");
  });

  it("falls back to docx_url when no direct url is present", () => {
    const doc = assetToFile({
      uuid: "a",
      asset_type: "DOC_FILE",
      doc_file: { filename: "Notes.docx", url: null, docx_url: "https://cdn.example.net/N.docx" },
    } as Asset);
    expect(doc?.url).toBe("https://cdn.example.net/N.docx");
  });

  it("ignores assets that are inline content, not files", () => {
    expect(assetToFile({ uuid: "a", asset_type: "ASSET_DIFF" } as Asset)).toBeNull();
    expect(
      assetToFile({
        uuid: "b",
        asset_type: "EXTERNAL_URL",
        external_url: { url: "https://example.com" },
      } as Asset),
    ).toBeNull();
  });

  it("ignores assets with no downloadable url", () => {
    expect(
      assetToFile({
        uuid: "a",
        asset_type: "CODE_FILE",
        code_file: { filename: "gen.py", url: null },
      } as Asset),
    ).toBeNull();
  });

  it("adds a missing extension from the url", () => {
    const file = assetToFile({
      uuid: "a",
      asset_type: "PDF_FILE",
      pdf_file: { name: "No Extension Here", url: "https://cdn.example.net/a/file.pdf?Policy=x" },
    } as Asset);
    expect(file?.filename).toBe("No Extension Here.pdf");
  });

  it("strips path separators so an asset name cannot escape its directory", () => {
    const file = assetToFile({
      uuid: "a",
      asset_type: "PDF_FILE",
      pdf_file: { filename: "../../etc/passwd.pdf", url: "https://cdn.example.net/a.pdf" },
    } as Asset);
    expect(file?.filename).not.toContain("/");
    expect(file?.filename).not.toContain("..");
  });
});

describe("collectGeneratedFiles", () => {
  it("keeps only the newest revision of a regenerated file", () => {
    const files = collectGeneratedFiles({
      artifact_entries: [
        {
          entry_uuid: "e1",
          assets: [
            pdfAsset({
              uuid: "v1",
              root_asset_id: "root-1",
              created_at: "1000",
              pdf_file: { filename: "Report.pdf", url: "https://cdn.example.net/v1.pdf" },
            }),
            pdfAsset({
              uuid: "v2",
              root_asset_id: "root-1",
              created_at: "2000",
              pdf_file: { filename: "Report.pdf", url: "https://cdn.example.net/v2.pdf" },
            }),
          ],
        },
      ],
    });
    expect(files).toHaveLength(1);
    expect(files[0].url).toBe("https://cdn.example.net/v2.pdf");
  });

  it("falls back to document order when created_at is absent", () => {
    const files = collectGeneratedFiles({
      artifact_entries: [
        {
          assets: [
            pdfAsset({
              uuid: "v1",
              root_asset_id: "root-1",
              pdf_file: { filename: "R.pdf", url: "https://cdn.example.net/first.pdf" },
            }),
            pdfAsset({
              uuid: "v2",
              root_asset_id: "root-1",
              pdf_file: { filename: "R.pdf", url: "https://cdn.example.net/last.pdf" },
            }),
          ],
        },
      ],
    });
    expect(files).toHaveLength(1);
    expect(files[0].url).toBe("https://cdn.example.net/last.pdf");
  });

  it("keeps distinct files apart and marks them generated", () => {
    const files = collectGeneratedFiles({
      artifact_entries: [
        { assets: [pdfAsset({ uuid: "a", root_asset_id: "root-a" })] },
        {
          assets: [
            {
              uuid: "b",
              asset_type: "XLSX_FILE",
              root_asset_id: "root-b",
              xlsx_file: { filename: "Log.xlsx", url: "https://cdn.example.net/Log.xlsx" },
            } as Asset,
          ],
        },
      ],
    });
    expect(files).toHaveLength(2);
    expect(files.every((f) => f.kind === "generated")).toBe(true);
  });

  it("tolerates missing or empty metadata", () => {
    expect(collectGeneratedFiles({})).toEqual([]);
    expect(collectGeneratedFiles({ artifact_entries: null })).toEqual([]);
    expect(collectGeneratedFiles({ artifact_entries: [{ assets: null }] })).toEqual([]);
  });
});

describe("collectUploadedFiles", () => {
  function thread(entries: unknown[]): ConversationResponse {
    return {
      status: "completed",
      entries: entries as ConversationResponse["entries"],
      has_next_page: false,
      next_cursor: null,
    };
  }

  it("extracts attachment urls and derives names from the path", () => {
    const files = collectUploadedFiles(
      thread([
        {
          uuid: "e1",
          attachments: [
            "https://ppl-ai-file-upload.s3.amazonaws.com/web/direct-files/a/b/My%20Form.pdf?X-Amz-Signature=xyz",
          ],
        },
      ]),
    );
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ kind: "upload", filename: "My Form.pdf", entryUuid: "e1" });
  });

  it("dedupes the same object across entries despite differing signatures", () => {
    const files = collectUploadedFiles(
      thread([
        { uuid: "e1", attachments: ["https://s3.example.com/a/b/doc.pdf?X-Amz-Signature=one"] },
        { uuid: "e2", attachments: ["https://s3.example.com/a/b/doc.pdf?X-Amz-Signature=two"] },
      ]),
    );
    expect(files).toHaveLength(1);
  });

  it("ignores entries without usable attachments", () => {
    const files = collectUploadedFiles(
      thread([
        { uuid: "e1" },
        { uuid: "e2", attachments: null },
        { uuid: "e3", attachments: [] },
        { uuid: "e4", attachments: ["not-a-url", 42, null] },
      ]),
    );
    expect(files).toEqual([]);
  });
});

describe("uniqueName", () => {
  it("passes through a name that is not taken", () => {
    expect(uniqueName("a.pdf", new Set())).toBe("a.pdf");
  });

  it("suffixes collisions before the extension", () => {
    const used = new Set<string>();
    expect(uniqueName("Report.pdf", used)).toBe("Report.pdf");
    expect(uniqueName("Report.pdf", used)).toBe("Report (2).pdf");
    expect(uniqueName("Report.pdf", used)).toBe("Report (3).pdf");
  });

  it("handles names with no extension", () => {
    const used = new Set<string>();
    expect(uniqueName("LICENSE", used)).toBe("LICENSE");
    expect(uniqueName("LICENSE", used)).toBe("LICENSE (2)");
  });
});

describe("fetchThreadFiles", () => {
  /** Minimal stand-in for the Puppeteer page: only page.evaluate is used, and
   *  only to fetch entry-metadata, so it returns that payload directly. */
  function fakePage(metadata: unknown, opts: { reject?: boolean } = {}) {
    return {
      evaluate: async () => {
        if (opts.reject) throw new Error("page closed");
        return { ok: true, status: 200, text: JSON.stringify(metadata) };
      },
    } as unknown as Page;
  }

  function thread(entries: unknown[] = []): ConversationResponse {
    return {
      status: "completed",
      entries: entries as ConversationResponse["entries"],
      has_next_page: false,
      next_cursor: null,
    };
  }

  let tmpDir: string;
  const realFetch = globalThis.fetch;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "perplexport-files-"));
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /** Serve fixed bytes for any URL. */
  function serve(body: Buffer | string, init: { status?: number } = {}) {
    const status = init.status ?? 200;
    globalThis.fetch = (async () =>
      new Response(typeof body === "string" ? body : new Uint8Array(body), {
        status,
      })) as typeof fetch;
  }

  const oneAsset = {
    artifact_entries: [
      {
        entry_uuid: "e1",
        assets: [
          {
            uuid: "a1",
            asset_type: "PDF_FILE",
            pdf_file: { filename: "Out.pdf", url: "https://cdn.example.net/Out.pdf" },
          },
        ],
      },
    ],
  };

  it("writes downloaded files and a manifest", async () => {
    serve(Buffer.from("%PDF-1.4 hello"));
    const filesDir = path.join(tmpDir, "thread");

    const result = await fetchThreadFiles({
      page: fakePage(oneAsset),
      uuid: "t1",
      conversation: thread(),
      filesDir,
    });

    expect(result).toEqual({ downloaded: 1, failed: 0, gone: 0, skipped: 0 });
    expect(await fs.readFile(path.join(filesDir, "Out.pdf"), "utf8")).toBe("%PDF-1.4 hello");

    const manifest = JSON.parse(await fs.readFile(path.join(filesDir, "manifest.json"), "utf8"));
    expect(manifest.threadUuid).toBe("t1");
    expect(manifest.files).toHaveLength(1);
    expect(manifest.files[0]).toMatchObject({ filename: "Out.pdf", status: "ok" });
    expect(manifest.files[0].sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("skips files already on disk, and re-downloads them with force", async () => {
    serve(Buffer.from("new"));
    const filesDir = path.join(tmpDir, "thread");
    await fs.mkdir(filesDir, { recursive: true });
    await fs.writeFile(path.join(filesDir, "Out.pdf"), "old");

    const skip = await fetchThreadFiles({
      page: fakePage(oneAsset),
      uuid: "t1",
      conversation: thread(),
      filesDir,
    });
    expect(skip).toMatchObject({ downloaded: 0, skipped: 1 });
    expect(await fs.readFile(path.join(filesDir, "Out.pdf"), "utf8")).toBe("old");

    const forced = await fetchThreadFiles({
      page: fakePage(oneAsset),
      uuid: "t1",
      conversation: thread(),
      filesDir,
      force: true,
    });
    expect(forced).toMatchObject({ downloaded: 1, skipped: 0 });
    expect(await fs.readFile(path.join(filesDir, "Out.pdf"), "utf8")).toBe("new");
  });

  it("records a pruned upload as gone, not failed", async () => {
    // Perplexity deletes old uploaded files; S3 then answers 404 NoSuchKey.
    serve("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
    const filesDir = path.join(tmpDir, "thread");

    const result = await fetchThreadFiles({
      page: fakePage({ artifact_entries: [] }),
      uuid: "t1",
      conversation: thread([
        { uuid: "e1", attachments: ["https://s3.example.com/a/gone.pdf?X-Amz-Signature=x"] },
      ]),
      filesDir,
    });

    expect(result).toMatchObject({ downloaded: 0, failed: 0, gone: 1 });
    const manifest = JSON.parse(await fs.readFile(path.join(filesDir, "manifest.json"), "utf8"));
    expect(manifest.files[0]).toMatchObject({ kind: "upload", status: "gone" });
  });

  it("still saves uploads when the asset metadata request fails", async () => {
    serve(Buffer.from("jpegdata"));
    const filesDir = path.join(tmpDir, "thread");

    const result = await fetchThreadFiles({
      page: fakePage(null, { reject: true }),
      uuid: "t1",
      conversation: thread([
        { uuid: "e1", attachments: ["https://s3.example.com/a/photo.jpeg?X-Amz-Signature=x"] },
      ]),
      filesDir,
    });

    expect(result).toMatchObject({ downloaded: 1, failed: 0 });
    expect(await fs.readFile(path.join(filesDir, "photo.jpeg"), "utf8")).toBe("jpegdata");
  });

  it("does nothing and writes no manifest when a thread has no files", async () => {
    const filesDir = path.join(tmpDir, "empty");
    const result = await fetchThreadFiles({
      page: fakePage({ artifact_entries: [] }),
      uuid: "t1",
      conversation: thread([{ uuid: "e1" }]),
      filesDir,
    });

    expect(result).toEqual({ downloaded: 0, failed: 0, gone: 0, skipped: 0 });
    await expect(fs.stat(filesDir)).rejects.toThrow();
  });

  it("cleans up the temp file when the final rename fails", async () => {
    serve(Buffer.from("%PDF-1.4"));
    const filesDir = path.join(tmpDir, "thread");
    await fs.mkdir(filesDir, { recursive: true });
    // A non-empty directory at the destination makes rename fail (ENOTEMPTY)
    // after the .part file has already been written. isFile() is false for it,
    // so the skip check doesn't mistake it for an existing download.
    await fs.mkdir(path.join(filesDir, "Out.pdf"), { recursive: true });
    await fs.writeFile(path.join(filesDir, "Out.pdf", "blocker"), "x");

    const result = await fetchThreadFiles({
      page: fakePage(oneAsset),
      uuid: "t1",
      conversation: thread(),
      filesDir,
    });

    expect(result).toMatchObject({ downloaded: 0, failed: 1 });
    expect(await fs.readdir(filesDir)).not.toContain("Out.pdf.part");
  });

  it("leaves no .part file behind when a download fails", async () => {
    serve("nope", { status: 500 });
    const filesDir = path.join(tmpDir, "thread");

    const result = await fetchThreadFiles({
      page: fakePage(oneAsset),
      uuid: "t1",
      conversation: thread(),
      filesDir,
    });

    expect(result).toMatchObject({ downloaded: 0, failed: 1 });
    expect(await fs.readdir(filesDir)).toEqual(["manifest.json"]);
  });
});
