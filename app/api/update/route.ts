import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getFirestoreAdmin, getRtdbAdmin } from "@/lib/firebase-admin";

export const runtime = "nodejs";

type HeartbeatBody = {
  unidad: string;
  token: string;
  fase?: number;
  relays?: number;
  prog?: number;
  ms?: number;
  tS?: number;
  tB?: number;
  ciclos?: number;
  uso?: number;
  alerta?: boolean;
};

const DEFAULT_UNIT = {
  pacS_ms: 9000,
  pacB_ms: 9000,
  limC: 10,
  limM_min: 120,
};

function sanitizeUnitId(id: string): string | null {
  if (!id || typeof id !== "string") return null;
  const t = id.trim();
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(t)) return null;
  return t;
}

export async function POST(req: Request) {
  let body: HeartbeatBody;
  try {
    body = (await req.json()) as HeartbeatBody;
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const unitId = sanitizeUnitId(body.unidad);
  const token = typeof body.token === "string" ? body.token.trim() : "";

  if (!unitId || !token) {
    return NextResponse.json({ error: "unidad y token requeridos" }, { status: 400 });
  }

  const fs = getFirestoreAdmin();
  const rtdb = getRtdbAdmin();

  let unitRef = fs.collection("units").doc(unitId);
  let snap = await unitRef.get();

  if (!snap.exists) {
    const prov = await fs.collection("provisionTokens").doc(token).get();
    if (!prov.exists || prov.data()?.unitId !== unitId) {
      return NextResponse.json({ error: "unidad o token no autorizado" }, { status: 401 });
    }
    await unitRef.set({
      token,
      pin: "1234",
      pacS_ms: DEFAULT_UNIT.pacS_ms,
      pacB_ms: DEFAULT_UNIT.pacB_ms,
      limC: DEFAULT_UNIT.limC,
      limM_min: DEFAULT_UNIT.limM_min,
      pendingCmd: 0,
      createdAt: new Date().toISOString(),
    });
    snap = await unitRef.get();
  } else if (snap.data()?.token !== token) {
    return NextResponse.json({ error: "token inválido" }, { status: 401 });
  }

  const data = snap.data()!;
  const now = Date.now();

  const telemetry = {
    fase: body.fase ?? 0,
    prog: body.prog ?? 0,
    ms: body.ms ?? 0,
    tS: body.tS ?? data.pacS_ms ?? DEFAULT_UNIT.pacS_ms,
    tB: body.tB ?? data.pacB_ms ?? DEFAULT_UNIT.pacB_ms,
    relays: body.relays ?? 0,
    ciclos: body.ciclos ?? 0,
    uso: body.uso ?? 0,
    limC: data.limC ?? DEFAULT_UNIT.limC,
    limM: (data.limM_min ?? DEFAULT_UNIT.limM_min) * 60,
    alerta: Boolean(body.alerta),
    lastSeen: now,
  };

  await rtdb.ref(`telemetry/${unitId}`).set(telemetry);

  const pendingCmd = Number(data.pendingCmd ?? 0) || 0;
  const pendingPacS = data.pendingPacS_ms as number | undefined;
  const pendingPacB = data.pendingPacB_ms as number | undefined;
  const pendingPin = data.pendingPin as string | undefined;
  const pendingLimC = data.pendingLimC as number | undefined;
  const pendingLimM = data.pendingLimM_min as number | undefined;
  const pendingResetMante = Boolean(data.pendingResetMante);

  const response: Record<string, number | string> = {
    cmd: pendingCmd,
    tCS: data.pacS_ms ?? DEFAULT_UNIT.pacS_ms,
    tCB: data.pacB_ms ?? DEFAULT_UNIT.pacB_ms,
  };

  if (pendingPacS != null) response.tCS = pendingPacS;
  if (pendingPacB != null) response.tCB = pendingPacB;
  if (pendingPin && pendingPin.length === 4) response.newPin = pendingPin;
  if (pendingLimC != null) response.limC = pendingLimC;
  if (pendingLimM != null) response.limM = pendingLimM;
  if (pendingResetMante) response.resetMante = 1;

  const patch: Record<string, unknown> = {};

  if (pendingCmd !== 0) patch.pendingCmd = 0;
  if (pendingPacS != null) {
    patch.pacS_ms = pendingPacS;
    patch.pendingPacS_ms = FieldValue.delete();
  }
  if (pendingPacB != null) {
    patch.pacB_ms = pendingPacB;
    patch.pendingPacB_ms = FieldValue.delete();
  }
  if (pendingPin) {
    patch.pin = pendingPin;
    patch.pendingPin = FieldValue.delete();
  }
  if (pendingLimC != null) {
    patch.limC = pendingLimC;
    patch.pendingLimC = FieldValue.delete();
  }
  if (pendingLimM != null) {
    patch.limM_min = pendingLimM;
    patch.pendingLimM_min = FieldValue.delete();
  }
  if (pendingResetMante) patch.pendingResetMante = false;

  if (Object.keys(patch).length) {
    await unitRef.update(patch);
  }

  return NextResponse.json(response);
}
