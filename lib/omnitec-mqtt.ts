/** URL WebSocket del broker (Mosquitto). Configurable vía .env.local */
export const MQTT_WS_URL =
  typeof process !== "undefined" && process.env.NEXT_PUBLIC_MQTT_WS_URL
    ? process.env.NEXT_PUBLIC_MQTT_WS_URL
    : "ws://192.168.100.40:9001";

export function telemetryTopic(unitId: string) {
  return `omnitec/telemetry/${unitId}`;
}

export function cmdTopic(unitId: string) {
  return `omnitec/cmd/${unitId}`;
}
