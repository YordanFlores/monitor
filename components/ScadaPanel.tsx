"use client";

import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type MouseEvent,
} from "react";
import { useRouter } from "next/navigation";
import mqtt, { type MqttClient } from "mqtt";
import { drawActividadDiariaChart } from "@/lib/chart-actividad";
import {
  buildCajaDayBlocks,
  buildChartPointsFromCsv,
  getColorForEvent,
  groupLogsByDay,
  parseLogLine,
  type LogsByDay,
} from "@/lib/caja-negra";
import {
  type PlcConfigJson,
  fetchPlcConfig,
  getPlcConfigOrigin,
  resolveEspLanOrigin,
} from "@/lib/esp-api";
import { buildMqttWebSocketUrl, cmdTopic, otaTopic, telemetryTopic } from "@/lib/omnitec-mqtt";
import {
  mqttPayloadApagadoMin,
  mqttPayloadIdentidad,
  mqttPayloadMantePin,
  mqttPayloadNewOperPin,
  mqttPayloadResetMante,
  mqttPayloadSetMante,
  mqttPayloadSetMode,
  mqttPayloadSetT,
  mqttPayloadSnoozeMante,
} from "@/lib/plc-mqtt";
import "./omnitec-scada.css";
const ackTopic = (id: string) => `omnitec/ack/${id}`;

/**
 * Telemetría omnitec/telemetry/{unitId} (JSON). Núcleo mínimo + campos opcionales
 * (tCS… prog, net, authOk) si el firmware los publica.
 */
