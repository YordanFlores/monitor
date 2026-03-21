# OMNITEC Cloud

Plataforma Next.js (App Router) para monitoreo de PLCs ESP32 (OMNIPLC-X), con Firebase Realtime Database (telemetría en vivo) y Firestore (configuración, PIN, tokens).

## Requisitos

- Node.js 20+
- Proyecto Firebase con **Realtime Database** y **Firestore** habilitados
- Cuenta de servicio (JSON) para el servidor (`/api/update`, validación de PIN)

## Variables de entorno

Copia `.env.local.example` a `.env.local` y completa:

- `NEXT_PUBLIC_FIREBASE_*` — configuración del cliente (consola Firebase)
- `FIREBASE_SERVICE_ACCOUNT_JSON` — JSON completo de la cuenta de servicio en una línea
- `SCADA_SESSION_SECRET` — cadena larga aleatoria para firmar la cookie de acceso al SCADA tras el PIN

## Registro de un PLC nuevo

1. En Firestore, crea un documento en la colección **`provisionTokens`** con **ID = token** (el mismo string que enviará el ESP32) y el campo `unitId` con el nombre de la unidad (ej. `UNIDAD_01`).
2. El ESP32 envía `POST /api/update` con `unidad` + `token`. Si la unidad no existe y el token coincide con `provisionTokens`, se crea el documento en **`units/{unidad}`** con PIN por defecto `1234` (cámbialo desde el SCADA).

## Endpoint hardware

`POST /api/update`

Cuerpo JSON (ejemplo):

```json
{
  "unidad": "UNIDAD_01",
  "token": "tu_token",
  "fase": 0,
  "relays": 0,
  "prog": 0,
  "ms": 0,
  "tS": 9000,
  "tB": 9000,
  "ciclos": 0,
  "uso": 0,
  "alerta": false
}
```

Respuesta: `cmd`, `tCS`, `tCB`, y campos opcionales (`newPin`, `limC`, `limM`, `resetMante`) cuando haya pendientes en Firestore.

## Desarrollo

```bash
npm install
npm run dev
```

## Producción (Ubuntu + PM2)

```bash
npm run build
pm2 start ecosystem.config.cjs
pm2 save
```

Proxy inverso (nginx/caddy) hacia el puerto configurado (`PORT`, por defecto 3000).

## Reglas de seguridad Firebase

Configura reglas para que solo usuarios autenticados accedan a Firestore/RTDB según tu política; el backend usa la cuenta de servicio y no depende de esas reglas para `/api/update`.
