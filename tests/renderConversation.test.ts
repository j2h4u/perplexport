import { describe, it, expect } from "vitest";
import renderConversation from "../src/renderConversation";
import type { ConversationResponse, ConversationEntry } from "../src/types/conversation";

function makeEntry(overrides: Partial<ConversationEntry> = {}): ConversationEntry {
  return {
    uuid: "entry-uuid-1",
    query_str: "What is TypeScript?",
    thread_url_slug: "what-is-typescript",
    thread_title: "TypeScript Overview",
    updated_datetime: "2024-01-01T10:00:00Z",
    text: "[]",
    ...overrides,
  };
}

function makeConversation(entries: ConversationEntry[]): ConversationResponse {
  return { status: "completed", entries, has_next_page: false, next_cursor: null };
}

function makeFinalAnswerText(answer: string, webResults = []): string {
  const steps = [
    {
      step_type: "FINAL",
      content: {
        goal_id: null,
        answer: JSON.stringify({ answer, web_results: webResults }),
      },
    },
  ];
  return JSON.stringify(steps);
}

describe("renderConversation", () => {
  it("returns empty string for empty entries", () => {
    expect(renderConversation(makeConversation([]))).toBe("");
  });

  it("renders frontmatter with title, type, created_at, updated_at", () => {
    const entry = makeEntry({ thread_title: "My Thread", updated_datetime: "2024-06-01T12:00:00Z" });
    const result = renderConversation(makeConversation([entry]));
    expect(result).toContain('title: "My Thread"');
    expect(result).toContain("type: perplexity-thread");
    expect(result).toContain("created_at: 2024-06-01T12:00:00Z");
    expect(result).toContain("updated_at: 2024-06-01T12:00:00Z");
  });

  it("adds collection field when space is provided", () => {
    const result = renderConversation(makeConversation([makeEntry()]), "My Space");
    expect(result).toContain('collection: "My Space"');
  });

  it("renders query as h1 and callout", () => {
    const entry = makeEntry({ query_str: "Explain closures" });
    const result = renderConversation(makeConversation([entry]));
    expect(result).toContain("# Explain closures");
    expect(result).toContain("[!important]");
  });

  it("renders final answer text", () => {
    const entry = makeEntry({ text: makeFinalAnswerText("Closures capture surrounding scope.") });
    const result = renderConversation(makeConversation([entry]));
    expect(result).toContain("Closures capture surrounding scope.");
  });

  it("renders sources section when web results are present", () => {
    const webResults = [{ name: "MDN", url: "https://developer.mozilla.org/", snippet: "Web docs" }];
    const entry = makeEntry({ text: makeFinalAnswerText("Answer", webResults) });
    const result = renderConversation(makeConversation([entry]));
    expect(result).toContain("## 1 Sources");
    expect(result).toContain("[MDN](https://developer.mozilla.org/)");
    expect(result).toContain("Web docs");
  });

  it("silently omits answer section when entry.text is not parseable JSON", () => {
    const entry = makeEntry({ text: "not json" });
    const result = renderConversation(makeConversation([entry]));
    expect(result).not.toContain("Sources");
    expect(result).toContain("# What is TypeScript?");
  });

  it("inserts separator between multiple entries", () => {
    const e1 = makeEntry({ query_str: "First", updated_datetime: "2024-01-01T10:00:00Z" });
    const e2 = makeEntry({ uuid: "entry-2", query_str: "Second", updated_datetime: "2024-01-02T10:00:00Z" });
    const result = renderConversation(makeConversation([e1, e2]));
    expect(result).toContain("* * *");
    expect(result).toContain("# First");
    expect(result).toContain("# Second");
  });

  it("uses query_str as title fallback when thread_title is empty", () => {
    const entry = makeEntry({ thread_title: "", query_str: "Fallback title" });
    const result = renderConversation(makeConversation([entry]));
    expect(result).toContain('"Fallback title"');
  });

  it("truncates title at 120 characters", () => {
    const longTitle = "A".repeat(150);
    const entry = makeEntry({ thread_title: longTitle });
    const result = renderConversation(makeConversation([entry]));
    expect(result).toContain('"' + "A".repeat(120) + '"');
    expect(result).not.toContain('"' + "A".repeat(121));
  });
});
