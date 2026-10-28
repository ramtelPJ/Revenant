import type { z } from "zod";
import { AppError } from "./respond";

const MAX_JSON_CHARS = 100_000;

/** Reads a JSON request body and validates it. `maxChars` is the size of the whole body, for routes whose own field limit is larger. Malformed JSON is the caller's mistake (400), not a 500. */
export async function readJson<T extends z.ZodType>(request: Request, schema: T, maxChars = MAX_JSON_CHARS): Promise<z.infer<T>> {
  const text = await request.text();
  if (text.length > maxChars) throw new AppError("TOO_LARGE", 413, "The request is too large.");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new AppError("VALIDATION_FAILED", 400, "Request body must be valid JSON.", { body: "Send valid JSON." });
  }
  return schema.parse(value); // a ZodError becomes 400 VALIDATION_FAILED with per-field messages in handle()
}