export type Telemetry = {
  plcM: boolean;
  ms: number;
  rout: number;
  step: number;
  col: number;
  relays: number;
  fase: number;
  ciclos: number;
  uso: number;
  alerta: boolean;
  prog?: number;
  /** Duraciones en ms (solo si el JSON las incluye; si no, no forzar 0). */
  tCS?: number;
  tCB?: number;
  tTS?: number;
  tTB?: number;
  /** Alternativa: segundos en telemetría (cs/cb/ts/tb). */
  cs?: number;
  cb?: number;
  ts?: number;
  tb?: number;
  limC?: number;
  limM?: number;
  net?: boolean;
  silenciada?: boolean;
  pin?: string;
  authOk?: boolean;
  pinCheckOk?: boolean;
  deviceId?: string;
  /** Últimas líneas de caja negra (mismo formato que WebUI), enviadas por MQTT en telemetría (`cn`). */
  cn?: string[];
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

/** Compatible con firmwares que usan distintos nombres (ver README). */
function telemetryAuthOk(raw: Record<string, unknown>): boolean {
  const cr = String(raw.checkPinResult ?? raw.checkResult ?? "").toLowerCase();
  const res = String(raw.result ?? "").toLowerCase();
  return (
    asBool(raw.authOk) ||
    asBool(raw.loginOk) ||
    asBool(raw.sessionOk) ||
    asBool(raw.authLoginOk) ||
    asBool(raw.pinOk) ||
    asBool(raw.checkPinOk) ||
    asBool(raw.accessGranted) ||
    asBool(raw.unlocked) ||
    asBool(raw.configUnlocked) ||
    String(raw.authResult ?? "").toUpperCase() === "OK" ||
    String(raw.loginResult ?? "").toUpperCase() === "OK" ||
    String(raw.checkPin ?? "").toLowerCase() === "ok" ||
    cr === "ok" ||
    cr === "success" ||
    res === "ok" ||
    res === "success" ||
    res === "pin_ok"
  );
}

function telemetryPinCheckOk(raw: Record<string, unknown>): boolean {
  return (
    asBool(raw.pinCheckOk) ||
    asBool(raw.configUnlocked) ||
    String(raw.pinCheck ?? "").toLowerCase() === "ok"
  );
}

/** ID en telemetría: nombres habituales en firmware OMNITEC. */
function pickDeviceId(raw: Record<string, unknown>): string | null {
  const v = raw.id ?? raw.idUnidad ?? raw.unitId ?? raw.deviceId ?? raw.nombreUnidad;
  if (v == null) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

/** Solo si la clave existe en el JSON (evita confundir ausencia con 0). */
function optNum(raw: Record<string, unknown>, key: string): number | undefined {
  if (!(key in raw) || raw[key] === undefined || raw[key] === null) return undefined;
  const n = Number(raw[key]);
  return Number.isFinite(n) ? n : undefined;
}

/** Igual que el HTML del ESP: valor escrito o, si está vacío, el placeholder (s). */
function readSecFromInputOrPh(id: string, placeholderSec: string): number {
  if (typeof document === "undefined") return NaN;
  const el = document.getElementById(id) as HTMLInputElement | null;
  const raw = el?.value?.trim() ?? "";
  if (raw !== "") {
    const n = Number(raw.replace(",", "."));
    return Number.isFinite(n) ? n : NaN;
  }
  const p = placeholderSec.trim();
  if (p !== "" && p !== "—") {
    const n = Number(p.replace(",", "."));
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

function readStrFromInputOrPh(id: string, ph: string): string {
  if (typeof document === "undefined") return "";
  const el = document.getElementById(id) as HTMLInputElement | null;
  const raw = el?.value?.trim() ?? "";
  if (raw !== "") return raw;
  return ph.trim();
}

function parseCnTelemetry(raw: Record<string, unknown>): string[] | undefined {
  const v = raw.cn;
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const x of v) {
    if (typeof x === "string" && x.trim()) out.push(x.trim());
  }
  return out.length > 0 ? out : undefined;
}

function normalizeLiveTelemetry(raw: Record<string, unknown>): Telemetry {
  const deviceId = pickDeviceId(raw) ?? undefined;
  const pin = raw.pin != null ? String(raw.pin) : undefined;
  const progN = num(raw.prog, NaN);
  return {
    plcM: asBool(raw.plcM),
    ms: num(raw.ms),
    rout: num(raw.rout),
    step: num(raw.step),
    col: num(raw.col),
    relays: num(raw.relays),
    fase: num(raw.fase),
    ciclos: num(raw.ciclos),
    uso: num(raw.uso),
    alerta: asBool(raw.alerta),
    prog: Number.isFinite(progN) ? progN : undefined,
    tCS: optNum(raw, "tCS"),
    tCB: optNum(raw, "tCB"),
    tTS: optNum(raw, "tTS"),
    tTB: optNum(raw, "tTB"),
    cs: optNum(raw, "cs"),
    cb: optNum(raw, "cb"),
    ts: optNum(raw, "ts"),
    tb: optNum(raw, "tb"),
    limC: optNum(raw, "limC"),
    limM: optNum(raw, "limM"),
    net: raw.net !== undefined ? asBool(raw.net) : undefined,
    silenciada: raw.silenciada !== undefined ? asBool(raw.silenciada) : undefined,
    pin,
    pinCheckOk: telemetryPinCheckOk(raw),
    authOk: telemetryAuthOk(raw),
    deviceId,
    cn: parseCnTelemetry(raw),
  };
}

function msFromTelOrCfg(
  tel: Telemetry,
  ms: keyof Pick<Telemetry, "tCS" | "tCB" | "tTS" | "tTB">,
  sec: keyof Pick<Telemetry, "cs" | "cb" | "ts" | "tb">,
  cfgSec: number,
): number {
  const v = tel[ms];
  if (v != null && Number.isFinite(v)) return Math.max(0, v);
  const s = tel[sec];
  if (s != null && Number.isFinite(s)) return Math.max(0, s) * 1000;
  return Math.max(0, cfgSec) * 1000;
}

function gateTolvaMs(cfg: PlcConfigJson | null, tel: Telemetry | null) {
  if (tel) {
    const hasAnyTel =
      tel.tCS != null ||
      tel.tCB != null ||
      tel.tTS != null ||
      tel.tTB != null ||
      tel.cs != null ||
      tel.cb != null ||
      tel.ts != null ||
      tel.tb != null;
    if (hasAnyTel || cfg) {
      const c = cfg;
      return {
        tCS: msFromTelOrCfg(tel, "tCS", "cs", c?.cs ?? 0),
        tCB: msFromTelOrCfg(tel, "tCB", "cb", c?.cb ?? 0),
        tTS: msFromTelOrCfg(tel, "tTS", "ts", c?.ts ?? 0),
        tTB: msFromTelOrCfg(tel, "tTB", "tb", c?.tb ?? 0),
      };
    }
  }
  if (cfg) {
    return {
      tCS: Math.max(0, cfg.cs) * 1000,
      tCB: Math.max(0, cfg.cb) * 1000,
      tTS: Math.max(0, cfg.ts) * 1000,
      tTB: Math.max(0, cfg.tb) * 1000,
    };
  }
  return { tCS: 0, tCB: 0, tTS: 0, tTB: 0 };
}

/** Duración de la fase actual en ms (orden igual que configPhaseMs: CS, TS, TB, CB). */
function phaseDurationMsNow(t: Telemetry, cfg: PlcConfigJson | null): number {
  const gt = gateTolvaMs(cfg, t);
  const byFase = [gt.tCS, gt.tTS, gt.tTB, gt.tCB];
  return byFase[t.fase] ?? 0;
}

/** Progreso 0–100: telemetría `prog` o estimación desde ms y tiempos (MQTT o /api/config). */
function computePhaseProg(t: Telemetry, cfg: PlcConfigJson | null): number {
  if (typeof t.prog === "number" && Number.isFinite(t.prog)) {
    return Math.min(100, Math.max(0, t.prog));
  }
  const dur = phaseDurationMsNow(t, cfg);
  if (dur <= 0) return 0;
  return Math.min(100, (t.ms / dur) * 100);
}

/** ACK omnitec/ack/{unitId} — JSON o texto plano. */
function parseMqttAck(buf: Buffer): { ok: true } | { ok: false; message: string } | null {
  const t = buf.toString().trim();
  if (!t) return null;
  if (/^OK$/i.test(t)) return { ok: true };
  if (/^(SUCCESS|TRUE|PIN_OK|PIN OK)$/i.test(t)) return { ok: true };
  const errPlain = t.match(/^ERROR\s*(.*)$/i);
  if (errPlain) {
    return { ok: false, message: errPlain[1]?.trim() || "PIN INCORRECTO" };
  }
  try {
    const raw = JSON.parse(t) as Record<string, unknown>;
    const st = String(raw.status ?? raw.result ?? "").toUpperCase();
    const msg =
      typeof raw.message === "string" && raw.message.trim()
        ? raw.message.trim()
        : "PIN INCORRECTO";
    if (
      st === "OK" ||
      raw.success === true ||
      telemetryAuthOk(raw) ||
      asBool(raw.checkPinOk)
    ) {
      return { ok: true };
    }
    if (st === "ERROR" || raw.success === false) return { ok: false, message: msg };
  } catch {
    /* ignore */
  }
  return null;
}

/** Telemetría: JSON directo, o string JSON anidado, o `{ data: "..." }`. */
function parseTelemetryJson(buf: Buffer): Record<string, unknown> | null {
  const t = buf.toString().trim();
  if (!t) return null;
  try {
    const raw: unknown = JSON.parse(t);
    if (typeof raw === "string") {
      try {
        const inner = JSON.parse(raw) as unknown;
        if (inner && typeof inner === "object" && !Array.isArray(inner)) {
          return inner as Record<string, unknown>;
        }
        return null;
      } catch {
        return null;
      }
    }
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const o = raw as Record<string, unknown>;
      if (typeof o.data === "string") {
        try {
          const inner = JSON.parse(o.data) as unknown;
          if (inner && typeof inner === "object" && !Array.isArray(inner)) {
            return inner as Record<string, unknown>;
          }
        } catch {
          /* usar objeto raíz */
        }
      }
      return o;
    }
    return null;
  } catch {
    return null;
  }
}

export function ScadaPanel({ unitId }: { unitId: string }) {
  const router = useRouter();
  /** Tópicos MQTT: se actualiza con la URL y con el ID que manda el PLC en telemetría. */
  const [mqttUnitId, setMqttUnitId] = useState(unitId);

  const [tel, setTel] = useState<Telemetry | null>(null);
  const [authenticated, setAuthenticated] = useState(SKIP_LOGIN);
  const [wifiOpen, setWifiOpen] = useState(false);
  const [historialOpen, setHistorialOpen] = useState(false);
  const [muted, setMuted] = useState(false);
  const [pinLogin, setPinLogin] = useState("");
  const [loginError, setLoginError] = useState("");
  const [pin, setPin] = useState("");
  const [alertaOpen, setAlertaOpen] = useState(false);
  const [manteAuthOpen, setManteAuthOpen] = useState(false);
  const [pinMante, setPinMante] = useState("");
  const [mqttConnected, setMqttConnected] = useState(false);
  const [cineOpen, setCineOpen] = useState(false);
  const [otaOpen, setOtaOpen] = useState(false);
  const [otaBusy, setOtaBusy] = useState(false);
  const [logoUploadBusy, setLogoUploadBusy] = useState(false);
  const [logoNombreArchivo, setLogoNombreArchivo] = useState("Ningún archivo seleccionado");
  /** PIN usado al desbloquear config avanzada — para /authLogin en el ESP al subir logo. */
  const pinRef = useRef("");
  const espAuthPinRef = useRef("");
  const [chartOpen, setChartOpen] = useState(false);
  const [downloadOpen, setDownloadOpen] = useState(false);
  const [rtcOpen, setRtcOpen] = useState(false);
  const [cajaOpen, setCajaOpen] = useState(false);
  const [plcEditorOpen, setPlcEditorOpen] = useState(false);
  const [cajaGrouped, setCajaGrouped] = useState<LogsByDay | null>(null);
  const [cajaLoading, setCajaLoading] = useState(false);
  const [dlTipo, setDlTipo] = useState<"todo" | "rango">("todo");
  const [dlDesde, setDlDesde] = useState("");
  const [dlHasta, setDlHasta] = useState("");
  const [cajaDayOpen, setCajaDayOpen] = useState<Record<string, boolean>>({});
  const chartCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const cajaBlocks = useMemo(() => {
    if (!cajaGrouped || Object.keys(cajaGrouped).length === 0) return [];
    return buildCajaDayBlocks(cajaGrouped);
  }, [cajaGrouped]);
  /** PIN enviado en telemetría (opcional, fallback local) */
  const [rawPinFromESP, setRawPinFromESP] = useState("");

  const esperandoReset = useRef(false);
  const anguloTolva = useRef(0);
  const audioCtx = useRef<AudioContext | null>(null);
  const beepInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const isOperating = useRef(false);
  const clientRef = useRef<MqttClient | null>(null);
  const historialPanelRef = useRef<HTMLDivElement>(null);
  const pendingAuth = useRef(false);
  const pendingPinCheck = useRef(false);
  const authTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pinCheckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Origen HTTP para GET /api/config (CONFIG_ORIGIN o ESP_ORIGIN). */
  const configOrigin = useMemo(() => getPlcConfigOrigin(), []);
  /** Origen del AP del equipo (OTA, logs, lógica) — mismo host que el ESP en LAN. */
  const espLanOrigin = useMemo(() => resolveEspLanOrigin(), []);
  const [plcConfig, setPlcConfig] = useState<PlcConfigJson | null>(null);
  /** Evita pisar inputs mientras el usuario edita; fuera de foco se reflejan cambios del PLC vía MQTT. */
  const [liveFieldFocus, setLiveFieldFocus] = useState<string | null>(null);
  const telRef = useRef<Telemetry | null>(null);
  /** Agrupa setTel en un frame para no re-renderizar en cada mensaje MQTT (UI y PIN lentos). */
  const telFlushRafRef = useRef<number | null>(null);
  const pendingTelRef = useRef<Telemetry | null>(null);
  /** Si el historial vino de GET /api/unit-logs, no lo pisa la telemetría `cn` (suele ser más corta / otro formato). */
  const cajaFromServerRef = useRef(false);

  const publishCmd = useCallback(
    (payload: Record<string, unknown>): boolean => {
      const c = clientRef.current;
      if (!c?.connected) {
        console.warn("[MQTT] No conectado al broker, comando no enviado:", payload);
        return false;
      }
      const topic = cmdTopic(mqttUnitId);
      c.publish(topic, JSON.stringify(payload), { qos: 0 });
      return true;
    },
    [mqttUnitId],
  );

  useEffect(() => {
    telRef.current = tel;
  }, [tel]);

  useEffect(() => {
    pinRef.current = pin;
  }, [pin]);

  /** Caja negra vía MQTT (`cn`): solo si no cargamos historial completo del servidor; no pisar con parseo vacío. */
  useEffect(() => {
    if (cajaFromServerRef.current) return;
    const lines = tel?.cn;
    if (!lines?.length) return;
    const grouped = groupLogsByDay(lines.join("\n"));
    if (Object.keys(grouped).length === 0) return;
    setCajaGrouped(grouped);
  }, [tel]);

  useEffect(() => {
    setMqttUnitId(unitId);
  }, [unitId]);

  useEffect(() => {
    cajaFromServerRef.current = false;
    setLiveFieldFocus(null);
  }, [mqttUnitId]);

  useEffect(() => {
    if (mqttUnitId !== unitId) {
      router.replace(`/unit/${encodeURIComponent(mqttUnitId)}/scada`);
    }
  }, [mqttUnitId, unitId, router]);

  /** Misma lógica que WifiConfig.h: icono + borde/sombra según color, clase .show 2500ms */
  const showLog = useCallback((m: string, c: string) => {
    const t = document.getElementById("toast-overlay");
    if (!t) return;
    let icon = "✅";
    if (c.includes("rojo") || c.includes("ff4444")) icon = "❌";
    if (c.includes("ambar") || c.includes("FFBF00")) icon = "⚠️";
    t.innerHTML = `<div style="font-size: 2.5rem; margin-bottom: 10px;">${icon}</div>${m}`;
    const el = t as HTMLElement;
    el.style.borderColor = c;
    el.style.boxShadow = `0 15px 35px rgba(0,0,0,0.8), 0 0 25px ${c} inset`;
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    t.classList.add("show");
    toastTimerRef.current = setTimeout(() => {
      t.classList.remove("show");
      toastTimerRef.current = null;
    }, 2500);
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

  /** MQTT (WebSocket seguro): telemetría + ACK en tópicos separados (Mosquitto vía Nginx). */
  useEffect(() => {
    const wsUrl = buildMqttWebSocketUrl();
    console.log("[MQTT] Conectando a", wsUrl);
    const client = mqtt.connect(wsUrl, {
      protocolVersion: 4,
      clientId: `omnitec-web-${Math.random().toString(16).slice(2)}`,
      reconnectPeriod: 3000,
      connectTimeout: 10_000,
    });
    clientRef.current = client;

    const telT = telemetryTopic(mqttUnitId);
    const ackT = ackTopic(mqttUnitId);

    const clearTimers = () => {
      if (authTimerRef.current) {
        clearTimeout(authTimerRef.current);
        authTimerRef.current = null;
      }
      if (pinCheckTimerRef.current) {
        clearTimeout(pinCheckTimerRef.current);
        pinCheckTimerRef.current = null;
      }
    };

    const applyAckOk = () => {
      clearTimers();
      if (pendingAuth.current) {
        pendingAuth.current = false;
        setAuthenticated(true);
        setPinLogin("");
        setLoginError("");
      }
      if (pendingPinCheck.current) {
        pendingPinCheck.current = false;
        espAuthPinRef.current = pinRef.current;
        const bloqueo = document.getElementById("panel-bloqueo");
        const edicion = document.getElementById("panel-edicion");
        if (bloqueo) bloqueo.style.display = "none";
        if (edicion) edicion.style.display = "block";
        setPin("");
      }
    };

    const applyAckErr = (errMsg: string) => {
      clearTimers();
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
    };

    const onConn = () => {
      setMqttConnected(true);
      console.log("[MQTT] Suscrito a:", telT, ackT);
      client.subscribe(telT, { qos: 0 });
      client.subscribe(ackT, { qos: 0 });
    };
    client.on("connect", onConn);
    client.on("close", () => setMqttConnected(false));
    client.on("offline", () => setMqttConnected(false));
    client.on("disconnect", () => setMqttConnected(false));

    client.on("message", (topic, buf) => {
      if (topic === ackT) {
        const parsed = parseMqttAck(buf);
        if (!parsed) {
          if (process.env.NODE_ENV === "development") {
            console.warn("[MQTT] ACK no reconocido:", buf.toString().slice(0, 160));
          }
          return;
        }
        if (parsed.ok) applyAckOk();
        else applyAckErr(parsed.message);
        return;
      }

      if (topic !== telT) return;

      const raw = parseTelemetryJson(buf);
      if (!raw) {
        if (process.env.NODE_ENV === "development") {
          console.warn("[MQTT] Telemetría no parseable en", telT, buf.toString().slice(0, 200));
        }
        return;
      }
      pendingTelRef.current = normalizeLiveTelemetry(raw);
      if (raw.pin != null) setRawPinFromESP(String(raw.pin));
      if (telFlushRafRef.current == null) {
        telFlushRafRef.current = requestAnimationFrame(() => {
          telFlushRafRef.current = null;
          const next = pendingTelRef.current;
          if (next) setTel(next);
        });
      }
    });

    return () => {
      if (telFlushRafRef.current != null) {
        cancelAnimationFrame(telFlushRafRef.current);
        telFlushRafRef.current = null;
      }
      setMqttConnected(false);
      client.end(true);
      clientRef.current = null;
    };
  }, [mqttUnitId, showLog]);

  /**
   * Tras iniciar sesión: lectura única de parámetros NV (GET /api/config).
   * Requiere NEXT_PUBLIC_OMNITEC_CONFIG_ORIGIN o NEXT_PUBLIC_OMNITEC_ESP_ORIGIN alcanzable desde el navegador.
   * El ID de tópicos MQTT sigue la ruta /unit/[unitId]/scada (no se sobrescribe con c.id) para no perder telemetría.
   */
  useEffect(() => {
    if (!authenticated || !configOrigin) return;
    let cancelled = false;
    void fetchPlcConfig(configOrigin).then((c) => {
      if (cancelled || !c) return;
      setPlcConfig(c);
    });
    return () => {
      cancelled = true;
    };
  }, [authenticated, configOrigin]);

  useEffect(() => {
    const d = tel;
    if (!d) return;
    const pinMatch =
      rawPinFromESP.trim() === pinLogin.trim() ||
      (rawPinFromESP.trim().length > 0 &&
        pinLogin.trim().length > 0 &&
        rawPinFromESP.trim().padStart(4, "0") === pinLogin.trim().padStart(4, "0"));
    if (pendingAuth.current && (pinMatch || d.authOk)) {
      pendingAuth.current = false;
      if (authTimerRef.current) {
        clearTimeout(authTimerRef.current);
        authTimerRef.current = null;
      }
      setAuthenticated(true);
      setPinLogin("");
      setLoginError("");
    }
    if (pendingPinCheck.current && (rawPinFromESP === pin || d.pinCheckOk)) {
      pendingPinCheck.current = false;
      espAuthPinRef.current = pinRef.current;
      if (pinCheckTimerRef.current) {
        clearTimeout(pinCheckTimerRef.current);
        pinCheckTimerRef.current = null;
      }
      const bloqueo = document.getElementById("panel-bloqueo");
      const edicion = document.getElementById("panel-edicion");
      if (bloqueo) bloqueo.style.display = "none";
      if (edicion) edicion.style.display = "block";
      setPin("");
    }
  }, [tel, pinLogin, pin, rawPinFromESP]);

  useEffect(() => {
    return () => {
      if (pinCheckTimerRef.current) clearTimeout(pinCheckTimerRef.current);
      if (authTimerRef.current) clearTimeout(authTimerRef.current);
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
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

    const gt = gateTolvaMs(plcConfig, d);
    const prog =
      typeof d.prog === "number" && Number.isFinite(d.prog)
        ? Math.min(100, Math.max(0, d.prog))
        : computePhaseProg(d, plcConfig);
    const limC = plcConfig?.lc ?? d.limC;

    const cron = document.getElementById("cronometro-cls");
    const faseTxt = document.getElementById("fase-txt");
    const hudT = document.getElementById("hud-time-val");
    const sec = (d.ms / 1000).toFixed(1);
    if (cron) cron.innerText = `${sec}s`;
    if (hudT) hudT.innerText = `${sec}s`;

    const nombres = ["ABRIENDO COMPUERTA", "SUBIENDO TOLVA", "BAJANDO TOLVA", "CERRANDO COMPUERTA"];
    if (faseTxt) {
      if (d.plcM) {
        faseTxt.innerText = `PLC · R${d.rout} · COL ${d.col} · PASO ${d.step + 1}`;
      } else {
        faseTxt.innerText = d.relays === 0 ? "SISTEMA LISTO v2.0" : nombres[d.fase] ?? "—";
      }
    }

    const setWifiBadge = (el: HTMLElement | null) => {
      if (!el) return;
      if (d.net !== undefined) {
        if (d.net) {
          el.innerText = "📡 WIFI: INTERNET";
          el.style.color = "var(--verde)";
          el.style.borderColor = "var(--verde)";
        } else {
          el.innerText = "📡 WIFI: AP LOCAL";
          el.style.color = "var(--ambar)";
          el.style.borderColor = "var(--ambar)";
        }
      } else {
        el.innerText = "📡 MQTT";
        el.style.color = "var(--ambar)";
        el.style.borderColor = "var(--ambar)";
      }
    };
    setWifiBadge(document.getElementById("wifi-status-btn"));
    setWifiBadge(document.getElementById("wifi-status-btn-plc"));

    const cronPlc = document.getElementById("cronometro-plc");
    if (cronPlc) cronPlc.innerText = `${sec}s`;
    const plcFase = document.getElementById("plc-fase-txt");
    if (plcFase && d.plcM) {
      plcFase.innerText = `PLC · R${d.rout} · COL ${d.col} · PASO ${d.step + 1}`;
    }

    for (let i = 0; i < 4; i++) {
      const n = document.getElementById(`n${i}`);
      if (n) {
        if ((d.relays >> i) & 1) n.classList.add("activo");
        else n.classList.remove("activo");
      }
      const rn = document.getElementById(`rn${i}`);
      if (rn) {
        if ((d.relays >> i) & 1) rn.classList.add("activo");
        else rn.classList.remove("activo");
      }
    }

    const f = d.fase;
    const r = d.relays;
    let p0 = 0;
    let p1 = 0;
    let p2 = 0;
    let p3 = 0;
    if (!d.plcM) {
      p0 = f === 0 && r > 0 ? prog : f > 0 ? 100 : 0;
      p1 = f === 1 && r > 0 ? prog : f > 1 ? 100 : 0;
      p2 = f === 2 && r > 0 ? prog : f > 2 ? 100 : 0;
      p3 = f === 3 && r > 0 ? prog : f < 3 ? 0 : 100;
      if (f === 0 && r === 0) p3 = 0;
    }

    const el0 = document.getElementById("prog0");
    const el1 = document.getElementById("prog1");
    const el2 = document.getElementById("prog2");
    const el3 = document.getElementById("prog3");
    if (el0) el0.style.strokeDashoffset = String(100 - p0);
    if (el1) el1.style.strokeDashoffset = String(100 - p1);
    if (el2) el2.style.strokeDashoffset = String(100 - p2);
    if (el3) el3.style.strokeDashoffset = String(100 - p3);

    if (!d.plcM) {
      let angComp = 0;
      if (f === 0) {
        if (gt.tCS > 0) angComp = (d.ms / gt.tCS) * -90;
        if (angComp < -90) angComp = -90;
      } else if (f === 1 || f === 2) {
        angComp = -90;
      } else if (f === 3) {
        if (gt.tCB > 0) {
          let pr = d.ms / gt.tCB;
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

      document.querySelectorAll(".omnitec-scada .truck-bed-wrapper").forEach((el) => {
        (el as HTMLElement).style.transform = `rotate(${anguloTolva.current.toFixed(1)}deg)`;
      });
      document.querySelectorAll(".omnitec-scada .truck-gate-wrapper").forEach((el) => {
        (el as HTMLElement).style.transform = `rotate(${angComp.toFixed(1)}deg)`;
      });
    }

    const hC = document.getElementById("h-ciclos");
    const hT = document.getElementById("h-tiempo");
    const hL = document.getElementById("h-limC");
    if (hC) hC.innerText = String(d.ciclos);
    if (hT) hT.innerText = `${Math.floor(d.uso / 3600)}h ${Math.floor((d.uso % 3600) / 60)}m`;
    if (hL) hL.innerText = limC != null ? String(limC) : "—";

    if (d.alerta && !esperandoReset.current) {
      const ol = document.getElementById("alerta-overlay");
      if (ol && !ol.classList.contains("open")) {
        ol.classList.add("open");
        const oc = document.getElementById("overlay-ciclos");
        const ou = document.getElementById("overlay-uso");
        if (oc) oc.innerText = `${d.ciclos} / ${limC ?? "—"}`;
        if (ou) ou.innerText = `${Math.floor(d.uso / 3600)}h`;
      }
      setAlertaOpen(true);
    }
  }, [tel, authenticated, plcConfig]);

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

  async function enviarLogin() {
    if (pinLogin.length !== 4) return;

    if (LOGIN_PIN_STATIC && pinLogin === LOGIN_PIN_STATIC) {
      setAuthenticated(true);
      setPinLogin("");
      setLoginError("");
      if (configOrigin) {
        const cfg = await fetchPlcConfig(configOrigin);
        if (cfg) setPlcConfig(cfg);
      }
      return;
    }

    const mq = clientRef.current;
    if (!mq?.connected) {
      setLoginError("SIN CONEXIÓN AL BROKER MQTT (wss). Comprueba red y NEXT_PUBLIC_MQTT_WS_URL.");
      setTimeout(() => setLoginError(""), 5000);
      return;
    }

    if (authTimerRef.current) clearTimeout(authTimerRef.current);

    if (rawPinFromESP !== "" && pinLogin === rawPinFromESP) {
      setAuthenticated(true);
      setPinLogin("");
      setLoginError("");
      if (configOrigin) {
        const cfg = await fetchPlcConfig(configOrigin);
        if (cfg) setPlcConfig(cfg);
      }
      return;
    }

    setLoginError("");
    pendingAuth.current = true;
    publishCmd({ checkPin: pinLogin });

    authTimerRef.current = setTimeout(() => {
      if (pendingAuth.current) {
        pendingAuth.current = false;
        setLoginError(
          "Sin ACK ni authOk en telemetría. Revisa omnitec/cmd y omnitec/ack para esta unidad.",
        );
        borrarPLog();
        setTimeout(() => setLoginError(""), 6000);
      }
    }, 15_000);
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

  function pMante(n: number) {
    if (pinMante.length < 4) setPinMante((s) => s + String(n));
  }

  function borrarMante() {
    setPinMante("");
  }

  function validarAcceso() {
    if (pinCheckTimerRef.current) clearTimeout(pinCheckTimerRef.current);

    if (rawPinFromESP !== "" && pin === rawPinFromESP) {
      espAuthPinRef.current = pin;
      const bloqueo = document.getElementById("panel-bloqueo");
      const edicion = document.getElementById("panel-edicion");
      if (bloqueo) bloqueo.style.display = "none";
      if (edicion) edicion.style.display = "block";
      setPin("");
      return;
    }

    if (!clientRef.current?.connected) {
      showLog("SIN CONEXIÓN AL BROKER MQTT", "var(--rojo)");
      return;
    }

    pendingPinCheck.current = true;
    publishCmd({ checkPin: pin });

    pinCheckTimerRef.current = setTimeout(() => {
      if (pendingPinCheck.current) {
        pendingPinCheck.current = false;
        showLog("PIN INCORRECTO", "var(--rojo)");
        setPin("");
      }
    }, 4000);
  }

  function bloquear() {
    const bloqueo = document.getElementById("panel-bloqueo");
    const edicion = document.getElementById("panel-edicion");
    if (bloqueo) bloqueo.style.display = "block";
    if (edicion) edicion.style.display = "none";
  }

  /** Evita blur→sync antes del click: sin esto, el efecto de telemetría restaura valores viejos y el guardado envía basura. */
  function preventSubmitBlur(e: MouseEvent<HTMLButtonElement>) {
    e.preventDefault();
  }

  /** Tras guardar, quitar foco para volver al estilo gris (input-live-plc) sin tener que clicar fuera. */
  function blurLiveFieldIfFocused() {
    if (typeof document === "undefined") return;
    const ae = document.activeElement as HTMLElement | null;
    if (!ae?.id) return;
    const liveIds = new Set([
      "in-cs",
      "in-cb",
      "in-ts",
      "in-tb",
      "lim-c",
      "lim-m",
      "t-apagado",
      "id-uni",
      "tok-uni",
    ]);
    if (liveIds.has(ae.id)) ae.blur();
  }

  function saveT() {
    const cs = readSecFromInputOrPh("in-cs", phCS);
    const cb = readSecFromInputOrPh("in-cb", phCB);
    const ts = readSecFromInputOrPh("in-ts", phTS);
    const tb = readSecFromInputOrPh("in-tb", phTB);
    if (![cs, cb, ts, tb].some((n) => Number.isFinite(n))) {
      showLog("SIN TIEMPOS PARA GUARDAR", "var(--ambar)");
      return;
    }
    const sec = (n: number) => (Number.isFinite(n) ? n : 0);
    const payload = mqttPayloadSetT(sec(cs) * 1000, sec(cb) * 1000, sec(ts) * 1000, sec(tb) * 1000);
    if (!publishCmd(payload)) {
      showLog("SIN CONEXIÓN MQTT", "var(--rojo)");
      return;
    }
    showLog("TIEMPOS GUARDADOS", "var(--verde)");
    blurLiveFieldIfFocused();
  }

  function togglePlcMode() {
    const current = tel?.plcM ?? false;
    const next = !current;
    if (
      !window.confirm(
        next
          ? "¿Activar modo PLC libre? El volquete clásico quedará deshabilitado en el equipo."
          : "¿Volver al modo volquete mina?",
      )
    ) {
      return;
    }
    if (!publishCmd(mqttPayloadSetMode(next))) {
      showLog("SIN CONEXIÓN MQTT", "var(--rojo)");
      return;
    }
    showLog(next ? "MODO PLC SOLICITADO" : "MODO VOLQUETE SOLICITADO", "var(--ambar)");
    window.setTimeout(() => {
      const t = telRef.current;
      if (t && t.plcM !== next) {
        showLog(
          "El equipo no confirmó el cambio. En OMNIPRO.ino el mqttCallback solo aplica checkPin: integre aplicarComandoMqtt (arduino/omnipro_mqtt_callback.cpp + PASOS_MQTT.txt).",
          "var(--rojo)",
        );
      } else if (t && t.plcM === next) {
        showLog("MODO CONFIRMADO POR TELEMETRÍA", "var(--verde)");
      }
    }, 2200);
  }

  function guardarTodo() {
    const np = (document.getElementById("new-pin") as HTMLInputElement)?.value?.trim();
    const npm = (document.getElementById("new-pin-mante") as HTMLInputElement)?.value?.trim();

    const lc = readSecFromInputOrPh("lim-c", phLC);
    const lm = readSecFromInputOrPh("lim-m", phLM);
    const tp = readSecFromInputOrPh("t-apagado", phTP);

    const idFallback = plcConfig?.id ?? mqttUnitId;
    const tokFallback = plcConfig?.token ?? "";
    const idEl = typeof document !== "undefined" ? (document.getElementById("id-uni") as HTMLInputElement | null) : null;
    const tokEl = typeof document !== "undefined" ? (document.getElementById("tok-uni") as HTMLInputElement | null) : null;
    const idTyped = idEl?.value?.trim() ?? "";
    const tokTyped = tokEl?.value?.trim() ?? "";

    const cmds: Record<string, unknown>[] = [];
    if (np?.length === 4) cmds.push(mqttPayloadNewOperPin(np));
    if (npm?.length === 4) cmds.push(mqttPayloadMantePin(npm));

    if (Number.isFinite(lc) || Number.isFinite(lm)) {
      const c = Number.isFinite(lc) ? Math.round(lc as number) : Math.round(Number(phLC) || 0);
      const m = Number.isFinite(lm) ? Math.round(lm as number) : Math.round(Number(phLM) || 0);
      cmds.push(mqttPayloadSetMante(c, m));
    }

    if (idTyped || tokTyped) {
      cmds.push(mqttPayloadIdentidad(idTyped || idFallback, tokTyped || tokFallback));
    }

    if (Number.isFinite(tp)) cmds.push(mqttPayloadApagadoMin(Math.round(tp as number)));

    if (cmds.length === 0) {
      showLog("NADA QUE GUARDAR", "var(--ambar)");
      bloquear();
      return;
    }
    for (const payload of cmds) {
      if (!publishCmd(payload)) {
        showLog("SIN CONEXIÓN MQTT", "var(--rojo)");
        return;
      }
    }
    if (idTyped) setMqttUnitId(idTyped || idFallback);
    if (configOrigin) {
      void fetchPlcConfig(configOrigin).then((c) => {
        if (c) setPlcConfig(c);
      });
    }
    blurLiveFieldIfFocused();
    bloquear();
    showLog("GUARDADO", "var(--verde)");
  }

  function posponerMantenimiento() {
    const ol = document.getElementById("alerta-overlay");
    if (ol) ol.classList.remove("open");
    setAlertaOpen(false);
    if (!publishCmd(mqttPayloadSnoozeMante())) {
      showLog("SIN CONEXIÓN MQTT", "var(--rojo)");
      return;
    }
    showLog("MANTENIMIENTO POSPUESTO", "var(--ambar)");
  }

  function abrirPinMantenimiento() {
    const ol = document.getElementById("alerta-overlay");
    if (ol) ol.classList.remove("open");
    setAlertaOpen(false);
    setPinMante("");
    setManteAuthOpen(true);
  }

  function enviarMantePIN() {
    if (pinMante.length !== 4) return;
    if (!publishCmd(mqttPayloadResetMante(pinMante))) {
      showLog("SIN CONEXIÓN MQTT", "var(--rojo)");
      return;
    }
    esperandoReset.current = true;
    setManteAuthOpen(false);
    setPinMante("");
    setTimeout(() => {
      esperandoReset.current = false;
    }, 1500);
    showLog("REINICIO MANTENIMIENTO ENVIADO", "var(--verde)");
  }

  function cerrarMantePIN() {
    setManteAuthOpen(false);
    setPinMante("");
  }

  function abrirEspLocal(path?: string) {
    const base = espLanOrigin ?? configOrigin;
    if (!base) {
      showLog("Configure NEXT_PUBLIC_OMNITEC_ESP_ORIGIN (URL del AP del equipo).", "var(--ambar)");
      return;
    }
    const url = path ? `${base.replace(/\/$/, "")}/${path.replace(/^\//, "")}` : base;
    window.open(url, "_blank", "noopener,noreferrer");
  }

  function abrirPaginaOtaEsp() {
    const u = `${espLanOrigin.replace(/\/$/, "")}/update`;
    window.open(u, "_blank", "noopener,noreferrer");
  }

  async function enviarOtaPorPullMqtt() {
    const input = document.getElementById("ota-bin-input") as HTMLInputElement | null;
    const file = input?.files?.[0];
    if (!file) {
      showLog("Seleccione un archivo .bin", "var(--ambar)");
      return;
    }
    if (!file.name.toLowerCase().endsWith(".bin")) {
      showLog("El firmware debe ser un archivo .bin", "var(--ambar)");
      return;
    }
    const c = clientRef.current;
    if (!c?.connected) {
      showLog("MQTT no conectado: no se puede enviar la URL OTA.", "var(--rojo)");
      return;
    }
    setOtaBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const secret =
        typeof process !== "undefined"
          ? process.env.NEXT_PUBLIC_OMNITEC_FIRMWARE_UPLOAD_SECRET?.trim() ?? ""
          : "";
      const res = await fetch(
        `/api/firmware/upload?unit=${encodeURIComponent(mqttUnitId.trim() || "latest")}`,
        {
          method: "POST",
          body: fd,
          headers: secret ? { "x-firmware-upload-secret": secret } : undefined,
        },
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        url?: string;
        error?: string;
      };
      if (!res.ok || !data.ok || !data.url) {
        showLog(data.error || `Error al guardar el firmware (${res.status})`, "var(--rojo)");
        return;
      }
      const topic = otaTopic(mqttUnitId.trim() || "latest");
      c.publish(topic, JSON.stringify({ url: data.url }), { qos: 1 });
      showLog(`OTA: firmware en servidor; orden enviada por MQTT (${topic})`, "var(--verde)");
      setOtaOpen(false);
    } catch (e) {
      showLog(e instanceof Error ? e.message : String(e), "var(--rojo)");
    } finally {
      setOtaBusy(false);
    }
  }

  async function subirFondoPantallaFisica(file: File | undefined) {
    if (!file) return;
    const base = espLanOrigin?.trim();
    if (!base) {
      showLog("Configure NEXT_PUBLIC_OMNITEC_ESP_ORIGIN (URL del AP del equipo).", "var(--ambar)");
      return;
    }
    const pinEsp = espAuthPinRef.current.trim() || rawPinFromESP.trim();
    if (!pinEsp) {
      showLog(
        "Use ENTRAR con el PIN del equipo antes de subir el fondo, o espere telemetría con el PIN.",
        "var(--ambar)",
      );
      return;
    }
    setLogoUploadBusy(true);
    try {
      showLog("SUBIENDO FONDO TFT…", "var(--ambar)");
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("No se pudo leer el archivo"));
        reader.readAsDataURL(file);
      });

      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("Imagen no válida"));
        image.src = dataUrl;
      });

      const cvs = document.createElement("canvas");
      cvs.width = 160;
      cvs.height = 128;
      const ctx = cvs.getContext("2d");
      if (!ctx) throw new Error("Canvas no disponible");
      ctx.fillStyle = "black";
      ctx.fillRect(0, 0, 160, 128);
      const scale = Math.min(160 / img.width, 128 / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      const x = 160 / 2 - w / 2;
      const y = 128 / 2 - h / 2;
      ctx.drawImage(img, x, y, w, h);

      const imgData = ctx.getImageData(0, 0, 160, 128).data;
      const buffer = new ArrayBuffer(40960);
      const view = new DataView(buffer);
      let j = 0;
      for (let i = 0; i < imgData.length; i += 4) {
        const r = imgData[i]! >> 3;
        const g = imgData[i + 1]! >> 2;
        const b = imgData[i + 2]! >> 3;
        const color = (r << 11) | (g << 5) | b;
        view.setUint16(j, color, true);
        j += 2;
      }

      const authRes = await fetch(`${base.replace(/\/$/, "")}/authLogin?pin=${encodeURIComponent(pinEsp)}`, {
        method: "GET",
        mode: "cors",
      });
      const authTxt = (await authRes.text()).trim();
      if (!authRes.ok || authTxt !== "OK") {
        throw new Error("PIN rechazado por el equipo o sin conexión al AP.");
      }

      const formData = new FormData();
      formData.append("logo", new Blob([buffer], { type: "application/octet-stream" }), "logo.bin");
      const upRes = await fetch(`${base.replace(/\/$/, "")}/api/upload_logo`, {
        method: "POST",
        body: formData,
        mode: "cors",
      });
      const upTxt = (await upRes.text()).trim();
      if (!upRes.ok || upTxt !== "OK") {
        throw new Error(upTxt || `Error HTTP ${upRes.status}`);
      }
      showLog("FONDO PANTALLA FÍSICA ACTUALIZADO", "var(--verde)");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      showLog(
        `${msg} Si falla por HTTPS/CORS, abra la web del equipo en la misma red (AP) y suba la imagen allí.`,
        "var(--rojo)",
      );
    } finally {
      setLogoUploadBusy(false);
    }
  }

  async function loadCajaNegraLogs() {
    setCajaLoading(true);
    try {
      const uid = mqttUnitId.trim();
      const quickCn = telRef.current?.cn;

      if (quickCn?.length) {
        cajaFromServerRef.current = false;
        setCajaGrouped(groupLogsByDay(quickCn.join("\n")));
        setCajaLoading(false);
      }

      if (uid) {
        const ac = new AbortController();
        const tid = window.setTimeout(() => ac.abort(), 6000);
        try {
          const res = await fetch(`/api/unit-logs/${encodeURIComponent(uid)}`, {
            cache: "no-store",
            signal: ac.signal,
          });
          window.clearTimeout(tid);
          if (res.ok) {
            const txt = await res.text();
            if (txt.trim()) {
              cajaFromServerRef.current = true;
              const apply = () => setCajaGrouped(groupLogsByDay(txt));
              if (txt.length > 100_000) startTransition(apply);
              else apply();
              return;
            }
          }
        } catch {
          window.clearTimeout(tid);
        }
      }

      if (quickCn?.length) {
        return;
      }

      cajaFromServerRef.current = false;
      const fromMqtt = telRef.current?.cn;
      if (fromMqtt && fromMqtt.length > 0) {
        setCajaGrouped(groupLogsByDay(fromMqtt.join("\n")));
        return;
      }
      const base = espLanOrigin ?? configOrigin;
      if (!base) {
        showLog("Sin datos MQTT (cn) ni origen AP: actualice el firmware o configure NEXT_PUBLIC_OMNITEC_ESP_ORIGIN.", "var(--ambar)");
        setCajaGrouped(null);
        return;
      }
      try {
        const res = await fetch(`${base.replace(/\/$/, "")}/api/logs`, { cache: "no-store", credentials: "omit" });
        const txt = await res.text();
        if (!txt.trim() || txt.includes("Sin registros")) {
          setCajaGrouped({});
          showLog("SIN REGISTROS EN EL EQUIPO", "var(--ambar)");
        } else {
          const apply = () => setCajaGrouped(groupLogsByDay(txt));
          if (txt.length > 100_000) startTransition(apply);
          else apply();
        }
      } catch {
        setCajaGrouped(null);
        showLog("NO SE PUDO LEER /api/logs (CORS o sesión AP). Con firmware actual, los datos llegan por MQTT (cn).", "var(--rojo)");
      }
    } finally {
      setCajaLoading(false);
    }
  }

  function toggleCajaNegraPanel() {
    setCajaOpen((open) => {
      if (!open) void loadCajaNegraLogs();
      return !open;
    });
  }

  function drawChartCanvas(points: ReturnType<typeof buildChartPointsFromCsv>) {
    const canvas = chartCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const parent = canvas.parentElement;
    const rect = parent?.getBoundingClientRect();
    const w = rect?.width ?? 400;
    const h = 280;
    canvas.width = w * 2;
    canvas.height = h * 2;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(2, 2);
    drawActividadDiariaChart(ctx, w, h, points);
  }

  function isCajaDayExpanded(day: string, index: number) {
    if (cajaDayOpen[day] !== undefined) return cajaDayOpen[day];
    return index === 0;
  }

  function toggleCajaDay(day: string, index: number) {
    setCajaDayOpen((p) => {
      const cur = p[day] !== undefined ? p[day] : index === 0;
      return { ...p, [day]: !cur };
    });
  }

  async function abrirGraficoActividad() {
    setChartOpen(true);
    const uid = mqttUnitId.trim();
    if (uid) {
      try {
        const res = await fetch(`/api/unit-logs/${encodeURIComponent(uid)}`, {
          cache: "no-store",
        });
        if (res.ok) {
          const txt = await res.text();
          if (txt.trim()) {
            const pts = buildChartPointsFromCsv(txt);
            setTimeout(() => drawChartCanvas(pts), 100);
            return;
          }
        }
      } catch {
        /* MQTT o AP */
      }
    }
    const lines = telRef.current?.cn;
    if (lines && lines.length > 0) {
      const pts = buildChartPointsFromCsv(lines.join("\n"));
      setTimeout(() => drawChartCanvas(pts), 100);
      return;
    }
    const base = espLanOrigin ?? configOrigin;
    if (!base) {
      setTimeout(() => drawChartCanvas([]), 100);
      return;
    }
    try {
      const res = await fetch(`${base.replace(/\/$/, "")}/api/logs`, { cache: "no-store", credentials: "omit" });
      const txt = await res.text();
      const pts = buildChartPointsFromCsv(txt);
      setTimeout(() => drawChartCanvas(pts), 100);
    } catch {
      setTimeout(() => drawChartCanvas([]), 100);
    }
  }

  async function procesarDescargaCsv() {
    const base = espLanOrigin ?? configOrigin;
    if (!base) {
      showLog("Configure NEXT_PUBLIC_OMNITEC_ESP_ORIGIN.", "var(--ambar)");
      return;
    }
    if (dlTipo === "rango" && (!dlDesde || !dlHasta)) {
      showLog("SELECCIONE FECHAS", "var(--ambar)");
      return;
    }
    if (dlTipo === "rango" && dlDesde > dlHasta) {
      showLog("RANGO INVÁLIDO", "var(--rojo)");
      return;
    }
    setDownloadOpen(false);
    showLog("DESCARGANDO…", "var(--cyan)");
    try {
      const res = await fetch(`${base.replace(/\/$/, "")}/api/download_log`, { cache: "no-store", credentials: "omit" });
      const blob = await res.blob();
      const text = await blob.text();
      if (!text.trim()) {
        showLog("SIN DATOS", "var(--rojo)");
        return;
      }
      if (dlTipo === "todo") {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob(["\uFEFF" + text], { type: "text/csv;charset=utf-8" }));
        a.download = "Historial_OMNITEC.csv";
        a.click();
        URL.revokeObjectURL(a.href);
        showLog("DESCARGA LISTA", "var(--verde)");
        return;
      }
      const start = new Date(`${dlDesde}T00:00:00`).getTime();
      const end = new Date(`${dlHasta}T23:59:59`).getTime();
      const lines = text.split("\n");
      const logsByDay: Record<string, string[]> = {};
      const dates: string[] = [];
      for (const line of lines) {
        const parsed = parseLogLine(line);
        if (!parsed || parsed.day === "OTROS" || parsed.day === "BOOT-INIT") continue;
        const dp = parsed.day.split("/");
        if (dp.length === 3) {
          const logDate = new Date(`20${dp[2]}-${dp[1]}-${dp[0]}T12:00:00`).getTime();
          if (logDate < start || logDate > end) continue;
        }
        if (!logsByDay[parsed.day]) {
          logsByDay[parsed.day] = [];
          dates.push(parsed.day);
        }
        logsByDay[parsed.day].push(`${parsed.time} - ${parsed.ev}`);
      }
      if (dates.length === 0) {
        showLog("RANGO SIN DATOS", "var(--rojo)");
        return;
      }
      let csvOutput = `${dates.map((d) => `"${d}"`).join(";")}\n`;
      const maxRows = Math.max(...dates.map((d) => logsByDay[d].length));
      for (let i = 0; i < maxRows; i++) {
        csvOutput += `${dates.map((d) => `"${(logsByDay[d][i] || "").replace(/"/g, '""')}"`).join(";")}\n`;
      }
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob(["\uFEFF" + csvOutput], { type: "text/csv;charset=utf-8" }));
      a.download = "Reporte_Dinamico_OMNITEC.csv";
      a.click();
      URL.revokeObjectURL(a.href);
      showLog("DESCARGA EXITOSA", "var(--verde)");
    } catch {
      showLog("ERROR DE RED / CORS — use el AP local.", "var(--rojo)");
    }
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
    // La configuración WiFi real se hace desde el AP del equipo; aquí solo cerramos el panel.
    cerrarWiFi();
    showLog("CONFIGURA WIFI DESDE EL AP LOCAL DEL EQUIPO", "var(--ambar)");
  }

  function olvidarWiFi() {
    if (typeof window !== "undefined" && window.confirm("¿Seguro que deseas olvidar la red WiFi?")) {
      showLog("OLVIDAR WIFI: USE EL AP LOCAL DEL EQUIPO", "var(--ambar)");
      cerrarWiFi();
    }
  }

  /** Placeholders: prioridad telemetría MQTT (tCS… ms o cs… s), luego GET /api/config (también si el valor es 0). */
  const { phCS, phCB, phTS, phTB, phLC, phLM, phTP } = useMemo(() => {
    function pickSec(
      ms: number | undefined,
      sec: number | undefined,
      plcN: number | undefined,
    ): string {
      if (ms != null && Number.isFinite(ms)) return String(ms / 1000);
      if (sec != null && Number.isFinite(sec)) return String(sec);
      if (plcN !== undefined && plcN !== null && Number.isFinite(plcN)) return String(plcN);
      return "";
    }
    const p = plcConfig;
    return {
      phCS: pickSec(tel?.tCS, tel?.cs, p?.cs),
      phCB: pickSec(tel?.tCB, tel?.cb, p?.cb),
      phTS: pickSec(tel?.tTS, tel?.ts, p?.ts),
      phTB: pickSec(tel?.tTB, tel?.tb, p?.tb),
      phLC: (() => {
        if (tel?.limC != null && Number.isFinite(tel.limC)) return String(tel.limC);
        if (p && p.lc !== undefined && Number.isFinite(p.lc)) return String(p.lc);
        return "";
      })(),
      phLM: (() => {
        if (tel?.limM != null && Number.isFinite(tel.limM)) return String(tel.limM);
        if (p && p.lm !== undefined && Number.isFinite(p.lm)) return String(p.lm);
        return "";
      })(),
      phTP: p?.tp?.trim() ? p.tp : "",
    };
  }, [tel, plcConfig]);

  /** Reflejo en vivo desde telemetría/config (gris hasta que enfocas = modo AP: no interfiere hasta editar). */
  useEffect(() => {
    const sync = (id: string, val: string | undefined) => {
      if (val === undefined || val === null || val === "" || val === "—") return;
      const el = document.getElementById(id) as HTMLInputElement | null;
      if (!el) return;
      if (document.activeElement === el || liveFieldFocus === id) return;
      el.value = val;
    };
    sync("in-cs", phCS);
    sync("in-cb", phCB);
    sync("in-ts", phTS);
    sync("in-tb", phTB);
    sync("lim-c", phLC);
    sync("lim-m", phLM);
    sync("t-apagado", phTP);
    sync("id-uni", plcConfig?.id ?? mqttUnitId);
    if (plcConfig?.token) sync("tok-uni", plcConfig.token);
  }, [
    phCS,
    phCB,
    phTS,
    phTB,
    phLC,
    phLM,
    phTP,
    plcConfig?.id,
    plcConfig?.token,
    mqttUnitId,
    liveFieldFocus,
  ]);

  const bindLiveField = useCallback((id: string) => {
    return {
      onFocus: (e: FocusEvent<HTMLInputElement>) => {
        setLiveFieldFocus(id);
        const el = e.currentTarget;
        requestAnimationFrame(() => {
          el?.select();
        });
      },
      onBlur: () => setLiveFieldFocus((cur) => (cur === id ? null : cur)),
    };
  }, []);

  return (
    <div className="omnitec-scada">
      <div id="toast-overlay" />

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
          <div
            id="login-pin-display"
            style={{
              fontSize: "2.5rem",
              letterSpacing: 15,
              margin: "20px 0",
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
              fontSize: "0.8rem",
              marginTop: 10,
              minHeight: 15,
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
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 10,
              justifyContent: "center",
            }}
          >
            <button type="button" className="boton btn-gris" onClick={posponerMantenimiento}>
              LUEGO
            </button>
            <button type="button" className="boton btn-mante" onClick={abrirPinMantenimiento}>
              CONFIRMAR
            </button>
          </div>
        </div>
      </div>

      <div id="mante-auth-overlay" className={manteAuthOpen ? "open" : undefined}>
        <div
          style={{
            textAlign: "center",
            padding: 30,
            border: "2px solid var(--ambar)",
            borderRadius: 20,
            background: "#1a1a1a",
            maxWidth: "90%",
            width: 360,
          }}
        >
          <h2 style={{ border: "none", margin: "0 0 16px", fontSize: "1.1rem" }}>PIN MANTENIMIENTO</h2>
          <div
            style={{
              fontSize: "2rem",
              letterSpacing: 12,
              marginBottom: 12,
              color: "var(--ambar)",
            }}
          >
            {pinMante.padEnd(4, "_")}
          </div>
          <div className="teclado">
            <button type="button" className="tecla" onClick={() => pMante(1)}>
              1
            </button>
            <button type="button" className="tecla" onClick={() => pMante(2)}>
              2
            </button>
            <button type="button" className="tecla" onClick={() => pMante(3)}>
              3
            </button>
            <button type="button" className="tecla" onClick={() => pMante(4)}>
              4
            </button>
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 10,
              marginTop: 12,
            }}
          >
            <button type="button" className="boton btn-gris" onClick={borrarMante}>
              BORRAR
            </button>
            <button type="button" className="boton btn-azul" onClick={enviarMantePIN}>
              ENVIAR
            </button>
          </div>
          <button
            type="button"
            className="boton btn-gris"
            style={{ marginTop: 12, width: "100%" }}
            onClick={cerrarMantePIN}
          >
            CANCELAR
          </button>
        </div>
      </div>

      <div id="ota-overlay" className={otaOpen ? "open" : undefined}>
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
          <h2 style={{ border: "none", marginTop: 0 }}>ACTUALIZAR SISTEMA</h2>
          <p style={{ color: "#666", fontSize: "0.72rem", marginBottom: 10 }}>
            Unidad MQTT: <code style={{ color: "var(--cyan)" }}>{mqttUnitId}</code>
            {" · "}
            LAN: <code style={{ color: "var(--cyan)" }}>{espLanOrigin}</code>
            {configOrigin && configOrigin !== espLanOrigin ? (
              <> · config: {configOrigin}</>
            ) : null}
          </p>
          <p style={{ color: "#ccc", fontSize: "0.82rem", lineHeight: 1.45, marginBottom: 14 }}>
            El <code>.bin</code> se sube a este servidor (HTTPS) y luego se envía la URL al ESP por MQTT (
            <code style={{ color: "var(--ambar)" }}>omnitec/ota/{"{unidad}"}</code>
            ). El equipo debe tener Internet y MQTT; no hace falta abrir la web del AP para OTA.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 12, textAlign: "left" }}>
            <input
              id="ota-bin-input"
              type="file"
              accept=".bin"
              disabled={otaBusy}
              style={{ background: "#222", color: "white" }}
            />
            <button
              type="button"
              className="boton btn-azul"
              style={{ width: "100%" }}
              disabled={otaBusy || !mqttConnected}
              onClick={() => void enviarOtaPorPullMqtt()}
            >
              {otaBusy ? "SUBIENDO…" : "SUBIR FIRMWARE Y ENVIAR OTA POR MQTT"}
            </button>
            {!mqttConnected ? (
              <p style={{ color: "var(--rojo)", fontSize: "0.75rem", margin: 0 }}>
                Sin conexión al broker MQTT: espere la conexión o revise la configuración WebSocket.
              </p>
            ) : null}
          </div>
          <p style={{ color: "#666", fontSize: "0.72rem", marginTop: 14, marginBottom: 6 }}>
            Opcional (misma red que el ESP): actualización clásica por HTTP al AP.
          </p>
          <button
            type="button"
            className="boton btn-gris"
            style={{ width: "100%" }}
            onClick={abrirPaginaOtaEsp}
          >
            ABRIR /update EN EL EQUIPO (LAN)
          </button>
          <button type="button" className="boton btn-gris" style={{ marginTop: 12 }} onClick={() => setOtaOpen(false)}>
            CANCELAR
          </button>
        </div>
      </div>

      <div id="chart-overlay" className={chartOpen ? "open" : undefined}>
        <div
          style={{
            width: "100%",
            maxWidth: 800,
            background: "#111",
            border: "1px solid var(--cyan)",
            borderRadius: 15,
            padding: 20,
            position: "relative",
          }}
        >
          <button
            type="button"
            onClick={() => setChartOpen(false)}
            style={{
              position: "absolute",
              top: 10,
              right: 15,
              background: "none",
              border: "none",
              color: "white",
              fontSize: "1.5rem",
              cursor: "pointer",
            }}
          >
            ✖
          </button>
          <h2
            style={{
              color: "var(--cyan)",
              textAlign: "center",
              border: "none",
              marginBottom: 16,
              letterSpacing: 2,
            }}
          >
            ACTIVIDAD DIARIA DE OPERACIÓN
          </h2>
          <div style={{ width: "100%", height: 300, position: "relative" }}>
            <canvas ref={chartCanvasRef} style={{ width: "100%", height: "100%" }} />
          </div>
        </div>
      </div>

      <div id="download-overlay" className={downloadOpen ? "open" : undefined}>
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
          <h2 style={{ color: "var(--ambar)", border: "none", fontSize: "1.1rem" }}>DESCARGAR HISTORIAL</h2>
          <div className="input-group" style={{ textAlign: "left", marginBottom: 15 }}>
            <label style={{ color: "#888", fontSize: "0.7rem" }}>RANGO DE FECHAS</label>
            <select
              id="dl-tipo"
              value={dlTipo}
              onChange={(e) => setDlTipo(e.target.value as "todo" | "rango")}
              style={{ fontSize: "1rem", padding: 10, width: "100%" }}
            >
              <option value="todo">Todo el historial</option>
              <option value="rango">Seleccionar días…</option>
            </select>
            {dlTipo === "rango" ? (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 10 }}>
                <div>
                  <label style={{ color: "var(--azul)", fontSize: "0.65rem" }}>DESDE</label>
                  <input type="date" value={dlDesde} onChange={(e) => setDlDesde(e.target.value)} style={{ width: "100%" }} />
                </div>
                <div>
                  <label style={{ color: "var(--azul)", fontSize: "0.65rem" }}>HASTA</label>
                  <input type="date" value={dlHasta} onChange={(e) => setDlHasta(e.target.value)} style={{ width: "100%" }} />
                </div>
              </div>
            ) : null}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <button type="button" className="boton btn-gris" onClick={() => setDownloadOpen(false)}>
              CANCELAR
            </button>
            <button type="button" className="boton btn-azul" onClick={() => void procesarDescargaCsv()}>
              DESCARGAR
            </button>
          </div>
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
          <input type="password" id="wifi-pass" placeholder="Contraseña Red WiFi" />
          <button type="button" className="boton btn-azul" onClick={conectarWiFi}>
            CONECTAR
          </button>
          <button type="button" className="boton btn-rojo" onClick={olvidarWiFi}>
            OLVIDAR WIFI
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

      <div className="contenedor" id="main-container">
        <div className="top-btn-container">
          {authenticated && (
            <button
              type="button"
              id="btn-toggle-mode"
              className="btn-animacion-pro"
              onClick={togglePlcMode}
            >
              {tel?.plcM ? "RESTAURAR MODO VOLQUETE MINA" : "HABILITAR MODO PLC LIBRE"}
            </button>
          )}
        </div>

        <div id="view-classic" style={{ display: tel?.plcM ? "none" : "block" }}>
        <button type="button" className="btn-animacion-pro" onClick={abrirCine}>
          VER ANIMACIÓN CAMION
        </button>
        <div className="tarjeta" id="tarjeta-pac">
          <div className="status-header">
            <div id="badge-status-cls" className={mqttConnected ? "badge-online" : "badge-offline"}>
              {mqttConnected ? "EN LÍNEA" : "SIN MQTT"} — {tel?.plcM ? "PLC LIBRE" : "VOLQUETE MINA"}
            </div>
            <div
              className="badge-wifi"
              id="wifi-status-btn"
              onClick={abrirWiFi}
              onKeyDown={(e) => e.key === "Enter" && abrirWiFi()}
              role="button"
              tabIndex={0}
            >
              📡 WIFI: AP LOCAL
            </div>
          </div>
          <p
            style={{
              fontSize: "0.65rem",
              color: "#888",
              textAlign: "center",
              margin: "0 0 10px 0",
            }}
          >
            ID:{" "}
            <span style={{ color: "var(--ambar)", fontWeight: 800 }}>{mqttUnitId}</span>
            {unitId !== mqttUnitId ? (
              <span style={{ display: "block", marginTop: 4, fontSize: "0.6rem" }}>
                (ruta inicial: {unitId})
              </span>
            ) : null}
          </p>
          <div id="cronometro-cls" className="reloj-big">
            0.0s
          </div>
          <div id="fase-txt" className="estado-centro">
            SISTEMA LISTO v2.0
          </div>

          <div
            className="ciclo-wrapper"
            style={{ position: "relative", height: 280, width: 280, margin: "20px auto" }}
          >
            <div
              style={{
                position: "absolute",
                top: "50%",
                left: "50%",
                width: 1000,
                height: 600,
                transform: "translate(-50%, -50%) scale(0.13)",
                pointerEvents: "none",
                zIndex: 2,
              }}
            >
              <div
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  height: "100%",
                  transform: "translate(var(--global-x), var(--global-y))",
                }}
              >
                <div className="truck-chassis truck-part" />
                <div className="truck-bed-wrapper">
                  <div className="truck-bed-img truck-part" />
                  <div className="truck-gate-wrapper">
                    <div className="truck-gate-img truck-part" />
                  </div>
                </div>
              </div>
            </div>
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
        </div>

        <div id="view-plc" style={{ display: tel?.plcM ? "block" : "none" }}>
          <div style={{ textAlign: "center" }}>
            <button type="button" className="btn-animacion-pro" onClick={() => setPlcEditorOpen((v) => !v)}>
              {plcEditorOpen ? "OCULTAR PROGRAMADOR I/O" : "PROGRAMADOR I/O"}
            </button>
          </div>
          {plcEditorOpen ? (
            <div className="tarjeta" id="editor-wrapper" style={{ marginTop: 18 }}>
              <p style={{ fontSize: "0.75rem", color: "#888", textAlign: "center" }}>
                El diseño lógico completo (recetas, simulador, arrastrar pasos) vive en la interfaz del AP. Con
                la misma red que el equipo puede abrirla aquí embebida (solo HTTP→HTTP).
              </p>
              {espLanOrigin && typeof window !== "undefined" && window.location.protocol === "http:" ? (
                <iframe
                  title="Programador PLC"
                  src={`${espLanOrigin.replace(/\/$/, "")}/`}
                  style={{ width: "100%", height: 480, border: "1px solid #333", borderRadius: 12, background: "#000" }}
                  sandbox="allow-scripts allow-same-origin allow-forms"
                />
              ) : (
                <div style={{ textAlign: "center", padding: 20 }}>
                  <button type="button" className="boton btn-azul" onClick={() => abrirEspLocal()}>
                    ABRIR PROGRAMADOR EN EL EQUIPO (AP)
                  </button>
                </div>
              )}
            </div>
          ) : null}

          <div
            className="tarjeta"
            id="tarjeta-plc-monitor"
            style={{ display: plcEditorOpen ? "none" : "block" }}
          >
            <div className="status-header">
              <div id="badge-status-plc" className={mqttConnected ? "badge-online" : "badge-offline"}>
                {mqttConnected ? "EN LÍNEA" : "SIN MQTT"} — PLC
              </div>
              <div
                className="badge-wifi wifi-status-btn-plc"
                id="wifi-status-btn-plc"
                onClick={abrirWiFi}
                onKeyDown={(e) => e.key === "Enter" && abrirWiFi()}
                role="button"
                tabIndex={0}
              >
                📡 WIFI: AP LOCAL
              </div>
            </div>
            <p
              style={{
                fontSize: "0.65rem",
                color: "#888",
                textAlign: "center",
                margin: "0 0 10px 0",
              }}
            >
              ID:{" "}
              <span style={{ color: "var(--ambar)", fontWeight: 800 }}>{mqttUnitId}</span>
            </p>
            <div id="cronometro-plc" className="reloj-big">
              0.0s
            </div>
            <div id="plc-fase-txt" className="estado-centro">
              PLC · R0 · COL 0 · PASO 1
            </div>
            <div
              className="ciclo-wrapper plc-nodos-grid"
              style={{
                position: "relative",
                minHeight: 200,
                width: "100%",
                maxWidth: 280,
                margin: "16px auto",
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 12,
                alignItems: "center",
                justifyItems: "center",
              }}
            >
              <div id="rn0" className="plc-monitor-node">
                <span>S1</span>
              </div>
              <div id="rn1" className="plc-monitor-node">
                <span>S2</span>
              </div>
              <div id="rn2" className="plc-monitor-node">
                <span>S3</span>
              </div>
              <div id="rn3" className="plc-monitor-node">
                <span>S4</span>
              </div>
            </div>
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

        <div className="acordeon" id="seccion-rtc" style={{ display: tel?.plcM ? "block" : "none" }}>
          <button type="button" className="acordeon-btn" onClick={() => setRtcOpen((o) => !o)}>
            PROGRAMADOR HORARIO (ALARMAS) <span>{rtcOpen ? "▲" : "▼"}</span>
          </button>
          <div
            className="acordeon-content"
            id="alarms-panel"
            style={{ maxHeight: rtcOpen ? 420 : 0, overflow: "hidden", transition: "max-height 0.3s ease" }}
          >
            <p style={{ fontSize: "0.75rem", color: "#888", padding: "10px 0" }}>
              Las alarmas viven en la receta PLC del equipo (misma lógica que el AP). Desde la nube, ábralas en la
              interfaz local o use iframe si su página es HTTP y el ESP es HTTP en LAN.
            </p>
            <button type="button" className="boton btn-azul" style={{ width: "100%", marginBottom: 10 }} onClick={() => abrirEspLocal()}>
              EDITAR ALARMAS EN EL AP
            </button>
          </div>
        </div>

        <div className="acordeon" id="seccion-cajanegra">
          <div
            className="acordeon-btn"
            style={{
              cursor: "default",
              padding: "15px 10px",
              display: "flex",
              flexWrap: "wrap",
              gap: 8,
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <div
              style={{
                flex: 1,
                textAlign: "left",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                fontSize: "0.9rem",
              }}
              onClick={() => toggleCajaNegraPanel()}
              onKeyDown={(e) => e.key === "Enter" && toggleCajaNegraPanel()}
              role="button"
              tabIndex={0}
            >
              <span>CAJA NEGRA</span>
              <span style={{ marginLeft: 5 }}>{cajaOpen ? "▲" : "▼"}</span>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button
                type="button"
                className="cn-calendar-btn"
                title="Actividad diaria"
                style={{ background: "var(--cyan)", borderColor: "var(--cyan)" }}
                onClick={() => void abrirGraficoActividad()}
              >
                <span style={{ fontSize: "1.1rem", color: "#000" }}>📈</span>
              </button>
              <button type="button" className="cn-calendar-btn" title="Descargar historial" onClick={() => setDownloadOpen(true)}>
                <span style={{ fontSize: "1.1rem" }}>⬇</span>
              </button>
            </div>
          </div>
          <p style={{ fontSize: "0.6rem", color: "#666", margin: "0 15px 8px", padding: "0 4px" }}>
            Vista alineada al AP: por fecha, desplegable. Telemetría MQTT: hasta 40 líneas recientes; el historial
            completo sigue en la SD / descarga por AP.
          </p>
          <div className="acordeon-content" style={{ maxHeight: cajaOpen ? 380 : 0, overflow: "hidden", transition: "max-height 0.3s ease" }}>
            {cajaLoading ? (
              <p style={{ padding: 10, fontSize: "0.75rem" }}>Cargando…</p>
            ) : cajaBlocks.length > 0 ? (
              <div id="cn-content" className="cn-content">
                {cajaBlocks.map((block, di) => {
                  const open = isCajaDayExpanded(block.day, di);
                  const circle = block.day !== "OTROS" && block.day !== "BOOT-INIT" ? "🟢 " : "";
                  return (
                    <div key={block.day} style={{ marginBottom: 6 }}>
                      <button
                        type="button"
                        className="cn-day-btn"
                        onClick={() => toggleCajaDay(block.day, di)}
                      >
                        <span>
                          {circle}
                          {block.day}
                        </span>
                        <span>{open ? "▲" : "▼"}</span>
                      </button>
                      <div
                        className="cn-day-content"
                        style={{ display: open ? "block" : "none" }}
                      >
                        {block.items.map((row, i) => (
                          <div key={`${block.day}-${i}-${row.time}`} className="log-entry">
                            {row.time ? (
                              <span className="log-entry-time">{row.time}</span>
                            ) : null}
                            <span className="log-entry-ev" style={{ color: getColorForEvent(row.event) }}>
                              {row.event}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p style={{ padding: 10, fontSize: "0.75rem", color: "#888" }}>
                Sin líneas en telemetría (<code style={{ color: "var(--ambar)" }}>cn</code>) ni CSV por HTTP. Actualice el
                firmware del ESP (caja negra en MQTT) o configure{" "}
                <code style={{ color: "var(--ambar)" }}>NEXT_PUBLIC_OMNITEC_ESP_ORIGIN</code> y abra el{" "}
                <button type="button" className="boton btn-gris" style={{ padding: "2px 8px" }} onClick={() => abrirEspLocal()}>
                  AP local
                </button>
                .
              </p>
            )}
          </div>
        </div>

        <div className="tarjeta">
          <h2 id="lbl-tiempos">CONFIGURAR TIEMPOS (S)</h2>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div className="input-group">
              <label htmlFor="in-cs" id="l-cs">
                COMPUERTA SUBIDA
              </label>
              <input
                type="number"
                id="in-cs"
                className="input-live-plc"
                placeholder={phCS || "—"}
                {...bindLiveField("in-cs")}
              />
            </div>
            <div className="input-group">
              <label htmlFor="in-cb" id="l-cb">
                COMPUERTA BAJADA
              </label>
              <input
                type="number"
                id="in-cb"
                className="input-live-plc"
                placeholder={phCB || "—"}
                {...bindLiveField("in-cb")}
              />
            </div>
            <div className="input-group">
              <label htmlFor="in-ts" id="l-ts">
                TOLVA SUBIDA
              </label>
              <input
                type="number"
                id="in-ts"
                className="input-live-plc"
                placeholder={phTS || "—"}
                {...bindLiveField("in-ts")}
              />
            </div>
            <div className="input-group">
              <label htmlFor="in-tb" id="l-tb">
                TOLVA BAJADA
              </label>
              <input
                type="number"
                id="in-tb"
                className="input-live-plc"
                placeholder={phTB || "—"}
                {...bindLiveField("in-tb")}
              />
            </div>
          </div>
          <button
            type="button"
            className="boton btn-azul"
            id="btn-save-t"
            onMouseDown={preventSubmitBlur}
            onClick={saveT}
          >
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
            <button
              type="button"
              className="boton btn-mante"
              style={{ marginBottom: 20, width: "100%" }}
              onClick={() => setOtaOpen(true)}
            >
              ACTUALIZAR SISTEMA (OTA)
            </button>
            <p style={{ fontSize: "0.65rem", color: "#888", marginBottom: 12 }}>
              OTA y programador completo requieren alcanzar al ESP por LAN o abrir el AP (
              {espLanOrigin ?? configOrigin ?? "configure ESP_ORIGIN"}).
            </p>
            <div className="input-group" style={{ marginBottom: 15 }}>
              <label htmlFor="file-logo-esp">CAMBIAR FONDO PANTALLA FÍSICA (ESP)</label>
              <input
                id="file-logo-esp"
                type="file"
                accept="image/*"
                disabled={logoUploadBusy}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  setLogoNombreArchivo(f?.name || "Ningún archivo seleccionado");
                  e.target.value = "";
                  void subirFondoPantallaFisica(f);
                }}
                style={{ display: "none" }}
              />
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "10px 0",
                  flexWrap: "wrap",
                }}
              >
                <label
                  htmlFor="file-logo-esp"
                  className="boton btn-gris"
                  style={{
                    margin: 0,
                    cursor: logoUploadBusy ? "not-allowed" : "pointer",
                    opacity: logoUploadBusy ? 0.6 : 1,
                  }}
                >
                  Seleccionar archivo
                </label>
                <span style={{ color: "var(--ambar)", fontSize: "0.95rem" }}>{logoNombreArchivo}</span>
              </div>
            </div>
            <div className="input-group" style={{ marginBottom: 15 }}>
              <label htmlFor="new-pin">CAMBIAR PIN</label>
              <input type="number" id="new-pin" placeholder="NUEVO PIN" />
            </div>
            <div className="input-group" style={{ marginBottom: 15 }}>
              <label htmlFor="new-pin-mante">PIN MANTENIMIENTO (4 DÍGITOS)</label>
              <input type="number" id="new-pin-mante" placeholder="PIN MANT." maxLength={4} />
            </div>
            <div style={{ borderTop: "1px solid #333", margin: "10px 0", paddingTop: 15 }}>
              <h2 style={{ border: "none", color: "#888", fontSize: "0.75rem" }}>
                IDENTIDAD Y CONEXIÓN
              </h2>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <div className="input-group">
                  <label htmlFor="id-uni">ID UNIDAD</label>
                  <input
                    type="text"
                    id="id-uni"
                    className="input-live-plc"
                    placeholder={mqttUnitId}
                    autoComplete="off"
                    {...bindLiveField("id-uni")}
                  />
                </div>
                <div className="input-group">
                  <label htmlFor="tok-uni">TOKEN API</label>
                  <input
                    type="text"
                    id="tok-uni"
                    className="input-live-plc"
                    placeholder="••••••"
                    {...bindLiveField("tok-uni")}
                  />
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
                  <input
                    type="number"
                    id="lim-c"
                    className="input-live-plc"
                    placeholder={phLC || "—"}
                    {...bindLiveField("lim-c")}
                  />
                </div>
                <div className="input-group">
                  <label htmlFor="lim-m">LÍMITE HORAS</label>
                  <input
                    type="number"
                    id="lim-m"
                    className="input-live-plc"
                    placeholder={phLM || "—"}
                    {...bindLiveField("lim-m")}
                  />
                </div>
                <div className="input-group">
                  <label htmlFor="t-apagado">PANTALLA (MIN)</label>
                  <input
                    type="number"
                    step={0.1}
                    id="t-apagado"
                    className="input-live-plc"
                    placeholder={phTP || "—"}
                    {...bindLiveField("t-apagado")}
                  />
                </div>
              </div>
            </div>
            <button type="button" className="boton btn-azul" onMouseDown={preventSubmitBlur} onClick={guardarTodo}>
              GUARDAR TODO
            </button>
            <button type="button" className="boton btn-gris" onClick={bloquear}>
              SALIR
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}