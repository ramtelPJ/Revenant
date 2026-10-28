import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { HealthBannerView, SessionBannerView } from "@/components/health-banner";
import { InlineText } from "@/components/inline-text";
import { JobProgressView } from "@/components/job-progress";
import { SESSION_ENDED_MESSAGE, ApiError } from "@/lib/api-client";
import { START_DOCKER_FIX, START_OLLAMA_FIX, pullImageFix, pullModelFix } from "@/lib/fixes";
import { healthProblems, showsBanners, splitInlineCode, type Health } from "@/lib/health-problems";
import type { JobView } from "@/lib/polling";

const healthy: Health = {
  ollama: { reachable: true, modelInstalled: true, model: "gemma2:2b" },
  docker: { available: true, imagePresent: true, image: "node:lts-slim" },
};
const html = (node: React.ReactElement) => renderToStaticMarkup(node);

describe("healthProblems", () => {
  test("nothing is wrong when both are ready", () => expect(healthProblems(healthy)).toEqual([]));

  test("Ollama not running", () => {
    const [p, ...rest] = healthProblems({ ...healthy, ollama: { reachable: false, modelInstalled: false, model: "gemma2:2b" } });
    expect(rest).toEqual([]); // one problem, not "not running" plus "no model"
    expect(p).toMatchObject({ id: "ollama", fix: START_OLLAMA_FIX });
    expect(p.consequence).toContain("unavailable");
  });

  test("model missing names the exact model", () => {
    const [p] = healthProblems({ ...healthy, ollama: { reachable: true, modelInstalled: false, model: "qwen2.5-coder:3b" } });
    expect(p).toMatchObject({ id: "model", title: "The model qwen2.5-coder:3b is not installed", fix: pullModelFix("qwen2.5-coder:3b") });
  });

  test("Docker not available, and image missing names the exact image", () => {
    expect(healthProblems({ ...healthy, docker: { available: false, imagePresent: false, image: "node:lts-slim" } })).toMatchObject([{ id: "docker", fix: START_DOCKER_FIX }]);
    const [p] = healthProblems({ ...healthy, docker: { available: true, imagePresent: false, image: "node:22-slim" } });
    expect(p).toMatchObject({ id: "image", title: "The sandbox image node:22-slim is not installed", fix: pullImageFix("node:22-slim") });
    expect(p.consequence).toContain("Unverified");
  });

  test("Ollama and Docker problems are reported together", () => {
    const problems = healthProblems({ ollama: { reachable: false, modelInstalled: false, model: "m" }, docker: { available: false, imagePresent: false, image: "i" } });
    expect(problems.map((p) => p.id)).toEqual(["ollama", "docker"]);
  });

  test("the fixes are the very same text the setup-check script prints", async () => {
    const { runSetupChecks } = await import("@/lib/setup-check");
    const results = await runSetupChecks({
      env: { OLLAMA_MODEL: "gemma2:2b" },
      cwd: "/nonexistent",
      checkOllama: async (_u, model) => ({ reachable: false, modelInstalled: false, model }),
      checkDocker: async (image) => ({ available: true, imagePresent: false, image }),
      dockerBin: async () => "docker",
    });
    expect(results.find((r) => r.id === "ollama")!.fix).toBe(START_OLLAMA_FIX);
    expect(results.find((r) => r.id === "image")!.fix).toBe(pullImageFix("node:lts-slim"));
  });
});

