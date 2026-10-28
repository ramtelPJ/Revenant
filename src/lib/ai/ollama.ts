import { z } from "zod";
import { getEnv, isLoopbackUrl } from "@/lib/env";
import { AppError } from "@/lib/http/respond";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
export type ChatJsonOptions = {
  temperature?: number;
  /** Defaults to OLLAMA_MODEL. */
  model?: string;
  /** Defaults to OLLAMA_URL. Must be on this machine; it is checked again here. */
  url?: string;
  /** Defaults to AI_TIMEOUT_SEC. */
  timeoutMs?: number;
  /** The model's context window in tokens. */
  numCtx?: number;
  /** Aborting (a user's Cancel) rejects with the AbortError itself, so the job runner can see it. */
  signal?: AbortSignal;
  fetch?: typeof fetch;
};
export type ChatJsonResult<T> = { data: T; model: string; attempts: 1 | 2 };

const DEFAULT_TEMPERATURE = 0.1;
const DEFAULT_NUM_CTX = 8192; // gemma2's limit; Ollama's own default would silently cut a long prompt
const MAX_FEEDBACK_ISSUES = 8;

const unavailable = (message: string) => new AppError("AI_UNAVAILABLE", 503, message);
const badOutput = () => new AppError("AI_BAD_OUTPUT", 502, "The model's answer couldn't be used. Try again.");

/** `z.toJSONSchema` without the `$schema` marker, which Ollama does not need. */
export function toFormat(schema: z.ZodType): Record<string, unknown> {
  const { $schema, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  void $schema;
  return rest;
}

/** Models sometimes wrap JSON in a code fence even when told not to. */
function stripFence(text: string): string {
  const match = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(text);
  return match ? match[1] : text;
}

/** Why an answer was rejected, short enough to hand back to the model. */
function describeProblem(error: z.ZodError | "not-json" | "empty" | "cut-off"): string {
  if (error === "not-json") return "it was not valid JSON";
  if (error === "empty") return "it was empty";
  if (error === "cut-off") return "it was cut off before it finished";
  return error.issues
    .slice(0, MAX_FEEDBACK_ISSUES)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

type Answer = { content: string; cutOff: boolean };

async function ask(url: string, model: string, messages: ChatMessage[], format: Record<string, unknown>, options: ChatJsonOptions, timeoutMs: number): Promise<Answer> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  const doFetch = options.fetch ?? fetch;

  let response: Response;
  try {
    response = await doFetch(`${url.replace(/\/+$/, "")}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        format,
        options: { temperature: options.temperature ?? DEFAULT_TEMPERATURE, num_ctx: options.numCtx ?? DEFAULT_NUM_CTX },
      }),
    });
  } catch (error) {
    if (options.signal?.aborted) throw error; // the user cancelled: not a failure of the AI
    if (timeout.aborted) throw unavailable("The local AI took too long to answer.");
    throw unavailable("The local AI isn't available. Start Ollama and check that the model is installed.");
  }

  if (response.status === 404) throw unavailable(`The model ${model} isn't installed. Run \`ollama pull ${model}\` (needs internet once).`);
  if (!response.ok) throw unavailable("The local AI returned an error.");

  let body: { message?: { content?: unknown }; done_reason?: unknown };
  try {
    body = await response.json();
  } catch {
    throw unavailable("The local AI sent an unexpected response.");
  }
  if (typeof body?.message?.content !== "string") throw unavailable("The local AI sent an unexpected response.");
  return { content: body.message.content, cutOff: body.done_reason === "length" };
}

/**
 * Asks the local model for JSON that matches `schema` and returns it parsed and typed.
 * One retry is allowed, and only when the model answered but the answer was unusable: it is shown what was wrong.
 * Not reachable, slow, or missing the model → AI_UNAVAILABLE (never retried). Unusable twice → AI_BAD_OUTPUT.
 * Prompts and answers are never logged.
 */
export async function chatJson<T extends z.ZodType>(schema: T, messages: ChatMessage[], options: ChatJsonOptions = {}): Promise<ChatJsonResult<z.infer<T>>> {
  const url = options.url ?? getEnv().OLLAMA_URL;
  const model = options.model ?? getEnv().OLLAMA_MODEL;
  const timeoutMs = options.timeoutMs ?? getEnv().AI_TIMEOUT_SEC * 1000;
  // project code only ever goes to this machine
  if (!isLoopbackUrl(url)) throw unavailable("The AI address must be on this machine.");

  const format = toFormat(schema);
  const conversation = [...messages];

  for (const attempt of [1, 2] as const) {
    const { content, cutOff } = await ask(url, model, conversation, format, options, timeoutMs);

    let problem: z.ZodError | "not-json" | "empty" | "cut-off";
    if (cutOff) problem = "cut-off";
    else if (content.trim() === "") problem = "empty";
    else {
      let value: unknown;
      try {
        value = JSON.parse(stripFence(content));
      } catch {
        value = undefined;
      }
      if (value === undefined) problem = "not-json";
      else {
        const parsed = schema.safeParse(value);
        if (parsed.success) return { data: parsed.data, model, attempts: attempt };
        problem = parsed.error;
      }
    }

    if (attempt === 2) throw badOutput();
    conversation.push(
      { role: "assistant", content: content.slice(0, 4000) },
      { role: "user", content: `Your answer could not be used: ${describeProblem(problem)}. Answer again with only JSON that matches the required schema.` },
    );
  }
  throw badOutput(); // unreachable; keeps the types honest
}
