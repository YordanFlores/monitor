import { createHmac, timingSafeEqual } from "crypto";

const COOKIE = "omnitec_scada";
const MAX_AGE_SEC = 60 * 60 * 8;

export function signScadaToken(unitId: string, secret: string): string {
  const exp = Math.floor(Date.now() / 1000) + MAX_AGE_SEC;
  const payload = `${unitId}:${exp}`;
  const sig = createHmac("sha256", secret).update(payload).digest("hex");
  return Buffer.from(`${payload}:${sig}`).toString("base64url");
}

export function verifyScadaToken(
  token: string | undefined,
  secret: string
): string | null {
  if (!token || !secret) return null;
  try {
    const raw = Buffer.from(token, "base64url").toString("utf8");
    const parts = raw.split(":");
    if (parts.length !== 3) return null;
    const [unitId, expStr, sig] = parts;
    const exp = parseInt(expStr!, 10);
    if (Number.isNaN(exp) || exp < Math.floor(Date.now() / 1000)) return null;
    const payload = `${unitId}:${exp}`;
    const expected = createHmac("sha256", secret).update(payload).digest("hex");
    const a = Buffer.from(sig!, "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    return unitId!;
  } catch {
    return null;
  }
}

export { COOKIE, MAX_AGE_SEC };