describe("HealthBannerView", () => {
  test("renders nothing before the answer arrives, and nothing when everything is ready", () => {
    expect(html(<HealthBannerView health={null} />)).toBe("");
    expect(html(<HealthBannerView health={healthy} />)).toBe("");
  });

  test("lists the specific missing item with its consequence and its fix, the command shown as code", () => {
    const out = html(<HealthBannerView health={{ ...healthy, ollama: { reachable: true, modelInstalled: false, model: "gemma2:2b" } }} />);
    expect(out).toContain("One thing needs attention");
    expect(out).toContain("The model gemma2:2b is not installed");
    expect(out).toContain("To fix:");
    expect(out).toMatch(/<code[^>]*>ollama pull gemma2:2b<\/code>/);
    expect(out).toContain('role="status"');
  });

  test("several problems are counted and each is listed", () => {
    const out = html(<HealthBannerView health={{ ollama: { reachable: false, modelInstalled: false, model: "m" }, docker: { available: false, imagePresent: false, image: "i" } }} />);
    expect(out).toContain("2 things need attention");
    expect(out).toContain("The local AI (Ollama) is not running");
    expect(out).toContain("Docker is not available");
    expect((out.match(/<li/g) ?? []).length).toBe(2);
  });

  test("the Check again button only exists when there is something to do with it", () => {
    const broken = { ...healthy, docker: { available: false, imagePresent: false, image: "i" } };
    expect(html(<HealthBannerView health={broken} onRecheck={() => {}} />)).toContain("Check again");
    expect(html(<HealthBannerView health={broken} />)).not.toContain("Check again");
  });

  test("names from the server are text, never markup", () => {
    const out = html(<HealthBannerView health={{ ...healthy, ollama: { reachable: true, modelInstalled: false, model: "<script>alert(1)</script>" } }} />);
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
    const img = html(<HealthBannerView health={{ ...healthy, docker: { available: true, imagePresent: false, image: '"><img src=x onerror=alert(1)>' } }} />);
    expect(img).not.toContain("<img");
  });
});

describe("SessionBannerView", () => {
  test("says the session ended and how to get back in", () => {
    const out = html(<SessionBannerView />);
    expect(out).toContain('role="alert"');
    expect(out).toContain("Session ended");
    expect(out).toContain(SESSION_ENDED_MESSAGE);
  });
});

const job = (status: JobView["status"], extra: Partial<JobView> = {}): JobView => ({
  id: "j", caseId: "c", kind: "diagnose", status, progressNote: null, steps: [], errorCode: null, errorMessage: null, createdAt: 1, startedAt: 1, finishedAt: null, ...extra,
});

describe("JobProgressView", () => {
  test("before the first answer", () => expect(html(<JobProgressView job={null} />)).toContain("Starting…"));

  test("if the job cannot be followed, say so", () => {
    const out = html(<JobProgressView job={null} error={new ApiError("NOT_FOUND", 404, "We couldn't find that.")} />);
    expect(out).toContain('role="alert"');
    expect(out).toContain("Can&#x27;t follow this step");
    expect(out).toContain("We couldn&#x27;t find that.");
  });

  test.each([
    ["queued", "Waiting"], ["running", "Working"], ["succeeded", "Done"], ["failed", "Failed"], ["cancelled", "Cancelled"],
  ] as const)("%s is labelled %s", (status, label) => expect(html(<JobProgressView job={job(status)} />)).toContain(label));

  test("every step shows a symbol AND a word, in order", () => {
    const out = html(
      <JobProgressView
        job={job("running", { steps: [{ label: "Preparing", state: "done" }, { label: "Running the check", state: "running" }, { label: "Recording", state: "pending" }, { label: "Oops", state: "failed" }] })}
      />,
    );
    const order = ["Preparing", "Running the check", "Recording", "Oops"].map((label) => out.indexOf(label));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    for (const word of ["done", "in progress", "waiting", "failed"]) expect(out).toContain(`: ${word}`);
    for (const symbol of ["✓", "●", "○", "✗"]) expect(out).toContain(symbol);
    expect(out).toContain('aria-hidden="true"'); // the symbol is decoration; the word carries the meaning
  });

  test("Cancel is offered only while the job is active", () => {
    for (const status of ["queued", "running"] as const) expect(html(<JobProgressView job={job(status)} onCancel={() => {}} />)).toContain(">Cancel<");
    for (const status of ["succeeded", "failed", "cancelled"] as const) expect(html(<JobProgressView job={job(status)} onCancel={() => {}} />)).not.toContain("Cancel</button>");
    expect(html(<JobProgressView job={job("running")} />)).not.toContain("Cancel</button>"); // no handler, no button
  });

  test("while cancelling the button says so and is disabled", () => {
    const out = html(<JobProgressView job={job("running")} onCancel={() => {}} cancelling />);
    expect(out).toContain("Cancelling…");
    expect(out).toMatch(/<button[^>]*disabled/);
  });

  test("the note and a failure message are shown; a failure message only when the job failed", () => {
    expect(html(<JobProgressView job={job("succeeded", { progressNote: "The check passed. No failure was found." })} />)).toContain("The check passed. No failure was found.");
    const failed = html(<JobProgressView job={job("failed", { errorMessage: "The local AI isn't available." })} />);
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("The local AI isn&#x27;t available.");
    expect(html(<JobProgressView job={job("succeeded", { errorMessage: "stale" })} />)).not.toContain("stale");
  });

  test("everything the server sends is text, never markup", () => {
    const out = html(<JobProgressView job={job("failed", { progressNote: "<img src=x onerror=alert(1)>", errorMessage: "<script>x</script>", steps: [{ label: "<b>bold</b>", state: "done" }] })} />);
    expect(out).not.toMatch(/<img|<script|<b>/);
    expect(out).toContain("&lt;img");
  });

  test("a polling problem is shown without hiding the last known state", () => {
    const out = html(<JobProgressView job={job("running", { progressNote: "Working on it" })} error={new ApiError("NETWORK_ERROR", 0, "Lost contact with Revenant.")} />);
    expect(out).toContain("Working on it");
    expect(out).toContain("Lost contact with Revenant.");
  });
});

