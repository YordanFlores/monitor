import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { NextResponse } from "next/server";

/** logo.bin RGB565 (160x128) ≈ 40 KB; dejamos margen amplio. */
const MAX_BYTES = 2 * 1024 * 1024;

function sanitizeUnit(raw: string | null): string {
  const s = (raw ?? "latest").trim().replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return s.length > 0 ? s : "latest";
}

function checkSecret(request: Request): boolean {
  const secret = process.env.FIRMWARE_UPLOAD_SECRET?.trim();
  if (!secret) return true;
  const h = request.headers.get("x-firmware-upload-secret")?.trim();
  if (h === secret) return true;
  const auth = request.headers.get("authorization")?.trim();
  if (auth?.startsWith("Bearer ") && auth.slice(7).trim() === secret) return true;
  return false;
}

function publicAssetUrl(request: Request, pathname: string): string {
  const host =
    request.headers.get("x-forwarded-host")?.trim() ||
    request.headers.get("host")?.trim() ||
    "";
  const proto = (request.headers.get("x-forwarded-proto")?.trim() || "https").split(",")[0] || "https";
  if (!host) {
    return pathname;
  }
  return `${proto}://${host}${pathname}`;
}

/** POST /api/logo/upload?unit=UNIDAD_01 — guarda logo.bin y devuelve URL pública. */
export async function POST(request: Request) {
  if (!checkSecret(request)) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Cuerpo inválido o demasiado grande" }, { status: 413 });
  }

  const file = formData.get("file");
  if (!file || !(file instanceof File)) {
    return NextResponse.json({ error: 'Falta el campo "file" (archivo .bin)' }, { status: 400 });
  }

  const name = file.name?.toLowerCase() ?? "";
  if (!name.endsWith(".bin")) {
    return NextResponse.json({ error: "Solo se aceptan archivos .bin" }, { status: 400 });
  }

  const buf = Buffer.from(await file.arrayBuffer());
  if (buf.length === 0) {
    return NextResponse.json({ error: "Archivo vacío" }, { status: 400 });
  }
  if (buf.length > MAX_BYTES) {
    return NextResponse.json(
      { error: `El archivo supera el máximo permitido (${MAX_BYTES} bytes)` },
      { status: 413 },
    );
  }

  const { searchParams } = new URL(request.url);
  const unit = sanitizeUnit(searchParams.get("unit"));
  const filename = `${unit}.bin`;

  const root = process.cwd();
  const dir = path.join(root, "public", "firmware", "logo");
  const fsPath = path.join(dir, filename);

  await mkdir(dir, { recursive: true });
  await writeFile(fsPath, buf);

  const webPath = `/firmware/logo/${filename}`;
  const url = publicAssetUrl(request, webPath);

  return NextResponse.json({
    ok: true,
    path: webPath,
    url,
    bytes: buf.length,
    unit,
  });
}

export const dynamic = "force-dynamic";
export const maxDuration = 300;
