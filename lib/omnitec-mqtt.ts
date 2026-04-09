/**
 * WebSocket MQTT (Mosquitto vía mqtt.js).
 * Por defecto (sin NEXT_PUBLIC_MQTT_WS_URL): mismo esquema que página + host o broker LAN.
 * Override: NEXT_PUBLIC_MQTT_WS_URL (+ opcional NEXT_PUBLIC_MQTT_WS_PATH).
 */

/** URL por defecto: dominio omnitec → /ws (Nginx); si no, broker en LAN. */
function getDefaultMqttWebSocketUrl(): string {
  if (typeof window === "undefined") {
    return "ws://192.168.100.40:9001";
  }
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = window.location.hostname;

  if (host.includes("omnitec.store")) {
    return `${protocol}//${host}/ws`;
  }

  return `${protocol}//192.168.100.40:9001`;
}

function appendMqttPath(base: string, extraPath: string): string {
  if (!extraPath) return base;
  try {
    const u = new URL(base);
    if (u.pathname && u.pathname !== "/") return base;
    u.pathname = extraPath.startsWith("/") ? extraPath : `/${extraPath}`;
    return u.toString();
  } catch {
    return base;
  }
}

/** URL WebSocket lista para mqtt.connect() (solo tiene sentido en cliente). */
export function buildMqttWebSocketUrl(): string {
  const env =
    typeof process !== "undefined" ? process.env.NEXT_PUBLIC_MQTT_WS_URL?.trim() ?? "" : "";
  const extraPath =
    typeof process !== "undefined" ? process.env.NEXT_PUBLIC_MQTT_WS_PATH?.trim() ?? "" : "";

  if (env) {
    return appendMqttPath(env, extraPath);
  }

  return appendMqttPath(getDefaultMqttWebSocketUrl(), extraPath);
}

export function telemetryTopic(unitId: string) {
  return `omnitec/telemetry/${unitId}`;
}

export function cmdTopic(unitId: string) {
  return `omnitec/cmd/${unitId}`;
}
