import { promises as fs } from "fs";
import { createHash } from "crypto";
import * as path from "path";
import { Page } from "puppeteer";
import {
  Asset,
  AssetPayload,
  ConversationResponse,
  DiscoveredFile,
  EntryMetadataResponse,
  FileManifest,
  FileManifestEntry,
} from "./types/conversation";
import { sleep } from "./utils";
import {
  FILE_DOWNLOAD_CONCURRENCY,
  FILE_DOWNLOAD_RETRIES,
  FILE_DOWNLOAD_TIMEOUT_MS,
  FILE_RETRY_BACKOFF_MS,
} from "./config";

// Two separate mechanisms deliver a thread's files, and they behave differently.
//
// 1. Uploaded context files — plain URL strings in `entry.attachments[]` on
//    /rest/thread/<uuid>. The API re-signs these on every request, but the
//    signature lives only ~10 minutes (X-Amz-Expires=600), so they must be
//    downloaded during the same run that fetched the thread. Perplexity also
//    prunes the underlying S3 objects after a while: older threads return
//    404 NoSuchKey with a perfectly valid signature. That's upstream data
//    loss, not a bug here, so it's recorded as "gone" rather than "failed".
//
// 2. Generated result files — structured assets from
//    /rest/thread/<uuid>/entry-metadata, which returns `artifact_entries[].assets[]`
//    with CloudFront URLs signed fresh for ~7 days.
//
// The generated files are NOT reliably reachable from the thread JSON alone: the
// copies embedded in `entry.text` carry the signature minted when the file was
// generated, which has long since expired for any older thread. entry-metadata is
// what re-signs them, which is why it's a separate request instead of a walk over
// the thread body.
//
// Only the metadata requests go through the page (Cloudflare binds cf_clearance to
// the browser's TLS fingerprint — see fetchThread in ConversationSaver.ts). The S3
// and CloudFront downloads are pre-signed and sit outside Cloudflare, so those use
// node fetch: streaming megabytes through page.evaluate would mean base64 round-trips.

/** asset_type → the field holding that asset's payload (PDF_FILE → pdf_file). */
function payloadField(assetType: string): string {
  return assetType.toLowerCase();
}

/** Asset types that are inline content rather than a downloadable file. */
const NON_FILE_ASSET_TYPES = new Set(["ASSET_DIFF", "EXTERNAL_URL", "CODE", "CHART"]);

/** Reduce an API-supplied name to a single safe path segment.
 *  Separators and traversal segments are removed rather than escaped, so a
 *  hostile or merely odd asset name can never write outside its thread folder. */
