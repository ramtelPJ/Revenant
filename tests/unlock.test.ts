import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { NextRequest } from "next/server";

const launch = "c".repeat(64);
const secret = "d".repeat(64);
const t0 = 1_800_000_000_000;

let tryUnlock: typeof import("@/lib/http/unlock").tryUnlock;
let UNLOCK_WINDOW_MS: number;
let GET: typeof import("@/app/unlock/route").GET;
let proxy: typeof import("@/proxy").proxy;
let signSession: typeof import("@/lib/http/session").signSession;
let verifySession: typeof import("@/lib/http/session").verifySession;
let sessionCookieHeader: typeof import("@/lib/http/session").sessionCookieHeader;

beforeAll(async () => {
  vi.stubEnv("REVENANT_LAUNCH_TOKEN", launch);
  vi.stubEnv("REVENANT_SESSION_SECRET", secret);
  vi.stubEnv("OLLAMA_MODEL", "gemma2:2b");
  vi.stubEnv("PORT", "3000");
  ({ tryUnlock, UNLOCK_WINDOW_MS } = await import("@/lib/http/unlock"));
  ({ GET } = await import("@/app/unlock/route"));
  ({ proxy } = await import("@/proxy"));
  ({ signSession, verifySession, sessionCookieHeader } = await import("@/lib/http/session"));
});

beforeEach(() => {
  delete (globalThis as { __revenantUnlock?: unknown }).__revenantUnlock; // a fresh server start
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("tryUnlock", () => {
  test("the right token works exactly once", () => {
    expect(tryUnlock(launch, { now: t0, launchedAt: t0 })).toBe(true);
    expect(tryUnlock(launch, { now: t0, launchedAt: t0 })).toBe(false);
  });

  test("a wrong, empty, missing or differently sized token fails without consuming the real one", () => {
    for (const token of ["x".repeat(64), "", null, "short", launch + "0", launch.slice(1)]) {
      expect(tryUnlock(token, { now: t0, launchedAt: t0 }), String(token)).toBe(false);
    }
    expect(tryUnlock(launch, { now: t0, launchedAt: t0 })).toBe(true);
  });

  test("valid for 15 minutes after launch, not after", () => {
    expect(tryUnlock(launch, { now: t0 + UNLOCK_WINDOW_MS - 1000, launchedAt: t0 })).toBe(true);
    delete (globalThis as { __revenantUnlock?: unknown }).__revenantUnlock;
    expect(tryUnlock(launch, { now: t0 + UNLOCK_WINDOW_MS, launchedAt: t0 })).toBe(false);
    expect(tryUnlock(launch, { now: t0 + UNLOCK_WINDOW_MS + 60_000, launchedAt: t0 })).toBe(false);
  });

  test("an expired link stays unusable even with the right token", () => {
    expect(tryUnlock(launch, { now: t0 + 16 * 60 * 1000, launchedAt: t0 })).toBe(false);
  });
});

describe("GET /unlock", () => {
  const unlock = (token: string | null, host = "127.0.0.1:3000") =>
    GET(new Request(`http://127.0.0.1:3000/unlock${token === null ? "" : `?token=${token}`}`, { headers: { host } }));

  test("a valid link redirects home with a valid, correctly flagged session cookie", () => {
    const res = unlock(launch);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("no-store");

    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^revenant_session=v1\./);
    for (const flag of ["HttpOnly", "SameSite=Strict", "Path=/", "Max-Age=43200"]) expect(cookie).toContain(flag);
    expect(cookie).not.toContain("Secure");
    expect(verifySession(cookie.split(";")[0].split("=")[1])).toBe(true);
    expect(cookie).not.toContain(launch);
  });

  test("using the same link again goes to /locked with no cookie", () => {
    unlock(launch);
    const again = unlock(launch);
    expect(again.status).toBe(302);
    expect(again.headers.get("location")).toBe("/locked");
    expect(again.headers.get("set-cookie")).toBeNull();
  });

  test("wrong and missing tokens go to /locked with no cookie, and the real link still works afterwards", () => {
    for (const token of ["nope", null]) {
      const res = unlock(token);
      expect(res.headers.get("location")).toBe("/locked");
      expect(res.headers.get("set-cookie")).toBeNull();
    }
    expect(unlock(launch).headers.get("location")).toBe("/");
  });

  test("a wrong Host is 403, even with the right token, and does not consume it", () => {
    expect(unlock(launch, "evil.example:3000").status).toBe(403);
    expect(unlock(launch).headers.get("location")).toBe("/");
  });

  test("rejections are logged without the token", () => {
    const warn = vi.mocked(console.warn);
    unlock("guess-123");
    unlock(launch);
    unlock(launch);
    expect(warn.mock.calls.flat().join(" ")).not.toMatch(/guess-123|c{20}/);
  });
});

describe("proxy (page gate)", () => {
  const page = (cookie?: string, host = "127.0.0.1:3000") =>
    proxy(new NextRequest("http://127.0.0.1:3000/cases/new", { headers: { host, ...(cookie ? { cookie } : {}) } }));

  test("no cookie, a tampered cookie, and an expired cookie redirect to /locked", () => {
    const good = signSession();
    const tampered = good.slice(0, -1) + (good.endsWith("0") ? "1" : "0");
    const expired = signSession(Date.now() - 13 * 60 * 60 * 1000);
    for (const cookie of [undefined, `revenant_session=${tampered}`, `revenant_session=${expired}`, "revenant_session=junk"]) {
      const res = page(cookie);
      expect(res.status).toBe(307);
      expect(new URL(res.headers.get("location")!).pathname).toBe("/locked");
    }
  });

  test("a valid cookie passes through", () => {
    const res = page(`revenant_session=${signSession()}`);
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  test("a wrong Host is 403 before the cookie is considered", () => {
    expect(page(`revenant_session=${signSession()}`, "evil.example:3000").status).toBe(403);
    expect(page(undefined, "evil.example:3000").status).toBe(403);
  });

  test("the matcher covers pages but not /api, /_next, /unlock, /locked", async () => {
    const { config } = await import("@/proxy");
    const regex = new RegExp(`^${(config.matcher[0] as string).replace(/^\//, "/")}$`);
    for (const covered of ["/", "/cases/new", "/cases/abc/report"]) expect(regex.test(covered), covered).toBe(true);
    for (const excluded of ["/api/cases", "/api/health", "/_next/static/x.js", "/unlock", "/locked", "/favicon.ico"]) {
      expect(regex.test(excluded), excluded).toBe(false);
    }
  });
});

test("the cookie header builder never sets Secure and carries the 12h lifetime", () => {
  const header = sessionCookieHeader("v1.x");
  expect(header).toBe("revenant_session=v1.x; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200");
});
