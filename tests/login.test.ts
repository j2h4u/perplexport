import { describe, it, expect } from "vitest";
import { hasValidAuthCookie } from "../src/login";

const AUTH = "__Secure-next-auth.session-token";
const NOW = 1_700_000_000_000; // fixed reference time (ms)
const NOW_SEC = NOW / 1000;

describe("hasValidAuthCookie", () => {
  it("returns false for no cookies", () => {
    expect(hasValidAuthCookie([], NOW)).toBe(false);
  });

  it("returns false when the auth cookie is absent", () => {
    const cookies = [{ name: "pplx.session-id", expires: NOW_SEC + 1000 }];
    expect(hasValidAuthCookie(cookies, NOW)).toBe(false);
  });

  it("returns false when the auth cookie is expired", () => {
    const cookies = [{ name: AUTH, expires: NOW_SEC - 1000 }];
    expect(hasValidAuthCookie(cookies, NOW)).toBe(false);
  });

  it("returns true when the auth cookie is present and unexpired", () => {
    const cookies = [{ name: AUTH, expires: NOW_SEC + 1000 }];
    expect(hasValidAuthCookie(cookies, NOW)).toBe(true);
  });

  it("treats a session cookie (expires === -1) as valid", () => {
    const cookies = [{ name: AUTH, expires: -1 }];
    expect(hasValidAuthCookie(cookies, NOW)).toBe(true);
  });

  it("treats a missing expires field as valid", () => {
    const cookies = [{ name: AUTH }];
    expect(hasValidAuthCookie(cookies, NOW)).toBe(true);
  });
});
