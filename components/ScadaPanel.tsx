"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import mqtt, { type MqttClient } from "mqtt";
import "./omnitec-scada.css";

// --- CONFIGURACIÓN MQTT LOCAL (UBUNTU) ---
// Cambia la IP local por tu nuevo subdominio con seguridad SSL (wss)
const MQTT_WS_URL = "wss://broker.omnitec.store";
const cmdTopic = (unitId: string) => `omnitec/cmd/${unitId}`;
const telemetryTopic = (unitId: string) => `omnitec/telemetry/${unitId}`;
const ackTopic = (unitId: string) => `omnitec/ack/${unitId}`;

/** Estado alineado con /status del ESP OMNITEC (WifiConfig.h) */
export type Telemetry = {
  fase: number;
  prog: number;
  ms: number;
  tCS: number;
  tCB: number;
  tTS: number;
  tTB: number;
  relays: number;
  ciclos: number;
  uso: number;
  limC: number;
  limM: number;
  net: boolean;
  alerta: boolean;
  pinCheckOk?: boolean;
  authOk?: boolean;
};

const VEL_7S = 0.64;

const SKIP_LOGIN = typeof process !== "undefined" && process.env.NEXT_PUBLIC_OMNITEC_SKIP_LOGIN === "1";
const LOGIN_PIN_STATIC = typeof process !== "undefined" ? process.env.NEXT_PUBLIC_OMNITEC_LOGIN_PIN?.trim() ?? "" : "";

function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function asBool(v: unknown): boolean {
  return v === true || v === "true" || v === 1 || String(v).toLowerCase() === "true";
}

function normalizeTelemetry(raw: Record<string, unknown>): Telemetry {
  return {
    fase: num(raw.fase),
    prog: num(raw.prog),
    ms: num(raw.ms),
    tCS: num(raw.tCS),
    tCB: num(raw.tCB),
    tTS: num(raw.tTS),
    tTB: num(raw.tTB),
    relays: num(raw.relays),
    ciclos: num(raw.ciclos),
    uso: num(raw.uso),
    limC: num(raw.limC),
    limM: num(raw.limM),
    net: asBool(raw.net),
    alerta: asBool(raw.alerta),
    pinCheckOk: asBool(raw.pinCheckOk) || String(raw.pinCheck ?? "").toLowerCase() === "ok",
    authOk: asBool(raw.authOk) || String(raw.authResult ?? "").toUpperCase() === "OK",
  };
}

