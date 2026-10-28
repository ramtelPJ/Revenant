import { NextResponse, type NextRequest } from "next/server";
import { isAllowedHost } from "@/lib/http/guard";
import { SESSION_COOKIE, verifySession } from "@/lib/http/session";

// Page gate only. API routes check the session themselves with guardApi (see architecture.md section G).
export function proxy(request: NextRequest) {
  if (!isAllowedHost(request.headers.get("host"))) return new NextResponse("This request was blocked.", { status: 403 });
  if (!verifySession(request.cookies.get(SESSION_COOKIE)?.value)) {
    return NextResponse.redirect(new URL("/locked", request.url));
  }
  return NextResponse.next();
}

export const config = {
  // everything except API routes, Next internals, /unlock and /locked
  matcher: ["/((?!api/|_next/|unlock$|locked$|favicon.ico$).*)"],
};
