/**
 * Carga JSON para omnitec/cmd/{idUnidad} — mismos efectos que los handlers HTTP en WifiConfig.h
 * (setT usa query cs/cb/ts/tb en MILISEGUNDOS).
 */

/** Igual que fetch `/setT?cs=…&cb=…&ts=…&tb=…` con valores en ms. */
export function mqttPayloadSetT(csMs: number, cbMs: number, tsMs: number, tbMs: number): Record<string, unknown> {
  return {
    cs: Math.round(csMs),
    cb: Math.round(cbMs),
    ts: Math.round(tsMs),
    tb: Math.round(tbMs),
  };
}

/**
 * Igual que GET `/api/setMode?m=0|1` (WifiConfig.h).
 * Incluye `m` para firmwares que solo lean esa clave; `setMode`/`modoPLC` para el handler recomendado.
 * En el ESP, aplicar `setMode`/`modoPLC` ANTES que el bloque setMante (`c`/`m` horas).
 */
export function mqttPayloadSetMode(plcLibre: boolean): Record<string, unknown> {
  const m = plcLibre ? 1 : 0;
  return { m, setMode: m, modoPLC: plcLibre };
}

/** setP?new= */
export function mqttPayloadNewOperPin(pin4: string): Record<string, unknown> {
  return { new: pin4, newPin: pin4 };
}

/** POST /api/setMantePin body pin= */
export function mqttPayloadMantePin(pin4: string): Record<string, unknown> {
  return { mantePin: pin4 };
}

/** setMante?c=&m= (m en horas) */
export function mqttPayloadSetMante(ciclos: number, horas: number): Record<string, unknown> {
  return { c: ciclos, m: horas };
}

/** setIdentidad?id=&token= */
export function mqttPayloadIdentidad(id: string, token: string): Record<string, unknown> {
  return { id, token };
}

/** setApagado?min= */
export function mqttPayloadApagadoMin(minutos: number): Record<string, unknown> {
  return { min: minutos };
}

/** POST /api/snoozeMante */
export function mqttPayloadSnoozeMante(): Record<string, unknown> {
  return { snoozeMante: true };
}

/** POST /api/resetMante con pin en body */
export function mqttPayloadResetMante(pin4: string): Record<string, unknown> {
  return { resetMante: true, pin: pin4 };
}
