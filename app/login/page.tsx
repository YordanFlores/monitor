"use client";

import Link from "next/link";
import styles from "./login.module.css";

export default function LoginPage() {
  return (
    <div className={styles.wrap}>
      <div className={styles.card}>
        <h1 className={styles.title}>OMNITEC</h1>
        <p className={styles.sub}>
          Panel local vía MQTT (sin nube). Elige la unidad en el dashboard.
        </p>
        <Link className={styles.btn} href="/dashboard">
          Ir al dashboard
        </Link>
      </div>
    </div>
  );
}
