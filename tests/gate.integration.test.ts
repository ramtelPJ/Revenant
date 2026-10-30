// TEST-002: the access gate, against the real production server (auth T1, T3, T4, T6, T8, T9, T10, T33).
// Needs `npm run build`; without a build these tests are skipped and the skip is reported.
// No assertion prints a token, secret or cookie: values are compared, only booleans are shown.
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { hasBuild, sessionCookie, startTestServer, type TestServer } from "./helpers/server";

let server: TestServer;
let cookie: string; // from the first (and only valid) use of the launch link
let firstUnlockStatus = 0;
let firstUnlockLocation = "";
let firstSetCookie = "";

beforeAll(async () => {
  if (!hasBuild) return;
  server = await startTestServer();
  const first = await server.request({ path: server.unlockPath });
  firstUnlockStatus = first.status;
  firstUnlockLocation = String(first.headers.location ?? "");
  cookie = sessionCookie(first) ?? "";
  firstSetCookie = (first.headers["set-cookie"] ?? []).join("\n");
}, 60_000);
afterAll(async () => {
  await server?.dispose();
});

describe.skipIf(!hasBuild)("the gate on a running server", () => {
  test("T1: an API call with no cookie is 401 UNAUTHORIZED and returns no data", async () => {
    const res = await server.request({ path: "/api/cases" });
    expect(res.status).toBe(401);
    const body = res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(body.data).toBeUndefined();
    expect(typeof body.error.requestId).toBe("string");
  });

  test("T1: a tampered or garbage cookie is 401 too", async () => {
    const flipped = cookie.slice(0, -1) + (cookie.endsWith("0") ? "1" : "0");
    for (const bad of [flipped, "revenant_session=garbage", "revenant_session="]) {
      expect((await server.request({ path: "/api/cases", cookie: bad })).status).toBe(401);
    }
  });

  test("T1: pages are gated as well: no cookie redirects to /locked", async () => {
    const res = await server.request({ path: "/" });
    expect(res.status).toBe(307);
    expect(String(res.headers.location)).toContain("/locked");
  });

  test("T9: the launch link works once: it set a session cookie and went home", () => {
    expect(firstUnlockStatus).toBe(302);
    expect(new URL(firstUnlockLocation, "http://x").pathname).toBe("/");
    expect(cookie.startsWith("revenant_session=")).toBe(true);
  });

  test("T9: opening the same link again goes to /locked and sets no cookie", async () => {
    const second = await server.request({ path: server.unlockPath });
    expect(second.status).toBe(302);
    expect(new URL(String(second.headers.location), "http://x").pathname).toBe("/locked");
    expect(sessionCookie(second)).toBeNull();
  });

  test("the cookie from the first use works", async () => {
    const res = await server.request({ path: "/api/cases", cookie });
    expect(res.status).toBe(200);
    expect(res.json().data).toEqual([]);
  });

  test("the session cookie is HttpOnly and SameSite=Strict, with a 12 hour life", () => {
    expect(firstSetCookie).toMatch(/HttpOnly/i);
    expect(firstSetCookie).toMatch(/SameSite=Strict/i);
    expect(firstSetCookie).toMatch(/Max-Age=43200/i);
    expect(firstSetCookie).not.toMatch(/;\s*Secure/i); // plain loopback HTTP
  });

  test("a wrong token never unlocks", async () => {
    const wrong = await server.request({ path: "/unlock?token=" + "0".repeat(64) });
    expect(new URL(String(wrong.headers.location), "http://x").pathname).toBe("/locked");
    expect(sessionCookie(wrong)).toBeNull();
  });

  test("T3: a cross-origin POST is 403 FORBIDDEN_ORIGIN and creates no case", async () => {
    const res = await server.request({
      method: "POST",
      path: "/api/cases",
      cookie,
      headers: { origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ kind: "sample", sampleId: "control-working" }),
    });
    expect(res.status).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN_ORIGIN");
    expect((await server.request({ path: "/api/cases", cookie })).json().data).toEqual([]);
  });

  test("T3: the same POST from the app's own origin is allowed (the gate is not just blocking everything)", async () => {
    const res = await server.request({
      method: "POST",
      path: "/api/cases",
      cookie,
      headers: { origin: `http://127.0.0.1:${server.port}`, "content-type": "application/json" },
      body: JSON.stringify({ kind: "sample", sampleId: "control-working" }),
    });
    expect(res.status).toBe(201);
  });

  test("T4: Sec-Fetch-Site cross-site and same-site are 403; same-origin passes", async () => {
    for (const site of ["cross-site", "same-site"]) {
      const res = await server.request({ path: "/api/cases", cookie, headers: { "sec-fetch-site": site } });
      expect([site, res.status]).toEqual([site, 403]);
    }
    expect((await server.request({ path: "/api/cases", cookie, headers: { "sec-fetch-site": "same-origin" } })).status).toBe(200);
  });

  test("T6: a wrong Host (DNS rebinding) is 403 even with a valid cookie", async () => {
    for (const host of [`evil.example:${server.port}`, "127.0.0.1:1", "localhost"]) {
      const res = await server.request({ path: "/api/cases", cookie, headers: { host } });
      expect([host, res.status]).toEqual([host, 403]);
    }
    expect((await server.request({ path: "/api/cases", cookie, headers: { host: `localhost:${server.port}` } })).status).toBe(200);
  });

  test("INT-002: an unknown page is a real 404 page with a way back, not a blank screen", async () => {
    const res = await server.request({ path: "/no-such-page", cookie });
    expect(res.status).toBe(404);
    expect(res.body).toContain("That page isn&#x27;t here");
    expect(res.body).toContain("/cases/new");
    expect(/\bat \S+:\d+|node_modules|\/Users\//.test(res.body)).toBe(false);
  });

  test("a non-JSON body on a POST is refused before anything is read", async () => {
    const res = await server.request({ method: "POST", path: "/api/cases", cookie, headers: { "content-type": "text/plain" }, body: "kind=sample" });
    expect(res.status).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_FAILED");
  });

  test("T33: an unknown case id is a safe 404 and a malformed one a safe 400, with a requestId and no internals", async () => {
    const unknown = await server.request({ path: "/api/cases/00000000-0000-4000-8000-000000000000", cookie });
    expect(unknown.status).toBe(404);
    const malformed = await server.request({ path: "/api/cases/not-an-id", cookie });
    expect(malformed.status).toBe(400);
    for (const res of [unknown, malformed]) {
      const err = res.json().error;
      expect(typeof err.requestId).toBe("string");
      expect(/\bat \S+:\d+|node_modules|\/Users\/|SELECT |sqlite/i.test(res.body)).toBe(false);
    }
  });
});

