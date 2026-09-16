/**
 * Signed session tokens for the admin dashboard.
 *
 * The cookie used to hold the literal string "ok", which the middleware compared
 * against "ok" — so `document.cookie = "polis_auth=ok"` was a complete bypass of
 * the password, and the check itself is public in this repository.
 *
 * A token is `<expiry>.<hmac>`: the expiry is readable, the signature is not
 * forgeable without the server secret, and an expired token is refused even if
 * the signature is valid. Uses Web Crypto so the same code runs in the Node
 * route handler and in the Edge middleware.
 */

const encoder = new TextEncoder();

/** Server secret. AUTH_SECRET is preferred; the admin password is the fallback. */
export function authSecret(): string {
  return process.env.AUTH_SECRET || process.env.ADMIN_PASSWORD || "";
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Returns a TypedArray, not a bare ArrayBuffer: the Edge runtime's SubtleCrypto
 *  rejects a plain ArrayBuffer as a signature ("3rd argument is not instance of
 *  ArrayBuffer, Buffer, TypedArray"), so every session was refused even though
 *  the signature matched. Building the view over an explicit ArrayBuffer also
 *  keeps the type as BufferSource for TypeScript. */
function fromHex(hex: string) {
  if (hex.length === 0 || hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) return null;
  const out = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Mint a token valid for `ttlSeconds` (default 7 days, matching the old cookie). */
export async function createToken(secret: string, ttlSeconds = 7 * 24 * 60 * 60): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = String(exp);
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(payload));
  return `${payload}.${toHex(sig)}`;
}

/** True only for a token this server signed that has not expired yet. */
export async function verifyToken(secret: string, token: string | undefined): Promise<boolean> {
  if (!secret || !token) return false;

  const dot = token.indexOf(".");
  if (dot < 1) return false;

  const payload = token.slice(0, dot);
  const sig = fromHex(token.slice(dot + 1));
  if (!sig) return false;

  if (!/^\d+$/.test(payload)) return false;
  if (Number(payload) <= Math.floor(Date.now() / 1000)) return false;

  try {
    // subtle.verify compares in constant time
    return await crypto.subtle.verify("HMAC", await hmacKey(secret), sig, encoder.encode(payload));
  } catch (err) {
    // Never swallow this silently: a runtime rejection here looks exactly like a
    // forged token, which once turned a crypto type error into "wrong password".
    console.error("verifyToken: crypto failure —", err);
    return false;
  }
}
