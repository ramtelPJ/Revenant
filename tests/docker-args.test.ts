import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { buildDockerArgs, containerName, type DockerRunSpec } from "@/lib/sandbox/docker";
import { CHECK_KINDS, CHECKS } from "@/lib/sandbox/checks";

const spec = (over: Partial<DockerRunSpec> = {}): DockerRunSpec => {
  const runId = randomUUID();
  return { runId, folder: `/data/runs/${runId}`, kind: "test", image: "node:lts-slim", memoryMb: 512, cpus: 1, ...over };
};

const pair = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe("fixed flag set", () => {
  test.each(CHECK_KINDS)("every required isolation flag is present for %s", (kind) => {
    const s = spec({ kind });
    const args = buildDockerArgs(s);

    expect(args[0]).toBe("run");
    for (const flag of ["--rm", "--pull=never", "--read-only"]) expect(args).toContain(flag);
    expect(pair(args, "--network")).toBe("none");
    expect(pair(args, "--memory")).toBe("512m");
    expect(pair(args, "--memory-swap")).toBe("512m");
    expect(pair(args, "--cpus")).toBe("1");
    expect(pair(args, "--pids-limit")).toBe("256");
    expect(pair(args, "--cap-drop")).toBe("ALL");
    expect(pair(args, "--security-opt")).toBe("no-new-privileges");
    expect(pair(args, "--tmpfs")).toBe("/tmp:rw,size=64m");
    expect(pair(args, "--user")).toBe("node");
    expect(pair(args, "-w")).toBe("/app");
    expect(pair(args, "-e")).toBe("CI=true");
    expect(pair(args, "--name")).toBe(containerName(s.runId));
  });

  test("image and the check command come last, in that order", () => {
    for (const kind of CHECK_KINDS) {
      const args = buildDockerArgs(spec({ kind }));
      expect(args.slice(-1 - CHECKS[kind].command.length)).toEqual(["node:lts-slim", ...CHECKS[kind].command]);
    }
  });

  test("exactly one volume: the temporary copy, mounted at /app", () => {
    const s = spec();
    const args = buildDockerArgs(s);
    expect(args.filter((a) => a === "-v")).toHaveLength(1);
    expect(pair(args, "-v")).toBe(`${s.folder}:/app:rw`);
  });

  test("no flag that widens access ever appears", () => {
    const forbidden = [
      "--privileged", "--network=host", "host", "--pid", "--ipc", "--uts", "--cap-add", "--device", "-p", "--publish",
      "-P", "--volumes-from", "--mount", "--security-opt=seccomp=unconfined", "--add-host", "--env-file", "--userns",
    ];
    for (const kind of CHECK_KINDS) {
      const args = buildDockerArgs(spec({ kind }));
      for (const flag of forbidden) expect(args, flag).not.toContain(flag);
      expect(args.join(" ")).not.toMatch(/docker\.sock|--user root|--user 0\b|apparmor=unconfined/);
    }
  });
});

describe("only ids, the folder, the image and numeric limits are interpolated", () => {
  test("changing the limits and image changes only those arguments", () => {
    const base = spec({ memoryMb: 512, cpus: 1, image: "node:lts-slim" });
    const a = buildDockerArgs(base);
    const b = buildDockerArgs({ ...base, memoryMb: 1024, cpus: 2, image: "node:22-slim" });
    expect(b.length).toBe(a.length);
    // the token before each changed argument names what it is
    const changedAfter = a.flatMap((value, i) => (value === b[i] ? [] : [a[i - 1]]));
    expect(changedAfter.sort()).toEqual(["--cpus", "--memory", "--memory-swap", "CI=true"].sort()); // CI=true precedes the image
  });

  test("random project names and paths cannot reach the command line", () => {
    for (let i = 0; i < 200; i++) {
      const hostile = `proj-${i}-${Math.random().toString(36).slice(2)}; rm -rf / --privileged -v /:/host`;
      const s = spec();
      // extra properties (as if a caller passed project data along) must be ignored entirely
      const args = buildDockerArgs({ ...s, projectName: hostile, command: hostile, args: [hostile], env: { X: hostile } } as DockerRunSpec);
      expect(args).toEqual(buildDockerArgs(s));
      expect(args.join("\n")).not.toMatch(/rm -rf|proj-|\/host/);
    }
  });

  test("output depends only on the validated fields", () => {
    const s = spec();
    expect(buildDockerArgs({ ...s, extra: "x" } as DockerRunSpec)).toEqual(buildDockerArgs(s));
  });
});

describe("invalid input is refused, not sanitized", () => {
  const bad = (over: Record<string, unknown>) => () => buildDockerArgs(spec(over as Partial<DockerRunSpec>));

  test("run id must be a lowercase uuid", () => {
    for (const runId of ["", "abc", "../x", "--privileged", "x y", `${randomUUID()};ls`, randomUUID().toUpperCase(), `${randomUUID()}\n`, 5]) {
      expect(bad({ runId }), String(runId)).toThrow(RangeError);
    }
  });

  test("folder must be absolute and free of mount-syntax characters", () => {
    for (const folder of ["", "relative/path", "./x", "/a:/etc", "/a,b", "/a\nb", "/a\0b", "C:\\x", undefined]) {
      expect(bad({ folder }), String(folder)).toThrow(RangeError);
    }
    expect(bad({ folder: "/Users/me/my project/data/runs/x" })).not.toThrow(); // spaces are fine in an argument array
  });

  test("check kind must be allowlisted", () => {
    for (const kind of ["lint", "", "TEST", "__proto__", "toString", undefined, "test; id"]) {
      expect(bad({ kind }), String(kind)).toThrow(RangeError);
    }
  });

  test("image must be a plain image reference and can never look like a flag", () => {
    for (const image of ["", "--privileged", "-v", "node lts", "node;id", "$(id)", "`id`", "node\nslim", undefined]) {
      expect(bad({ image }), String(image)).toThrow(RangeError);
    }
    for (const ok of ["node:lts-slim", "node:22-slim", "registry.example.com:5000/team/node:1.0", "node@sha256:" + "a".repeat(64)]) {
      expect(bad({ image: ok }), ok).not.toThrow();
    }
  });

  test("memory and cpu limits must be integers inside their bounds", () => {
    for (const memoryMb of [0, 63, 4097, -1, 1.5, NaN, Infinity, 1e9, "512", undefined]) expect(bad({ memoryMb }), String(memoryMb)).toThrow(RangeError);
    for (const cpus of [0, 5, -1, 0.5, 1.5, NaN, "1", undefined]) expect(bad({ cpus }), String(cpus)).toThrow(RangeError);
    expect(bad({ memoryMb: 64, cpus: 4 })).not.toThrow();
    expect(bad({ memoryMb: 4096, cpus: 1 })).not.toThrow();
  });
});

describe("docker is only spawned from lib/sandbox/docker.ts", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      return statSync(full).isDirectory() ? files(full) : [full];
    });

  test("no other file under src imports child_process", () => {
    const offenders = files("src")
      .filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith(path.join("sandbox", "docker.ts")))
      .filter((f) => /child_process/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  test("docker.ts imports only spawn from child_process and never asks for a shell", () => {
    const source = readFileSync("src/lib/sandbox/docker.ts", "utf8");
    const imported = [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*"node:child_process"/g)]
      .flatMap((m) => m[1].split(","))
      .map((name) => name.trim().replace(/^type\s+/, ""))
      .filter(Boolean);
    expect(imported.sort()).toEqual(["ChildProcess", "spawn"]);
    expect(source).not.toMatch(/shell\s*:\s*(true|"|')/);
  });
});
