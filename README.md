# OMNITEC (MQTT local)

Frontend Next.js para SCADA de PLCs ESP32 sobre **MQTT** (Mosquitto en LAN). Sin Firebase ni `/api/update`.

## Variables de entorno

Ver `.env.local.example`:

- `NEXT_PUBLIC_MQTT_WS_URL` — URL WebSocket del broker (por defecto en código: `ws://192.168.100.40:9001`). Si Mosquitto usa path `/mqtt`, pon `ws://192.168.100.40:9001/mqtt`.
- `NEXT_PUBLIC_SCADA_UNITS` — Lista de IDs separados por coma para el dashboard.
- `NEXT_PUBLIC_OMNITEC_SKIP_LOGIN=1` — Omite el overlay “ACCESO OMNITEC” (solo desarrollo en LAN).
- `NEXT_PUBLIC_OMNITEC_LOGIN_PIN` — PIN de 4 dígitos: si coincide con lo que escribes en “ACCESO OMNITEC”, entras sin que el PLC tenga que mandar `authOk` en telemetría (útil mientras el firmware no lo implementa).

La UI del SCADA replica `WifiConfig.h` del firmware OMNITEC (mismas tarjetas, overlays, acordeón y lógica de progreso por fase).

## Tópicos

| Dirección | Tópico | Payload |
|-----------|--------|---------|
| ESP → web | `omnitec/telemetry/{unitId}` | JSON de estado (cada ~1 s) |
| Web → ESP | `omnitec/cmd/{unitId}` | JSON de comando / config |

Ejemplos de publicación desde la web: `{"tCS":9000}`, `{"tCB":8000}`, `{"newPin":"1234"}`, `{"limC":10}`, `{"limM":120}`, `{"resetMante":"true"}`, `{"cmd":1}`.

### PIN inicial (overlay ACCESO OMNITEC)

Tras ENTRAR se publica **un solo JSON**: `{"authLogin":"<pin>","checkPin":"<pin>"}` (compatible con firmwares que solo tratan `checkPin`).

El PLC debe, en el siguiente (o en algún) mensaje de `omnitec/telemetry/...`, incluir alguno de: **`authOk`**, **`loginOk`**, **`sessionOk`**, **`authLoginOk`**, **`pinCheckOk`**, **`configUnlocked`**, **`pinOk`**, **`authResult":"OK"`**, **`loginResult":"OK"`**.

Si aún no tienes eso en el firmware, define **`NEXT_PUBLIC_OMNITEC_LOGIN_PIN`** en `.env.local` con el mismo PIN de 4 dígitos del PLC, o usa **`NEXT_PUBLIC_OMNITEC_SKIP_LOGIN=1`**.

### PIN de “CONFIGURACIÓN AVANZADA”

`{"checkPin":"XXXX"}` y en telemetría `pinCheckOk` o `configUnlocked: true` para desbloquear el panel de edición.

## Telemetría (campos reconocidos)

La UI normaliza nombres habituales: `tS` / `tCS` y `tB` / `tCB` (ms), `fase`, `prog`, `ms`, `relays`, `ciclos`, `uso`, `limC`, `limM` (segundos para el límite de tiempo de uso; el placeholder de horas usa `limM/3600`), `alerta`.

## Desarrollo

```bash
npm install
npm run dev
```

## Producción (PM2)

```bash
npm run build
pm2 start ecosystem.config.cjs
```
