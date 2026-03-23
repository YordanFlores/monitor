# Documento de contexto técnico — OMNIPLC-X / monitor (Next.js)

> Para compartir con otra IA o con el equipo. Última revisión según el árbol `app/`, `components/` y `lib/` del repositorio.

---

## 1. Arquitectura base

| Pregunta | Respuesta |
|----------|-----------|
| **Next.js App Router o Pages Router?** | **App Router** (`/app`). No existe carpeta `/pages`. |
| **Tailwind CSS?** | **No**. Estilos con **CSS global** (`app/globals.css`), **CSS Modules** (`*.module.css` en login/dashboard) y **`components/omnitec-scada.css`** (SCADA clon del firmware OMNITEC). |
| **React** | React 19 + Next 15. |
| **TypeScript** | Sí (`tsconfig.json`). |

Rutas relevantes:

- `/` → redirige a `/login` (ver `app/page.tsx`).
- `/login` → pantalla mínima con enlace al dashboard.
- `/dashboard` → lista de unidades (`NEXT_PUBLIC_SCADA_UNITS`, coma-separadas).
- `/unit/[unitId]/scada` → **monitor SCADA completo** (`ScadaPanel`).

---

## 2. Comunicación y “base de datos”

### No hay backend de datos en este proyecto para el hardware

- **No** Firebase, **no** Prisma, **no** API REST propia para telemetría en la rama actual del análisis.
- **No** hay carpeta `app/api/` (sin Route Handlers HTTP para el PLC).

### Canal real: MQTT (broker Mosquitto, típicamente en LAN o vía `wss://`)

El **frontend (solo cliente)** usa la librería **`mqtt`** y conecta por **WebSocket** al broker:

- URL: configuración en código o en env; en el repo puede aparecer `lib/omnitec-mqtt.ts` con `NEXT_PUBLIC_MQTT_WS_URL`, o constantes al inicio de `ScadaPanel.tsx` (p. ej. `wss://broker.omnitec.store` — **verificar el archivo actual**).

**Tópicos (convención OMNITEC):**

| Dirección | Tópico | Contenido |
|-----------|--------|-----------|
| PLC → Web | `omnitec/telemetry/{unitId}` | JSON de estado (telemetría periódica, ~1 Hz en firmware típico). |
| Web → PLC | `omnitec/cmd/{unitId}` | JSON de comandos / configuración. |

**Lectura:** `client.subscribe(telemetryTopic(unitId))` y `client.on('message', ...)` → `JSON.parse` → `normalizeTelemetry(raw)` → `setTel(...)`.

**Escritura:** `client.publish(cmdTopic(unitId), JSON.stringify(payload), { qos: 0 })`.

**No** Server Actions para hardware; **no** fetch a API propia; **no** WebSockets nativos de Next: todo MQTT en el **navegador** (bundle con fallbacks de Webpack para `fs`/`net`/`tls` en `next.config.ts`).

**Dependencias** en `package.json` que no son el núcleo del SCADA: `express`, `socket.io`, `sqlite3` pueden existir para otros experimentos; el flujo SCADA documentado aquí es **MQTT + React**.

---

## 3. Estructura de datos (telemetría y comandos)

### 3.1 Telemetría (PLC → Web)

Tipo TypeScript (`components/ScadaPanel.tsx`, export `Telemetry`), alineado con el JSON del ESP (equivalente `/status` en `WifiConfig.h`):

```ts
export type Telemetry = {
  fase: number;       // 0..3: fase FSM
  prog: number;       // 0..100 progreso en la fase actual
  ms: number;         // ms acumulados en la fase
  tCS: number;        // tiempo compuerta subida (ms)
  tCB: number;        // tiempo compuerta bajada (ms)
  tTS: number;        // tiempo tolva subida (ms)
  tTB: number;        // tiempo tolva bajada (ms)
  relays: number;     // bitmask: bits 0..3 = subida compuerta, subida tolva, bajada tolva, bajada compuerta
  ciclos: number;
  uso: number;        // segundos de uso (o acumulado que envíe el firmware)
  limC: number;       // límite ciclos mantenimiento
  limM: number;       // límite tiempo (segundos o según firmware; la UI puede mostrar horas)
  net: boolean;       // WiFi con internet vs AP
  alerta: boolean;    // mantenimiento requerido
  pinCheckOk?: boolean;
  authOk?: boolean;
};
```

