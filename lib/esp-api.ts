/**
 * Cliente HTTP + tipos para el ESP32 unificado (Fetch) y URL del WebSocket de telemetría.
 */

const trim = (s: string | undefined) => s?.trim() ?? "";

/** AP por defecto del ESP32 en modo configuración (Arduino / OMNIPRO típico). */
export const DEFAULT_ESP_AP_ORIGIN = "http://192.168.4.1";

/** Origen HTTP del PLC desde env, p. ej. http://192.168.4.1 — sin barra final; null si no está definido. */
export function getEspOrigin(): string | null {
  if (typeof process === "undefined") return null;
  const o = trim(process.env.NEXT_PUBLIC_OMNITEC_ESP_ORIGIN);
  return o ? o.replace(/\/$/, "") : null;
}

/**
 * Origen para OTA / abrir AP: usa NEXT_PUBLIC_OMNITEC_ESP_ORIGIN o, si falta, el AP por defecto.
 * Así el formulario /update no queda roto sin .env (en LAN suele ser 192.168.4.1).
 */
export function resolveEspLanOrigin(): string {
  return getEspOrigin() ?? DEFAULT_ESP_AP_ORIGIN;
}

/**
 * Origen para GET /api/config (parámetros NV del PLC).
 * Prioridad: NEXT_PUBLIC_OMNITEC_CONFIG_ORIGIN → NEXT_PUBLIC_OMNITEC_ESP_ORIGIN
 */
export function getPlcConfigOrigin(): string | null {
  if (typeof process === "undefined") return null;
  const c = trim(process.env.NEXT_PUBLIC_OMNITEC_CONFIG_ORIGIN);
  if (c) return c.replace(/\/$/, "");
  return getEspOrigin();
}

/** URL completa del WebSocket; si no existe, se deriva de ORIGIN → ws + puerto 81 */
export function getEspWsUrl(): string | null {
  if (typeof process === "undefined") return null;
  const explicit = trim(process.env.NEXT_PUBLIC_OMNITEC_ESP_WS);
  if (explicit) return explicit;
  const origin = getEspOrigin();
  if (!origin) return null;
  try {
    const u = new URL(origin);
    const wsProto = u.protocol === "https:" ? "wss:" : "ws:";
    const portPart = u.port ? `:${u.port}` : ":81";
    return `${wsProto}//${u.hostname}${portPart}/`;
  } catch {
    return null;
  }
}

/** JSON de GET /api/config (memoria no volátil en el PLC). */
export type PlcConfigJson = {
  cs: number;
  cb: number;
  ts: number;
  tb: number;
  lc: number;
  lm: number;
  tp: string;
  id: string;
  token: string;
};

export async function fetchPlcConfig(origin: string): Promise<PlcConfigJson | null> {
  const url = `${origin.replace(/\/$/, "")}/api/config`;
  const res = await fetch(url, { cache: "no-store", credentials: "omit" });
  if (!res.ok) return null;
  try {
    return (await res.json()) as PlcConfigJson;
  } catch {
    return null;
  }
}

/** Login inicial (mismo contrato que el HTML del ESP: respuesta texto OK / ERROR). */
export async function fetchAuthLogin(origin: string, pin: string): Promise<boolean> {
  const url = `${origin.replace(/\/$/, "")}/authLogin?pin=${encodeURIComponent(pin)}`;
  const res = await fetch(url, { cache: "no-store", credentials: "omit" });
  const text = (await res.text()).trim();
  return text === "OK";
}

/** Desbloqueo configuración avanzada. */
export async function fetchCheckPin(origin: string, pin: string): Promise<boolean> {
  const url = `${origin.replace(/\/$/, "")}/setP?check=${encodeURIComponent(pin)}`;
  const res = await fetch(url, { cache: "no-store", credentials: "omit" });
  const text = (await res.text()).trim();
  return text === "OK";
}

/** Telemetría en vivo: sin campo `status` (los ACK llevan status OK/ERROR). */
export function isTelemetryPayload(raw: Record<string, unknown>): boolean {
  if (typeof raw.status === "string") return false;
  return typeof raw.ms === "number" && typeof raw.relays === "number";
}

export function isAckPayload(raw: Record<string, unknown>): boolean {
  return typeof raw.status === "string";
}
