"use client";

import { useParams } from "next/navigation";
import { ScadaPanel } from "@/components/ScadaPanel";

/** Página 100% cliente: evita fallos de RSC / Next DevTools (SegmentViewNode) en dev. */
export default function ScadaPage() {
  const params = useParams();
  const unitId = typeof params?.unitId === "string" ? params.unitId : "UNIDAD_01";
  return <ScadaPanel unitId={decodeURIComponent(unitId)} />;
}