**Ejemplo JSON mínimo (ilustrativo):**

```json
{
  "fase": 1,
  "prog": 42,
  "ms": 3500,
  "tCS": 9000,
  "tCB": 8000,
  "tTS": 7000,
  "tTB": 6000,
  "relays": 6,
  "ciclos": 120,
  "uso": 86400,
  "limC": 500,
  "limM": 432000,
  "net": true,
  "alerta": false
}
```

`relays` en binario: bit `i` activo → nodo `i` activo en la UI (compuerta/tolva según etiquetas).

### 3.2 Comandos (Web → PLC)

Publicación JSON en `omnitec/cmd/{unitId}`. Ejemplos usados por la UI:

```json
{ "authLogin": "1234", "checkPin": "1234" }
{ "tCS": 9000, "tCB": 8000, "tTS": 7000, "tTB": 6000 }
{ "newPin": "5678" }
{ "limC": 500, "limM": 120 }
{ "unitId": "UNIDAD_01", "token": "..." }
{ "tApagado": 5.0 }
{ "resetMante": "true" }
{ "connectWiFi": { "ssid": "...", "pass": "..." } }
```

(El firmware debe interpretar las mismas claves o mapearlas.)

### 3.3 Variables de entorno útiles

- `NEXT_PUBLIC_MQTT_WS_URL` — WebSocket del broker (si se usa `lib/omnitec-mqtt.ts`).
- `NEXT_PUBLIC_SCADA_UNITS` — Lista de IDs para `/dashboard`.
- `NEXT_PUBLIC_OMNITEC_SKIP_LOGIN=1` — Omite overlay de PIN inicial.
- `NEXT_PUBLIC_OMNITEC_LOGIN_PIN` — PIN de 4 dígitos aceptado sin esperar flags en telemetría (desarrollo / LAN).

---

## 4. Código de las páginas “Dashboard” y entrada al SCADA

### 4.1 Dashboard — `app/dashboard/page.tsx` (código completo)

```tsx
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
```

### 4.2 Ruta SCADA — `app/unit/[unitId]/scada/page.tsx` (código completo)

Página **100% cliente** (`useParams`) para evitar problemas de RSC/DevTools en desarrollo:

```tsx
"use client";

import { useParams } from "next/navigation";
import { ScadaPanel } from "@/components/ScadaPanel";

/** Página 100% cliente: evita fallos de RSC / Next DevTools (SegmentViewNode) en dev. */
export default function ScadaPage() {
  const params = useParams();
  const unitId = typeof params?.unitId === "string" ? params.unitId : "UNIDAD_01";
  return <ScadaPanel unitId={decodeURIComponent(unitId)} />;
}
```

---

## 5. Archivo principal del monitor SCADA (UI completa)

**Archivo:** `components/ScadaPanel.tsx`  
**Tamaño:** ~1000+ líneas (componente cliente único: MQTT, overlays de login, WiFi, mantenimiento, modo cine, animación tolva/compuerta, formularios, teclados PIN).

**No** se incluye aquí íntegro por tamaño; la **fuente de verdad** es el archivo en el repositorio. Para otra IA: leer `components/ScadaPanel.tsx` completo y `components/omnitec-scada.css`.

**Estilos SCADA:** `components/omnitec-scada.css` (clon visual del `WifiConfig.h` OMNITEC).

**Imports clave en ScadaPanel:** `mqtt`, `./omnitec-scada.css`, hooks `useState`/`useEffect`/`useRef`/`useCallback`.

---

## 6. Resumen ejecutivo para otra IA

1. **Stack:** Next.js 15 **App Router**, React 19, TypeScript, **sin Tailwind**; CSS modular + global + SCADA dedicado.  
2. **Hardware:** **MQTT** (telemetría subscribe + comandos publish), **sin** API routes ni base de datos en el servidor Next para el PLC.  
3. **Datos:** JSON en tópicos `omnitec/telemetry/{unitId}` y `omnitec/cmd/{unitId}`; tipo `Telemetry` y `normalizeTelemetry` en `ScadaPanel.tsx`.  
4. **Dashboard:** lista simple en `app/dashboard/page.tsx`; **SCADA real** en `components/ScadaPanel.tsx` montado desde `app/unit/[unitId]/scada/page.tsx`.

Cualquier nueva feature debe respetar el contrato MQTT anterior o extenderlo de forma explícita en firmware y en `normalizeTelemetry` / `publishCmd`.
