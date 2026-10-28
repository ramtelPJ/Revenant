import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { chatJson, toFormat, type ChatMessage } from "@/lib/ai/ollama";
import { AppError } from "@/lib/http/respond";

type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> };
type Handler = (n: number, res: http.ServerResponse, seen: Seen) => void;

let server: http.Server;
let url: string;
let seen: Seen[] = [];
let handler: Handler = () => {};

const reply = (res: http.ServerResponse, content: string, extra: Record<string, unknown> = {}) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ model: "m", message: { role: "assistant", content }, done: true, done_reason: "stop", ...extra }));
};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const entry: Seen = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: raw ? JSON.parse(raw) : {} };
      seen.push(entry);
      handler(seen.length, res, entry);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});
beforeEach(() => {
  seen = [];
  handler = (_n, res) => reply(res, "{}");
});
afterEach(() => vi.restoreAllMocks());

const schema = z.object({ title: z.string().min(1), count: z.number().int(), tags: z.array(z.string()).max(3) });
const good = { title: "hello", count: 2, tags: ["a"] };
const messages: ChatMessage[] = [{ role: "system", content: "You answer in JSON." }, { role: "user", content: "Summarise." }];
const opts = { url: undefined as unknown as string, model: "gemma2:2b", timeoutMs: 2000 };
const run = (over: Record<string, unknown> = {}, msgs = messages) => chatJson(schema, msgs, { ...opts, url, ...over });

const failure = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
};
const code = (error: unknown) => (error instanceof AppError ? `${error.status} ${error.code}` : String(error));

describe("a good answer", () => {
  test("returns typed, parsed data with the model and the attempt count", async () => {
    handler = (_n, res) => reply(res, JSON.stringify(good));
    const result = await run();
    expect(result).toEqual({ data: good, model: "gemma2:2b", attempts: 1 });
    expect(seen).toHaveLength(1);
  });

  test("sends exactly what Ollama needs: POST /api/chat, JSON, no streaming, the schema as `format`, the messages, temperature and context", async () => {
    handler = (_n, res) => reply(res, JSON.stringify(good));
    await run();
    const [request] = seen;
    expect(request.method).toBe("POST");
    expect(request.url).toBe("/api/chat");
    expect(request.headers["content-type"]).toBe("application/json");
    expect(request.body).toMatchObject({ model: "gemma2:2b", stream: false, messages, options: { temperature: 0.1, num_ctx: 8192 } });
    expect(request.body.format).toMatchObject({ type: "object", required: ["title", "count", "tags"] });
    expect(request.body.format).not.toHaveProperty("$schema");
  });

  test("temperature and context size can be set", async () => {
    handler = (_n, res) => reply(res, JSON.stringify(good));
    await run({ temperature: 0.4, numCtx: 4096 });
    expect(seen[0].body.options).toEqual({ temperature: 0.4, num_ctx: 4096 });
  });

  test("a trailing slash on the address is fine", async () => {
    handler = (_n, res) => reply(res, JSON.stringify(good));
    await run({ url: `${url}///` });
    expect(seen[0].url).toBe("/api/chat");
  });

  test("a code fence around the JSON is tolerated", async () => {
    handler = (_n, res) => reply(res, "```json\n" + JSON.stringify(good) + "\n```");
    expect((await run()).data).toEqual(good);
  });

  test("the caller's message list is not changed", async () => {
    handler = (n, res) => reply(res, n === 1 ? "nope" : JSON.stringify(good));
    const original = structuredClone(messages);
    await run();
    expect(messages).toEqual(original);
  });

  test("unknown fields in the answer are dropped, not trusted", async () => {
    handler = (_n, res) => reply(res, JSON.stringify({ ...good, label: "confirmed_by_check", extra: { x: 1 } }));
    expect((await run()).data).toEqual(good);
  });
});

