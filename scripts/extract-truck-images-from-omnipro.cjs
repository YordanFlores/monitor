/**
 * Lee OMNIPRO/truck_images.h (PNG en data URI) y escribe public/Chasis.png, tolva.png, Compuerta.png
 */
const fs = require("fs");
const path = require("path");

const src = process.argv[2] || "C:\\ARDUINO\\OMNIPRO\\truck_images.h";
const outDir = path.join(__dirname, "..", "public");

const content = fs.readFileSync(src, "utf8");
const pairs = [
  ["IMG_CHASSIS_DATA", "Chasis.png"],
  ["IMG_TOLVA_DATA", "tolva.png"],
  ["IMG_GATE_DATA", "Compuerta.png"],
];

for (const [varName, outName] of pairs) {
  const re = new RegExp(`const char\\* ${varName}\\s*=\\s*"([^"]+)"`);
  const m = content.match(re);
  if (!m) {
    console.error("No encontrado:", varName);
    process.exit(1);
  }
  const uri = m[1];
  const prefix = "data:image/png;base64,";
  if (!uri.startsWith(prefix)) {
    console.error("Prefijo inesperado en", varName);
    process.exit(1);
  }
  const b64 = uri.slice(prefix.length);
  const buf = Buffer.from(b64, "base64");
  fs.writeFileSync(path.join(outDir, outName), buf);
  console.log(outName, buf.length, "bytes");
}
