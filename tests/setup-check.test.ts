import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { formatReport, nodeVersionOk, runSetupChecks, type CheckResult, type SetupDeps } from "@/lib/setup-check";

let cwd: string;

const goodEnv = { OLLAMA_MODEL: "gemma2:2b" };
/** Everything is fine unless a test overrides a piece. */
const deps = (over: Partial<SetupDeps> = {}): Partial<SetupDeps> => ({
  env: goodEnv,
  nodeVersion: "v24.1.0",
  platform: "darwin",
  cwd,
  checkOllama: vi.fn(async (_url: string, model: string) => ({ reachable: true, modelInstalled: true, model })),
  checkDocker: vi.fn(async (image: string) => ({ available: true, imagePresent: true, image })),
  dockerBin: async () => "docker",
  ...over,
});
const byId = (results: CheckResult[], id: string) => results.find((r) => r.id === id)!;

beforeEach(() => {
  cwd = mkdtempSync(path.join(os.tmpdir(), "revenant-setup-"));
  mkdirSync(path.join(cwd, ".next"));
  writeFileSync(path.join(cwd, ".next", "BUILD_ID"), "x");
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe("nodeVersionOk", () => {
  test.each([
    ["v26.10.0", true], ["v24.0.0", true], ["v23.6.0", true], ["v22.18.0", true], ["v22.18.1", true], ["v22.30.0", true],
    ["v22.17.9", false], ["v22.0.0", false], ["v20.11.1", false], ["v18.19.0", false], ["", false], ["banana", false], ["v22", false],
  ])("%s -> %s", (version, expected) => expect(nodeVersionOk(version)).toBe(expected));
});

describe("everything installed", () => {
  test("every check passes, nothing is a failure, and the report says setup is complete", async () => {
    const results = await runSetupChecks(deps());
    expect(results.map((r) => [r.id, r.status])).toEqual([
      ["node", "ok"], ["config", "ok"], ["ollama", "ok"], ["docker", "ok"], ["image", "ok"], ["samples", "ok"], ["build", "ok"],
    ]);
    const report = formatReport(results);
    expect(report.ok).toBe(true);
    expect(report.text).toContain("Setup is complete.");
    expect(report.text).not.toContain("fix:");
  });

  test("the configured model and image are what get checked", async () => {
    const d = deps({ env: { OLLAMA_MODEL: "qwen2.5-coder:3b", SANDBOX_IMAGE: "node:22-slim", OLLAMA_URL: "http://localhost:11434" } });
    await runSetupChecks(d);
    expect(d.checkOllama).toHaveBeenCalledWith("http://localhost:11434", "qwen2.5-coder:3b");
    expect(d.checkDocker).toHaveBeenCalledWith("node:22-slim");
  });
});

describe("Node", () => {
  test("too old: required failure with a fix", async () => {
    const results = await runSetupChecks(deps({ nodeVersion: "v20.11.0" }));
    expect(byId(results, "node")).toMatchObject({ status: "fail", required: true });
    expect(byId(results, "node").fix).toContain("nodejs.org");
    expect(formatReport(results).ok).toBe(false);
  });
});

describe("configuration", () => {
  test("no model configured: config and Ollama both fail, with fixes, and Ollama is not contacted", async () => {
    const d = deps({ env: {} });
    const results = await runSetupChecks(d);
    expect(byId(results, "config")).toMatchObject({ status: "fail", required: true });
    expect(byId(results, "config").detail).toContain("OLLAMA_MODEL");
    expect(byId(results, "ollama")).toMatchObject({ status: "fail", fix: "Set OLLAMA_MODEL in .env.local" });
    expect(d.checkOllama).not.toHaveBeenCalled();
    expect(formatReport(results).ok).toBe(false);
  });

  test("a non-loopback OLLAMA_URL is reported and NEVER contacted: the default loopback address is used instead", async () => {
    for (const bad of ["http://example.com:11434", "https://localhost:11434", "http://127.0.0.1.evil.com", "http://10.0.0.5:11434"]) {
      const d = deps({ env: { ...goodEnv, OLLAMA_URL: bad } });
      const results = await runSetupChecks(d);
      expect(byId(results, "config")).toMatchObject({ status: "fail" });
      expect(d.checkOllama).toHaveBeenCalledWith("http://127.0.0.1:11434", "gemma2:2b");
      expect(vi.mocked(d.checkOllama!).mock.calls.flat().join(" ")).not.toContain(bad);
      expect(byId(results, "ollama").detail).toContain("the default address");
    }
  });

  test("the report never repeats secret values", async () => {
    const results = await runSetupChecks(deps({ env: { ...goodEnv, REVENANT_LAUNCH_TOKEN: "supersecret-launch", REVENANT_SESSION_SECRET: "supersecret-session", OLLAMA_URL: "http://example.com" } }));
    const text = formatReport(results).text;
    expect(text).not.toContain("supersecret");
  });

  test("the launcher's secrets are not required here", async () => {
    const results = await runSetupChecks(deps({ env: goodEnv })); // no REVENANT_* at all
    expect(byId(results, "config").status).toBe("ok");
  });

  test("a malformed SANDBOX_IMAGE (one that could be read as a docker flag) is reported and never passed on", async () => {
    for (const bad of ["--privileged", "-v", "node lts", "node;id", "$(id)"]) {
      const d = deps({ env: { ...goodEnv, SANDBOX_IMAGE: bad } });
      const results = await runSetupChecks(d);
      expect(byId(results, "config")).toMatchObject({ status: "fail" });
      expect(byId(results, "config").detail).toContain("SANDBOX_IMAGE");
      expect(d.checkDocker).toHaveBeenCalledWith("node:lts-slim"); // the default is checked instead
      expect(vi.mocked(d.checkDocker!).mock.calls.flat()).not.toContain(bad);
    }
  });
});

describe("Ollama", () => {
  test("not running", async () => {
    const results = await runSetupChecks(deps({ checkOllama: async (_u, model) => ({ reachable: false, modelInstalled: false, model }) }));
    expect(byId(results, "ollama")).toMatchObject({ status: "fail", required: true });
    expect(byId(results, "ollama").fix).toContain("ollama serve");
  });

  test("running but the model is missing: the fix names the exact model", async () => {
    const results = await runSetupChecks(deps({ env: { OLLAMA_MODEL: "qwen2.5-coder:7b" }, checkOllama: async (_u, model) => ({ reachable: true, modelInstalled: false, model }) }));
    expect(byId(results, "ollama").fix).toBe("Run `ollama pull qwen2.5-coder:7b` (needs internet once)");
    expect(byId(results, "ollama").detail).toContain("not installed");
  });
});

describe("Docker", () => {
  test("missing or stopped: required failure; the macOS fix mentions PATH", async () => {
    const d = deps({ checkDocker: async (image) => ({ available: false, imagePresent: false, image }) });
    const results = await runSetupChecks(d);
    expect(byId(results, "docker")).toMatchObject({ status: "fail", required: true });
    expect(byId(results, "docker").fix).toContain("Docker Desktop");
    expect(byId(results, "docker").fix).toContain("PATH");
    expect(results.find((r) => r.id === "image")).toBeUndefined(); // no claim about the image without an engine
    const linux = await runSetupChecks({ ...d, platform: "linux" });
    expect(byId(linux, "docker").fix).toContain("get-docker");
    expect(byId(linux, "docker").fix).not.toContain("Docker.app");
  });

  test("engine up but the image is missing: the fix is the exact pull command", async () => {
    const results = await runSetupChecks(deps({ env: { ...goodEnv, SANDBOX_IMAGE: "node:22-slim" }, checkDocker: async (image) => ({ available: true, imagePresent: false, image }) }));
    expect(byId(results, "image")).toMatchObject({ status: "fail", required: true, fix: "Run `docker pull node:22-slim` (needs internet once)" });
  });

  test("docker found only through the Docker Desktop folder: a warning, not a failure", async () => {
    const results = await runSetupChecks(deps({ dockerBin: async () => "/Applications/Docker.app/Contents/Resources/bin/docker" }));
    expect(byId(results, "docker").status).toBe("warn");
    expect(byId(results, "docker").fix).toContain("/Applications/Docker.app/Contents/Resources/bin");
    expect(formatReport(results).ok).toBe(true);
  });
});

describe("optional items never make setup fail", () => {
  const sample = (name: string, installed: boolean, deps = { "esm-greeter": "1.0.0" }) => {
    const dir = path.join(cwd, "samples", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, dependencies: deps }));
    if (installed) mkdirSync(path.join(dir, "node_modules", "esm-greeter"), { recursive: true });
  };

  test("samples with missing dependencies: a warning that names them, with the prepare command", async () => {
    sample("a", true);
    sample("b", false);
    const results = await runSetupChecks(deps());
    expect(byId(results, "samples")).toMatchObject({ status: "warn", required: false, fix: "Run `npm run prepare-samples`" });
    expect(byId(results, "samples").detail).toContain("b");
    expect(byId(results, "samples").detail).not.toContain("a,");
    const report = formatReport(results);
    expect(report.ok).toBe(true);
    expect(report.text).toContain("Setup is complete. 1 optional item could be improved.");
  });

  test("prepared samples, a sample with no dependencies, and no samples folder are all fine", async () => {
    sample("ready", true);
    sample("no-deps", false, {} as never);
    expect(byId(await runSetupChecks(deps()), "samples")).toMatchObject({ status: "ok", detail: "2 samples ready" });
    rmSync(path.join(cwd, "samples"), { recursive: true });
    expect(byId(await runSetupChecks(deps()), "samples").status).toBe("ok");
  });

  test("no production build: a warning with the build command", async () => {
    rmSync(path.join(cwd, ".next"), { recursive: true });
    const results = await runSetupChecks(deps());
    expect(byId(results, "build")).toMatchObject({ status: "warn", required: false, fix: "Run `npm run build`" });
    expect(formatReport(results).ok).toBe(true);
  });
});

