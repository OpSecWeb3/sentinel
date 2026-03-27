import { NextRequest, NextResponse } from "next/server";

/**
 * Server-side route protection middleware.
 *
 * Gates on the presence of the `sentinel.sid` session cookie.
 * The API is responsible for validating the session itself — this
 * middleware only prevents unauthenticated users from receiving
 * server-rendered dashboard pages.
 */

const PUBLIC_PATHS = new Set(["/", "/login", "/register"]);

function isPublic(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true;
  // Allow API routes, Next.js internals, and static assets
  if (pathname.startsWith("/api/")) return true;
  if (pathname.startsWith("/_next/")) return true;
  if (pathname === "/favicon.ico") return true;
  // Static file extensions (images, fonts, etc.)
  if (/\.\w{2,5}$/.test(pathname)) return true;
  return false;
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isPublic(pathname)) {
    return NextResponse.next();
  }

  const session = request.cookies.get("sentinel.sid");

  if (!session?.value) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     *  - _next/static (static files)
     *  - _next/image  (image optimization)
     *  - favicon.ico
     */
    "/((?!_next/static|_next/image|favicon\\.ico).*)",
  ],
};
