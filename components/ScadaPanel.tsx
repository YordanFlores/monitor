"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { onValue, ref } from "firebase/database";
import { doc, onSnapshot, updateDoc } from "firebase/firestore";
import { getDb, getRtdb } from "@/lib/firebase";
import styles from "./ScadaPanel.module.css";

export type Telemetry = {
  fase: number;
  prog: number;
  ms: number;
  tS: number;
  tB: number;
  relays: number;
  ciclos: number;
  uso: number;
  limC: number;
  limM: number;
  alerta: boolean;
  lastSeen?: number;
};

const VEL_7S = 0.64;

type UnitCfg = {
  pacS_ms?: number;
  pacB_ms?: number;
  limC?: number;
  limM_min?: number;
};

export function ScadaPanel({ unitId }: { unitId: string }) {
  const [tel, setTel] = useState<Telemetry | null>(null);
  const [cfg, setCfg] = useState<UnitCfg | null>(null);
  const [cineOpen, setCineOpen] = useState(false);
  const [historialOpen, setHistorialOpen] = useState(false);
  const [muted, setMuted] = useState(false);
  const [log, setLog] = useState({ m: "", c: "" });
  const [pin, setPin] = useState("");
  const [panelEdicion, setPanelEdicion] = useState(false);
  const [alertaOpen, setAlertaOpen] = useState(false);
  const esperandoReset = useRef(false);

  const anguloTolva = useRef(0);
  const audioCtx = useRef<AudioContext | null>(null);
  const beepInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const isOperating = useRef(false);

  const cineViewportRef = useRef<HTMLDivElement>(null);
  const cineModeRef = useRef<HTMLDivElement>(null);

  const prog0 = useRef<SVGPathElement>(null);
  const prog1 = useRef<SVGPathElement>(null);
  const prog2 = useRef<SVGPathElement>(null);
  const prog3 = useRef<SVGPathElement>(null);

  const showLog = useCallback((m: string, c: string) => {
    setLog({ m, c });
    setTimeout(() => setLog({ m: "", c: "" }), 3000);
  }, []);

  const initAudio = useCallback(() => {
    if (!audioCtx.current) {
      audioCtx.current = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    }
    if (audioCtx.current.state === "suspended") {
      void audioCtx.current.resume();
    }
  }, []);

  const playBeep = useCallback(() => {
    if (muted || !audioCtx.current) return;
    const ctx = audioCtx.current;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "square";
    osc.frequency.setValueAtTime(1250, ctx.currentTime);
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.15, ctx.currentTime + 0.05);
    gain.gain.setValueAtTime(0.15, ctx.currentTime + 0.25);
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.3);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.35);
  }, [muted]);

  useEffect(() => {
    const d = tel;
    if (!d) return;
    const relaysActivos = d.relays;
    if (relaysActivos > 0 && !isOperating.current) {
      isOperating.current = true;
      if (!muted) {
        initAudio();
        playBeep();
        beepInterval.current = setInterval(playBeep, 750);
      }
    } else if (relaysActivos === 0 && isOperating.current) {
      isOperating.current = false;
      if (beepInterval.current) {
        clearInterval(beepInterval.current);
        beepInterval.current = null;
      }
    }
  }, [tel, muted, initAudio, playBeep]);

  useEffect(() => {
    return () => {
      if (beepInterval.current) clearInterval(beepInterval.current);
    };
  }, []);

  useEffect(() => {
    const r = ref(getRtdb(), `telemetry/${unitId}`);
    return onValue(r, (snap) => {
      const v = snap.val() as Telemetry | null;
      if (v) setTel(v);
    });
  }, [unitId]);

  useEffect(() => {
    const u = doc(getDb(), "units", unitId);
    return onSnapshot(u, (s) => {
      if (s.exists()) setCfg(s.data() as UnitCfg);
    });
  }, [unitId]);

  const ajustarPantalla = useCallback(() => {
    const v = cineViewportRef.current;
    const m = cineModeRef.current;
    if (!v || !m) return;
    if (m.style.display !== "flex" && getComputedStyle(m).display !== "flex") return;
    const scale = Math.min(window.innerWidth / 1000, window.innerHeight / 600) * 0.98;
    v.style.transform = `scale(${scale})`;
  }, []);

  useEffect(() => {
    window.addEventListener("resize", ajustarPantalla);
    return () => window.removeEventListener("resize", ajustarPantalla);
  }, [ajustarPantalla]);

  useEffect(() => {
    if (cineOpen) setTimeout(ajustarPantalla, 100);
  }, [cineOpen, ajustarPantalla]);

  useEffect(() => {
    const d = tel;
    if (!d) return;

    const pS =
      d.fase === 0 && d.relays > 0 ? d.prog : d.fase > 0 ? 100 : 0;
    if (prog0.current) prog0.current.style.strokeDashoffset = String(100 - pS);

    const p1 = (d.relays >> 1) & 1 ? 0 : 100;
    if (prog1.current) prog1.current.style.strokeDashoffset = String(p1);

    const p2 = (d.relays >> 2) & 1 ? 0 : 100;
    if (prog2.current) prog2.current.style.strokeDashoffset = String(p2);

    let pB = d.fase === 3 && d.relays > 0 ? d.prog : d.fase < 3 ? 0 : 100;
    if (d.fase === 0 && d.relays === 0) pB = 0;
    if (prog3.current) prog3.current.style.strokeDashoffset = String(100 - pB);

    let angComp = 0;
    if (d.fase === 0) {
      if (d.tS > 0) angComp = (d.ms / d.tS) * -90;
      if (angComp < -90) angComp = -90;
    } else if (d.fase === 1 || d.fase === 2) {
      angComp = -90;
    } else if (d.fase === 3) {
      if (d.tB > 0) {
        let prog = d.ms / d.tB;
        if (prog > 1) prog = 1;
        angComp = -90 + prog * 90;
      }
    }

    if (d.relays & 2) {
      if (anguloTolva.current < 45) anguloTolva.current += VEL_7S;
    } else if (d.relays & 4) {
      if (anguloTolva.current > 0) anguloTolva.current -= VEL_7S;
    }
    if (d.fase === 0 || d.fase === 3) {
      if (anguloTolva.current > 0) anguloTolva.current -= VEL_7S * 2;
      if (anguloTolva.current < 0) anguloTolva.current = 0;
    }

    const tolvaEl = document.getElementById(`tolva-obj-${unitId}`);
    const compEl = document.getElementById(`compuerta-obj-${unitId}`);
    if (tolvaEl) tolvaEl.style.transform = `rotate(${anguloTolva.current.toFixed(1)}deg)`;
    if (compEl) compEl.style.transform = `rotate(${angComp.toFixed(1)}deg)`;

    if (d.alerta && !esperandoReset.current) {
      setAlertaOpen(true);
    }
  }, [tel, unitId]);

  const abrirCine = () => {
    setCineOpen(true);
    void document.documentElement.requestFullscreen?.();
    setTimeout(ajustarPantalla, 100);
    initAudio();
  };

  const cerrarCine = () => {
    setCineOpen(false);
    if (document.exitFullscreen) void document.exitFullscreen();
  };

  const toggleMute = () => {
    initAudio();
    setMuted((m) => !m);
    if (!muted && beepInterval.current) {
      clearInterval(beepInterval.current);
      beepInterval.current = null;
    }
  };

  const p = (n: number) => {
    if (pin.length < 4) setPin((s) => s + String(n));
  };
  const borrarP = () => setPin("");

  const validarAcceso = async () => {
    const res = await fetch("/api/unit/check-pin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ unitId, pin }),
    });
    const j = (await res.json()) as { ok?: boolean };
    if (j.ok) {
      setPanelEdicion(true);
      setPin("");
    } else {
      showLog("PIN ERROR", "var(--rojo)");
      setPin("");
    }
  };

  const bloquear = () => {
    setPanelEdicion(false);
  };

  const saveT = async () => {
    const sEl = document.getElementById(`in-ts-${unitId}`) as HTMLInputElement | null;
    const bEl = document.getElementById(`in-tb-${unitId}`) as HTMLInputElement | null;
    const s = sEl?.value ? Number(sEl.value) : 0;
    const b = bEl?.value ? Number(bEl.value) : 0;
    const patch: Record<string, unknown> = {};
    if (s) patch.pendingPacS_ms = s * 1000;
    if (b) patch.pendingPacB_ms = b * 1000;
    if (Object.keys(patch).length) {
      await updateDoc(doc(getDb(), "units", unitId), patch);
      showLog("TIEMPOS GUARDADOS (pendiente hardware)", "var(--verde)");
    }
  };

  const guardarTodo = async () => {
    const npEl = document.getElementById(`new-pin-${unitId}`) as HTMLInputElement | null;
    const cEl = document.getElementById(`lim-c-${unitId}`) as HTMLInputElement | null;
    const mEl = document.getElementById(`lim-m-${unitId}`) as HTMLInputElement | null;
    const np = npEl?.value?.trim() ?? "";
    const patch: Record<string, unknown> = {};
    if (np.length === 4) patch.pendingPin = np;
    const c = cEl?.value;
    const m = mEl?.value;
    if (c) patch.pendingLimC = Number(c);
    if (m) patch.pendingLimM_min = Number(m);
    if (Object.keys(patch).length) {
      await updateDoc(doc(getDb(), "units", unitId), patch);
    }
    bloquear();
    showLog("CONFIGURACIÓN GUARDADA (pendiente hardware)", "var(--verde)");
  };

  const confirmarMantenimiento = async () => {
    esperandoReset.current = true;
    setAlertaOpen(false);
    await updateDoc(doc(getDb(), "units", unitId), { pendingResetMante: true });
    setTimeout(() => {
      esperandoReset.current = false;
    }, 1500);
  };

  const remoteCmd = async (cmd: number) => {
    await updateDoc(doc(getDb(), "units", unitId), { pendingCmd: cmd });
    showLog(`COMANDO ${cmd} EN COLA`, "var(--verde)");
  };

  const d = tel;
  const nombres = ["ABRIENDO COMPUERTA", "SUBIENDO TOLVA", "BAJANDO TOLVA", "CERRANDO COMPUERTA"];
  const faseTxt =
    !d || d.relays === 0 ? "SISTEMA LISTO" : nombres[d.fase] ?? "—";
  const cron = d ? `${(d.ms / 1000).toFixed(1)}s` : "0.0s";

  const hudVisible =
    d && (d.fase === 0 || d.fase === 3) && d.relays > 0;
  const hudLabel =
    d?.fase === 0 ? "ABRIENDO COMPUERTA" : "CERRANDO COMPUERTA";

  const tsPh = cfg?.pacS_ms != null ? String(cfg.pacS_ms / 1000) : "—";
  const tbPh = cfg?.pacB_ms != null ? String(cfg.pacB_ms / 1000) : "—";
  const lcPh = cfg?.limC != null ? String(cfg.limC) : "—";
  const lmPh = cfg?.limM_min != null ? String(cfg.limM_min) : "—";

  const usoH = d ? Math.floor(d.uso / 3600) : 0;
  const usoM = d ? Math.floor((d.uso % 3600) / 60) : 0;

  return (
    <div className={styles.root}>
      <div
        className={`${styles.alertaOverlay} ${alertaOpen ? styles.alertaOverlayOpen : ""}`}
      >
        <div
          style={{
            textAlign: "center",
            padding: 30,
            border: "2px solid var(--ambar)",
            borderRadius: 20,
            background: "#1a1a1a",
            maxWidth: "80%",
          }}
        >
          <div className={styles.iconoAlerta}>⚠️</div>
          <h2
            className={styles.h2}
            style={{ border: "none", margin: 0, fontSize: "1.2rem" }}
          >
            MANTENIMIENTO REQUERIDO
          </h2>
          <p style={{ color: "#ccc", fontSize: "0.9rem", margin: "15px 0" }}>
            Límite operativo alcanzado.
          </p>
          <div
            style={{
              background: "#000",
              padding: 10,
              borderRadius: 10,
              marginBottom: 20,
              fontSize: "0.8rem",
              textAlign: "left",
            }}
          >
            <div>
              CICLOS:{" "}
              <span style={{ color: "var(--rojo)", float: "right" }}>
                {d?.ciclos ?? 0} / {d?.limC ?? "—"}
              </span>
            </div>
            <div>
              USO:{" "}
              <span style={{ color: "var(--rojo)", float: "right" }}>{usoH}h</span>
            </div>
          </div>
          <button
            type="button"
            className={`${styles.boton} ${styles.btnMante}`}
            onClick={confirmarMantenimiento}
          >
            CONFIRMAR SERVICIO
          </button>
        </div>
      </div>

      <div
        ref={cineModeRef}
        className={`${styles.cineMode} ${cineOpen ? styles.cineModeOpen : ""}`}
      >
        <div className={styles.hudFixed}>
          <div
            className={`${styles.hudContent} ${hudVisible ? styles.hudContentVisible : ""}`}
          >
            <span className={styles.hudLabel}>{hudLabel}</span>
            <div className={styles.hudVal}>{cron}</div>
          </div>
        </div>
        <button
          type="button"
          className={styles.btnVolverFix}
          aria-label="Volver"
          onClick={cerrarCine}
        />
        <div ref={cineViewportRef} className={styles.cineViewport}>
          <div className={styles.truckGroup}>
            <div className={`${styles.truckChassis} ${styles.truckPart}`} />
            <div className={styles.truckBedWrapper} id={`tolva-obj-${unitId}`}>
              <div className={`${styles.truckBedImg} ${styles.truckPart}`} />
              <div
                className={styles.truckGateWrapper}
                id={`compuerta-obj-${unitId}`}
              >
                <div className={`${styles.truckGateImg} ${styles.truckPart}`} />
              </div>
            </div>
          </div>
        </div>
      </div>

      <button
        type="button"
        id={`btn-mute-web-${unitId}`}
        className={styles.btnMuteWeb}
        onClick={toggleMute}
      >
        {muted ? "🔇" : "🔊"}
      </button>

      <div className={styles.contenedor}>
        <button type="button" className={styles.btnAnimacionPro} onClick={abrirCine}>
          VER ANIMACIÓN
        </button>

        <div className={styles.tarjeta}>
          <div className={styles.statusHeader}>
            <div className={styles.badgeOnline}>SISTEMA EN LÍNEA</div>
          </div>
          <div className={styles.relojBig}>{cron}</div>
          <div className={styles.estadoCentro}>{faseTxt}</div>

          <div className={styles.cicloWrap}>
            <div
              className={`${styles.nodo} ${styles.n0} ${d && (d.relays & 1) ? styles.nodoActivo : ""}`}
            >
              <span>
                SUBIDA
                <br />
                COMPUERTA
              </span>
            </div>
            <div
              className={`${styles.nodo} ${styles.n1} ${d && ((d.relays >> 1) & 1) ? styles.nodoActivo : ""}`}
            >
              <span>
                SUBIDA
                <br />
                TOLVA
              </span>
            </div>
            <div
              className={`${styles.nodo} ${styles.n2} ${d && ((d.relays >> 2) & 1) ? styles.nodoActivo : ""}`}
            >
              <span>
                BAJADA
                <br />
                TOLVA
              </span>
            </div>
            <div
              className={`${styles.nodo} ${styles.n3} ${d && ((d.relays >> 3) & 1) ? styles.nodoActivo : ""}`}
            >
              <span>
                BAJADA
                <br />
                COMPUERTA
              </span>
            </div>
            <svg className={styles.flechasSvg} viewBox="0 0 280 280">
              <defs>
                <marker
                  id={`head-on-${unitId}`}
                  markerWidth="10"
                  markerHeight="8"
                  refX="9"
                  refY="4"
                  orient="auto"
                  markerUnits="userSpaceOnUse"
                >
                  <path d="M0,0 L10,4 L0,8 Z" fill="#33adff" />
                </marker>
              </defs>
              <path
                className={styles.pathBg}
                d="M 170 35 Q 245 35 245 110"
              />
              <path
                className={styles.pathBg}
                d="M 245 170 Q 245 245 170 245"
              />
              <path
                className={styles.pathBg}
                d="M 110 245 Q 35 245 35 170"
              />
              <path
                className={styles.pathBg}
                d="M 35 110 Q 35 35 110 35"
              />
              <path
                ref={prog0}
                id={`prog0-${unitId}`}
                className={`${styles.pathProg} ${styles.prog0}`}
                pathLength={100}
                d="M 170 35 Q 245 35 245 110"
                markerEnd={`url(#head-on-${unitId})`}
              />
              <path
                ref={prog1}
                className={`${styles.pathProg} ${styles.prog1}`}
                pathLength={100}
                d="M 245 170 Q 245 245 170 245"
                markerEnd={`url(#head-on-${unitId})`}
              />
              <path
                ref={prog2}
                className={`${styles.pathProg} ${styles.prog2}`}
                pathLength={100}
                d="M 110 245 Q 35 245 35 170"
                markerEnd={`url(#head-on-${unitId})`}
              />
              <path
                ref={prog3}
                className={`${styles.pathProg} ${styles.prog3}`}
                pathLength={100}
                d="M 35 110 Q 35 35 110 35"
                markerEnd={`url(#head-on-${unitId})`}
              />
            </svg>
          </div>
        </div>

        <div className={styles.acordeon}>
          <button
            type="button"
            className={styles.acordeonBtn}
            onClick={() => setHistorialOpen((v) => !v)}
          >
            MANTENIMIENTO <span>{historialOpen ? "▲" : "▼"}</span>
          </button>
          <div
            className={`${styles.acordeonContent} ${historialOpen ? styles.acordeonOpen : ""}`}
          >
            <div className={styles.statRow}>
              <span>Ciclos Totales</span>
              <span>{d?.ciclos ?? "—"}</span>
            </div>
            <div className={styles.statRow}>
              <span>Tiempo de Uso</span>
              <span>
                {usoH}h {usoM}m
              </span>
            </div>
            <div className={styles.statRow}>
              <span>Límite Ciclos</span>
              <span style={{ color: "#888" }}>{d?.limC ?? lcPh}</span>
            </div>
          </div>
        </div>

        <div className={styles.tarjeta}>
          <h2 className={styles.h2}>CONFIGURAR TIEMPOS</h2>
          <div className={styles.grid2mb}>
            <div className={styles.inputGroup}>
              <label htmlFor={`in-ts-${unitId}`}>SUBIDA (S)</label>
              <input
                id={`in-ts-${unitId}`}
                type="number"
                placeholder={tsPh}
              />
            </div>
            <div className={styles.inputGroup}>
              <label htmlFor={`in-tb-${unitId}`}>BAJADA (S)</label>
              <input
                id={`in-tb-${unitId}`}
                type="number"
                placeholder={tbPh}
              />
            </div>
          </div>
          <button type="button" className={`${styles.boton} ${styles.btnAzul}`} onClick={saveT}>
            GUARDAR CAMBIOS
          </button>
        </div>

        <div className={styles.tarjeta}>
          <h2 className={styles.h2}>CONTROL REMOTO</h2>
          <p style={{ fontSize: "0.7rem", color: "#666", marginTop: 0 }}>
            Encola un comando; el PLC lo recibirá en el próximo latido.
          </p>
          <div className={styles.remoteRow}>
            <button type="button" className={styles.remoteBtn} onClick={() => remoteCmd(1)}>
              CMD 1
            </button>
            <button type="button" className={styles.remoteBtn} onClick={() => remoteCmd(2)}>
              CMD 2
            </button>
            <button type="button" className={styles.remoteBtn} onClick={() => remoteCmd(3)}>
              CMD 3
            </button>
            <button type="button" className={styles.remoteBtn} onClick={() => remoteCmd(4)}>
              CMD 4
            </button>
          </div>
        </div>

        <div className={styles.tarjeta}>
          <h2 className={styles.h2}>SEGURIDAD Y LÍMITES</h2>
          {!panelEdicion ? (
            <div id={`panel-bloqueo-${unitId}`}>
              <div className={styles.pinDisplay}>
                {pin.padEnd(4, "_")}
              </div>
              <div className={styles.teclado}>
                <button type="button" className={styles.tecla} onClick={() => p(1)}>
                  1
                </button>
                <button type="button" className={styles.tecla} onClick={() => p(2)}>
                  2
                </button>
                <button type="button" className={styles.tecla} onClick={() => p(3)}>
                  3
                </button>
                <button type="button" className={styles.tecla} onClick={() => p(4)}>
                  4
                </button>
              </div>
              <div className={styles.grid2}>
                <button type="button" className={`${styles.boton} ${styles.btnGris}`} onClick={borrarP}>
                  BORRAR
                </button>
                <button type="button" className={`${styles.boton} ${styles.btnAzul}`} onClick={validarAcceso}>
                  ENTRAR
                </button>
              </div>
            </div>
          ) : (
            <div id={`panel-edicion-${unitId}`}>
              <div className={styles.inputGroup} style={{ marginBottom: 15 }}>
                <label htmlFor={`new-pin-${unitId}`}>CAMBIAR PIN</label>
                <input id={`new-pin-${unitId}`} type="number" placeholder="NUEVO PIN" />
              </div>
              <div style={{ borderTop: "1px solid #333", margin: "10px 0", paddingTop: 15 }}>
                <h2 className={`${styles.h2} ${styles.h2muted}`}>DEFINIR LÍMITES</h2>
                <div className={styles.grid2}>
                  <div className={styles.inputGroup}>
                    <label htmlFor={`lim-c-${unitId}`}>LÍMITE CICLOS</label>
                    <input id={`lim-c-${unitId}`} type="number" placeholder={lcPh} />
                  </div>
                  <div className={styles.inputGroup}>
                    <label htmlFor={`lim-m-${unitId}`}>LÍMITE HORAS</label>
                    <input id={`lim-m-${unitId}`} type="number" placeholder={lmPh} />
                  </div>
                </div>
              </div>
              <button type="button" className={`${styles.boton} ${styles.btnAzul}`} onClick={guardarTodo}>
                GUARDAR TODO
              </button>
              <button type="button" className={`${styles.boton} ${styles.btnGris}`} onClick={bloquear}>
                SALIR
              </button>
            </div>
          )}
        </div>

        <p className={styles.log} style={{ color: log.c || "var(--verde)" }}>
          {log.m}
        </p>
      </div>
    </div>
  );
}
