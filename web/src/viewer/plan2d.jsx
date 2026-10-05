/**
 * The plan from above, in 2D: the minimap drawn each frame (VIEW-05), and an
 * SVG shown where the browser cannot do WebGL.
 */

/** Fits the model's bounds into a w × h box, with padding. */
export function fit(bounds, w, h, pad = 8) {
  const bw = Math.max(bounds.maxX - bounds.minX, 0.1);
  const bh = Math.max(bounds.maxY - bounds.minY, 0.1);
  const k = Math.min((w - pad * 2) / bw, (h - pad * 2) / bh);
  const ox = (w - bw * k) / 2 - bounds.minX * k;
  const oy = (h - bh * k) / 2 - bounds.minY * k;
  return { k, map: (x, y) => [ox + x * k, oy + y * k] };
}

/** Draws the minimap: floor, walls, objects, and you with your facing. */
export function drawMinimap(ctx, model, pos, yaw, w, h) {
  const dpr = ctx.canvas.width / w;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const { k, map } = fit(model.bounds, w, h);

  if (model.floor?.length >= 3) {
    ctx.beginPath();
    model.floor.forEach(([x, y], i) => (i ? ctx.lineTo(...map(x, y)) : ctx.moveTo(...map(x, y))));
    ctx.closePath();
    ctx.fillStyle = '#0c1d25';
    ctx.fill();
  }
  ctx.fillStyle = '#1d444f';
  for (const o of model.objects) {
    const [cx, cy] = map(o.x, o.y);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(o.angle);
    ctx.fillRect((-o.w / 2) * k, (-o.d / 2) * k, o.w * k, o.d * k);
    ctx.restore();
  }
  ctx.lineCap = 'round';
  for (const p of model.walls) {
    if (p.bottom > 1.8) continue; // Door heads: the gap shows as a gap.
    ctx.strokeStyle = p.mirror ? '#927de5' : p.kind === 'sill' ? '#6fb7d9' : '#c9d1d3';
    ctx.lineWidth = p.kind === 'sill' ? 1.5 : 2;
    ctx.beginPath();
    ctx.moveTo(...map(...p.a));
    ctx.lineTo(...map(...p.b));
    ctx.stroke();
  }

  const [px, py] = map(pos[0], pos[1]);
  const spread = 0.55;
  ctx.fillStyle = 'rgba(0, 202, 178, 0.28)';
  ctx.beginPath();
  ctx.moveTo(px, py);
  ctx.arc(px, py, 18, yaw - spread, yaw + spread);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#00cab2';
  ctx.beginPath();
  ctx.arc(px, py, 4, 0, Math.PI * 2);
  ctx.fill();
}

/** The whole plan as an SVG, for browsers without WebGL. */
export function PlanSvg({ model, title }) {
  const w = 800;
  const h = 560;
  const { k, map } = fit(model.bounds, w, h, 24);
  const poly = (pts) => pts.map(([x, y]) => map(x, y).join(',')).join(' ');
  return (
    <svg className="wt-plan-svg" viewBox={`0 0 ${w} ${h}`} role="img" aria-label={title}>
      {model.floor?.length >= 3 && <polygon points={poly(model.floor)} fill="#0c1d25" />}
      {model.zones.map((z, i) => (
        <polygon key={`z${i}`} points={poly(z.points)} fill="rgba(251,72,91,0.2)" stroke="#fb485b" strokeDasharray="6 4" />
      ))}
      {model.objects.map((o, i) => {
        const [cx, cy] = map(o.x, o.y);
        return (
          <rect
            key={`o${i}`}
            x={cx - (o.w * k) / 2}
            y={cy - (o.d * k) / 2}
            width={o.w * k}
            height={o.d * k}
            transform={`rotate(${(o.angle * 180) / Math.PI} ${cx} ${cy})`}
            fill="#1d444f"
          />
        );
      })}
      {model.walls
        .filter((p) => p.bottom <= 1.8)
        .map((p, i) => {
          const [x1, y1] = map(...p.a);
          const [x2, y2] = map(...p.b);
          return (
            <line
              key={`w${i}`}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke={p.mirror ? '#927de5' : p.kind === 'sill' ? '#6fb7d9' : '#c9d1d3'}
              strokeWidth={p.kind === 'sill' ? 3 : 5}
              strokeLinecap="round"
            />
          );
        })}
    </svg>
  );
}
