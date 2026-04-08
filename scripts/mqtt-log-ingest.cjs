/**
 * Servicio de ingestión: suscribe a omnitec/log/+ y añade cada línea al archivo de la unidad.
 * Ejecutar en el servidor (p. ej. 192.168.100.40) junto al broker Mosquitto:
 *   CAJA_NEGRA_DIR=/var/lib/omnitec/caja-negra MQTT_URL=mqtt://127.0.0.1:1883 node scripts/mqtt-log-ingest.cjs
 */
const mqtt = require("mqtt");
const fs = require("fs");
const path = require("path");

const BROKER = process.env.MQTT_URL || "mqtt://192.168.100.40:1883";
const DATA_DIR = process.env.CAJA_NEGRA_DIR || path.join(__dirname, "..", "data", "caja-negra");

function safeName(unitId) {
  const s = String(unitId).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return s.length > 0 ? s : "unknown";
}

fs.mkdirSync(DATA_DIR, { recursive: true });
console.log("[omnitec-log-ingest] broker:", BROKER);
console.log("[omnitec-log-ingest] directorio:", path.resolve(DATA_DIR));

const client = mqtt.connect(BROKER, {
  reconnectPeriod: 5000,
  connectTimeout: 10_000,
});

client.on("connect", () => {
  console.log("[omnitec-log-ingest] conectado, suscripción omnitec/log/+");
  client.subscribe("omnitec/log/+", { qos: 0 }, (err) => {
    if (err) console.error("[omnitec-log-ingest] subscribe error:", err);
  });
});

client.on("message", (topic, buf) => {
  const parts = topic.split("/");
  const unitId = parts[parts.length - 1];
  let line = buf.toString("utf8");
  if (!line.trim()) return;
  if (!line.endsWith("\n")) line += "\n";
  const file = path.join(DATA_DIR, `${safeName(unitId)}.log`);
  try {
    fs.appendFileSync(file, line, "utf8");
  } catch (e) {
    console.error("[omnitec-log-ingest] write error:", file, e);
  }
});

client.on("error", (e) => console.error("[omnitec-log-ingest]", e));
client.on("reconnect", () => console.log("[omnitec-log-ingest] reconectando…"));
