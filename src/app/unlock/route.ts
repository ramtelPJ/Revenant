import { isAllowedHost } from "@/lib/http/guard";
import { sessionCookieHeader, signSession } from "@/lib/http/session";
import { tryUnlock } from "@/lib/http/unlock";

const redirect = (location: string, cookie?: string) =>
  new Response(null, {
    status: 302,
    headers: {
      Location: location,
      // the launch token is in this request's URL; keep it out of Referer and caches
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
      ...(cookie ? { "Set-Cookie": cookie } : {}),
    },
  });

// Not under /api: this creates the session, so it cannot require one.
export function GET(request: Request): Response {
  if (!isAllowedHost(request.headers.get("host"))) return new Response("This request was blocked.", { status: 403 });

  const token = new URL(request.url).searchParams.get("token");
  if (!tryUnlock(token)) {
    console.warn("[unlock] rejected"); // never says why, and never logs the token
    return redirect("/locked");
  }
  return redirect("/", sessionCookieHeader(signSession()));
}
