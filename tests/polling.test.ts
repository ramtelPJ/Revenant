import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ApiError } from "@/lib/api-client";
import { isFinished, startPolling, type JobView } from "@/lib/polling";

const job = (status: JobView["status"], extra: Partial<JobView> = {}): JobView => ({
  id: "j", caseId: "c", kind: "diagnose", status, progressNote: null, steps: [], errorCode: null, errorMessage: null, createdAt: 1, startedAt: null, finishedAt: null, ...extra,
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** Lets queued promise callbacks run (fake timers do not advance microtasks by themselves). */
const flush = () => vi.advanceTimersByTimeAsync(0);

function run(answers: (JobView | Error | (() => Promise<JobView>))[], options: { intervalMs?: number; maxConsecutiveErrors?: number } = {}) {
  let call = 0;
  const signals: AbortSignal[] = [];
  const onUpdate = vi.fn();
  const onFinished = vi.fn();
  const onError = vi.fn();
  const fetchJob = vi.fn(async (signal: AbortSignal) => {
    signals.push(signal);
    const next = answers[Math.min(call++, answers.length - 1)];
    if (typeof next === "function") return next();
    if (next instanceof Error) throw next;
    return next;
  });
  const stop = startPolling({ fetchJob, onUpdate, onFinished, onError, intervalMs: 1500, ...options });
  return { stop, fetchJob, onUpdate, onFinished, onError, signals };
}

describe("a normal job", () => {
  test("asks at once, then every interval, and stops after the job finishes", async () => {
    const p = run([job("queued"), job("running"), job("running"), job("succeeded")]);
    await flush();
    expect(p.fetchJob).toHaveBeenCalledTimes(1); // right away, not after the first interval

    await vi.advanceTimersByTimeAsync(1500);
    expect(p.fetchJob).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1500);
    await vi.advanceTimersByTimeAsync(1500);
    expect(p.fetchJob).toHaveBeenCalledTimes(4);
    expect(p.onUpdate.mock.calls.map((c) => c[0].status)).toEqual(["queued", "running", "running", "succeeded"]);
    expect(p.onFinished).toHaveBeenCalledTimes(1);
    expect(p.onFinished.mock.calls[0][0].status).toBe("succeeded");

    await vi.advanceTimersByTimeAsync(60_000); // nothing more is ever requested
    expect(p.fetchJob).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  test.each(["succeeded", "failed", "cancelled"] as const)("%s ends polling", async (status) => {
    const p = run([job(status)]);
    await flush();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(p.fetchJob).toHaveBeenCalledTimes(1);
    expect(p.onFinished).toHaveBeenCalledTimes(1);
  });

  test("isFinished", () => {
    expect(["queued", "running"].map((s) => isFinished(job(s as JobView["status"])))).toEqual([false, false]);
    expect(["succeeded", "failed", "cancelled"].map((s) => isFinished(job(s as JobView["status"])))).toEqual([true, true, true]);
  });

  test("uses the interval it is given", async () => {
    const p = run([job("running")], { intervalMs: 200 });
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(p.fetchJob.mock.calls.length).toBe(6); // 1 immediately + 5 more in 1000 ms
    p.stop();
  });
});

describe("stop()", () => {
  test("cancels the timer: no further requests and no further updates", async () => {
    const p = run([job("running")]);
    await flush();
    p.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(p.fetchJob).toHaveBeenCalledTimes(1);
    expect(p.onUpdate).toHaveBeenCalledTimes(1);
  });

  test("aborts the request in flight and ignores its late answer", async () => {
    let release!: (j: JobView) => void;
    const p = run([() => new Promise<JobView>((resolve) => (release = resolve))]);
    await flush();
    expect(p.signals[0].aborted).toBe(false);

    p.stop();
    expect(p.signals[0].aborted).toBe(true);
    release(job("succeeded")); // arrives after the component went away
    await flush();
    expect(p.onUpdate).not.toHaveBeenCalled();
    expect(p.onFinished).not.toHaveBeenCalled();
    expect(p.onError).not.toHaveBeenCalled();
  });

  test("an error that arrives after stop() is ignored", async () => {
    let fail!: (e: Error) => void;
    const p = run([() => new Promise<JobView>((_, reject) => (fail = reject))]);
    await flush();
    p.stop();
    fail(new ApiError("NETWORK_ERROR", 0, "x"));
    await flush();
    expect(p.onError).not.toHaveBeenCalled();
  });

  test("calling stop() twice, or after the job finished, is harmless", async () => {
    const p = run([job("succeeded")]);
    await flush();
    p.stop();
    p.stop();
    expect(p.onFinished).toHaveBeenCalledTimes(1);
  });
});

describe("one request at a time", () => {
  test("a slow answer delays the next request instead of overlapping it", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const slow = async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5000)); // slower than the interval
      inFlight--;
      return job("running");
    };
    const p = run([slow]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(maxInFlight).toBe(1);
    expect(p.fetchJob.mock.calls.length).toBeGreaterThanOrEqual(2);
    p.stop();
  });
});

describe("errors", () => {
  test.each([401, 403, 404])("a %s stops polling at once and is reported", async (status) => {
    const error = new ApiError("X", status, "no");
    const p = run([error]);
    await flush();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(p.fetchJob).toHaveBeenCalledTimes(1);
    expect(p.onError).toHaveBeenCalledTimes(1);
    expect(p.onError).toHaveBeenCalledWith(error);
  });

  test("a few network blips are tolerated and polling carries on", async () => {
    const blip = new ApiError("NETWORK_ERROR", 0, "x");
    const p = run([job("running"), blip, blip, job("running"), job("succeeded")]);
    await vi.advanceTimersByTimeAsync(1500 * 5);
    expect(p.onError).not.toHaveBeenCalled();
    expect(p.onFinished).toHaveBeenCalledTimes(1);
  });

  test("the error counter resets after a success: blips spread out never add up", async () => {
    const blip = new ApiError("NETWORK_ERROR", 0, "x");
    const p = run([blip, blip, job("running"), blip, blip, job("running"), blip, blip, job("succeeded")], { maxConsecutiveErrors: 3 });
    await vi.advanceTimersByTimeAsync(1500 * 10);
    expect(p.onError).not.toHaveBeenCalled();
    expect(p.onFinished).toHaveBeenCalledTimes(1);
  });

  test("too many failures in a row give up, once", async () => {
    const blip = new ApiError("NETWORK_ERROR", 0, "x");
    const p = run([blip], { maxConsecutiveErrors: 3 });
    await vi.advanceTimersByTimeAsync(1500 * 10);
    expect(p.fetchJob).toHaveBeenCalledTimes(3);
    expect(p.onError).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("a 500 is treated like a network blip, not fatal", async () => {
    const p = run([new ApiError("INTERNAL", 500, "x"), job("succeeded")]);
    await vi.advanceTimersByTimeAsync(1500 * 3);
    expect(p.onError).not.toHaveBeenCalled();
    expect(p.onFinished).toHaveBeenCalledTimes(1);
  });
});