describe("one retry for an unusable answer", () => {
  test("not JSON, then valid: a second request that shows the model what was wrong", async () => {
    handler = (n, res) => reply(res, n === 1 ? "Sure! Here is the summary: it is great." : JSON.stringify(good));
    const result = await run();
    expect(result).toMatchObject({ data: good, attempts: 2 });
    expect(seen).toHaveLength(2);
    const second = seen[1].body.messages as ChatMessage[];
    expect(second.slice(0, 2)).toEqual(messages);
    expect(second[2]).toEqual({ role: "assistant", content: "Sure! Here is the summary: it is great." });
    expect(second[3].role).toBe("user");
    expect(second[3].content).toContain("it was not valid JSON");
  });

  test("valid JSON of the wrong shape, then valid: the feedback names the fields that were wrong", async () => {
    handler = (n, res) => reply(res, n === 1 ? JSON.stringify({ title: "", count: "two", tags: ["a", "b", "c", "d"] }) : JSON.stringify(good));
    expect((await run()).attempts).toBe(2);
    const feedback = (seen[1].body.messages as ChatMessage[])[3].content;
    expect(feedback).toMatch(/title/);
    expect(feedback).toMatch(/count/);
    expect(feedback).toMatch(/tags/);
  });

  test("an empty answer and a cut-off answer both count as unusable", async () => {
    for (const first of [(res: http.ServerResponse) => reply(res, "  "), (res: http.ServerResponse) => reply(res, '{"title":"hel', { done_reason: "length" })]) {
      seen = [];
      handler = (n, res) => (n === 1 ? first(res) : reply(res, JSON.stringify(good)));
      expect(await run()).toMatchObject({ data: good, attempts: 2 });
    }
    expect((seen[1].body.messages as ChatMessage[])[3].content).toContain("cut off");
  });

  test("a cut-off answer is rejected even if the partial text happens to be valid JSON", async () => {
    handler = (n, res) => reply(res, JSON.stringify(good), n === 1 ? { done_reason: "length" } : {});
    expect((await run()).attempts).toBe(2);
  });

  test("unusable twice: AI_BAD_OUTPUT, after exactly two requests, with a safe message", async () => {
    handler = (_n, res) => reply(res, "still not json <script>secret</script>");
    const error = await failure(run());
    expect(code(error)).toBe("502 AI_BAD_OUTPUT");
    expect((error as AppError).message).toBe("The model's answer couldn't be used. Try again.");
    expect(seen).toHaveLength(2);
  });

  test("wrong shape twice is also AI_BAD_OUTPUT", async () => {
    handler = (_n, res) => reply(res, JSON.stringify({ title: 1 }));
    expect(code(await failure(run()))).toBe("502 AI_BAD_OUTPUT");
  });

  test("the feedback is bounded: a huge wrong answer is not echoed back in full", async () => {
    handler = (n, res) => reply(res, n === 1 ? "x".repeat(50_000) : JSON.stringify(good));
    await run();
    const echoed = (seen[1].body.messages as ChatMessage[])[2].content;
    expect(echoed.length).toBeLessThanOrEqual(4000);
  });
});

describe("the AI is not available (never retried)", () => {
  test("nothing listening: AI_UNAVAILABLE with a plain message and a single try", async () => {
    const spy = vi.fn(fetch);
    const error = await failure(run({ url: "http://127.0.0.1:1", fetch: spy }));
    expect(code(error)).toBe("503 AI_UNAVAILABLE");
    expect((error as AppError).message).toBe("The local AI isn't available. Start Ollama and check that the model is installed.");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test("404 means the model is not installed, and the message says how to get it", async () => {
    handler = (_n, res) => {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "model 'nope' not found" }));
    };
    const error = await failure(run({ model: "nope:1b" }));
    expect(code(error)).toBe("503 AI_UNAVAILABLE");
    expect((error as AppError).message).toBe("The model nope:1b isn't installed. Run `ollama pull nope:1b` (needs internet once).");
    expect(seen).toHaveLength(1);
  });

  test("a server error, a body that is not JSON, and a body without a message are all AI_UNAVAILABLE", async () => {
    const cases: Handler[] = [
      (_n, res) => void res.writeHead(500).end("boom"),
      (_n, res) => void res.writeHead(200).end("<html>not json</html>"),
      (_n, res) => void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ done: true })),
      (_n, res) => void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ message: { content: 42 } })),
      (_n, res) => void res.writeHead(200, { "content-type": "application/json" }).end("null"),
    ];
    for (const h of cases) {
      seen = [];
      handler = h;
      expect(code(await failure(run())), String(h)).toBe("503 AI_UNAVAILABLE");
      expect(seen).toHaveLength(1);
    }
  });

  test("a server that never answers times out as AI_UNAVAILABLE, quickly, with one try", async () => {
    handler = () => {}; // never responds
    const started = Date.now();
    const error = await failure(run({ timeoutMs: 250 }));
    expect(code(error)).toBe("503 AI_UNAVAILABLE");
    expect((error as AppError).message).toBe("The local AI took too long to answer.");
    expect(Date.now() - started).toBeLessThan(2500);
    expect(seen).toHaveLength(1);
    server.closeAllConnections();
  });

  test("the error never contains the prompt, the answer, or the address", async () => {
    handler = (_n, res) => void res.writeHead(500).end("secret-answer");
    const secretPrompt: ChatMessage[] = [{ role: "user", content: "TOP-SECRET-SOURCE-CODE" }];
    const error = (await failure(run({}, secretPrompt))) as AppError;
    expect(JSON.stringify({ message: error.message, code: error.code })).not.toMatch(/TOP-SECRET|secret-answer|127\.0\.0\.1/);
  });
});

