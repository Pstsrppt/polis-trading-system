import { NextRequest, NextResponse } from "next/server";
import { authSecret, createToken } from "../../../lib/auth";

const SESSION_SECONDS = 7 * 24 * 60 * 60;

export async function POST(req: NextRequest) {
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
  if (!ADMIN_PASSWORD) {
    return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
  }
  const { password } = await req.json();
  if (password !== ADMIN_PASSWORD) {
    return NextResponse.json({ error: "รหัสผ่านไม่ถูกต้อง" }, { status: 401 });
  }

  // Signed token, not a fixed marker: the cookie used to be the literal "ok",
  // which anyone could set for themselves to skip the password entirely.
  const res = NextResponse.json({ ok: true });
  res.cookies.set("polis_auth", await createToken(authSecret(), SESSION_SECONDS), {
    httpOnly: true,
    sameSite: "lax",
    // Off by default: the dashboard is reached over plain HTTP on localhost and
    // over Tailscale, where a Secure cookie would never be sent. Turn it on with
    // COOKIE_SECURE=true once this is served over HTTPS.
    secure: process.env.COOKIE_SECURE === "true",
    maxAge: SESSION_SECONDS,
    path: "/",
  });
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.delete("polis_auth");
  return res;
}
