import type { ChartPoint } from "./caja-negra";

/** Gráfico de actividad diaria al estilo WebUI.h drawChart (línea + área degradada). */
export function drawActividadDiariaChart(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  data: ChartPoint[],
): void {
  ctx.clearRect(0, 0, w, h);
  if (data.length === 0) {
    ctx.fillStyle = "#888";
    ctx.font = "16px monospace";
    ctx.textAlign = "center";
    ctx.fillText("SIN DATOS PARA GRAFICAR", w / 2, h / 2);
    return;
  }

  let maxVal = Math.max(...data.map((d) => d.count), 1);
  maxVal = maxVal < 5 ? 5 : maxVal + Math.ceil(maxVal * 0.2);

  const padX = 40;
  const padY = 30;
  const drawW = w - padX * 2;
  const drawH = h - padY * 2;

  ctx.strokeStyle = "#333";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i <= 5; i++) {
    const y = padY + drawH - (i / 5) * drawH;
    ctx.moveTo(padX, y);
    ctx.lineTo(w - padX, y);
    ctx.fillStyle = "#666";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(String(Math.round((i / 5) * maxVal)), padX - 10, y + 4);
  }
  ctx.stroke();

  if (data.length === 1) {
    const x = w / 2;
    const y = padY + drawH - (data[0].count / maxVal) * drawH;
    ctx.fillStyle = "#00e5ff";
    ctx.beginPath();
    ctx.arc(x, y, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#ccc";
    ctx.textAlign = "center";
    ctx.fillText(data[0].label, x, h - 5);
    ctx.fillStyle = "#fff";
    ctx.fillText(String(data[0].count), x, y - 15);
    return;
  }

  const grad = ctx.createLinearGradient(0, padY, 0, padY + drawH);
  grad.addColorStop(0, "rgba(0, 229, 255, 0.4)");
  grad.addColorStop(1, "rgba(0, 229, 255, 0)");

  ctx.beginPath();
  ctx.moveTo(padX, padY + drawH);
  const points: { x: number; y: number; d: ChartPoint }[] = [];
  data.forEach((d, i) => {
    const x = padX + (i / (data.length - 1)) * drawW;
    const y = padY + drawH - (d.count / maxVal) * drawH;
    points.push({ x, y, d });
    ctx.lineTo(x, y);
  });
  ctx.lineTo(points[points.length - 1].x, padY + drawH);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.beginPath();
  points.forEach((p, i) => {
    if (i === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  });
  ctx.strokeStyle = "#00e5ff";
  ctx.lineWidth = 3;
  ctx.stroke();

  ctx.textAlign = "center";
  ctx.font = "10px sans-serif";
  points.forEach((p) => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = "#000";
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#00e5ff";
    ctx.stroke();

    ctx.fillStyle = "#fff";
    ctx.fillText(String(p.d.count), p.x, p.y - 12);

    ctx.fillStyle = "#888";
    ctx.fillText(p.d.label, p.x, h - 10);
  });
}
