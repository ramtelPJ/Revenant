import { beforeAll, describe, expect, test, vi } from "vitest";

const secret = "b".repeat(64);
let guardApi: typeof import("@/lib/http/guard").guardApi;
let AppError: typeof import("@/lib/http/respond").AppError;
let signSession: typeof import("@/lib/http/session").signSession;
let SESSION_COOKIE: string;

beforeAll(async () => {
  vi.stubEnv("REVENANT_LAUNCH_TOKEN", "a".repeat(64));
  vi.stubEnv("REVENANT_SESSION_SECRET", secret);
  vi.stubEnv("OLLAMA_MODEL", "gemma2:2b");
  vi.stubEnv("PORT", "3000");
  ({ guardApi } = await import("@/lib/http/guard"));
  ({ AppError } = await import("@/lib/http/respond"));
  ({ signSession, SESSION_COOKIE } = await import("@/lib/http/session"));
});

type Opts = { method?: string; headers?: Record<string, string>; cookie?: string | null; body?: string };

function request(opts: Opts = {}) {
  const headers: Record<string, string> = { host: "127.0.0.1:3000", ...opts.headers };
  const cookie = opts.cookie === undefined ? `${SESSION_COOKIE}=${signSession(Date.now(), secret)}` : opts.cookie;
  if (cookie) headers.cookie = cookie;
  return new Request("http://127.0.0.1:3000/api/cases", { method: opts.method ?? "GET", headers, body: opts.body });
}

function outcome(req: Request, options?: { multipart?: boolean }) {
  try {
    guardApi(req, options);
    return "ok";
  } catch (error) {
    if (error instanceof AppError) return `${error.status} ${error.code}`;
    throw error;
  }
}

describe("session cookie", () => {
  test("a valid cookie passes", () => {
    expect(outcome(request())).toBe("ok");
  });

  test("missing, tampered, expired and garbage cookies are 401 UNAUTHORIZED", () => {
    const good = signSession(Date.now(), secret);
    const tampered = good.slice(0, -1) + (good.endsWith("0") ? "1" : "0");
    const expired = signSession(Date.now() - 13 * 60 * 60 * 1000, secret);
    for (const cookie of [null, `${SESSION_COOKIE}=${tampered}`, `${SESSION_COOKIE}=${expired}`, `${SESSION_COOKIE}=garbage`, "other=1"]) {
      expect(outcome(request({ cookie })), String(cookie)).toBe("401 UNAUTHORIZED");
    }
  });

  test("the cookie is found among other cookies", () => {
    const value = signSession(Date.now(), secret);
    expect(outcome(request({ cookie: `a=1; ${SESSION_COOKIE}=${value}; b=2` }))).toBe("ok");
  });

  test("the 401 message is the documented one and has no detail", () => {
    try {
      guardApi(request({ cookie: null }));
    } catch (error) {
      expect((error as InstanceType<typeof AppError>).message).toBe(
        "Your session ended. Restart Revenant and open the new link from the terminal.",
      );
    }
  });
});

describe("Host header (DNS rebinding)", () => {
  test("only 127.0.0.1:PORT and localhost:PORT are accepted", () => {
    expect(outcome(request({ headers: { host: "localhost:3000" } }))).toBe("ok");
    for (const host of ["evil.example:3000", "127.0.0.1:4000", "127.0.0.1", "localhost", "127.0.0.1.evil.com:3000", "[::1]:3000"]) {
      expect(outcome(request({ headers: { host } })), host).toBe("403 FORBIDDEN_ORIGIN");
    }
  });

  test("a missing Host header is rejected", () => {
    const req = new Request("http://127.0.0.1:3000/api/cases");
    req.headers.delete("host");
    expect(outcome(req)).toBe("403 FORBIDDEN_ORIGIN");
  });
});

