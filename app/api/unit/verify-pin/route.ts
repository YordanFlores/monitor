import { NextResponse } from "next/server";
import { getFirestoreAdmin } from "@/lib/firebase-admin";
import { COOKIE, MAX_AGE_SEC, signScadaToken } from "@/lib/scada-cookie";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const secret = process.env.SCADA_SESSION_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "SCADA_SESSION_SECRET no configurado" }, { status: 500 });
  }

  let body: { unitId?: string; pin?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
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

  const token = signScadaToken(unitId, secret);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE, token, {
    httpOnly: true,
    path: "/",
    maxAge: MAX_AGE_SEC,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
  return res;
}
