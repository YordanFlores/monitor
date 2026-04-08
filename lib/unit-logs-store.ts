/**
 * Historial de caja negra por unidad en disco (servidor Next.js o mismo directorio que el ingestor MQTT).
 */
import fs from "fs/promises";
import path from "path";

export function getCajaNegraDir(): string {
  const fromEnv = process.env.CAJA_NEGRA_DIR?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(process.cwd(), "data", "caja-negra");
}

/** Nombre de archivo seguro a partir del id de unidad. */
export function safeUnitFileBase(unitId: string): string {
  const s = unitId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return s.length > 0 ? s : "unknown";
}

export function unitLogFilePath(unitId: string): string {
  return path.join(getCajaNegraDir(), `${safeUnitFileBase(unitId)}.log`);
}

export async function readUnitLogFile(unitId: string): Promise<string> {
  try {
    return await fs.readFile(unitLogFilePath(unitId), "utf8");
  } catch {
    return "";
  }
}

export async function appendUnitLogLine(unitId: string, line: string): Promise<void> {
  const dir = getCajaNegraDir();
  await fs.mkdir(dir, { recursive: true });
  const text = line.trim();
  if (!text) return;
  await fs.appendFile(unitLogFilePath(unitId), text + "\n", "utf8");
}