describe("InlineText", () => {
  test("backticked parts become code, the rest stays plain, nothing becomes HTML", () => {
    expect(splitInlineCode("Run `ollama pull x` now")).toEqual([{ text: "Run ", code: false }, { text: "ollama pull x", code: true }, { text: " now", code: false }]);
    expect(splitInlineCode("no code here")).toEqual([{ text: "no code here", code: false }]);
    expect(splitInlineCode("")).toEqual([]);
    expect(splitInlineCode("`only`")).toEqual([{ text: "only", code: true }]);
    expect(html(<InlineText text="a `<b>x</b>` b" />)).not.toContain("<b>");
  });

  test("an unmatched backtick does not break rendering", () => {
    expect(() => html(<InlineText text="oops `never closed" />)).not.toThrow();
  });
});

describe("the shell", () => {
  test("banners are hidden on the locked page and shown everywhere else", () => {
    expect(showsBanners("/locked")).toBe(false);
    for (const p of ["/", "/cases/new", "/cases/abc/report", null]) expect(showsBanners(p), String(p)).toBe(true);
  });
});

describe("rules for all UI code", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      return statSync(full).isDirectory() ? files(full) : [full];
    });
  const ui = [...files("src/app"), ...files("src/components")].filter((f) => /\.(tsx?|css)$/.test(f));

  test("dangerouslySetInnerHTML is never used anywhere in src", () => {
    const offenders = files("src").filter((f) => /\.tsx?$/.test(f) && readFileSync(f, "utf8").includes("dangerouslySetInnerHTML"));
    expect(offenders).toEqual([]);
  });

  test("the UI loads nothing from the internet: no remote URLs, fonts, scripts or imports", () => {
    const remote = /(?:https?:)?\/\/(?!127\.0\.0\.1|localhost)[a-z0-9-]+\.[a-z]{2,}/i;
    const offenders = ui.filter((f) => remote.test(readFileSync(f, "utf8").replace(/\/\/.*$/gm, ""))); // ignore code comments
    expect(offenders).toEqual([]);
    expect(readFileSync("src/app/globals.css", "utf8")).not.toMatch(/@import url|fonts\.googleapis|url\(\s*["']?https?:/i);
  });

  test("components use only the named theme colours, so the design can be swapped in one file", () => {
    const hardCoded = ui.filter((f) => f.endsWith(".tsx") && /(?:bg|text|border)-\[#|#[0-9a-f]{6}\b/i.test(readFileSync(f, "utf8")));
    expect(hardCoded).toEqual([]);
  });
});
