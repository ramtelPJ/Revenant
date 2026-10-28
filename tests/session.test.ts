import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { SESSION_MAX_AGE_SEC, signSession, verifySession } from "@/lib/http/session";

const secret = "a".repeat(64);
const otherSecret = "b".repeat(64);
const t0 = 1_800_000_000_000; // fixed clock, ms

const flip = (c: string) => (c === "0" ? "1" : "0");
const withPart = (value: string, index: number, change: (part: string) => string) =>
  value
    .split(".")
    .map((part, i) => (i === index ? change(part) : part))
    .join(".");

describe("signSession / verifySession", () => {
  test("a freshly signed value verifies and has the documented shape", () => {
    const value = signSession(t0, secret);
    expect(value).toMatch(/^v1\.\d+\.[0-9a-f]{32}\.[0-9a-f]{64}$/);
    expect(verifySession(value, t0, secret)).toBe(true);
  });

  test("two signed values differ (random nonce) but both verify", () => {
    const a = signSession(t0, secret);
    const b = signSession(t0, secret);
    expect(a).not.toBe(b);
    expect(verifySession(a, t0, secret) && verifySession(b, t0, secret)).toBe(true);
  });

  test("changing any character of expiry, nonce or signature fails", () => {
    const value = signSession(t0, secret);
    for (const index of [1, 2, 3]) {
      const part = value.split(".")[index];
      for (let position = 0; position < part.length; position++) {
        const tampered = withPart(value, index, (p) => p.slice(0, position) + flip(p[position]) + p.slice(position + 1));
        if (tampered !== value) expect(verifySession(tampered, t0, secret), `part ${index} char ${position}`).toBe(false);
      }
    }
  });

  test("extending the expiry without the secret fails", () => {
    const value = signSession(t0, secret);
    const longer = withPart(value, 1, (p) => String(Number(p) + 100_000));
    expect(verifySession(longer, t0, secret)).toBe(false);
  });

  test("uppercase hex (a different spelling of the same bytes) is rejected", () => {
    const value = signSession(t0, secret);
    expect(verifySession(withPart(value, 3, (p) => p.toUpperCase()), t0, secret)).toBe(false);
  });

  test("a value signed with another secret fails", () => {
    expect(verifySession(signSession(t0, otherSecret), t0, secret)).toBe(false);
  });

  test("expiry boundary: valid one second before, invalid at and after expiry", () => {
    const value = signSession(t0, secret);
    const expiresAtMs = t0 + SESSION_MAX_AGE_SEC * 1000;
    expect(verifySession(value, expiresAtMs - 1000, secret)).toBe(true);
    expect(verifySession(value, expiresAtMs, secret)).toBe(false);
    expect(verifySession(value, expiresAtMs + 1000, secret)).toBe(false);
  });

  test("lasts 12 hours", () => {
    expect(SESSION_MAX_AGE_SEC).toBe(43200);
  });

  test("malformed input returns false and never throws", () => {
    const value = signSession(t0, secret);
    const bad: unknown[] = [
      "",
      "v1",
      "v1...",
      "v1.1.2.3",
      `${value}.extra`,
      value.split(".").slice(0, 3).join("."),
      withPart(value, 0, () => "v2"),
      withPart(value, 1, () => "-5"),
      withPart(value, 1, () => "1e9"),
      withPart(value, 1, () => ""),
      "x".repeat(100_000),
      value + "a".repeat(1000),
      undefined,
      null,
      123,
      {},
      ["v1"],
    ];
    for (const input of bad) {
      expect(() => verifySession(input, t0, secret)).not.toThrow();
      expect(verifySession(input, t0, secret)).toBe(false);
    }
  });

  test("signature comparison uses timingSafeEqual", () => {
    expect(readFileSync("src/lib/http/session.ts", "utf8")).toContain("timingSafeEqual");
  });
});
