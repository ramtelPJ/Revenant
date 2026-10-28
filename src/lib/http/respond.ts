import { randomBytes } from "node:crypto";
import { ZodError } from "zod";

/** An error the user can be told about: a stable code, an HTTP status and a message safe to show. */
export class AppError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

const HEADERS = { "Cache-Control": "no-store" };

export const ok = <T>(data: T, status = 200) => Response.json({ data }, { status, headers: HEADERS });

export const fail = (error: AppError, requestId?: string) =>
  Response.json(
    { error: { code: error.code, message: error.message, ...(requestId ? { requestId } : {}), ...(error.fields ? { fields: error.fields } : {}) } },
    { status: error.status, headers: HEADERS },
  );

const newRequestId = () => `req_${randomBytes(4).toString("hex")}`;

function validationError(error: ZodError): AppError {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "body";
    fields[key] ??= issue.message;
  }
  return new AppError("VALIDATION_FAILED", 400, "Check the highlighted fields and try again.", fields);
}

/**
 * Wraps a route handler so every failure leaves as the same envelope. An unexpected error is a generic 500:
 * its message may hold SQL, paths or file contents, so only its kind is logged, next to the id the user sees.
 */
export function handle<C = unknown>(fn: (request: Request, context: C) => Response | Promise<Response>) {
  return async (request: Request, context: C): Promise<Response> => {
    const requestId = newRequestId();
    try {
      return await fn(request, context);
    } catch (error) {
      if (error instanceof AppError) return fail(error, requestId);
      if (error instanceof ZodError) return fail(validationError(error), requestId);
      console.error(`[${requestId}] INTERNAL ${error instanceof Error ? error.name : typeof error}`);
      return fail(new AppError("INTERNAL", 500, "Something went wrong. Please try again."), requestId);
    }
  };
}
