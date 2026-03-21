"use client";

import { useState } from "react";
import { signInWithEmailAndPassword } from "firebase/auth";
import { useRouter } from "next/navigation";
import { getAuthClient } from "@/lib/firebase";
import styles from "./login.module.css";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const router = useRouter();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    try {
      await signInWithEmailAndPassword(getAuthClient(), email.trim(), password);
      router.push("/dashboard");
      router.refresh();
    } catch {
      setErr("Credenciales incorrectas o error de red.");
    }
  };

  return (
    <div className={styles.wrap}>
      <form className={styles.card} onSubmit={submit}>
        <h1 className={styles.title}>OMNITEC Cloud</h1>
        <p className={styles.sub}>Acceso administrador</p>
        <label className={styles.label}>
          Correo
          <input
            className={styles.input}
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>
        <label className={styles.label}>
          Contraseña
          <input
            className={styles.input}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        {err ? <p className={styles.err}>{err}</p> : null}
        <button type="submit" className={styles.btn}>
          Entrar
        </button>
      </form>
    </div>
  );
}
