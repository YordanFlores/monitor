/** Parseo de líneas CSV de caja negra (mismo criterio que WebUI.h). */

export type ParsedLogLine = { day: string; time: string; ev: string; raw: string };

export function parseLogLine(line: string): ParsedLogLine | null {
  const text = line.trim();
  if (text.length < 10 || text.startsWith("FECHA") || text.startsWith("===")) return null;
  if (text.includes(" ; ")) {
    const p = text.split(" ; ");
    if (p.length >= 3) {
      let day = p[0].replace(/"/g, "").trim();
      if (day === "31/12/69" || day === "01/01/70" || day.endsWith("/69") || day.endsWith("/70")) return null;
      if (day === "BOOT-INIT" || day === "OTROS") return null;
      const time = p[1].replace(/"/g, "").trim();
      const ev = p.slice(2).join(" ; ").replace(/^"|"$/g, "").trim();
      return { day, time, ev, raw: text };
    }
  } else if (text.includes(" | ")) {
    const p = text.split(" | ");
    if (p.length >= 2) {
      const dt = p[0].trim();
      const day = dt.substring(0, 8).trim();
      if (day === "31/12/69" || day === "01/01/70" || day.endsWith("/69") || day.endsWith("/70")) return null;
      if (day === "BOOT-INIT" || day === "OTROS" || dt === "BOOT-INIT") return null;
      const time = dt.substring(9).trim();
      const ev = p.slice(1).join(" | ").trim();
      return { day, time, ev, raw: text };
    }
  }
  return null;
}

/** Mismas reglas que WebUI.h getColorForEvent */
export function getColorForEvent(ev: string): string {
  const e = ev.toUpperCase();
  if (e.startsWith("HMI") || e.startsWith("WEB")) return "#ffffff";
  if (e.includes("SISTEMA") || e.includes("RECUPERACION") || e.includes("WIFI")) return "var(--cyan)";
  if (e.includes("COMPUERTA") || e.includes("TOLVA") || e.includes("ABORTO") || e.includes("MODO MANUAL")) return "var(--ambar)";
  if (e.includes("CLIC") || e.includes("PULSADOR") || e.includes("SWITCH") || e.includes("MANTENIMIENTO")) return "var(--rojo)";
  if (e.includes("TIEMPOS") || e.includes("LIMITES") || e.includes("FONDO") || e.includes("PIN:")) return "var(--verde)";
  if (e.startsWith("MQTT")) return "#88ccff";
  if (e.includes("ERROR") || e.includes("FALLO")) return "var(--rojo)";
  return "var(--verde)";
}

/** Día + eventos; días más recientes primero; dentro de cada día, eventos más recientes arriba (como el AP). */
export type CajaDayBlock = { day: string; items: { time: string; event: string }[] };

export function buildCajaDayBlocks(grouped: LogsByDay): CajaDayBlock[] {
  const dayKeys = Object.keys(grouped).sort((a, b) => {
    const pa = a.split("/");
    const pb = b.split("/");
    const da = pa.length === 3 ? new Date(`20${pa[2]}-${pa[1]}-${pa[0]}T12:00:00`).getTime() : 0;
    const db = pb.length === 3 ? new Date(`20${pb[2]}-${pb[1]}-${pb[0]}T12:00:00`).getTime() : 0;
    return db - da;
  });
  return dayKeys.map((day) => ({
    day,
    items: [...grouped[day]].reverse(),
  }));
}

export type ChartPoint = { label: string; count: number; date: Date };

export function buildChartPointsFromCsv(csv: string): ChartPoint[] {
  const lines = csv.trim().split("\n");
  const counts: Record<string, number> = {};
  for (const l of lines) {
    const p = parseLogLine(l);
    if (!p || p.day === "OTROS" || p.day === "BOOT-INIT") continue;
    counts[p.day] = (counts[p.day] || 0) + 1;
  }
  return Object.keys(counts)
    .map((k) => {
      const parts = k.split("/");
      const date =
        parts.length === 3
          ? new Date(`20${parts[2]}-${parts[1]}-${parts[0]}T12:00:00`)
          : new Date(0);
      return { label: k.substring(0, 5), date, count: counts[k] };
    })
    .sort((a, b) => a.date.getTime() - b.date.getTime());
}

export type LogsByDay = Record<string, { time: string; event: string }[]>;

export function groupLogsByDay(csv: string): LogsByDay {
  const logsByDay: LogsByDay = {};
  for (const l of csv.split("\n")) {
    const p = parseLogLine(l);
    if (!p) continue;
    if (!logsByDay[p.day]) logsByDay[p.day] = [];
    logsByDay[p.day].push({ time: p.time, event: p.ev });
  }
  return logsByDay;
}
