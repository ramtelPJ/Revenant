import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { resetDockerBin, resolveDockerBin, runDocker, type Run } from "@/lib/sandbox/docker";
import { evaluateCheck } from "@/lib/sandbox/checks";

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
}

type Call = { bin: string; args: string[]; options: unknown };

/** `onRun` drives the `docker run` child; `docker kill <name>` is recorded and, if `killCloses`, ends it with 137. */
function harness(onRun: (child: FakeChild) => void, killCloses = true) {
  const calls: Call[] = [];
  let runChild: FakeChild | undefined;
  const fake = ((bin: string, args: string[], options: unknown) => {
    calls.push({ bin, args, options });
    const child = new FakeChild();
    if (args[0] === "run") {
      runChild = child;
      queueMicrotask(() => onRun(child));
    } else if (args[0] === "kill" && killCloses) {
      queueMicrotask(() => runChild?.emit("close", 137));
    }
    return child;
  }) as unknown as typeof spawn;
  return { calls, spawn: fake, deps: { spawn: fake, resolveBin: async () => "/usr/bin/docker" } };
}

const NAME = "revenant-test";
const ARGS = ["run", "--name", NAME, "node:lts-slim", "npm", "test"];
const kills = (calls: Call[]) => calls.filter((c) => c.args[0] === "kill");

describe("finishing normally", () => {
  test("collects stdout and stderr in arrival order and reports the exit code", async () => {
    const h = harness((c) => {
      c.stdout.emit("data", Buffer.from("hello\n"));
      c.stderr.emit("data", Buffer.from("warn\n"));
      c.stdout.emit("data", Buffer.from("bye\n"));
      c.emit("close", 0);
    });
    const result = await runDocker(ARGS, { name: NAME, timeoutMs: 1000, deps: h.deps });
    expect(result).toMatchObject({ kind: "finished", exitCode: 0, output: "hello\nwarn\nbye\n", timedOut: false, survived: false, aborted: false, truncated: false });
    expect(kills(h.calls)).toHaveLength(0);
    expect(evaluateCheck("test", result as never)).toBe("passed");
  });

  test("a failing project is a finished run with its exit code", async () => {
    const h = harness((c) => {
      c.stderr.emit("data", Buffer.from("Error: boom"));
      c.emit("close", 1);
    });
    const result = await runDocker(ARGS, { name: NAME, timeoutMs: 1000, deps: h.deps });
    expect(result).toMatchObject({ kind: "finished", exitCode: 1 });
    expect(evaluateCheck("test", result as never)).toBe("failed");
  });

  test("spawns the resolved binary with exactly the given arguments, no shell", async () => {
    const h = harness((c) => c.emit("close", 0));
    await runDocker(ARGS, { name: NAME, timeoutMs: 1000, deps: h.deps });
    expect(h.calls[0].bin).toBe("/usr/bin/docker");
    expect(h.calls[0].args).toEqual(ARGS);
    expect(h.calls[0].options).not.toHaveProperty("shell");
  });
});

