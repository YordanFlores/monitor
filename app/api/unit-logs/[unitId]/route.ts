import { NextResponse } from "next/server";
import { readUnitLogFile } from "@/lib/unit-logs-store";

/**
 * GET /api/unit-logs/{unitId}
 * Devuelve el historial completo almacenado en el servidor (archivo .log por unidad).
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ unitId: string }> },
) {
  const { unitId: raw } = await context.params;
  const unitId = decodeURIComponent(raw || "").trim();
  if (!unitId) {
    return NextResponse.json({ error: "unitId requerido" }, { status: 400 });
  }

  const text = await readUnitLogFile(unitId);
  return new NextResponse(text, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
