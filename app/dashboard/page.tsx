"use client";

import { useEffect, useState } from "react";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { collection, onSnapshot } from "firebase/firestore";
import { onValue, ref } from "firebase/database";
import { useRouter } from "next/navigation";
import { getAuthClient, getDb, getRtdb } from "@/lib/firebase";
import styles from "./dashboard.module.css";

type UnitDoc = { id: string; createdAt?: string };
type TelemetryMap = Record<string, { lastSeen?: number } | null>;

const ONLINE_MS = 10_000;

export default function DashboardPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [units, setUnits] = useState<UnitDoc[]>([]);
  const [tel, setTel] = useState<TelemetryMap>({});
  const [pinUnit, setPinUnit] = useState<string | null>(null);
  const [pin, setPin] = useState("");
  const [pinErr, setPinErr] = useState("");
  const [, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 2000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const unsub = onAuthStateChanged(getAuthClient(), (u) => {
      if (!u) router.replace("/login");
      setReady(!!u);
    });
    return () => unsub();
  }, [router]);

  useEffect(() => {
    return onSnapshot(collection(getDb(), "units"), (snap) => {
      const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }) as UnitDoc);
      list.sort((a, b) =>
        String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? ""))
      );
      setUnits(list);
    });
  }, []);

  useEffect(() => {
    const r = ref(getRtdb(), "telemetry");
    return onValue(r, (snap) => {
      setTel((snap.val() as TelemetryMap) ?? {});
    });
  }, []);

  const now = Date.now();
  const isOnline = (id: string) => {
    const t = tel[id]?.lastSeen;
    if (typeof t !== "number") return false;
    return now - t < ONLINE_MS;
  };

  const openPin = (id: string) => {
    setPinUnit(id);
    setPin("");
    setPinErr("");
  };

  const submitPin = async () => {
    if (!pinUnit || pin.length !== 4) return;
    const res = await fetch("/api/unit/verify-pin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ unitId: pinUnit, pin }),
    });
    const j = (await res.json()) as { ok?: boolean };
    if (j.ok) {
      router.push(`/unit/${encodeURIComponent(pinUnit)}/scada`);
    } else {
      setPinErr("PIN incorrecto");
      setPin("");
    }
  };

  const p = (n: number) => {
    if (pin.length < 4) setPin((s) => s + String(n));
  };

  if (!ready) {
    return (
      <div className={styles.wrap}>
        <p className={styles.loading}>Cargando…</p>
      </div>
    );
  }

  return (
    <div className={styles.wrap}>
      <header className={styles.header}>
        <h1 className={styles.h1}>OMNITEC Cloud</h1>
        <button
          type="button"
          className={styles.out}
          onClick={() => signOut(getAuthClient())}
        >
          Salir
        </button>
      </header>

      <p className={styles.lead}>Unidades registradas</p>

      <div className={styles.grid}>
        {units.map((u) => (
          <button
            key={u.id}
            type="button"
            className={styles.card}
            onClick={() => openPin(u.id)}
          >
            <span className={styles.unitId}>{u.id}</span>
            <span
              className={
                isOnline(u.id) ? styles.dotOn : styles.dotOff
              }
            >
              {isOnline(u.id) ? "En línea" : "Fuera de línea"}
            </span>
          </button>
        ))}
      </div>

      {units.length === 0 ? (
        <p className={styles.empty}>
          Aún no hay PLCs. Crea un documento en{" "}
          <code>provisionTokens</code> y envía telemetría desde el ESP32.
        </p>
      ) : null}

      {pinUnit ? (
        <div className={styles.overlay} role="dialog">
          <div className={styles.modal}>
            <h2 className={styles.modalTitle}>PIN — {pinUnit}</h2>
            <p className={styles.modalSub}>Introduce el PIN de 4 dígitos del PLC</p>
            <div className={styles.pinDisplay}>{pin.padEnd(4, "_")}</div>
            <div className={styles.teclado}>
              {[1, 2, 3, 4].map((n) => (
                <button
                  key={n}
                  type="button"
                  className={styles.tecla}
                  onClick={() => p(n)}
                >
                  {n}
                </button>
              ))}
            </div>
            {pinErr ? <p className={styles.pinErr}>{pinErr}</p> : null}
            <div className={styles.modalActions}>
              <button
                type="button"
                className={styles.btnGris}
                onClick={() => setPin("")}
              >
                Borrar
              </button>
              <button
                type="button"
                className={styles.btnAzul}
                onClick={submitPin}
              >
                Entrar
              </button>
              <button
                type="button"
                className={styles.btnClose}
                onClick={() => setPinUnit(null)}
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
