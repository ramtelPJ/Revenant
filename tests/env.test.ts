import { describe, expect, test } from "vitest";
import { parseEnv } from "@/lib/env";

const a = "a".repeat(64);
const b = "b".repeat(64);
const valid = {
  REVENANT_LAUNCH_TOKEN: a,
  REVENANT_SESSION_SECRET: b,
  OLLAMA_MODEL: "qwen2.5-coder:7b",
};

describe("parseEnv", () => {
  test("applies documented defaults", () => {
    const env = parseEnv(valid);
    expect(env).toMatchObject({
      HOST: "127.0.0.1",
      PORT: 3000,
      DATA_DIR: "./data",
      OLLAMA_URL: "http://127.0.0.1:11434",
      AI_TIMEOUT_SEC: 120,
      SANDBOX_IMAGE: "node:lts-slim",
      SANDBOX_MEMORY_MB: 512,
      SANDBOX_CPUS: 1,
      CHECK_TIMEOUT_SEC: 120,
      MAX_ARCHIVE_MB: 100,
      MAX_PROJECT_MB: 300,
    });
  });

  test("refuses a non-loopback HOST", () => {
    expect(() => parseEnv({ ...valid, HOST: "0.0.0.0" })).toThrow(/HOST/);
  });

  test("OLLAMA_URL must be loopback", () => {
    expect(() => parseEnv({ ...valid, OLLAMA_URL: "http://example.com" })).toThrow(/OLLAMA_URL/);
    expect(() => parseEnv({ ...valid, OLLAMA_URL: "http://127.0.0.1.evil.com:11434" })).toThrow(/OLLAMA_URL/);
    expect(() => parseEnv({ ...valid, OLLAMA_URL: "https://localhost:11434" })).toThrow(/OLLAMA_URL/);
    expect(parseEnv({ ...valid, OLLAMA_URL: "http://localhost:11434" }).OLLAMA_URL).toBe("http://localhost:11434");
    expect(parseEnv({ ...valid, OLLAMA_URL: "http://127.0.0.1:11434" }).OLLAMA_URL).toBe("http://127.0.0.1:11434");
  });

  test("secrets must be 32 bytes of hex", () => {
    expect(() => parseEnv({ ...valid, REVENANT_LAUNCH_TOKEN: "abc" })).toThrow(/REVENANT_LAUNCH_TOKEN/);
    expect(() => parseEnv({ ...valid, REVENANT_SESSION_SECRET: "z".repeat(64) })).toThrow(/REVENANT_SESSION_SECRET/);
    expect(() => parseEnv({ ...valid, REVENANT_SESSION_SECRET: undefined })).toThrow(/REVENANT_SESSION_SECRET/);
  });

  test("sandbox limits above the upper bound are rejected", () => {
    expect(() => parseEnv({ ...valid, SANDBOX_MEMORY_MB: "999999" })).toThrow(/SANDBOX_MEMORY_MB/);
    expect(() => parseEnv({ ...valid, SANDBOX_CPUS: "64" })).toThrow(/SANDBOX_CPUS/);
    expect(() => parseEnv({ ...valid, SANDBOX_CPUS: "0" })).toThrow(/SANDBOX_CPUS/);
  });

  test("SANDBOX_IMAGE must be a plain image name, never something docker could read as a flag", () => {
    for (const bad of ["--privileged", "-v", "node lts", "node;id", "$(id)", "node\nslim", ""]) {
      expect(() => parseEnv({ ...valid, SANDBOX_IMAGE: bad }), JSON.stringify(bad)).toThrow(/SANDBOX_IMAGE/);
    }
    for (const ok of ["node:lts-slim", "node:22-slim", "registry.example.com:5000/team/node:1.0", "node@sha256:" + "a".repeat(64)]) {
      expect(parseEnv({ ...valid, SANDBOX_IMAGE: ok }).SANDBOX_IMAGE).toBe(ok);
    }
  });

  test("OLLAMA_MODEL is required", () => {
    expect(() => parseEnv({ ...valid, OLLAMA_MODEL: undefined })).toThrow(/OLLAMA_MODEL/);
  });

  test("error message does not echo secret values", () => {
    try {
      parseEnv({ ...valid, REVENANT_LAUNCH_TOKEN: "supersecretvalue" });
    } catch (e) {
      expect(String(e)).not.toContain("supersecretvalue");
      return;
    }
    throw new Error("expected parseEnv to throw");
  });
});

test(".env.example contains no real-looking secret", async () => {
  const { readFileSync } = await import("node:fs");
  expect(readFileSync(".env.example", "utf8")).not.toMatch(/[0-9a-f]{64}/i);
});
