import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ApiError, SESSION_ENDED_MESSAGE, apiFetch, sessionEnded } from "@/lib/api-client";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  sessionEnded.reset();
});
afterEach(() => vi.unstubAllGlobals());

const caught = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
};

describe("success", () => {
  test("returns the data field", async () => {
    fetchMock.mockResolvedValue(json({ data: { id: 1 } }));
    expect(await apiFetch("/api/cases")).toEqual({ id: 1 });
  });

  test("a GET has no body or content type; same-origin credentials; never cached", async () => {
    fetchMock.mockResolvedValue(json({ data: [] }));
    await apiFetch("/api/cases");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/cases");
    expect(init).toMatchObject({ method: "GET", credentials: "same-origin", cache: "no-store" });
    expect(init.body).toBeUndefined();
    expect(init.headers).not.toHaveProperty("Content-Type");
  });

  test("an object body is sent as JSON", async () => {
    fetchMock.mockResolvedValue(json({ data: {} }, 201));
    await apiFetch("/api/cases", { method: "POST", body: { kind: "sample", sampleId: "broken-esm" } });
    const init = fetchMock.mock.calls[0][1];
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.body).toBe('{"kind":"sample","sampleId":"broken-esm"}');
  });

  test("FormData is passed through untouched, with no content type (the browser adds the boundary)", async () => {
    fetchMock.mockResolvedValue(json({ data: {} }, 201));
    const form = new FormData();
    form.append("archive", new Blob(["x"]), "p.zip");
    await apiFetch("/api/cases", { method: "POST", body: form });
    const init = fetchMock.mock.calls[0][1];
    expect(init.body).toBe(form);
    expect(init.headers).not.toHaveProperty("Content-Type");
  });

  test("a body-less POST (like cancel) sends no body and no content type", async () => {
    fetchMock.mockResolvedValue(json({ data: { status: "cancelled" } }));
    await apiFetch("/api/jobs/x/cancel", { method: "POST" });
    expect(fetchMock.mock.calls[0][1].body).toBeUndefined();
    expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty("Content-Type");
  });

  test("an abort signal reaches fetch", async () => {
    fetchMock.mockResolvedValue(json({ data: 1 }));
    const controller = new AbortController();
    await apiFetch("/api/health", { signal: controller.signal });
    expect(fetchMock.mock.calls[0][1].signal).toBe(controller.signal);
  });
});