export function ScadaPanel({ unitId }: { unitId: string }) {
  const [tel, setTel] = useState<Telemetry | null>(null);
  const [authenticated, setAuthenticated] = useState(SKIP_LOGIN);
  const [wifiOpen, setWifiOpen] = useState(false);
  const [historialOpen, setHistorialOpen] = useState(false);
  const [muted, setMuted] = useState(false);
  const [pinLogin, setPinLogin] = useState("");
  const [loginError, setLoginError] = useState("");
  const [pin, setPin] = useState("");
  const [alertaOpen, setAlertaOpen] = useState(false);
  const [cineOpen, setCineOpen] = useState(false);
  /** PIN enviado en telemetría (opcional, fallback local) */
  const [rawPinFromESP, setRawPinFromESP] = useState("");

  const esperandoReset = useRef(false);
  const anguloTolva = useRef(0);
  const audioCtx = useRef<AudioContext | null>(null);
  const beepInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const isOperating = useRef(false);
  const clientRef = useRef<MqttClient | null>(null);
  const historialPanelRef = useRef<HTMLDivElement>(null);
  const pendingPinCheck = useRef(false);
  const pendingAuth = useRef(false);
  const pinCheckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const authTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const publishCmd = useCallback((payload: Record<string, unknown>) => {
    const c = clientRef.current;
    if (!c?.connected) {
        console.warn("[MQTT] No conectado, comando no enviado:", payload);
        return;
    }
    console.log(`[MQTT] Publicando a ${cmdTopic(unitId)}:`, payload);
    c.publish(cmdTopic(unitId), JSON.stringify(payload), { qos: 0 });
  }, [unitId]);

  const showLog = useCallback((m: string, c: string) => {
    const e = document.getElementById("log");
    if (e) {
      e.innerText = m;
      (e as HTMLElement).style.color = c;
      setTimeout(() => { e.innerText = ""; }, 3000);
    }
  }, []);

  const refreshP = useCallback(() => {
    const el = document.getElementById("pin-display");
    if (el) el.innerText = pin.padEnd(4, "_");
  }, [pin]);

  useEffect(() => { refreshP(); }, [pin, refreshP]);

  const initAudio = useCallback(() => {
    if (!audioCtx.current) {
      audioCtx.current = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    }
    if (audioCtx.current.state === "suspended") void audioCtx.current.resume();
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
    document.body.addEventListener("click", initAudio, { once: true });
    return () => document.body.removeEventListener("click", initAudio);
  }, [initAudio]);

  useEffect(() => {
    console.log("[MQTT] Conectando a", MQTT_WS_URL);
    const client = mqtt.connect(MQTT_WS_URL, {
      protocolVersion: 4,
      clientId: `omnitec-web-${Math.random().toString(16).slice(2)}`,
      reconnectPeriod: 3000,
      connectTimeout: 10_000,
    });

    clientRef.current = client;

    const telT = telemetryTopic(unitId);
    const ackT = ackTopic(unitId);

    client.on("connect", () => {
      console.log("[MQTT] Conectado! Suscribiendo a:", telT, ackT);
      client.subscribe(telT, { qos: 0 });
      client.subscribe(ackT, { qos: 0 });
    });

    client.on("message", (topic, buf) => {
      try {
        const raw = JSON.parse(buf.toString()) as Record<string, unknown>;

        if (topic === telT) {
          setTel(normalizeTelemetry(raw));
          if (raw.pin != null) setRawPinFromESP(String(raw.pin));
          return;
        }

        if (topic === ackT) {
          const st = String(raw.status ?? "").toUpperCase();

          if (st === "OK") {
            if (authTimerRef.current) {
              clearTimeout(authTimerRef.current);
              authTimerRef.current = null;
            }
            if (pinCheckTimerRef.current) {
              clearTimeout(pinCheckTimerRef.current);
              pinCheckTimerRef.current = null;
            }

            if (pendingAuth.current) {
              pendingAuth.current = false;
              setAuthenticated(true);
              setPinLogin("");
              setLoginError("");
            }

            if (pendingPinCheck.current) {
              pendingPinCheck.current = false;
              const bloqueo = document.getElementById("panel-bloqueo");
              const edicion = document.getElementById("panel-edicion");
              if (bloqueo) bloqueo.style.display = "none";
              if (edicion) edicion.style.display = "block";
              setPin("");
            }
            return;
          }

          if (st === "ERROR") {
            if (authTimerRef.current) {
              clearTimeout(authTimerRef.current);
              authTimerRef.current = null;
            }
            if (pinCheckTimerRef.current) {
              clearTimeout(pinCheckTimerRef.current);
              pinCheckTimerRef.current = null;
            }

            const errMsg =
              typeof raw.message === "string" && raw.message.trim()
                ? raw.message
                : "PIN INCORRECTO";

            if (pendingAuth.current) {
              pendingAuth.current = false;
              setLoginError(errMsg);
              setPinLogin("");
              const el = document.getElementById("login-pin-display");
              if (el) el.innerText = "____";
            }

            if (pendingPinCheck.current) {
              pendingPinCheck.current = false;
              setPin("");
              showLog(errMsg, "var(--rojo)");
            }
            return;
          }
        }
      } catch {
        /* ignore */
      }
    });

    return () => {
      client.end(true);
      clientRef.current = null;
    };
  }, [unitId]);

  useEffect(() => {
    const d = tel;
    if (!d) return;
    // Si la telemetría incluye el PIN actual (como lo configuramos en el ESP32), validamos localmente.
    // Esto es mucho más rápido y seguro que esperar una respuesta de autenticación.
    if (pendingAuth.current && (rawPinFromESP === pinLogin || d.authOk)) {
      pendingAuth.current = false;
      if (authTimerRef.current) clearTimeout(authTimerRef.current);
      setAuthenticated(true);
      setPinLogin("");
      setLoginError("");
    }
    
    if (pendingPinCheck.current && rawPinFromESP === pin) {
      pendingPinCheck.current = false;
      if (pinCheckTimerRef.current) clearTimeout(pinCheckTimerRef.current);
      const bloqueo = document.getElementById("panel-bloqueo");
      const edicion = document.getElementById("panel-edicion");
      if (bloqueo) bloqueo.style.display = "none";
      if (edicion) edicion.style.display = "block";
      setPin("");
    }
  }, [tel, pinLogin, pin]);

  useEffect(() => {
    return () => {
      if (pinCheckTimerRef.current) clearTimeout(pinCheckTimerRef.current);
      if (authTimerRef.current) clearTimeout(authTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const d = tel;
    if (!d) return;
    checkSonidoOperacion(d.relays);
  }, [tel, muted, initAudio, playBeep]);

  function checkSonidoOperacion(relaysActivos: number) {
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
  }

  useEffect(() => {
    return () => {
      if (beepInterval.current) clearInterval(beepInterval.current);
    };
  }, []);

  const ajustarPantalla = useCallback(() => {
    const v = document.getElementById("cine-viewport");
    const m = document.getElementById("cine-mode");
    if (!v || !m) return;
    if (!m.classList.contains("cine-open")) return;
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
    if (!d || !authenticated) return;

    const cron = document.getElementById("cronometro");
    const faseTxt = document.getElementById("fase-txt");
    if (cron) cron.innerText = `${(d.ms / 1000).toFixed(1)}s`;
    const nombres = ["ABRIENDO COMPUERTA", "SUBIENDO TOLVA", "BAJANDO TOLVA", "CERRANDO COMPUERTA"];
    if (faseTxt) faseTxt.innerText = d.relays === 0 ? "SISTEMA LISTO" : nombres[d.fase] ?? "—";

    const wBtn = document.getElementById("wifi-status-btn");
    if (wBtn) {
      if (d.net) {
        wBtn.innerText = "WIFI: INTERNET";
        wBtn.style.color = "var(--verde)";
        wBtn.style.borderColor = "var(--verde)";
      } else {
        wBtn.innerText = "WIFI: AP LOCAL";
        wBtn.style.color = "var(--ambar)";
        wBtn.style.borderColor = "var(--ambar)";
      }
    }

    for (let i = 0; i < 4; i++) {
      const n = document.getElementById(`n${i}`);
      if (n) {
        if ((d.relays >> i) & 1) n.classList.add("activo");
        else n.classList.remove("activo");
      }
    }

    const f = d.fase;
    const r = d.relays;
    const prog = d.prog;
    let p0 = f === 0 && r > 0 ? prog : f > 0 ? 100 : 0;
    let p1 = f === 1 && r > 0 ? prog : f > 1 ? 100 : 0;
    let p2 = f === 2 && r > 0 ? prog : f > 2 ? 100 : 0;
    let p3 = f === 3 && r > 0 ? prog : f < 3 ? 0 : 100;
    if (f === 0 && r === 0) p3 = 0;

    const el0 = document.getElementById("prog0");
    const el1 = document.getElementById("prog1");
    const el2 = document.getElementById("prog2");
    const el3 = document.getElementById("prog3");
    if (el0) el0.style.strokeDashoffset = String(100 - p0);
    if (el1) el1.style.strokeDashoffset = String(100 - p1);
    if (el2) el2.style.strokeDashoffset = String(100 - p2);
    if (el3) el3.style.strokeDashoffset = String(100 - p3);

    const tolva = document.getElementById("tolva-obj");
    const compuerta = document.getElementById("compuerta-obj");
    let angComp = 0;
    if (f === 0) {
      if (d.tCS > 0) angComp = (d.ms / d.tCS) * -90;
      if (angComp < -90) angComp = -90;
    } else if (f === 1 || f === 2) {
      angComp = -90;
    } else if (f === 3) {
      if (d.tCB > 0) {
        let pr = d.ms / d.tCB;
        if (pr > 1) pr = 1;
        angComp = -90 + pr * 90;
      }
    }

    if (d.relays & 2) {
      if (anguloTolva.current < 45) anguloTolva.current += VEL_7S;
    } else if (d.relays & 4) {
      if (anguloTolva.current > 0) anguloTolva.current -= VEL_7S;
    }
    if (f === 0 || f === 3) {
      if (anguloTolva.current > 0) anguloTolva.current -= VEL_7S * 2;
      if (anguloTolva.current < 0) anguloTolva.current = 0;
    }

    if (tolva) tolva.style.transform = `rotate(${anguloTolva.current.toFixed(1)}deg)`;
    if (compuerta) compuerta.style.transform = `rotate(${angComp.toFixed(1)}deg)`;

    const hC = document.getElementById("h-ciclos");
    const hT = document.getElementById("h-tiempo");
    const hL = document.getElementById("h-limC");
    if (hC) hC.innerText = String(d.ciclos);
    if (hT) hT.innerText = `${Math.floor(d.uso / 3600)}h ${Math.floor((d.uso % 3600) / 60)}m`;
    if (hL) hL.innerText = String(d.limC);

    if (d.alerta && !esperandoReset.current) {
      const ol = document.getElementById("alerta-overlay");
      if (ol && !ol.classList.contains("open")) {
        ol.classList.add("open");
        const oc = document.getElementById("overlay-ciclos");
        const ou = document.getElementById("overlay-uso");
        if (oc) oc.innerText = `${d.ciclos} / ${d.limC}`;
        if (ou) ou.innerText = `${Math.floor(d.uso / 3600)}h`;
      }
      setAlertaOpen(true);
    }
  }, [tel, authenticated]);

  function pLog(n: number) {
    if (pinLogin.length < 4) {
      const next = pinLogin + String(n);
      setPinLogin(next);
      const el = document.getElementById("login-pin-display");
      if (el) el.innerText = next.padEnd(4, "_");
    }
  }

  function borrarPLog() {
    setPinLogin("");
    const el = document.getElementById("login-pin-display");
    if (el) el.innerText = "____";
  }

  function enviarLogin() {
    if (pinLogin.length !== 4) return;

    if (LOGIN_PIN_STATIC && pinLogin === LOGIN_PIN_STATIC) {
      setAuthenticated(true);
      setPinLogin("");
      setLoginError("");
      return;
    }

    const c = clientRef.current;
    if (!c?.connected) {
      setLoginError("SIN CONEXIÓN MQTT");
      setTimeout(() => setLoginError(""), 3500);
      return;
    }

    if (authTimerRef.current) clearTimeout(authTimerRef.current);
    
    // Si ya tenemos el PIN de la telemetría, validamos instantáneo
    if (rawPinFromESP !== "" && pinLogin === rawPinFromESP) {
        setAuthenticated(true);
        setPinLogin("");
        setLoginError("");
        return;
    }

    pendingAuth.current = true;
    publishCmd({ authLogin: pinLogin, checkPin: pinLogin });

    authTimerRef.current = setTimeout(() => {
      if (pendingAuth.current) {
        pendingAuth.current = false;
        setLoginError("PIN INCORRECTO O SIN RESPUESTA");
        borrarPLog();
        setTimeout(() => setLoginError(""), 3000);
      }
    }, 4000);
  }

  function abrirCine() {
    const m = document.getElementById("cine-mode");
    if (m) m.classList.add("cine-open");
    setCineOpen(true);
    void document.documentElement.requestFullscreen?.();
    setTimeout(ajustarPantalla, 100);
    initAudio();
  }

  function cerrarCine() {
    const m = document.getElementById("cine-mode");
    if (m) m.classList.remove("cine-open");
    setCineOpen(false);
    if (document.exitFullscreen) void document.exitFullscreen();
  }

  function toggleMute() {
    initAudio();
    setMuted((m) => {
      const next = !m;
      if (next && beepInterval.current) {
        clearInterval(beepInterval.current);
        beepInterval.current = null;
      }
      return next;
    });
  }

  useEffect(() => {
    const btn = document.getElementById("btn-mute-web");
    if (btn) btn.innerText = muted ? "🔇" : "🔊";
  }, [muted]);

  function toggleHistorial() {
    const p = historialPanelRef.current;
    if (!p) return;
    if (historialOpen) {
      p.style.maxHeight = "";
      setHistorialOpen(false);
    } else {
      p.style.maxHeight = `${p.scrollHeight}px`;
      setHistorialOpen(true);
    }
  }

  function p(n: number) {
    if (pin.length < 4) setPin((s) => s + String(n));
  }

  function borrarP() {
    setPin("");
  }

  function validarAcceso() {
    if (pinCheckTimerRef.current) clearTimeout(pinCheckTimerRef.current);
    
    // Validación instantánea local si el ESP32 mandó el PIN en la telemetría
    if (rawPinFromESP !== "" && pin === rawPinFromESP) {
        const bloqueo = document.getElementById("panel-bloqueo");
        const edicion = document.getElementById("panel-edicion");
        if (bloqueo) bloqueo.style.display = "none";
        if (edicion) edicion.style.display = "block";
        setPin("");
        return;
    }

    pendingPinCheck.current = true;
    publishCmd({ checkPin: pin });

    pinCheckTimerRef.current = setTimeout(() => {
      if (pendingPinCheck.current) {
        pendingPinCheck.current = false;
        showLog("PIN ERROR", "var(--rojo)");
        setPin("");
      }
    }, 3000);
  }

  function bloquear() {
    const bloqueo = document.getElementById("panel-bloqueo");
    const edicion = document.getElementById("panel-edicion");
    if (bloqueo) bloqueo.style.display = "block";
    if (edicion) edicion.style.display = "none";
  }

  function saveT() {
    const cs = (document.getElementById("in-cs") as HTMLInputElement)?.value;
    const cb = (document.getElementById("in-cb") as HTMLInputElement)?.value;
    const ts = (document.getElementById("in-ts") as HTMLInputElement)?.value;
    const tb = (document.getElementById("in-tb") as HTMLInputElement)?.value;
    const payload: Record<string, unknown> = {};
    
    if (cs) payload.tCS = Number(cs) * 1000;
    if (cb) payload.tCB = Number(cb) * 1000;
    if (ts) payload.tTS = Number(ts) * 1000;
    if (tb) payload.tTB = Number(tb) * 1000;
    
    if (Object.keys(payload).length) {
      publishCmd(payload);
      showLog("TIEMPOS GUARDADOS", "var(--verde)");
    }
  }

  function guardarTodo() {
    const payload: Record<string, unknown> = {};
    const np = (document.getElementById("new-pin") as HTMLInputElement)?.value;
    if (np?.length === 4) payload.newPin = np;
    
    const c = (document.getElementById("lim-c") as HTMLInputElement)?.value;
    const m = (document.getElementById("lim-m") as HTMLInputElement)?.value;
    if (c) payload.limC = Number(c);
    if (m) payload.limM = Number(m);
    
    const idu = (document.getElementById("id-uni") as HTMLInputElement)?.value;
    const toku = (document.getElementById("tok-uni") as HTMLInputElement)?.value;
    if (idu) payload.newId = idu;
    if (toku) payload.newToken = toku;
    
    const tp = (document.getElementById("t-apagado") as HTMLInputElement)?.value;
    if (tp) payload.tApagado = Number(tp);
    
    if (Object.keys(payload).length) publishCmd(payload);
    bloquear();
    showLog("GUARDADO", "var(--verde)");
  }

  function confirmarMantenimiento() {
    esperandoReset.current = true;
    const ol = document.getElementById("alerta-overlay");
    if (ol) ol.classList.remove("open");
    setAlertaOpen(false);
    
    publishCmd({ resetMante: "true" });
    
    setTimeout(() => {
      esperandoReset.current = false;
    }, 1500);
  }

  function abrirWiFi() {
    setWifiOpen(true);
    const sel = document.getElementById("wifi-list") as HTMLSelectElement;
    if (sel) {
      sel.innerHTML = "";
      const opt = document.createElement("option");
      opt.value = "";
      opt.text = "Escaneo no disponible vía MQTT, usa el AP local.";
      sel.appendChild(opt);
    }
  }

  function cerrarWiFi() {
    setWifiOpen(false);
  }

  function conectarWiFi() {
    // Para simplificar, esta función se mantiene visual pero la lógica completa de WiFi se hace idealmente desde el AP
    cerrarWiFi();
  }

  const phCS = tel && tel.tCS > 0 ? String(tel.tCS / 1000) : "";
  const phCB = tel && tel.tCB > 0 ? String(tel.tCB / 1000) : "";
  const phTS = tel && tel.tTS > 0 ? String(tel.tTS / 1000) : "";
  const phTB = tel && tel.tTB > 0 ? String(tel.tTB / 1000) : "";
  const phLC = tel && tel.limC > 0 ? String(tel.limC) : "";
  const phLM = tel && tel.limM > 0 ? String(Math.floor(tel.limM / 3600) || Math.floor(tel.limM / 60)) : "";
  const phTP = ""; // El ESP32 no manda tApagado por defecto, puedes añadirlo en main.cpp si lo necesitas

  return (
    <div className="omnitec-scada">
      <div id="auth-overlay" className={authenticated ? "hidden" : undefined}>
        <div
          style={{
            textAlign: "center",
            padding: 30,
            border: "2px solid var(--azul)",
            borderRadius: 20,
            background: "#121212",
            width: "85%",
            maxWidth: 400,
          }}
        >
          <h2
            style={{
              fontSize: "1.2rem",
              border: "none",
              marginBottom: 5,
              color: "white",
            }}
          >
            ACCESO OMNITEC
          </h2>
          <p style={{ color: "#888", fontSize: "0.8rem", marginBottom: 20 }}>
            INGRESE PIN DE ACCESO
          </p>
          <div
            id="login-pin-display"
            style={{
              fontSize: "2.5rem",
              letterSpacing: 15,
              marginBottom: 20,
              color: "var(--ambar)",
            }}
          >
            ____
          </div>
          <div className="teclado">
            <button type="button" className="tecla" onClick={() => pLog(1)}>
              1
            </button>
            <button type="button" className="tecla" onClick={() => pLog(2)}>
              2
            </button>
            <button type="button" className="tecla" onClick={() => pLog(3)}>
              3
            </button>
            <button type="button" className="tecla" onClick={() => pLog(4)}>
              4
            </button>
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 10,
              marginTop: 15,
            }}
          >
            <button type="button" className="boton btn-gris" onClick={borrarPLog}>
              BORRAR
            </button>
            <button type="button" className="boton btn-azul" onClick={enviarLogin}>
              ENTRAR
            </button>
          </div>
          <p
            id="login-error"
            style={{
              color: "var(--rojo)",
              fontSize: "0.75rem",
              marginTop: 10,
              minHeight: "2.5em",
              lineHeight: 1.35,
            }}
          >
            {loginError}
          </p>
        </div>
      </div>

      <div id="alerta-overlay" className={alertaOpen ? "open" : undefined}>
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
          <div className="icono-alerta">⚠️</div>
          <h2 style={{ border: "none", margin: 0, fontSize: "1.2rem" }}>
            MANTENIMIENTO REQUERIDO
          </h2>
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
              <span id="overlay-ciclos" style={{ color: "var(--rojo)", float: "right" }}>
                0
              </span>
            </div>
            <div>
              USO:{" "}
              <span id="overlay-uso" style={{ color: "var(--rojo)", float: "right" }}>
                0h
              </span>
            </div>
          </div>
          <button type="button" className="boton btn-mante" onClick={confirmarMantenimiento}>
            CONFIRMAR SERVICIO
          </button>
        </div>
      </div>

      <div id="wifi-overlay" className={wifiOpen ? "open" : undefined}>
        <div
          style={{
            textAlign: "center",
            padding: 30,
            border: "2px solid var(--azul)",
            borderRadius: 20,
            background: "#1a1a1a",
            width: "80%",
            maxWidth: 400,
          }}
        >
          <h2>CONFIGURAR WIFI INTERNET</h2>
          <select id="wifi-list">
            <option>Escaneando redes...</option>
          </select>
          <input type="password" id="wifi-pass" placeholder="Contraseña Red WiFi" disabled/>
          <button type="button" className="boton btn-azul" onClick={conectarWiFi} disabled>
            CONECTAR
          </button>
          <button type="button" className="boton btn-gris" onClick={cerrarWiFi}>
            CANCELAR
          </button>
        </div>
      </div>

      <div id="cine-mode" className={cineOpen ? "cine-open" : undefined}>
        <div className="hud-fixed">
          <div id="hud-info" className="hud-content">
            <span className="hud-label" id="hud-label-txt">
              ESTADO PAC
            </span>
            <div className="hud-val" id="hud-time-val">
              0.0s
            </div>
          </div>
        </div>
        <button type="button" className="btn-volver-fix" aria-label="Volver" onClick={cerrarCine} />
        <div id="cine-viewport">
          <div id="truck-group">
            <div className="truck-chassis truck-part" />
            <div className="truck-bed-wrapper" id="tolva-obj">
              <div className="truck-bed-img truck-part" />
              <div className="truck-gate-wrapper" id="compuerta-obj">
                <div className="truck-gate-img truck-part" />
              </div>
            </div>
          </div>
        </div>
      </div>

      <button type="button" id="btn-mute-web" onClick={toggleMute}>
        🔊
      </button>

      <div className="contenedor">
        <button type="button" className="btn-animacion-pro" onClick={abrirCine}>
          VER ANIMACIÓN
        </button>

        <div className="tarjeta">
          <div className="status-header">
            <div className="badge-online">{unitId}</div>
            <div
              className="badge-wifi"
              id="wifi-status-btn"
              onClick={abrirWiFi}
              onKeyDown={(e) => e.key === "Enter" && abrirWiFi()}
              role="button"
              tabIndex={0}
            >
              WIFI: AP LOCAL
            </div>
          </div>
          <div id="cronometro" className="reloj-big">
            0.0s
          </div>
          <div id="fase-txt" className="estado-centro">
            SISTEMA LISTO
          </div>

          <div
            className="ciclo-wrapper"
            style={{ position: "relative", height: 280, width: 280, margin: "20px auto" }}
          >
            <div id="n0" className="nodo n0">
              <span>
                SUBIDA
                <br />
                COMPUERTA
              </span>
            </div>
            <div id="n1" className="nodo n1">
              <span>
                SUBIDA
                <br />
                TOLVA
              </span>
            </div>
            <div id="n2" className="nodo n2">
              <span>
                BAJADA
                <br />
                TOLVA
              </span>
            </div>
            <div id="n3" className="nodo n3">
              <span>
                BAJADA
                <br />
                COMPUERTA
              </span>
            </div>
            <svg className="flechas-svg" viewBox="0 0 280 280">
              <defs>
                <marker
                  id="head-on"
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
              <path className="path-bg" d="M 170 35 Q 245 35 245 110" />
              <path className="path-bg" d="M 245 170 Q 245 245 170 245" />
              <path className="path-bg" d="M 110 245 Q 35 245 35 170" />
              <path className="path-bg" d="M 35 110 Q 35 35 110 35" />
              <path
                id="prog0"
                className="path-prog"
                pathLength={100}
                d="M 170 35 Q 245 35 245 110"
                markerEnd="url(#head-on)"
              />
              <path
                id="prog1"
                className="path-prog"
                pathLength={100}
                d="M 245 170 Q 245 245 170 245"
                markerEnd="url(#head-on)"
              />
              <path
                id="prog2"
                className="path-prog"
                pathLength={100}
                d="M 110 245 Q 35 245 35 170"
                markerEnd="url(#head-on)"
              />
              <path
                id="prog3"
                className="path-prog"
                pathLength={100}
                d="M 35 110 Q 35 35 110 35"
                markerEnd="url(#head-on)"
              />
            </svg>
          </div>
        </div>

        <div className="acordeon">
          <button type="button" className="acordeon-btn" onClick={toggleHistorial}>
            MANTENIMIENTO <span>{historialOpen ? "▲" : "▼"}</span>
          </button>
          <div className="acordeon-content" id="historial-panel" ref={historialPanelRef}>
            <div className="stat-row">
              <span>Ciclos Totales</span>
              <span id="h-ciclos">0</span>
            </div>
            <div className="stat-row">
              <span>Tiempo de Uso</span>
              <span id="h-tiempo">0h</span>
            </div>
            <div className="stat-row">
              <span>Límite Ciclos</span>
              <span style={{ color: "#888" }} id="h-limC">
                —
              </span>
            </div>
          </div>
        </div>

        <div className="tarjeta">
          <h2>CONFIGURAR TIEMPOS (SEG)</h2>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div className="input-group">
              <label htmlFor="in-cs">COMPUERTA SUB</label>
              <input type="number" id="in-cs" placeholder={phCS || "—"} />
            </div>
            <div className="input-group">
              <label htmlFor="in-cb">COMPUERTA BAJ</label>
              <input type="number" id="in-cb" placeholder={phCB || "—"} />
            </div>
            <div className="input-group">
              <label htmlFor="in-ts">TOLVA SUB</label>
              <input type="number" id="in-ts" placeholder={phTS || "—"} />
            </div>
            <div className="input-group">
              <label htmlFor="in-tb">TOLVA BAJ</label>
              <input type="number" id="in-tb" placeholder={phTB || "—"} />
            </div>
          </div>
          <button type="button" className="boton btn-azul" onClick={saveT}>
            GUARDAR CAMBIOS
          </button>
        </div>

        <div className="tarjeta">
          <h2>CONFIGURACIÓN AVANZADA</h2>
          <div id="panel-bloqueo">
            <div
              id="pin-display"
              style={{
                fontSize: "2rem",
                letterSpacing: 15,
                textAlign: "center",
                marginBottom: 10,
                color: "var(--ambar)",
              }}
            >
              ____
            </div>
            <div className="teclado">
              <button type="button" className="tecla" onClick={() => p(1)}>
                1
              </button>
              <button type="button" className="tecla" onClick={() => p(2)}>
                2
              </button>
              <button type="button" className="tecla" onClick={() => p(3)}>
                3
              </button>
              <button type="button" className="tecla" onClick={() => p(4)}>
                4
              </button>
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 10,
                marginTop: 10,
              }}
            >
              <button type="button" className="boton btn-gris" onClick={borrarP}>
                BORRAR
              </button>
              <button type="button" className="boton btn-azul" onClick={validarAcceso}>
                ENTRAR
              </button>
            </div>
          </div>
          <div id="panel-edicion" style={{ display: "none" }}>
            <div className="input-group" style={{ marginBottom: 15 }}>
              <label htmlFor="new-pin">CAMBIAR PIN</label>
              <input type="number" id="new-pin" placeholder="NUEVO PIN" />
            </div>
            <div style={{ borderTop: "1px solid #333", margin: "10px 0", paddingTop: 15 }}>
              <h2 style={{ border: "none", color: "#888", fontSize: "0.75rem" }}>
                IDENTIDAD Y CONEXIÓN
              </h2>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <div className="input-group">
                  <label htmlFor="id-uni">ID UNIDAD</label>
                  <input type="text" id="id-uni" placeholder={unitId} />
                </div>
                <div className="input-group">
                  <label htmlFor="tok-uni">TOKEN API</label>
                  <input type="text" id="tok-uni" placeholder="••••••" />
                </div>
              </div>
            </div>
            <div style={{ borderTop: "1px solid #333", margin: "10px 0", paddingTop: 15 }}>
              <h2 style={{ border: "none", color: "#888", fontSize: "0.75rem" }}>
                LÍMITES Y PANTALLA
              </h2>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <div className="input-group">
                  <label htmlFor="lim-c">LÍMITE CICLOS</label>
                  <input type="number" id="lim-c" placeholder={phLC || "—"} />
                </div>
                <div className="input-group">
                  <label htmlFor="lim-m">LÍMITE HORAS</label>
                  <input type="number" id="lim-m" placeholder={phLM || "—"} />
                </div>
                <div className="input-group">
                  <label htmlFor="t-apagado">PANTALLA (MIN)</label>
                  <input type="number" step={0.1} id="t-apagado" placeholder={phTP || "—"} />
                </div>
              </div>
            </div>
            <button type="button" className="boton btn-azul" onClick={guardarTodo}>
              GUARDAR TODO
            </button>
            <button type="button" className="boton btn-gris" onClick={bloquear}>
              SALIR
            </button>
          </div>
        </div>

        <p
          id="log"
          style={{
            textAlign: "center",
            fontSize: "0.8rem",
            color: "var(--verde)",
            fontWeight: "bold",
            minHeight: "1em",
          }}
        />
      </div>
    </div>
  );
}