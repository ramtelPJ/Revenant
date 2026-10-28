import { afterEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { AppError, fail, handle, ok } from "@/lib/http/respond";

const req = new Request("http://127.0.0.1:3000/api/x");
afterEach(() => vi.restoreAllMocks());

describe("envelope", () => {
  test("ok wraps data and disables caching", async () => {
    const res = ok({ id: 1 }, 201);
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ data: { id: 1 } });
  });

  test("fail returns code, message, requestId and optional fields", async () => {
    const res = fail(new AppError("NOT_FOUND", 404, "We couldn't find that."), "req_deadbeef");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: "NOT_FOUND", message: "We couldn't find that.", requestId: "req_deadbeef" },
    });
    const withFields = await fail(new AppError("VALIDATION_FAILED", 400, "bad", { path: "required" })).json();
    expect(withFields.error.fields).toEqual({ path: "required" });
  });
});

describe("handle", () => {
  test("an AppError becomes its envelope with a requestId", async () => {
    const res = await handle(() => {
      throw new AppError("CONSENT_REQUIRED", 400, "Permission to run project code in the sandbox is required.");
    })(req, undefined);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("CONSENT_REQUIRED");
    expect(body.error.requestId).toMatch(/^req_[0-9a-f]{8}$/);
  });

  test("a ZodError becomes 400 VALIDATION_FAILED with per-field messages", async () => {
    const schema = z.object({ content: z.string().min(1), n: z.number() });
    const res = await handle(() => {
      schema.parse({ content: "", n: "x" });
      return ok(null);
    })(req, undefined);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_FAILED");
    expect(Object.keys(body.error.fields).sort()).toEqual(["content", "n"]);
  });

  test("an unexpected error is a generic 500 that leaks nothing, in the body or the log", async () => {
    const secret = "SELECT * FROM cases /Users/me/project/.env API_KEY=hunter2";
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await handle(() => {
      throw new Error(secret);
    })(req, undefined);

    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text).error).toMatchObject({ code: "INTERNAL", message: "Something went wrong. Please try again." });
    expect(text).not.toMatch(/SELECT|\/Users|hunter2|stack/i);

    const line = String(logged.mock.calls[0][0]);
    expect(line).toMatch(/^\[req_[0-9a-f]{8}\] INTERNAL Error/);
    expect(line).not.toContain("hunter2");
    expect(line).not.toContain("SELECT");
  });

  test("the requestId in the log matches the one in the response", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await handle(() => {
      throw new Error("boom");
    })(req, undefined);
    const { requestId } = (await res.json()).error;
    expect(String(logged.mock.calls[0][0])).toContain(requestId);
  });

  test("a thrown non-Error value is also a safe 500", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await handle(() => {
      throw "raw string with /secret/path";
    })(req, undefined);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("/secret/path");
  });

  test("a normal response passes through and the context is forwarded", async () => {
    const res = await handle((_r, ctx: { id: string }) => ok({ id: ctx.id }))(req, { id: "abc" });
    expect(await res.json()).toEqual({ data: { id: "abc" } });
  });
});
