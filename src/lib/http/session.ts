import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getEnv } from "@/lib/env";

export const SESSION_COOKIE = "revenant_session";
export const SESSION_MAX_AGE_SEC = 12 * 60 * 60;

const VERSION = "v1";
const MAX_LENGTH = 200;

const sign = (payload: string, secret: string) =>
  createHmac("sha256", Buffer.from(secret, "hex")).update(payload).digest("hex");

/** Set-Cookie value. No `Secure` flag: the app is served over plain loopback HTTP (arch Assumption 13). */
export const sessionCookieHeader = (value: string) =>
  `${SESSION_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE_SEC}`;

/**
 * Returns `v1.<expiresAtEpochSec>.<nonceHex>.<signatureHex>`. The expiry is inside the
 * signed payload, so it cannot be extended without the secret.
 */
export function signSession(now = Date.now(), secret = getEnv().REVENANT_SESSION_SECRET): string {
  const expiresAt = Math.floor(now / 1000) + SESSION_MAX_AGE_SEC;
  const payload = `${VERSION}.${expiresAt}.${randomBytes(16).toString("hex")}`;
  return `${payload}.${sign(payload, secret)}`;
}

/** Never throws; any malformed, tampered, or expired value is simply invalid. */
export function verifySession(value: unknown, now = Date.now(), secret = getEnv().REVENANT_SESSION_SECRET): boolean {
  if (typeof value !== "string" || value.length > MAX_LENGTH) return false;

  const parts = value.split(".");
  if (parts.length !== 4) return false;
  const [version, expiresAt, nonce, signature] = parts;

  // Only the exact canonical form we produce is accepted (lowercase hex, plain digits).
  if (version !== VERSION) return false;
  if (!/^\d{1,12}$/.test(expiresAt)) return false;
  if (!/^[0-9a-f]{32}$/.test(nonce)) return false;
  if (!/^[0-9a-f]{64}$/.test(signature)) return false;

  const expected = Buffer.from(sign(`${version}.${expiresAt}.${nonce}`, secret));
  if (!timingSafeEqual(expected, Buffer.from(signature))) return false;

  return Math.floor(now / 1000) < Number(expiresAt);
}
