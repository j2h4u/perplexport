import { describe, it, expect } from "vitest";
import { readLocalConversationState } from "../src/exportLibrary";

describe("readLocalConversationState", () => {
  it("returns undefined for non-array input", () => {
    expect(readLocalConversationState(null)).toBeUndefined();
    expect(readLocalConversationState(undefined)).toBeUndefined();
    expect(readLocalConversationState("string")).toBeUndefined();
    expect(readLocalConversationState(42)).toBeUndefined();
    expect(readLocalConversationState({})).toBeUndefined();
  });

  it("returns empty state for empty array", () => {
    expect(readLocalConversationState([])).toEqual({
      latestEntryUuid: undefined,
      latestUpdatedDatetime: undefined,
    });
  });

  it("extracts uuid from last entry and latest datetime", () => {
    const entries = [{ uuid: "abc", updated_datetime: "2024-01-01T00:00:00Z" }];
    expect(readLocalConversationState(entries)).toEqual({
      latestEntryUuid: "abc",
      latestUpdatedDatetime: "2024-01-01T00:00:00Z",
    });
  });

  it("picks latest updated_datetime across all entries", () => {
    const entries = [
      { uuid: "first", updated_datetime: "2024-01-01T00:00:00Z" },
      { uuid: "last", updated_datetime: "2024-06-15T00:00:00Z" },
      { uuid: "mid", updated_datetime: "2024-03-01T00:00:00Z" },
    ];
    const result = readLocalConversationState(entries);
    expect(result?.latestUpdatedDatetime).toBe("2024-06-15T00:00:00Z");
  });

  it("uuid comes from last array entry, not the one with latest datetime", () => {
    const entries = [
      { uuid: "first", updated_datetime: "2024-06-15T00:00:00Z" },
      { uuid: "last", updated_datetime: "2024-01-01T00:00:00Z" },
    ];
    const result = readLocalConversationState(entries);
    expect(result?.latestEntryUuid).toBe("last");
    expect(result?.latestUpdatedDatetime).toBe("2024-06-15T00:00:00Z");
  });

  it("returns undefined uuid when last entry has no uuid field", () => {
    const entries = [{ updated_datetime: "2024-01-01T00:00:00Z" }];
    expect(readLocalConversationState(entries)?.latestEntryUuid).toBeUndefined();
  });

  it("returns undefined datetime when no entries have updated_datetime", () => {
    const entries = [{ uuid: "abc" }];
    expect(readLocalConversationState(entries)?.latestUpdatedDatetime).toBeUndefined();
  });

  it("ignores entries with non-string updated_datetime", () => {
    const entries = [
      { uuid: "abc", updated_datetime: 12345 },
      { uuid: "def", updated_datetime: "2024-01-01T00:00:00Z" },
    ];
    const result = readLocalConversationState(entries);
    expect(result?.latestUpdatedDatetime).toBe("2024-01-01T00:00:00Z");
  });
});
