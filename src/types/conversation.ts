export interface ConversationResponse {
  status: string;
  entries: ConversationEntry[];
  has_next_page: boolean;
  next_cursor: string | null;
  thread_metadata?: Record<string, unknown>;
}

export interface ConversationEntry {
  uuid: string;
  query_str: string;
  thread_url_slug: string;
  thread_title: string;
  updated_datetime: string;
  // JSON string: array of Step objects
  text: string;
  [key: string]: unknown;
}

// Parsed from entry.text
export interface EntryStep {
  step_type: "INITIAL_QUERY" | "SEARCH_WEB" | "SEARCH_RESULTS" | "FINAL" | string;
  content: {
    goal_id: string | null;
    query?: string;
    // FINAL step: JSON string with answer + web_results
    answer?: string;
    web_results?: WebResult[];
    [key: string]: unknown;
  };
}

// Parsed from JSON.parse(finalStep.content.answer)
export interface FinalAnswer {
  answer: string;
  web_results: WebResult[];
  [key: string]: unknown;
}

export interface WebResult {
  name: string;
  url: string;
  snippet?: string;
  timestamp?: string;
  meta_data?: Record<string, unknown>;
}

export interface ThreadListItem {
  uuid: string;
  title: string;
  link: string;
  variant: string;
  status: string;
}

// ---------------------------------------------------------------------------
// Attachments / generated files
// ---------------------------------------------------------------------------

/** Asset payload shape. Which field holds it is keyed off asset_type —
 *  PDF_FILE → pdf_file, XLSX_FILE → xlsx_file, and so on. */
export interface AssetPayload {
  name?: string | null;
  filename?: string | null;
  url?: string | null;
  docx_url?: string | null;
  file_size?: number | null;
  mime_type?: string | null;
}

export interface AssetDownloadInfo {
  filename?: string | null;
  url?: string | null;
  size?: number | null;
  is_exportable?: boolean | null;
}

export interface Asset {
  uuid: string;
  asset_type: string;
  download_info?: AssetDownloadInfo[] | null;
  /** Set on revisions of the same logical file; the newest shares its root. */
  root_asset_id?: string | null;
  parent_asset_id?: string | null;
  created_at?: string | null;
  [key: string]: unknown;
}

/** Response of GET /rest/thread/<uuid>/entry-metadata */
export interface EntryMetadataResponse {
  artifact_entries?: Array<{ entry_uuid?: string; assets?: Asset[] | null }> | null;
  [key: string]: unknown;
}

export type AttachmentKind = "upload" | "generated";

/** One downloadable file discovered for a thread. */
export interface DiscoveredFile {
  kind: AttachmentKind;
  /** Asset uuid for generated files; the S3 object key for uploads. */
  id: string;
  filename: string;
  url: string;
  assetType?: string;
  size?: number;
  entryUuid?: string;
}

/** Per-thread record written to _files/<uuid>/manifest.json */
export interface FileManifestEntry {
  kind: AttachmentKind;
  filename: string;
  assetType?: string;
  size?: number;
  entryUuid?: string;
  status: "ok" | "failed" | "gone";
  error?: string;
  sha256?: string;
}

export interface FileManifest {
  threadUuid: string;
  fetchedAt: string;
  files: FileManifestEntry[];
}