describe("T8: a non-loopback configuration is refused at startup", () => {
  const launch = (env: Record<string, string>) => spawnSync(process.execPath, ["scripts/launch.ts", "--no-open"], { env: { ...process.env, PORT: "39871", ...env }, encoding: "utf8", timeout: 20_000 });

  test("OLLAMA_URL pointing at another host exits non-zero with a clear message and starts no server", () => {
    const result = launch({ OLLAMA_URL: "http://example.com:11434", OLLAMA_MODEL: "gemma2:2b" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/OLLAMA_URL/);
    expect(result.stdout).not.toMatch(/unlock\?token=/); // no link is printed for a server that will not start
  });

  test("a PORT that is not a port is refused too", () => {
    const result = launch({ PORT: "99999", OLLAMA_MODEL: "gemma2:2b" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/PORT/);
  });
});

describe("T10: the launch link expires 15 minutes after launch", () => {
  test("a link is valid at 14 minutes and refused at 16, and a refused link does not use up the token", async () => {
    vi.stubEnv("REVENANT_LAUNCH_TOKEN", "c".repeat(64));
    vi.stubEnv("REVENANT_SESSION_SECRET", "d".repeat(64));
    vi.stubEnv("OLLAMA_MODEL", "gemma2:2b");
    vi.stubEnv("PORT", "3000");
    const { tryUnlock } = await import("@/lib/http/unlock");
    const token = "c".repeat(64);
    const launchedAt = 1_800_000_000_000;
    const fresh = () => delete (globalThis as { __revenantUnlock?: unknown }).__revenantUnlock; // a server start
    fresh();
    expect(tryUnlock(token, { now: launchedAt + 16 * 60_000, launchedAt })).toBe(false);
    expect(tryUnlock(token, { now: launchedAt + 14 * 60_000, launchedAt })).toBe(true);
    fresh();
    vi.unstubAllEnvs();
  });
});

describe("T33: a forced exception", () => {
  test("is a generic 500 INTERNAL with a requestId: no stack, SQL or path in the body, and no secret in the log", async () => {
    vi.stubEnv("REVENANT_LAUNCH_TOKEN", "e".repeat(64));
    vi.stubEnv("REVENANT_SESSION_SECRET", "f".repeat(64));
    vi.stubEnv("OLLAMA_MODEL", "gemma2:2b");
    vi.stubEnv("PORT", "3000");
    const { handle } = await import("@/lib/http/respond");
    const logged: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a) => void logged.push(a.map(String).join(" ")));
    const route = handle(async () => {
      throw new Error("SELECT * FROM cases WHERE id = 'x' failed at /Users/someone/dev/Revenant/data/revenant.db");
    });
    const res = await route(new Request("http://127.0.0.1:3000/api/cases"), undefined);
    spy.mockRestore();
    vi.unstubAllEnvs();
    expect(res.status).toBe(500);
    const body = JSON.stringify(await res.json());
    expect(body).toContain('"INTERNAL"');
    expect(body).toMatch(/requestId/);
    expect(/SELECT|revenant\.db|\/Users\/|\bat \S+:\d+/.test(body)).toBe(false);
    expect(/SELECT|revenant\.db|\/Users\//.test(logged.join("\n"))).toBe(false); // the log holds the kind of error, not its message
  });
});

test.skipIf(hasBuild)("gate integration tests were SKIPPED: there is no production build (run `npm run build`)", () => {});
