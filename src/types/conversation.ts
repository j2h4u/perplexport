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