describe("the report", () => {
  test("lists every failure with its fix, counts the missing items, and ok is false", async () => {
    const results = await runSetupChecks(
      deps({
        nodeVersion: "v18.0.0",
        checkOllama: async (_u, model) => ({ reachable: false, modelInstalled: false, model }),
        checkDocker: async (image) => ({ available: false, imagePresent: false, image }),
      }),
    );
    const report = formatReport(results);
    expect(report.ok).toBe(false);
    expect(report.text).toContain("✗ Node.js");
    expect(report.text).toContain("✗ Local AI (Ollama)");
    expect(report.text).toContain("✗ Docker");
    expect(report.text).toContain("Setup is not complete: 3 required items missing.");
    expect((report.text.match(/fix:/g) ?? []).length).toBe(3);
  });

  test("a single missing item uses the singular", () => {
    const report = formatReport([{ id: "x", label: "X", status: "fail", required: true, detail: "gone", fix: "get it" }]);
    expect(report.text).toContain("1 required item missing.");
  });
});

describe("against a real local server (nothing is mocked except the address)", () => {
  let server: http.Server;
  let url: string;
  beforeEach(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: [{ name: "gemma2:2b" }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => {
    server.closeAllConnections();
    server.close();
  });

  test("a running Ollama with the model is recognised; a closed port is a plain failure without a stack trace", async () => {
    const real = await runSetupChecks({ env: { OLLAMA_MODEL: "gemma2:2b", OLLAMA_URL: url }, cwd, checkDocker: async (image) => ({ available: true, imagePresent: true, image }), dockerBin: async () => "docker" });
    expect(byId(real, "ollama").status).toBe("ok");

    const closed = await runSetupChecks({ env: { OLLAMA_MODEL: "gemma2:2b", OLLAMA_URL: "http://127.0.0.1:1" }, cwd, checkDocker: async (image) => ({ available: true, imagePresent: true, image }), dockerBin: async () => "docker" });
    expect(byId(closed, "ollama")).toMatchObject({ status: "fail" });
    expect(JSON.stringify(closed)).not.toMatch(/ECONNREFUSED|at \w+ \(|node:internal/);
  });
});
