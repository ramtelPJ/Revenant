import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { checkOllama } from "@/lib/ai/ollama-health";
import { checkDocker, type Run } from "@/lib/sandbox/docker-health";

describe("checkOllama", () => {
  let server: http.Server;
  let url: string;
  let mode: "ok" | "error" | "hang" | "badjson" = "ok";

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (mode === "hang") return; // never answer
      if (mode === "error") return void res.writeHead(500).end();
      if (mode === "badjson") return void res.writeHead(200).end("not json");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: [{ name: "gemma2:2b", model: "gemma2:2b" }, { name: "llama3:latest" }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });

  test("reachable with the model installed", async () => {
    mode = "ok";
    expect(await checkOllama(url, "gemma2:2b")).toEqual({ reachable: true, modelInstalled: true, model: "gemma2:2b" });
  });

  test("reachable but the model is not installed", async () => {
    mode = "ok";
    expect(await checkOllama(url, "qwen2.5-coder:7b")).toEqual({ reachable: true, modelInstalled: false, model: "qwen2.5-coder:7b" });
  });

  test("a bare model name matches its :latest tag", async () => {
    mode = "ok";
    expect((await checkOllama(url, "llama3")).modelInstalled).toBe(true);
  });

  test("nothing listening is reported as unreachable, not thrown", async () => {
    expect(await checkOllama("http://127.0.0.1:1", "gemma2:2b")).toEqual({ reachable: false, modelInstalled: false, model: "gemma2:2b" });
  });

  test("a server error or invalid JSON is unreachable", async () => {
    mode = "error";
    expect((await checkOllama(url, "gemma2:2b")).reachable).toBe(false);
    mode = "badjson";
    expect((await checkOllama(url, "gemma2:2b")).reachable).toBe(false);
  });

  test("a hung server returns within the timeout", async () => {
    mode = "hang";
    const started = Date.now();
    const result = await checkOllama(url, "gemma2:2b", 300);
    expect(result.reachable).toBe(false);
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

describe("checkDocker", () => {
  // scripted fake: which (binary, subcommand) pairs succeed
  const fake = (ok: (bin: string, args: string[]) => boolean): Run => async (bin, args) => ok(bin, args);

  test("everything available", async () => {
    expect(await checkDocker("node:lts-slim", fake(() => true))).toEqual({ available: true, imagePresent: true, image: "node:lts-slim" });
  });

  test("no docker CLI anywhere", async () => {
    expect(await checkDocker("node:lts-slim", fake(() => false))).toEqual({ available: false, imagePresent: false, image: "node:lts-slim" });
  });

  test("CLI present but the engine is stopped", async () => {
    const result = await checkDocker("node:lts-slim", fake((_b, args) => args[0] === "--version"));
    expect(result).toEqual({ available: false, imagePresent: false, image: "node:lts-slim" });
  });

  test("engine running but the image is missing", async () => {
    const result = await checkDocker("node:lts-slim", fake((_b, args) => args[0] !== "image"));
    expect(result).toEqual({ available: true, imagePresent: false, image: "node:lts-slim" });
  });

  test("falls back to the Docker Desktop path when `docker` is not on PATH", async () => {
    const used: string[] = [];
    const result = await checkDocker("node:lts-slim", async (bin) => {
      used.push(bin);
      return bin.startsWith("/Applications/Docker.app");
    });
    expect(result.available).toBe(true);
    expect(used[0]).toBe("docker");
    expect(used).toContain("/Applications/Docker.app/Contents/Resources/bin/docker");
  });
});

describe("GET /api/health", () => {
  beforeAll(() => {
    vi.stubEnv("REVENANT_LAUNCH_TOKEN", "a".repeat(64));
    vi.stubEnv("REVENANT_SESSION_SECRET", "b".repeat(64));
    vi.stubEnv("OLLAMA_MODEL", "gemma2:2b");
    vi.stubEnv("PORT", "3000");
    vi.doMock("@/lib/ai/ollama-health", () => ({
      checkOllama: async (_u: string, model: string) => ({ reachable: false, modelInstalled: false, model }),
    }));
    vi.doMock("@/lib/sandbox/docker-health", () => ({
      checkDocker: async (image: string) => ({ available: false, imagePresent: false, image }),
    }));
  });

  const call = async (headers: Record<string, string>) => {
    const { GET } = await import("@/app/api/health/route");
    return GET(new Request("http://127.0.0.1:3000/api/health", { headers: { host: "127.0.0.1:3000", ...headers } }), undefined);
  };

  test("without a session it is 401 and reveals nothing", async () => {
    const res = await call({});
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).not.toContain("ollama");
    expect(JSON.parse(text).error.code).toBe("UNAUTHORIZED");
  });

  test("with a session and both services down it is still 200, all false", async () => {
    const { signSession } = await import("@/lib/http/session");
    const res = await call({ cookie: `revenant_session=${signSession()}` });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({
      ollama: { reachable: false, modelInstalled: false, model: "gemma2:2b" },
      docker: { available: false, imagePresent: false, image: "node:lts-slim" },
      limits: { maxArchiveMb: 100, maxProjectMb: 300, sandboxMemoryMb: 512, sandboxCpus: 1, checkTimeoutSec: 120 }, // the configured upload, project and sandbox limits
    });
  });

  test("a wrong Host is 403", async () => {
    expect((await call({ host: "evil.example:3000" })).status).toBe(403);
  });
});
