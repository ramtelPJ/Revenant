import { getEnv } from "@/lib/env";
import { AppError } from "./respond";
import { SESSION_COOKIE, verifySession } from "./session";

const SAFE_METHODS = new Set(["GET", "HEAD"]);

const blocked = (reason: string) => {
  // reason is a fixed label, never a header value
  console.warn(`[guard] blocked request: ${reason}`);
  return new AppError("FORBIDDEN_ORIGIN", 403, "This request was blocked.");
};

function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** Exact Host allowlist (DNS-rebinding defense), shared by guardApi, proxy.ts and /unlock. */
export function isAllowedHost(host: string | null): boolean {
  const port = getEnv().PORT;
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

/**
 * First statement of every API route handler. Throws AppError; use inside `handle()`.
 * Order matters: Host, then Fetch-Metadata/Origin, then content type, then the session,
 * so a rebinding or cross-site request is rejected before its cookie is even looked at.
 *
 * Fetch-Metadata is stricter than "reject cross-site": only same-origin and direct
 * navigation (`none`) are allowed, because another local app on a different port of
 * localhost is "same-site" and `SameSite=Strict` cookies would still be sent to us.
 */
export function guardApi(request: Request, options: { multipart?: boolean } = {}): void {
  const host = request.headers.get("host");
  if (!isAllowedHost(host)) throw blocked("unexpected Host");

  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") throw blocked("Fetch-Metadata not same-origin");

  const origin = request.headers.get("origin");
  if (origin !== null && origin !== `http://${host}`) throw blocked("Origin mismatch");

  if (!SAFE_METHODS.has(request.method)) {
    const hasBody = Number(request.headers.get("content-length") ?? 0) > 0 || request.headers.has("transfer-encoding");
    if (hasBody) {
      const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      const allowed = type === "application/json" || (options.multipart === true && type === "multipart/form-data");
      if (!allowed) {
        throw new AppError("VALIDATION_FAILED", 400, "Request body has an unsupported content type.", {
          "content-type": options.multipart ? "Use application/json or multipart/form-data." : "Use application/json.",
        });
      }
    }
  }

  if (!verifySession(readCookie(request.headers.get("cookie"), SESSION_COOKIE))) {
    throw new AppError(
      "UNAUTHORIZED",
      401,
      "Your session ended. Restart Revenant and open the new link from the terminal.",
    );
  }
}
