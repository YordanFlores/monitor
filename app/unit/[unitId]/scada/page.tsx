import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ScadaPanel } from "@/components/ScadaPanel";
import { COOKIE, verifyScadaToken } from "@/lib/scada-cookie";

export default async function ScadaPage({
  params,
}: {
  params: Promise<{ unitId: string }>;
}) {
  const { unitId } = await params;
  const secret = process.env.SCADA_SESSION_SECRET;
  if (!secret) {
    redirect("/dashboard");
  }
  const c = (await cookies()).get(COOKIE)?.value;
  if (verifyScadaToken(c, secret) !== unitId) {
    redirect("/dashboard");
  }

  return <ScadaPanel unitId={unitId} />;
}