describe("timeout", () => {
  test("a hanging run is stopped with `docker kill <name>` and reported as timed out", async () => {
    const h = harness(() => {}); // never closes by itself
    const result = await runDocker(ARGS, { name: NAME, timeoutMs: 30, deps: h.deps });
    expect(result).toMatchObject({ kind: "finished", timedOut: true, survived: false, exitCode: 137 });
    expect(kills(h.calls)).toHaveLength(1);
    expect(kills(h.calls)[0].args).toEqual(["kill", NAME]);
    expect(evaluateCheck("test", result as never)).toBe("timed_out");
  });

  test("a run that finishes in time is never killed", async () => {
    const h = harness((c) => setTimeout(() => c.emit("close", 0), 10));
    await runDocker(ARGS, { name: NAME, timeoutMs: 200, deps: h.deps });
    await new Promise((resolve) => setTimeout(resolve, 250)); // past the timeout: the timer must have been cleared
    expect(kills(h.calls)).toHaveLength(0);
  });

  test("if the client ignores docker kill, it is force-killed as a last resort", async () => {
    vi.useFakeTimers();
    try {
      let client: FakeChild | undefined;
      const h = harness((c) => (client = c), false);
      const promise = runDocker(ARGS, { name: NAME, timeoutMs: 100, deps: h.deps });
      await vi.advanceTimersByTimeAsync(100); // timeout fires, docker kill sent
      expect(kills(h.calls)).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(5000);
      expect(client!.kill).toHaveBeenCalledWith("SIGKILL");
      client!.emit("close", 137);
      await expect(promise).resolves.toMatchObject({ timedOut: true });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("survival (start check)", () => {
  test("still running at survivalMs: stopped, reported as survived and not as a timeout", async () => {
    const h = harness(() => {});
    const result = await runDocker(ARGS, { name: NAME, timeoutMs: 1000, survivalMs: 30, deps: h.deps });
    expect(result).toMatchObject({ kind: "finished", survived: true, timedOut: false });
    expect(kills(h.calls)).toHaveLength(1);
    expect(evaluateCheck("start", result as never)).toBe("passed");
  });

  test("exiting non-zero before survivalMs is a failure", async () => {
    const h = harness((c) => setTimeout(() => c.emit("close", 1), 5));
    const result = await runDocker(ARGS, { name: NAME, timeoutMs: 1000, survivalMs: 200, deps: h.deps });
    expect(result).toMatchObject({ survived: false, exitCode: 1 });
    expect(evaluateCheck("start", result as never)).toBe("failed");
  });
});

describe("output cap", () => {
  test("output beyond the limit is dropped and marked", async () => {
    const h = harness((c) => {
      c.stdout.emit("data", Buffer.from("a".repeat(6)));
      c.stdout.emit("data", Buffer.from("b".repeat(6)));
      c.stderr.emit("data", Buffer.from("c".repeat(100)));
      c.emit("close", 0);
    });
    const result = await runDocker(ARGS, { name: NAME, timeoutMs: 1000, maxOutputBytes: 10, deps: h.deps });
    expect(result).toMatchObject({ kind: "finished", truncated: true });
    const output = (result as { output: string }).output;
    expect(output.startsWith("aaaaaabbbb")).toBe(true);
    expect(output).toContain("[output truncated at 10 bytes]");
    expect(output).not.toContain("ccc"); // the stderr flood was dropped
  });

  test("the default cap is 64 KB", async () => {
    const h = harness((c) => {
      c.stdout.emit("data", Buffer.alloc(200 * 1024, "x"));
      c.emit("close", 0);
    });
    const result = (await runDocker(ARGS, { name: NAME, timeoutMs: 1000, deps: h.deps })) as { output: string; truncated: boolean };
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.output)).toBeLessThan(64 * 1024 + 100);
    expect(result.output).toContain("[output truncated at 64 KB]");
  });
});

describe("cancellation", () => {
  test("aborting stops the container and reports aborted", async () => {
    const h = harness(() => {});
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const result = await runDocker(ARGS, { name: NAME, timeoutMs: 5000, signal: controller.signal, deps: h.deps });
    expect(result).toMatchObject({ aborted: true, timedOut: false });
    expect(kills(h.calls)[0].args).toEqual(["kill", NAME]);
  });

  test("a signal that is already aborted stops it immediately", async () => {
    const h = harness(() => {});
    const result = await runDocker(ARGS, { name: NAME, timeoutMs: 5000, signal: AbortSignal.abort(), deps: h.deps });
    expect(result).toMatchObject({ aborted: true });
  });
});

describe("docker itself not usable", () => {
  test("no docker binary found", async () => {
    const result = await runDocker(ARGS, { name: NAME, timeoutMs: 100, deps: { resolveBin: async () => undefined } });
    expect(result).toEqual({ kind: "unavailable", reason: "docker_missing" });
  });

  test("the binary vanishes between lookup and spawn (ENOENT)", async () => {
    const h = harness((c) => c.emit("error", Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" })));
    expect(await runDocker(ARGS, { name: NAME, timeoutMs: 100, deps: h.deps })).toEqual({ kind: "unavailable", reason: "docker_missing" });
  });

  test("spawn throwing synchronously is also unavailable, not a crash", async () => {
    const spawnThrows = (() => {
      throw new Error("EPERM");
    }) as unknown as typeof spawn;
    const result = await runDocker(ARGS, { name: NAME, timeoutMs: 100, deps: { spawn: spawnThrows, resolveBin: async () => "docker" } });
    expect(result).toEqual({ kind: "unavailable", reason: "docker_missing" });
  });

  test("exit 125 with a daemon error means Docker is not running, not that the project failed", async () => {
    const h = harness((c) => {
      c.stderr.emit("data", Buffer.from("docker: Cannot connect to the Docker daemon at unix:///x.sock. Is the docker daemon running?"));
      c.emit("close", 125);
    });
    expect(await runDocker(ARGS, { name: NAME, timeoutMs: 100, deps: h.deps })).toEqual({ kind: "unavailable", reason: "docker_not_running" });
  });

  test("exit 125 for a missing image (pull is disabled) is image_missing", async () => {
    for (const message of ["Unable to find image 'node:lts-slim' locally", "Error response from daemon: No such image: node:lts-slim"]) {
      const h = harness((c) => {
        c.stderr.emit("data", Buffer.from(message));
        c.emit("close", 125);
      });
      expect(await runDocker(ARGS, { name: NAME, timeoutMs: 100, deps: h.deps })).toEqual({ kind: "unavailable", reason: "image_missing" });
    }
  });

  test("exit 125 with an unrecognised message stays a finished run so nothing is hidden", async () => {
    const h = harness((c) => {
      c.stderr.emit("data", Buffer.from("something else"));
      c.emit("close", 125);
    });
    expect(await runDocker(ARGS, { name: NAME, timeoutMs: 100, deps: h.deps })).toMatchObject({ kind: "finished", exitCode: 125 });
  });

  const DOCKER29 = "failed to connect to the docker API at unix:///Users/me/.docker/run/docker.sock; check if the path is correct and if the daemon is running: dial unix /Users/me/.docker/run/docker.sock: connect: no such file or directory\n";

  test("Docker 29 with the daemon unreachable exits 1 with its own message: that is docker_not_running, not the project failing", async () => {
    for (const message of [DOCKER29, `docker: ${DOCKER29}`]) {
      const h = harness((c) => {
        c.stderr.emit("data", Buffer.from(message));
        c.emit("close", 1);
      });
      expect(await runDocker(ARGS, { name: NAME, timeoutMs: 100, deps: h.deps })).toEqual({ kind: "unavailable", reason: "docker_not_running" });
    }
  });

  test("the same words after the project has printed something are still the project's failure", async () => {
    const h = harness((c) => {
      c.stdout.emit("data", Buffer.from("starting tests\n"));
      c.stderr.emit("data", Buffer.from(DOCKER29));
      c.emit("close", 1);
    });
    expect(await runDocker(ARGS, { name: NAME, timeoutMs: 100, deps: h.deps })).toMatchObject({ kind: "finished", exitCode: 1 });
  });

  test("exit 1 with any other message, or exit 2 with the Docker 29 message, is the project's result", async () => {
    for (const [message, code] of [["Error: test failed", 1], [DOCKER29, 2], [DOCKER29, 137]] as const) {
      const h = harness((c) => {
        c.stderr.emit("data", Buffer.from(message));
        c.emit("close", code);
      });
      expect(await runDocker(ARGS, { name: NAME, timeoutMs: 100, deps: h.deps })).toMatchObject({ kind: "finished", exitCode: code });
    }
  });

  test("a project that prints a docker-looking error and exits 1 is still the project's failure", async () => {
    const h = harness((c) => {
      c.stderr.emit("data", Buffer.from("Cannot connect to the Docker daemon"));
      c.emit("close", 1);
    });
    expect(await runDocker(ARGS, { name: NAME, timeoutMs: 100, deps: h.deps })).toMatchObject({ kind: "finished", exitCode: 1 });
  });
});

describe("resolveDockerBin", () => {
  beforeEach(() => resetDockerBin());

  test("tries PATH first, then Docker Desktop's folder, and caches the winner", async () => {
    const tried: string[] = [];
    const exec: Run = async (bin) => {
      tried.push(bin);
      return bin.startsWith("/Applications/Docker.app");
    };
    expect(await resolveDockerBin(exec)).toBe("/Applications/Docker.app/Contents/Resources/bin/docker");
    expect(tried[0]).toBe("docker");
    const before = tried.length;
    await resolveDockerBin(exec);
    expect(tried.length).toBe(before); // cached
  });

  test("a failed lookup is not cached, so installing Docker later works", async () => {
    expect(await resolveDockerBin(async () => false)).toBeUndefined();
    expect(await resolveDockerBin(async () => true)).toBe("docker");
  });
});
