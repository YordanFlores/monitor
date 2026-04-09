/**
 * WebSocket MQTT (Mosquitto vía mqtt.connect — no usar `new WebSocket` directo).
 * Por defecto: producción HTTPS + omnitec.store → wss://{host}/ws (Nginx); en casa/LAN → broker por IP.
 * Override: NEXT_PUBLIC_MQTT_WS_URL (+ opcional NEXT_PUBLIC_MQTT_WS_PATH).
 */

/** Lógica de conexión: servidor seguro vs red local (misma idea que getSocketUrl industrial). */
function getDefaultMqttWebSocketUrl(): string {
  if (typeof window === "undefined") {
    return "ws://192.168.100.40:9001";
  }
  const isSecure = window.location.protocol === "https:";
  const host = window.location.hostname;

  if (isSecure && host.includes("omnitec.store")) {
    return `wss://${host}/ws`;
  }

  return "ws://192.168.100.40:9001";
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
