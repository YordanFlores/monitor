"use client";

import Link from "next/link";
import styles from "./dashboard.module.css";

const UNITS = (process.env.NEXT_PUBLIC_SCADA_UNITS ?? "UNIDAD_01")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export default function DashboardPage() {
  return (
    <div className={styles.wrap}>
      <header className={styles.header}>
        <h1 className={styles.h1}>OMNITEC</h1>
      </header>
      <p className={styles.lead}>Unidades (MQTT). Abre el SCADA de cada una.</p>
      <ul className={styles.list}>
        {UNITS.map((id) => (
          <li key={id}>
            <Link className={styles.link} href={`/unit/${encodeURIComponent(id)}/scada`}>
              {id}
            </Link>
          </li>
        ))}
      </ul>
      <p className={styles.hint}>
        Lista configurable con{" "}
        <code className={styles.code}>NEXT_PUBLIC_SCADA_UNITS</code> (separadas por
        coma).
      </p>
    </div>
  );
}
