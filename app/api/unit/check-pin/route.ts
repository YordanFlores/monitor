import { NextResponse } from "next/server";
import { getFirestoreAdmin } from "@/lib/firebase-admin";

export const runtime = "nodejs";

/** Valida PIN sin emitir cookie (desbloqueo del panel de edición en SCADA). */
export async function POST(req: Request) {
  let body: { unitId?: string; pin?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const unitId = typeof body.unitId === "string" ? body.unitId.trim() : "";
  const pin = typeof body.pin === "string" ? body.pin.trim() : "";

  if (!unitId || pin.length !== 4) {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const snap = await getFirestoreAdmin().collection("units").doc(unitId).get();
  if (!snap.exists || snap.data()?.pin !== pin) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  return NextResponse.json({ ok: true });
}
