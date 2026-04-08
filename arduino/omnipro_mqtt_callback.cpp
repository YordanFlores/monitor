// =============================================================================
// REFERENCIA — integrar en OMNIPRO.ino dentro de mqttCallback tras checkPin.
// Ajusta nombres si tu sketch usa otros identificadores.
// Comandos JSON (misma semántica que WifiConfig.h):
//   setT:     { "cs":ms, "cb":ms, "ts":ms, "tb":ms }
//   setMode:  { "setMode": 0|1 }  o { "modoPLC": true|false }
//   setP:     { "new":"1234" }
//   mantePin: { "mantePin":"4444" }
//   límites:  { "c":ciclos, "m":horas }  (como /setMante?c=&m=)
//   identidad:{ "id":"...", "token":"..." }
//   apagado:  { "min": float }  (minutos, como /setApagado?min=)
//   snooze:   { "snoozeMante": true }
//   reset:    { "resetMante": true, "pin":"4444" }
// =============================================================================

/*
void aplicarComandoMqtt(JsonVariantConst v) {
  JsonObjectConst o = v.as<JsonObjectConst>();
  if (o.isNull()) return;

  // --- tiempos PAC (ms), igual que /setT ---
  if (o["cs"] || o["cb"] || o["ts"] || o["tb"]) {
    if (xSemaphoreTake(mutexLogica, pdMS_TO_TICKS(200))) {
      if (!o["cs"].isNull() && o["cs"].as<long>() != 0) {
        long n = o["cs"].as<long>();
        if (n != (long)tiempoPAC_S) { tiempoPAC_S = n; prefs.putLong("tPAC_S", tiempoPAC_S); }
      }
      if (!o["cb"].isNull() && o["cb"].as<long>() != 0) {
        long n = o["cb"].as<long>();
        if (n != (long)tiempoPAC_B) { tiempoPAC_B = n; prefs.putLong("tPAC_B", tiempoPAC_B); }
      }
      if (!o["ts"].isNull() && o["ts"].as<long>() != 0) {
        long n = o["ts"].as<long>();
        if (n != (long)tiempoTOLVA_S) { tiempoTOLVA_S = n; prefs.putLong("tTOL_S", tiempoTOLVA_S); }
      }
      if (!o["tb"].isNull() && o["tb"].as<long>() != 0) {
        long n = o["tb"].as<long>();
        if (n != (long)tiempoTOLVA_B) { tiempoTOLVA_B = n; prefs.putLong("tTOL_B", tiempoTOLVA_B); }
      }
      xSemaphoreGive(mutexLogica);
    }
    lastTelemetryMillis = 0;
    return;
  }

  if (!o["setMode"].isNull()) {
    modoPLCLibre = (o["setMode"].as<int>() == 1);
    prefs.putBool("modoPLC", modoPLCLibre);
    resetearEstadosPLC();
    agregarLogCajaNegra(modoPLCLibre ? "MQTT: PLC" : "MQTT: VOLQUETE");
    lastTelemetryMillis = 0;
    return;
  }
  if (o["modoPLC"].is<bool>()) {
    modoPLCLibre = o["modoPLC"].as<bool>();
    prefs.putBool("modoPLC", modoPLCLibre);
    resetearEstadosPLC();
    agregarLogCajaNegra(modoPLCLibre ? "MQTT: PLC" : "MQTT: VOLQUETE");
    lastTelemetryMillis = 0;
    return;
  }
  // Igual que /api/setMode?m= — solo 0|1, y sin "c" (setMante usa c + m horas)
  if (o.containsKey("m") && !o.containsKey("c") && !o.containsKey("cs")) {
    int mv = o["m"].as<int>();
    if (mv == 0 || mv == 1) {
      modoPLCLibre = (mv == 1);
      prefs.putBool("modoPLC", modoPLCLibre);
      resetearEstadosPLC();
      agregarLogCajaNegra(modoPLCLibre ? "MQTT: PLC (m)" : "MQTT: VOLQUETE (m)");
      lastTelemetryMillis = 0;
      return;
    }
  }

  if (o["new"].is<const char*>()) {
    String nuevo = o["new"].as<const char*>();
    if (nuevo.length() == 4 && nuevo != passwordGuardada) {
      passwordGuardada = nuevo;
      if (xSemaphoreTake(mutexLogica, pdMS_TO_TICKS(100))) {
        prefs.putString("clave", passwordGuardada);
        xSemaphoreGive(mutexLogica);
      }
    }
    return;
  }

  if (o["mantePin"].is<const char*>()) {
    String p = o["mantePin"].as<const char*>();
    if (p.length() == 4) { pinMantenimiento = p; prefs.putString("pinMante", pinMantenimiento); }
    return;
  }

  if (!o["c"].isNull() || !o["m"].isNull()) {
    if (xSemaphoreTake(mutexLogica, pdMS_TO_TICKS(200))) {
      if (!o["c"].isNull()) {
        limiteCiclosMante = o["c"].as<unsigned long>();
        prefs.putLong("limCiclos", limiteCiclosMante);
      }
      if (!o["m"].isNull()) {
        long hrs = o["m"].as<long>();
        limiteMinutosMante = hrs * 60;
        prefs.putLong("limMin", limiteMinutosMante);
      }
      xSemaphoreGive(mutexLogica);
    }
    lastTelemetryMillis = 0;
    return;
  }

  if (o["id"].is<const char*>() || o["token"].is<const char*>()) {
    if (xSemaphoreTake(mutexLogica, pdMS_TO_TICKS(200))) {
      if (o["id"].is<const char*>() && strlen(o["id"])) {
        String n = o["id"].as<const char*>();
        if (n != idUnidad) { idUnidad = n; prefs.putString("idUnidad", idUnidad); WiFi.softAP(idUnidad.c_str()); }
      }
      if (o["token"].is<const char*>() && strlen(o["token"])) {
        tokenUnidad = o["token"].as<const char*>();
        prefs.putString("tokenUnidad", tokenUnidad);
      }
      xSemaphoreGive(mutexLogica);
    }
    return;
  }

  if (o["min"].is<float>() || o["min"].is<long>()) {
    float n = o["min"].is<float>() ? o["min"].as<float>() : (float)o["min"].as<long>();
    unsigned long nuevoT = (unsigned long)(n * 60000.0);
    if (xSemaphoreTake(mutexLogica, pdMS_TO_TICKS(100))) {
      tiempoApagadoPantalla = nuevoT;
      prefs.putLong("tApagado", tiempoApagadoPantalla);
      xSemaphoreGive(mutexLogica);
    }
    return;
  }

  if (o["snoozeMante"].is<bool>() && o["snoozeMante"].as<bool>()) {
    alarmaSilenciada = true;
    lastTelemetryMillis = 0;
    TFT_Event e = { CMD_TFT_IDLE, "", 0, false };
    xQueueSend(colaTFT, &e, 0);
    return;
  }

  if (o["resetMante"].is<bool>() && o["resetMante"].as<bool>() && o["pin"].is<const char*>()) {
    String pinIn = o["pin"].as<const char*>();
    if (pinIn == pinMantenimiento) {
      if (xSemaphoreTake(mutexLogica, pdMS_TO_TICKS(100))) {
        contadorCiclos = 0;
        contadorSegundosUso = 0;
        alertaMantenimientoActiva = false;
        alarmaSilenciada = false;
        prefs.putLong("cntCiclos", 0);
        prefs.putLong("cntUso", 0);
        xSemaphoreGive(mutexLogica);
        agregarLogCajaNegra("MQTT: RESET MANTE");
      }
      lastTelemetryMillis = 0;
      TFT_Event e = { CMD_TFT_IDLE, "", 0, false };
      xQueueSend(colaTFT, &e, 0);
    }
    return;
  }
}
*/