describe("only same-origin API paths", () => {
  test.each(["https://evil.example/api/x", "//evil.example/api/x", "/other", "api/cases", "", "/apiary", "http://127.0.0.1:3000/api/cases"])("%s is refused before any request", async (path) => {
    expect(await caught(apiFetch(path))).toBeInstanceOf(TypeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("errors", () => {
  test("the server's error envelope becomes an ApiError with every field", async () => {
    fetchMock.mockResolvedValue(json({ error: { code: "TOO_LARGE", message: "This project is larger than the 300 MB limit.", requestId: "req_ab12", fields: { path: "too big" } } }, 413));
    const error = (await caught(apiFetch("/api/cases"))) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: "TOO_LARGE", status: 413, message: "This project is larger than the 300 MB limit.", requestId: "req_ab12", fields: { path: "too big" } });
    expect(sessionEnded.get()).toBe(false);
  });

  test("a 409 or 422 keeps its own code (so a screen can react to it)", async () => {
    fetchMock.mockResolvedValue(json({ error: { code: "JOB_RUNNING", message: "Another step is still running for this case." } }, 409));
    expect(await caught(apiFetch("/api/cases/x/diagnose", { method: "POST", body: {} }))).toMatchObject({ code: "JOB_RUNNING", status: 409 });
  });

  test("an error that is not JSON never shows the raw body", async () => {
    fetchMock.mockResolvedValue(new Response("<html>Traceback: /Users/me/secret.ts line 3</html>", { status: 500 }));
    const error = (await caught(apiFetch("/api/cases"))) as ApiError;
    expect(error).toMatchObject({ code: "BAD_RESPONSE", status: 500 });
    expect(error.message).toBe("Revenant sent an unexpected response. Try again.");
    expect(error.message).not.toContain("Traceback");
  });

  test("a success response that is not JSON (or has no data) is a bad response", async () => {
    fetchMock.mockResolvedValueOnce(new Response("<html>locked</html>", { status: 200 }));
    expect(await caught(apiFetch("/api/cases"))).toMatchObject({ code: "BAD_RESPONSE" });
    fetchMock.mockResolvedValueOnce(json({ nothing: true }));
    expect(await caught(apiFetch("/api/cases"))).toMatchObject({ code: "BAD_RESPONSE" });
    fetchMock.mockResolvedValueOnce(json(null));
    expect(await caught(apiFetch("/api/cases"))).toMatchObject({ code: "BAD_RESPONSE" });
  });

  test("a malformed error envelope falls back to a generic one", async () => {
    fetchMock.mockResolvedValue(json({ error: { code: 5, message: { nested: true } } }, 500));
    expect(await caught(apiFetch("/api/cases"))).toMatchObject({ code: "BAD_RESPONSE", message: "Revenant sent an unexpected response. Try again." });
  });

  test("no connection: a friendly NETWORK_ERROR with status 0", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed ECONNREFUSED 127.0.0.1:3000"));
    const error = (await caught(apiFetch("/api/cases"))) as ApiError;
    expect(error).toMatchObject({ code: "NETWORK_ERROR", status: 0, message: "Can't reach Revenant. Check that it is still running." });
    expect(error.message).not.toContain("ECONNREFUSED");
  });

  test("an aborted request is rethrown as an abort, not reported as a network failure", async () => {
    fetchMock.mockRejectedValue(new DOMException("aborted", "AbortError"));
    const error = await caught(apiFetch("/api/health"));
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe("AbortError");
  });
});

describe("a lost session (401)", () => {
  test("flags the whole app as ended, and still throws the error to the caller", async () => {
    fetchMock.mockResolvedValue(json({ error: { code: "UNAUTHORIZED", message: SESSION_ENDED_MESSAGE, requestId: "req_1" } }, 401));
    const listener = vi.fn();
    const unsubscribe = sessionEnded.subscribe(listener);

    const error = (await caught(apiFetch("/api/cases/x/logs", { method: "POST", body: { content: "a long pasted log" } }))) as ApiError;
    expect(error).toMatchObject({ code: "UNAUTHORIZED", status: 401, message: SESSION_ENDED_MESSAGE });
    expect(sessionEnded.get()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);

    await caught(apiFetch("/api/cases")); // a second 401 does not notify again
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  test("a 401 with no usable body still gets the session message", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 401 }));
    expect(await caught(apiFetch("/api/cases"))).toMatchObject({ code: "UNAUTHORIZED", message: SESSION_ENDED_MESSAGE });
    expect(sessionEnded.get()).toBe(true);
  });

  test("a 403 does not end the session", async () => {
    fetchMock.mockResolvedValue(json({ error: { code: "FORBIDDEN_ORIGIN", message: "This request was blocked." } }, 403));
    await caught(apiFetch("/api/cases"));
    expect(sessionEnded.get()).toBe(false);
  });

  test("reset() clears the flag and tells subscribers; unsubscribed listeners hear nothing", () => {
    const listener = vi.fn();
    const unsubscribe = sessionEnded.subscribe(listener);
    sessionEnded.mark();
    sessionEnded.reset();
    expect(sessionEnded.get()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    sessionEnded.mark();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  test("handling a 401 never navigates or reloads the page (that would throw away what the user typed)", () => {
    const source = readFileSync("src/lib/api-client.ts", "utf8");
    expect(source).not.toMatch(/location\.|window\.open|router\.(push|replace)|\.reload\(/);
  });
});
