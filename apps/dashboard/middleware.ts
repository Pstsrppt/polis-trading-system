import { NextRequest, NextResponse } from "next/server";
import { authSecret, verifyToken } from "./lib/auth";

const PUBLIC_PATHS = ["/login", "/subscribe", "/api/login"];

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Allow public paths
  if (PUBLIC_PATHS.some(p => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  const toLogin = (err?: string) => {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("from", pathname);
    if (err) url.searchParams.set("err", err);
    return NextResponse.redirect(url);
  };

  // Without a secret nothing can be verified — refuse rather than let everyone in
  const secret = authSecret();
  if (!secret) return toLogin("server_misconfigured");

  const ok = await verifyToken(secret, req.cookies.get("polis_auth")?.value);
  return ok ? NextResponse.next() : toLogin();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|manifest.json|icons).*)"],
};
