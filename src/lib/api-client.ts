// The browser's one way to talk to the server. Every page uses apiFetch, so session expiry,
// network trouble and the error envelope are handled in one place.

export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number, // 0 when no response arrived
    message: string,
    readonly requestId?: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const SESSION_ENDED_MESSAGE = "Your session ended. Restart Revenant and open the new link from the terminal.";

// ---- "the session ended" is a fact about the whole app, not about one request ----------------------------------
// A 401 flips this flag and the shell shows a banner. The page that made the call keeps its state, so text the
// user was typing (an error log, a folder path) is not lost.
type Listener = () => void;
let ended = false;
const listeners = new Set<Listener>();

export const sessionEnded = {
  get: () => ended,
  subscribe(listener: Listener) {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  },
  mark() {
    if (ended) return;
    ended = true;
    listeners.forEach((listener) => listener());
  },
  reset() {
    ended = false;
    listeners.forEach((listener) => listener());
  },
};

// ---- apiFetch ---------------------------------------------------------------------------------------------------
export type ApiInit = Omit<RequestInit, "body" | "method"> & {
  method?: "GET" | "POST" | "DELETE";
  /** A plain object is sent as JSON. FormData is sent as is (the browser sets the multipart header). */
  body?: Record<string, unknown> | unknown[] | FormData;
};

const unexpected = (status: number) => new ApiError("BAD_RESPONSE", status, "Revenant sent an unexpected response. Try again.");

/**
 * Calls an `/api/...` route and returns its `data`. Throws ApiError for everything else.
 * Only same-origin API paths are allowed, so the page can never be made to contact another site.
 */
export async function apiFetch<T>(path: string, init: ApiInit = {}): Promise<T> {
  if (!path.startsWith("/api/") || path.startsWith("//")) throw new TypeError("apiFetch only calls /api/ paths");

  const { body, method = "GET", headers, ...rest } = init;
  const isForm = typeof FormData !== "undefined" && body instanceof FormData;
  let response: Response;
  try {
    response = await fetch(path, {
      ...rest,
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json", ...(body !== undefined && !isForm ? { "Content-Type": "application/json" } : {}), ...headers },
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error; // the caller cancelled; not a failure
    throw new ApiError("NETWORK_ERROR", 0, "Can't reach Revenant. Check that it is still running.");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(await response.text());
  } catch {
    payload = undefined; // not JSON: never show the raw body
  }
  const envelope = (typeof payload === "object" && payload !== null ? payload : {}) as {
    data?: unknown;
    error?: { code?: unknown; message?: unknown; requestId?: unknown; fields?: unknown };
  };

  if (!response.ok) {
    if (response.status === 401) sessionEnded.mark();
    const err = envelope.error;
    if (!err || typeof err.code !== "string" || typeof err.message !== "string") {
      throw response.status === 401 ? new ApiError("UNAUTHORIZED", 401, SESSION_ENDED_MESSAGE) : unexpected(response.status);
    }
    throw new ApiError(
      err.code,
      response.status,
      err.message,
      typeof err.requestId === "string" ? err.requestId : undefined,
      typeof err.fields === "object" && err.fields !== null ? (err.fields as Record<string, string>) : undefined,
    );
  }
  if (!("data" in envelope)) throw unexpected(response.status);
  return envelope.data as T;
}
