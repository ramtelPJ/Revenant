import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

/**
 * Every route handler must be `export const METHOD = handle(async (request ...) => { guardApi(request ...`.
 * Returns a list of problems; empty means the file is compliant.
 */
export function checkRouteSource(source: string): string[] {
  const problems: string[] = [];
  const exported = [...source.matchAll(/export\s+(?:const|async function|function)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)];
  const wrapped = [...source.matchAll(/export\s+const\s+(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*=\s*handle\s*(?:<[^()]*>)?\s*\(/g)];
  if (exported.length === 0) problems.push("exports no HTTP method handler");
  if (wrapped.length !== exported.length) problems.push("a handler is not wrapped in handle(...)");

  const guarded = [
    ...source.matchAll(/=\s*handle\s*(?:<[^()]*>)?\s*\(\s*async\s*\([^)]*\)\s*(?::\s*[^=]+)?=>\s*\{\s*guardApi\(\s*request\b/g),
  ];
  if (guarded.length !== wrapped.length) problems.push("a handler does not start with guardApi(request)");
  return problems;
}

const routeFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return routeFiles(full);
    return name === "route.ts" ? [full] : [];
  });

describe("checkRouteSource", () => {
  test("accepts guarded handlers, including generics, context and several methods", () => {
    const good = `
      import { guardApi } from "@/lib/http/guard";
      import { handle, ok } from "@/lib/http/respond";
      export const GET = handle(async (request) => {
        guardApi(request);
        return ok(1);
      });
      export const POST = handle<{ params: Promise<{ caseId: string }> }>(async (request, { params }) => {
        guardApi(request, { multipart: true });
        return ok(2);
      });
    `;
    expect(checkRouteSource(good)).toEqual([]);
  });

  test("rejects a handler without guardApi", () => {
    const bad = `export const GET = handle(async (request) => { return ok(1); });`;
    expect(checkRouteSource(bad)).toContain("a handler does not start with guardApi(request)");
  });

  test("rejects guardApi that is not the first statement", () => {
    const bad = `export const GET = handle(async (request) => {
      const x = 1;
      guardApi(request);
      return ok(x);
    });`;
    expect(checkRouteSource(bad).length).toBeGreaterThan(0);
  });

  test("rejects an unwrapped handler, even if it calls guardApi", () => {
    const bad = `export async function GET(request: Request) { guardApi(request); return ok(1); }`;
    expect(checkRouteSource(bad)).toContain("a handler is not wrapped in handle(...)");
  });

  test("rejects one unguarded method among guarded ones", () => {
    const bad = `
      export const GET = handle(async (request) => { guardApi(request); return ok(1); });
      export const DELETE = handle(async (request) => { return ok(2); });`;
    expect(checkRouteSource(bad)).toContain("a handler does not start with guardApi(request)");
  });

  test("rejects a route file with no handler", () => {
    expect(checkRouteSource("export const dynamic = 'force-dynamic';")).toContain("exports no HTTP method handler");
  });
});

describe("every API route is guarded", () => {
  const root = "src/app/api";
  const files = routeFiles(root);

  test("scan finds the routes (none exist yet; this grows as routes are added)", () => {
    expect(Array.isArray(files)).toBe(true);
  });

  for (const file of files) {
    test(`${file} starts every handler with guardApi(request)`, () => {
      expect(checkRouteSource(readFileSync(file, "utf8")), file).toEqual([]);
    });
  }
});