describe("cancelling", () => {
  test("the caller's abort rejects with the abort itself, not an AI error, and the request is dropped", async () => {
    let closed = false;
    handler = (_n, res) => void res.on("close", () => (closed = true));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const error = await failure(run({ signal: controller.signal, timeoutMs: 5000 }));
    expect(error).not.toBeInstanceOf(AppError);
    expect((error as Error).name).toBe("AbortError");
    await vi.waitFor(() => expect(closed).toBe(true));
  });

  test("a signal that is already aborted never reaches the network", async () => {
    const spy = vi.fn(fetch);
    const error = await failure(run({ signal: AbortSignal.abort(), fetch: spy }));
    expect((error as Error).name).toBe("AbortError");
    expect(seen).toHaveLength(0);
  });
});

describe("only this machine is ever contacted", () => {
  test.each(["http://example.com:11434", "https://127.0.0.1:11434", "http://127.0.0.1.evil.com", "http://10.0.0.5:11434", "http://192.168.1.2:11434", "ftp://127.0.0.1", "not a url", ""])(
    "%s is refused before any request",
    async (bad) => {
      const spy = vi.fn(fetch);
      expect(code(await failure(run({ url: bad, fetch: spy })))).toBe("503 AI_UNAVAILABLE");
      expect(spy).not.toHaveBeenCalled();
    },
  );

  test("the address used is the one given, on loopback (localhost and 127.0.0.1 are accepted)", async () => {
    handler = (_n, res) => reply(res, JSON.stringify(good));
    const calls: string[] = [];
    const recording: typeof fetch = (input, init) => {
      calls.push(String(input));
      return fetch(input, init);
    };
    await run({ fetch: recording });
    expect(calls).toEqual([`${url}/api/chat`]);
    expect(new URL(calls[0]).hostname).toBe("127.0.0.1");
    await run({ url: url.replace("127.0.0.1", "localhost"), fetch: recording });
    expect(new URL(calls[1]).hostname).toBe("localhost");
  });
});

describe("defaults come from the environment", () => {
  test("OLLAMA_URL, OLLAMA_MODEL and AI_TIMEOUT_SEC are used when nothing is passed", async () => {
    vi.stubEnv("REVENANT_LAUNCH_TOKEN", "a".repeat(64));
    vi.stubEnv("REVENANT_SESSION_SECRET", "b".repeat(64));
    vi.stubEnv("OLLAMA_URL", url);
    vi.stubEnv("OLLAMA_MODEL", "env-model:7b");
    vi.stubEnv("AI_TIMEOUT_SEC", "30");
    handler = (_n, res) => reply(res, JSON.stringify(good));
    const result = await chatJson(schema, messages);
    expect(result.model).toBe("env-model:7b");
    expect(seen[0].body.model).toBe("env-model:7b");
    vi.unstubAllEnvs();
  });
});

describe("toFormat", () => {
  test("drops $schema and keeps the structure Ollama constrains the answer with", () => {
    const format = toFormat(schema);
    expect(format).not.toHaveProperty("$schema");
    expect(format).toMatchObject({ type: "object", properties: { title: { type: "string" }, count: { type: "integer" }, tags: { type: "array", maxItems: 3 } } });
  });
});

describe("nothing sensitive is logged", () => {
  test("prompts and answers never reach the console", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    handler = (n, res) => reply(res, n === 1 ? "PRIVATE-MODEL-ANSWER" : JSON.stringify(good));
    await run({}, [{ role: "user", content: "PRIVATE-PROMPT-TEXT" }]);
    handler = (_n, res) => void res.writeHead(500).end();
    await failure(run({}, [{ role: "user", content: "PRIVATE-PROMPT-TEXT" }]));
    expect(spies.flatMap((s) => s.mock.calls).join(" ")).not.toMatch(/PRIVATE/);
  });
});