describe("Origin and Fetch-Metadata", () => {
  test("a mismatched Origin is 403 for POST and GET; the matching Origin passes", () => {
    expect(outcome(request({ method: "POST", headers: { origin: "https://evil.example" } }))).toBe("403 FORBIDDEN_ORIGIN");
    expect(outcome(request({ method: "POST", headers: { origin: "null" } }))).toBe("403 FORBIDDEN_ORIGIN");
    expect(outcome(request({ headers: { origin: "https://evil.example" } }))).toBe("403 FORBIDDEN_ORIGIN");
    expect(outcome(request({ method: "POST", headers: { origin: "http://127.0.0.1:3000" } }))).toBe("ok");
    expect(outcome(request({ method: "POST", headers: { origin: "http://localhost:3000", host: "localhost:3000" } }))).toBe("ok");
  });

  test("a different port on localhost is a different origin", () => {
    expect(outcome(request({ method: "POST", headers: { origin: "http://localhost:8080" } }))).toBe("403 FORBIDDEN_ORIGIN");
  });

  test("Sec-Fetch-Site: only same-origin and none pass (cross-site and same-site are blocked)", () => {
    expect(outcome(request({ headers: { "sec-fetch-site": "same-origin" } }))).toBe("ok");
    expect(outcome(request({ headers: { "sec-fetch-site": "none" } }))).toBe("ok");
    expect(outcome(request({ headers: { "sec-fetch-site": "cross-site" } }))).toBe("403 FORBIDDEN_ORIGIN");
    expect(outcome(request({ headers: { "sec-fetch-site": "same-site" } }))).toBe("403 FORBIDDEN_ORIGIN");
  });
});

describe("check order: Host, then Origin/Fetch-Metadata, then cookie", () => {
  test("a bad Host with no cookie is 403, not 401", () => {
    expect(outcome(request({ headers: { host: "evil.example:3000" }, cookie: null }))).toBe("403 FORBIDDEN_ORIGIN");
  });
  test("a cross-site request with no cookie is 403, not 401", () => {
    expect(outcome(request({ headers: { "sec-fetch-site": "cross-site" }, cookie: null }))).toBe("403 FORBIDDEN_ORIGIN");
    expect(outcome(request({ method: "POST", headers: { origin: "https://evil.example" }, cookie: null }))).toBe("403 FORBIDDEN_ORIGIN");
  });
  test("a good origin with no cookie is 401", () => {
    expect(outcome(request({ cookie: null }))).toBe("401 UNAUTHORIZED");
  });
});

describe("content type", () => {
  const json = { "content-type": "application/json; charset=utf-8", "content-length": "2" };

  test("a body must be JSON on non-GET requests", () => {
    expect(outcome(request({ method: "POST", headers: json, body: "{}" }))).toBe("ok");
    expect(outcome(request({ method: "POST", headers: { "content-type": "text/plain", "content-length": "2" }, body: "{}" }))).toBe("400 VALIDATION_FAILED");
    expect(outcome(request({ method: "POST", headers: { "content-length": "2" }, body: "{}" }))).toBe("400 VALIDATION_FAILED");
    expect(outcome(request({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "content-length": "3" }, body: "a=b" }))).toBe("400 VALIDATION_FAILED");
  });

  test("a POST without a body needs no content type", () => {
    expect(outcome(request({ method: "POST" }))).toBe("ok");
  });

  test("multipart is allowed only when the route opts in", () => {
    const multipart = { "content-type": "multipart/form-data; boundary=x", "content-length": "10" };
    expect(outcome(request({ method: "POST", headers: multipart, body: "0123456789" }))).toBe("400 VALIDATION_FAILED");
    expect(outcome(request({ method: "POST", headers: multipart, body: "0123456789" }), { multipart: true })).toBe("ok");
  });
});

test("blocked requests are logged with a fixed label, not header values", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  outcome(request({ headers: { host: "secret-looking-host.example:3000" } }));
  expect(warn).toHaveBeenCalledTimes(1);
  expect(String(warn.mock.calls[0][0])).not.toContain("secret-looking-host");
  warn.mockRestore();
});