function sanitizeFilename(name: string): string {
  const cleaned = name
    .replace(/\.\.+/g, ".")
    .replace(/[/\\]/g, "-")
    // Control characters are matched on purpose: they are legal in an
    // API-supplied name but must never reach the filesystem.
    // oxlint-disable-next-line no-control-regex
    .replace(/[<>:"|?*\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  return cleaned.slice(0, 180) || "file";
}

function filenameFromUrl(url: string): string {
  try {
    const base = decodeURIComponent(path.basename(new URL(url).pathname));
    return sanitizeFilename(base);
  } catch {
    return "file";
  }
}

/** Pull the downloadable URL + name out of one asset. */
export function assetToFile(asset: Asset, entryUuid?: string): DiscoveredFile | null {
  if (!asset?.asset_type || NON_FILE_ASSET_TYPES.has(asset.asset_type)) return null;

  const payload = asset[payloadField(asset.asset_type)] as AssetPayload | undefined | null;
  const download = asset.download_info?.find((d) => d?.url);

  // download_info carries a Content-Disposition URL and the real filename; prefer it,
  // then fall back to the payload's own url (docx_url covers DOC_FILE exports).
  const url = download?.url ?? payload?.url ?? payload?.docx_url;
  if (!url) return null;

  const rawName = download?.filename ?? payload?.filename ?? payload?.name ?? filenameFromUrl(url);
  let filename = sanitizeFilename(rawName);

  // Asset names sometimes omit the extension that the URL carries.
  if (!path.extname(filename)) {
    const ext = path.extname(filenameFromUrl(url));
    if (ext) filename += ext;
  }

  return {
    kind: "generated",
    id: asset.uuid,
    filename,
    url,
    assetType: asset.asset_type,
    size: download?.size ?? payload?.file_size ?? undefined,
    entryUuid,
  };
}

/** Collect generated files from an entry-metadata response, newest revision first.
 *
 *  A regenerated file appears several times sharing a root_asset_id. Keeping every
 *  revision would write N copies of "report.xlsx"; keeping only the newest per root
 *  matches what the UI shows. Revisions are ordered by created_at when present, and
 *  otherwise by position (the API returns them oldest-first). */
export function collectGeneratedFiles(metadata: EntryMetadataResponse): DiscoveredFile[] {
  const byRoot = new Map<string, { file: DiscoveredFile; order: number; index: number }>();
  let index = 0;

  for (const entry of metadata.artifact_entries ?? []) {
    for (const asset of entry?.assets ?? []) {
      const file = assetToFile(asset, entry?.entry_uuid);
      if (!file) continue;

      const root = asset.root_asset_id ?? asset.uuid;
      const order = Number(asset.created_at ?? 0) || 0;
      const current = byRoot.get(root);
      const position = index++;

      if (
        !current ||
        order > current.order ||
        (order === current.order && position > current.index)
      ) {
        byRoot.set(root, { file, order, index: position });
      }
    }
  }

  return [...byRoot.values()].map((v) => v.file);
}

/** Collect uploaded context files from an already-fetched thread body. */
export function collectUploadedFiles(conversation: ConversationResponse): DiscoveredFile[] {
  const seen = new Map<string, DiscoveredFile>();

  for (const entry of conversation.entries ?? []) {
    const attachments = (entry as { attachments?: unknown }).attachments;
    if (!Array.isArray(attachments)) continue;

    for (const attachment of attachments) {
      if (typeof attachment !== "string" || !/^https?:\/\//.test(attachment)) continue;

      // The signature changes every request, so the path (minus query) is the identity.
      let id: string;
      try {
        id = new URL(attachment).pathname;
      } catch {
        continue;
      }
      if (seen.has(id)) continue;

      seen.set(id, {
        kind: "upload",
        id,
        filename: filenameFromUrl(attachment),
        url: attachment,
        entryUuid: entry.uuid,
      });
    }
  }

  return [...seen.values()];
}

/** Fetch the asset metadata that holds freshly-signed generated-file URLs. */
export async function loadEntryMetadata(page: Page, uuid: string): Promise<EntryMetadataResponse> {
  // In-page fetch: this is a /rest/ call behind Cloudflare.
  const result = await page.evaluate(async (u: string) => {
    try {
      const r = await fetch(u);
      return { ok: r.ok, status: r.status, text: await r.text() };
    } catch (e) {
      return { ok: false, status: -1, text: String(e) };
    }
  }, `/rest/thread/${uuid}/entry-metadata?source=default&version=2.18`);

  if (!result.ok || result.text.startsWith("<!DOCTYPE")) {
    throw new Error(`entry-metadata failed (HTTP ${result.status})`);
  }
  return JSON.parse(result.text) as EntryMetadataResponse;
}

/** True when S3/CloudFront says the object is gone rather than refused.
 *  Perplexity prunes old uploads, so this is expected for older threads. */
function isMissingUpstream(status: number, body: string): boolean {
  return status === 404 || (status === 403 && body.includes("<Code>AccessDenied</Code>"));
}

async function downloadOne(file: DiscoveredFile, destPath: string): Promise<FileManifestEntry> {
  const base: FileManifestEntry = {
    kind: file.kind,
    filename: path.basename(destPath),
    assetType: file.assetType,
    size: file.size,
    entryUuid: file.entryUuid,
    status: "failed",
  };

  let lastError = "unknown error";

  for (let attempt = 0; attempt < FILE_DOWNLOAD_RETRIES; attempt++) {
    if (attempt > 0) await sleep(FILE_RETRY_BACKOFF_MS * attempt);

    try {
      const response = await fetch(file.url, {
        redirect: "follow",
        signal: AbortSignal.timeout(FILE_DOWNLOAD_TIMEOUT_MS),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        if (isMissingUpstream(response.status, body)) {
          // Deleted upstream — retrying can't help.
          return {
            ...base,
            status: "gone",
            error: `HTTP ${response.status} (no longer stored by Perplexity)`,
          };
        }
        lastError = `HTTP ${response.status}`;
        continue;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length === 0) {
        lastError = "empty response";
        continue;
      }

      // Write to a temp file then rename, so an interrupted run never leaves a
      // half-written file that a later run would treat as already downloaded.
      const tmp = `${destPath}.part`;
      try {
        await fs.writeFile(tmp, buffer);
        await fs.rename(tmp, destPath);
      } catch (err) {
        await fs.rm(tmp, { force: true }).catch(() => {});
        throw err;
      }

      return {
        ...base,
        size: buffer.length,
        status: "ok",
        sha256: createHash("sha256").update(buffer).digest("hex"),
      };
    } catch (err) {
      lastError = (err as Error).message || String(err);
    }
  }

  return { ...base, status: "failed", error: lastError };
}

/** Make a per-thread-unique filename, keeping the extension intact.
 *  Two different assets in one thread can legitimately share a name
 *  (e.g. a file regenerated under a new root), so the second becomes
 *  "name (2).ext" rather than overwriting the first. */
export function uniqueName(filename: string, used: Set<string>): string {
  if (!used.has(filename)) {
    used.add(filename);
    return filename;
  }
  const ext = path.extname(filename);
  const stem = path.basename(filename, ext);
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

export interface FetchFilesResult {
  downloaded: number;
  failed: number;
  gone: number;
  skipped: number;
}

export interface FetchThreadFilesOptions {
  page: Page;
  uuid: string;
  conversation: ConversationResponse;
  /** Directory for this thread's files, e.g. conversations/_files/<uuid>. */
  filesDir: string;
  /** Re-download files that already exist on disk. */
  force?: boolean;
}

/** Download every uploaded and generated file for one thread.
 *
 *  Uploads are collected from the thread body the caller already has; generated
 *  files need one extra metadata request for fresh signatures. Writes a
 *  manifest.json next to the files recording what was found and what happened. */
export async function fetchThreadFiles(
  options: FetchThreadFilesOptions,
): Promise<FetchFilesResult> {
  const { page, uuid, conversation, filesDir, force = false } = options;

  const files: DiscoveredFile[] = collectUploadedFiles(conversation);

  try {
    files.push(...collectGeneratedFiles(await loadEntryMetadata(page, uuid)));
  } catch (err) {
    // An older thread with no agentic assets still has its uploads worth saving.
    console.log(`    asset metadata unavailable: ${(err as Error).message}`);
  }

  const result: FetchFilesResult = { downloaded: 0, failed: 0, gone: 0, skipped: 0 };
  if (files.length === 0) return result;

  await fs.mkdir(filesDir, { recursive: true });

  const used = new Set<string>();
  const planned = files.map((file) => ({
    file,
    destPath: path.join(filesDir, uniqueName(file.filename, used)),
  }));

  const manifestEntries: FileManifestEntry[] = [];
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (cursor < planned.length) {
      const { file, destPath } = planned[cursor++];

      if (!force) {
        const existing = await fs.stat(destPath).catch(() => null);
        if (existing?.isFile() && existing.size > 0) {
          manifestEntries.push({
            kind: file.kind,
            filename: path.basename(destPath),
            assetType: file.assetType,
            size: existing.size,
            entryUuid: file.entryUuid,
            status: "ok",
          });
          result.skipped++;
          continue;
        }
      }

      const entry = await downloadOne(file, destPath);
      manifestEntries.push(entry);

      if (entry.status === "ok") result.downloaded++;
      else if (entry.status === "gone") result.gone++;
      else result.failed++;
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(FILE_DOWNLOAD_CONCURRENCY, planned.length) }, worker),
  );

  const manifest: FileManifest = {
    threadUuid: uuid,
    fetchedAt: new Date().toISOString(),
    files: manifestEntries.sort((a, b) => a.filename.localeCompare(b.filename)),
  };
  await fs.writeFile(path.join(filesDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  return result;
}
