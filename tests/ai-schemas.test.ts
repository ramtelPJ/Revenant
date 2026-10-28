import { describe, expect, test } from "vitest";
import { evidenceSchema, findingSchema, overviewSchema, patchSchema } from "@/lib/ai/schemas";
import { toFormat } from "@/lib/ai/ollama";
import { FINDING_CATEGORIES } from "@/lib/db/schema";

const ok = (schema: { safeParse(v: unknown): { success: boolean } }, value: unknown) => schema.safeParse(value).success;
const props = (schema: Parameters<typeof toFormat>[0]) => (toFormat(schema) as { properties: Record<string, unknown>; required?: string[] });

describe("overviewSchema", () => {
  const valid = { purpose: "A greeter.", how_to_run: "npm test", key_files: [{ path: "src/index.js", reason: "entry" }] };
  test("accepts a normal answer, including no key files", () => {
    expect(ok(overviewSchema, valid)).toBe(true);
    expect(ok(overviewSchema, { ...valid, key_files: [] })).toBe(true);
  });
  test("rejects missing, empty, blank, wrong-typed and over-long fields", () => {
    expect(ok(overviewSchema, { ...valid, purpose: "" })).toBe(false);
    expect(ok(overviewSchema, { ...valid, purpose: "   " })).toBe(false);
    expect(ok(overviewSchema, { purpose: "x", key_files: [] })).toBe(false);
    expect(ok(overviewSchema, { ...valid, key_files: [{ path: "a" }] })).toBe(false);
    expect(ok(overviewSchema, { ...valid, key_files: "src/index.js" })).toBe(false);
    expect(ok(overviewSchema, { ...valid, purpose: "x".repeat(801) })).toBe(false);
    expect(ok(overviewSchema, { ...valid, key_files: Array.from({ length: 9 }, () => ({ path: "a", reason: "b" })) })).toBe(false);
  });
  test("trims whitespace", () => {
    expect(overviewSchema.parse({ ...valid, purpose: "  hi  " }).purpose).toBe("hi");
  });
});

describe("findingSchema", () => {
  const valid = {
    title: "Dependency is ESM-only", explanation: "require() fails.", category: "module_format", actionable: true,
    evidence: [{ kind: "file", path: "src/index.js", startLine: 1, endLine: 1, quote: 'require("esm-greeter")' }, { kind: "log", excerpt: "ERR_REQUIRE_ASYNC_MODULE" }],
  };
  test("accepts file and log evidence, and an empty evidence list", () => {
    expect(ok(findingSchema, valid)).toBe(true);
    expect(ok(findingSchema, { ...valid, evidence: [] })).toBe(true);
  });
  test("category must be one of the known categories", () => {
    for (const category of FINDING_CATEGORIES) expect(ok(findingSchema, { ...valid, category })).toBe(true);
    expect(ok(findingSchema, { ...valid, category: "magic" })).toBe(false);
    expect(ok(findingSchema, { ...valid, category: undefined })).toBe(false);
  });
  test("actionable must be a real boolean, line numbers real positive integers, evidence capped at 6", () => {
    expect(ok(findingSchema, { ...valid, actionable: "yes" })).toBe(false);
    expect(ok(findingSchema, { ...valid, evidence: [{ kind: "file", path: "a", startLine: 0 }] })).toBe(false);
    expect(ok(findingSchema, { ...valid, evidence: [{ kind: "file", path: "a", startLine: 1.5 }] })).toBe(false);
    expect(ok(findingSchema, { ...valid, evidence: [{ kind: "other" }] })).toBe(false);
    expect(ok(findingSchema, { ...valid, evidence: Array.from({ length: 7 }, () => ({ kind: "log", excerpt: "x" })) })).toBe(false);
  });
  test("the model cannot set the label: it is not in the schema and is dropped if sent", () => {
    expect(props(findingSchema).properties).not.toHaveProperty("label");
    expect(findingSchema.parse({ ...valid, label: "confirmed_by_check" })).not.toHaveProperty("label");
  });
  test("evidence is a flat object with only `kind` required (small models follow flat shapes)", () => {
    expect(toFormat(evidenceSchema)).toMatchObject({ type: "object", required: ["kind"] });
  });
});

describe("patchSchema", () => {
  const edit = { path: "src/index.js", search: 'require("x")', replace: 'await import("x")' };
  test("accepts one to five edits; an edit may delete text (empty replace)", () => {
    expect(ok(patchSchema, { rationale: "why", edits: [edit] })).toBe(true);
    expect(ok(patchSchema, { rationale: "why", edits: [{ ...edit, replace: "" }] })).toBe(true);
    expect(ok(patchSchema, { rationale: "why", edits: Array.from({ length: 5 }, () => edit) })).toBe(true);
  });
  test("rejects no edits, six edits, an empty search, a missing path, and over-long text", () => {
    expect(ok(patchSchema, { rationale: "why", edits: [] })).toBe(false);
    expect(ok(patchSchema, { rationale: "why", edits: Array.from({ length: 6 }, () => edit) })).toBe(false);
    expect(ok(patchSchema, { rationale: "why", edits: [{ ...edit, search: "" }] })).toBe(false);
    expect(ok(patchSchema, { rationale: "why", edits: [{ search: "a", replace: "b" }] })).toBe(false);
    expect(ok(patchSchema, { rationale: "why", edits: [{ ...edit, search: "x".repeat(4001) }] })).toBe(false);
    expect(ok(patchSchema, { edits: [edit] })).toBe(false);
  });
});

describe("what Ollama is told to produce", () => {
  test("each schema becomes an object schema that lists its required fields", () => {
    expect(props(overviewSchema).required).toEqual(["purpose", "how_to_run", "key_files"]);
    expect(props(findingSchema).required).toEqual(["title", "explanation", "category", "actionable", "evidence"]);
    expect(props(patchSchema).required).toEqual(["rationale", "edits"]);
  });
  test("the category list sent to the model is exactly the one the database accepts", () => {
    expect((props(findingSchema).properties.category as { enum: string[] }).enum).toEqual([...FINDING_CATEGORIES]);
  });
});
