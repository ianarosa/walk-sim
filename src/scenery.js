/*
 * scenery.js — motion cues: ground distance markers + parallax backdrop.
 * =====================================================================
 * Pure drawing, called from render.js INSIDE the cell clip, so everything
 * here is translucent glass on top of the page's animated gradient sky and is
 * clipped to (and framed by) each lane's rounded cell — exactly like the
 * bodies. Nothing here touches physics; it only reads a Camera and CONFIG.
 *
 * Two jobs, both meant to make it obvious the walker is TRAVELLING:
 *
 *   1. drawDistanceMarkers(ctx, camera) — regularly spaced ticks + "Nm" labels
 *      pinned to WORLD x (a START line at x=0, majors every `markerInterval`,
 *      minors every `markerMinor`). They live at fixed world positions, so as
 *      the camera chases the root they SCROLL past. Drawn with the REAL camera
 *      (parallax factor 1) so they sit exactly on the ground.
 *
 *   2. drawParallax(ctx, camera) — layered stationary scenery (far hills,
 *      clouds, mid trees, near bushes). Each layer is drawn through a VIRTUAL
 *      camera whose focus x = camera.focusX * factor. With factor 1 a layer
 *      moves fully with the world; with factor 0 it is pinned to the screen.
 *      Distant layers use a small factor so they barely drift while near ones
 *      sweep by — that difference in drift IS the sensation of motion.
 *
 * PARALLAX MATH (see layerScreenX): the real camera maps world x with
 *   screenX = offsetX + viewW/2 + (worldX - focusX) * ppm.
 * A layer just swaps the real focus for a scaled one:
 *   screenX = offsetX + viewW/2 + (worldX - focusX*factor) * ppm.
 * So when focusX moves by Δ, a layer's on-screen shift is Δ*factor*ppm — i.e.
 * proportional to factor. We keep ppm (and the y mapping) identical to the real
 * camera so trees stand on the same ground line and scale like the creature.
 *
 * DETERMINISM: scenery is a repeating FIELD. For each layer we only visit the
 * integer tile indices whose world x is on screen (culled from the camera), and
 * every per-object property (jitter, height, variant) comes from hash01(tile,
 * salt) — a pure integer hash. No Math.random, no per-frame state: a given tile
 * looks identical every frame, so the field never flickers, yet it tiles/wraps
 * out to any x the creature can reach.
 */

import { CONFIG } from './config.js';

/* --------------------------------------------------------------------------
 * Deterministic hashing helpers.
 * hash01(n, salt) -> a stable pseudo-random float in [0,1) for integer inputs.
 * We fold a `salt` in so one tile index can yield several independent values
 * (x jitter, height, variant, …) without correlating between them.
 * ------------------------------------------------------------------------ */
function hash01(n, salt = 0) {
  // Mix the tile index with the salt, then run a couple of xorshift/multiply
  // rounds (Math.imul keeps this 32-bit and identical across engines).
  let h = (n | 0) ^ Math.imul(salt | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h ^ (h >>> 4), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296; // 0xffffffff+1 -> normalize to [0,1)
}

/** Map a value in [0,1) onto [lo, hi]. */
function lerp(lo, hi, t) {
  return lo + (hi - lo) * t;
}

/**
 * layerScreenX(camera, worldX, factor) — the parallax x mapping.
 * Identical to camera.worldToScreen's x, but with the focus scaled by `factor`
 * so the layer drifts at rate `factor` relative to the real world.
 */
function layerScreenX(camera, worldX, factor) {
  return (
    (camera.offsetX || 0) +
    camera.viewW / 2 +
    (worldX - camera.focusX * factor) * camera.ppm
  );
}

/**
 * visibleTiles(camera, factor, spacing, marginM) — the inclusive [first,last]
 * tile-index range whose centers can appear in this cell, so callers loop only
 * over on-screen objects (never thousands). `marginM` pads the range in meters
 * so objects wider than one tile don't pop in/out at the cell edges.
 *
 * The layer's world center is focusX*factor; the cell shows ±(viewW/2)/ppm
 * meters around it. Tile i sits near x = i*spacing, hence the divisions below.
 */
function visibleTiles(camera, factor, spacing, marginM) {
  const halfW = camera.viewW / 2 / camera.ppm; // half the cell width, in meters
  const centerWX = camera.focusX * factor; // this layer's world-x center
  const minWX = centerWX - halfW - marginM;
  const maxWX = centerWX + halfW + marginM;
  return {
    first: Math.floor(minWX / spacing),
    last: Math.ceil(maxWX / spacing),
  };
}

/* ==========================================================================
 * FEATURE 2 — parallax scenery (call BEFORE the ground band + creature).
 * Draws back-to-front: far hills -> clouds -> mid trees -> near bushes.
 * ======================================================================== */
export function drawParallax(ctx, camera) {
  const S = CONFIG.scenery;
  drawSun(ctx, camera, S.sun); // furthest of all — behind the hills
  drawHills(ctx, camera, S.hills);
  drawClouds(ctx, camera, S.clouds);
  drawTrees(ctx, camera, S.trees);
  drawBushes(ctx, camera, S.bushes);
}

/**
 * A SINGLE soft sun disc, the furthest layer of all. It is anchored to one
 * fixed world x (SUN.worldX) rather than tiled, so there's exactly one sun; the
 * tiny parallax `factor` still gives it a gentle drift so it reads as distant.
 * Sits high in the cell by a fraction of the cell height (like clouds' band),
 * and is a warm translucent disc with a smooth radial-gradient halo (no rings).
 */
function drawSun(ctx, camera, SUN) {
  const oy = camera.offsetY || 0;
  const cx = layerScreenX(camera, SUN.worldX, SUN.factor); // near-pinned drift
  const cy = oy + camera.viewH * SUN.topFrac; // high-sky vertical spot
  const r = SUN.radius * camera.ppm; // disc radius, px (meters × ppm)

  // Cull if the whole disc + its glow is off either side of the cell.
  const glowR = r * SUN.glowFrac; // outermost halo reach
  if (cx + glowR < 0 || cx - glowR > camera.viewW) return;

  ctx.save();
  // Soft halo: ONE radial gradient warm at the disc edge, fading to transparent
  // at glowR — a smooth falloff with no visible ring banding.
  const halo = ctx.createRadialGradient(cx, cy, r, cx, cy, glowR);
  halo.addColorStop(0, SUN.glowColor);
  halo.addColorStop(1, SUN.glowEdgeColor);
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(cx, cy, glowR, 0, Math.PI * 2);
  ctx.fill();

  // The solid warm disc on top.
  ctx.fillStyle = SUN.color;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** Far hills: soft rounded mounds sitting on the ground line, two tinted rows. */
function drawHills(ctx, camera, H) {
  const groundY = camera.worldToScreen(0, CONFIG.ground.y).y;
  // Cull generously — a hill's half-width can be several meters.
  const { first, last } = visibleTiles(camera, H.factor, H.spacing, H.maxH * H.widthFrac);

  ctx.save();
  for (let i = first; i <= last; i++) {
    // Stable per-hill values from the tile index.
    const jitter = (hash01(i, 1) - 0.5) * 2 * H.jitter; // ± jitter meters
    const wx = i * H.spacing + jitter;
    const heightM = lerp(H.minH, H.maxH, hash01(i, 2)); // hill height, meters
    const isFront = hash01(i, 3) < 0.5; // two depth rows for a layered look

    const cx = layerScreenX(camera, wx, H.factor);
    const rY = heightM * camera.ppm; // vertical radius, px
    const rX = heightM * H.widthFrac * camera.ppm; // horizontal radius, px

    // A half-ellipse mound whose flat base rests on the ground line.
    ctx.beginPath();
    ctx.ellipse(cx, groundY, rX, rY, 0, Math.PI, Math.PI * 2);
    ctx.closePath();
    ctx.fillStyle = isFront ? H.colorNear : H.colorFar;
    ctx.fill();
  }
  ctx.restore();
}

/** Clouds: clusters of soft white lobes drifting slowly high in the cell. */
function drawClouds(ctx, camera, C) {
  const oy = camera.offsetY || 0;
  // Clouds live in a horizontal band defined as fractions of the cell height,
  // so they float in the "sky" regardless of where the ground line sits.
  const bandTop = oy + camera.viewH * C.topFrac;
  const bandH = camera.viewH * C.bandFrac;
  const { first, last } = visibleTiles(camera, C.factor, C.spacing, C.maxR * 3);

  ctx.save();
  ctx.fillStyle = C.color;
  for (let i = first; i <= last; i++) {
    const jitter = (hash01(i, 11) - 0.5) * 2 * C.jitter;
    const wx = i * C.spacing + jitter;
    const cx = layerScreenX(camera, wx, C.factor);
    const cy = bandTop + hash01(i, 12) * bandH; // stable vertical spot in the band
    const r = lerp(C.minR, C.maxR, hash01(i, 13)) * camera.ppm;

    // A cloud = three overlapping lobes; sizes/offsets are stable hashes.
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.arc(cx - r * 0.85, cy + r * 0.28, r * 0.72, 0, Math.PI * 2);
    ctx.arc(cx + r * 0.9, cy + r * 0.22, r * 0.66, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** Mid trees: a soft round canopy on a short trunk, standing on the ground. */
function drawTrees(ctx, camera, T) {
  const groundY = camera.worldToScreen(0, CONFIG.ground.y).y;
  const { first, last } = visibleTiles(camera, T.factor, T.spacing, T.maxH);

  ctx.save();
  for (let i = first; i <= last; i++) {
    const jitter = (hash01(i, 21) - 0.5) * 2 * T.jitter;
    const wx = i * T.spacing + jitter;
    const heightM = lerp(T.minH, T.maxH, hash01(i, 22)); // total tree height
    const variant = hash01(i, 23); // 0..1 -> canopy fullness (a little variety)

    const cx = layerScreenX(camera, wx, T.factor);
    const hpx = heightM * camera.ppm;
    const trunkW = Math.max(2, hpx * 0.09);
    const trunkH = hpx * 0.42; // trunk is the lower ~40% of the tree
    const canopyR = hpx * lerp(0.34, 0.44, variant); // canopy radius, px
    const canopyCy = groundY - trunkH - canopyR * 0.7; // canopy center

    // Trunk (rounded-ish rect from the ground up).
    ctx.fillStyle = T.trunkColor;
    ctx.fillRect(cx - trunkW / 2, groundY - trunkH, trunkW, trunkH);

    // Canopy = a couple of overlapping soft circles for a fuller silhouette.
    ctx.fillStyle = T.canopyColor;
    ctx.beginPath();
    ctx.arc(cx, canopyCy, canopyR, 0, Math.PI * 2);
    ctx.arc(cx - canopyR * 0.6, canopyCy + canopyR * 0.35, canopyR * 0.7, 0, Math.PI * 2);
    ctx.arc(cx + canopyR * 0.6, canopyCy + canopyR * 0.35, canopyR * 0.7, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** Near bushes: low rounded clumps just in front of the trees. */
function drawBushes(ctx, camera, B) {
  const groundY = camera.worldToScreen(0, CONFIG.ground.y).y;
  const { first, last } = visibleTiles(camera, B.factor, B.spacing, B.maxH * 2);

  ctx.save();
  ctx.fillStyle = B.color;
  for (let i = first; i <= last; i++) {
    const jitter = (hash01(i, 31) - 0.5) * 2 * B.jitter;
    const wx = i * B.spacing + jitter;
    const heightM = lerp(B.minH, B.maxH, hash01(i, 32));
    const cx = layerScreenX(camera, wx, B.factor);
    const r = heightM * camera.ppm; // clump radius, px

    // A three-lobe rounded clump sitting on the ground line.
    ctx.beginPath();
    ctx.arc(cx, groundY - r * 0.5, r, 0, Math.PI * 2);
    ctx.arc(cx - r * 0.8, groundY - r * 0.3, r * 0.75, 0, Math.PI * 2);
    ctx.arc(cx + r * 0.8, groundY - r * 0.3, r * 0.75, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/* ==========================================================================
 * FEATURE 1 — ground distance markers (call AFTER the ground band, so the
 * ticks read on top of it, but BEFORE the creature bodies).
 * ======================================================================== */
export function drawDistanceMarkers(ctx, camera) {
  const S = CONFIG.scenery;
  const groundY = camera.worldToScreen(0, CONFIG.ground.y).y;

  // Visible world-x span for the REAL camera (factor 1): only tick within it.
  const halfW = camera.viewW / 2 / camera.ppm;
  const minWX = camera.focusX - halfW;
  const maxWX = camera.focusX + halfW;

  // In tiny/zoomed-out cells the minor ticks + labels turn to noise, so below a
  // PPM threshold we draw ONLY the major ticks and the start line.
  const detailed = camera.ppm >= S.markerLabelMinPPM;

  ctx.save();
  ctx.lineWidth = 1;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.font = S.markerLabelFont;

  // Walk minor-tick multiples across the visible span (a small, bounded loop).
  const step = S.markerMinor;
  const firstK = Math.floor(minWX / step);
  const lastK = Math.ceil(maxWX / step);
  const majorEvery = Math.round(S.markerInterval / S.markerMinor); // e.g. 2

  for (let k = firstK; k <= lastK; k++) {
    const wx = k * step;
    const isMajor = k % majorEvery === 0;
    const isStart = k === 0; // x=0 gets the distinct START line
    if (!detailed && !isMajor) continue; // skip minor clutter when zoomed out

    const sx = layerScreenX(camera, wx, 1); // real camera => exact ground x
    if (isStart) {
      // START line: taller, tinted, with a small "START" cap.
      ctx.strokeStyle = S.startLineColor;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(sx, groundY - 4);
      ctx.lineTo(sx, groundY + S.startLineTickH);
      ctx.stroke();
      ctx.lineWidth = 1;
      if (detailed) {
        ctx.fillStyle = S.startLineColor;
        ctx.fillText('START', sx, groundY - 6);
      }
      continue;
    }

    // Regular tick dropping below the ground line; majors are longer/brighter.
    const tickH = isMajor ? S.markerMajorTickH : S.markerTickH;
    ctx.strokeStyle = isMajor ? S.markerMajorColor : S.markerMinorColor;
    ctx.beginPath();
    ctx.moveTo(sx, groundY);
    ctx.lineTo(sx, groundY + tickH);
    ctx.stroke();

    // Label majors with their distance ("1m", "2m", …) when there's room.
    if (isMajor && detailed) {
      const meters = Math.round(wx); // majors land on whole meters by design
      ctx.fillStyle = S.markerLabelColor;
      ctx.fillText(`${meters}m`, sx, groundY + tickH + 12);
    }
  }
  ctx.restore();

  // Milestone pennants on top of the ground band (still behind the creature).
  drawMilestones(ctx, camera);
}

/**
 * drawMilestones(ctx, camera) — a little pennant flag every `interval` meters
 * (10m, 20m, …), a strong "how far have I come" cue on long walks. Each flag is
 * a thin pole rising from the ground line with a small triangular pennant near
 * its top, labelled with the distance. Pinned to fixed world x and drawn with
 * the REAL camera (factor 1) so the poles stand exactly on the ground and scroll
 * past with the world. Determinism: fixed world positions, no jitter/state.
 */
function drawMilestones(ctx, camera) {
  const S = CONFIG.scenery;
  const M = S.milestones;
  const groundY = camera.worldToScreen(0, CONFIG.ground.y).y;

  // Same visible world-x span math as the markers above (real camera, factor 1).
  const halfW = camera.viewW / 2 / camera.ppm;
  const minWX = camera.focusX - halfW;
  const maxWX = camera.focusX + halfW;

  // Only the label text is gated by zoom; the pole+flag always draw.
  const detailed = camera.ppm >= S.markerLabelMinPPM;

  // Pole/flag sizes are meters × ppm so they scale with the creature.
  const poleH = M.poleH * camera.ppm; // pole height above the ground, px
  const flagW = M.flagW * camera.ppm; // pennant width (pole → tip), px
  const flagH = M.flagH * camera.ppm; // pennant height, px

  // Walk the whole-`interval` multiples across the visible span (bounded loop).
  const firstN = Math.floor(minWX / M.interval);
  const lastN = Math.ceil(maxWX / M.interval);

  ctx.save();
  ctx.lineWidth = 2;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.font = M.labelFont;

  for (let n = firstN; n <= lastN; n++) {
    if (n <= 0) continue; // skip x=0 (the START line owns it) and anything behind
    const wx = n * M.interval;
    const sx = layerScreenX(camera, wx, 1); // real camera => exact ground x
    const topY = groundY - poleH; // top of the pole

    // Thin vertical pole rising from the ground line.
    ctx.strokeStyle = M.poleColor;
    ctx.beginPath();
    ctx.moveTo(sx, groundY);
    ctx.lineTo(sx, topY);
    ctx.stroke();

    // Triangular pennant hanging off the top of the pole (points forward, +x).
    ctx.fillStyle = M.flagColor;
    ctx.beginPath();
    ctx.moveTo(sx, topY); // pole top
    ctx.lineTo(sx + flagW, topY + flagH * 0.5); // outward tip
    ctx.lineTo(sx, topY + flagH); // back to pole
    ctx.closePath();
    ctx.fill();

    // Distance label above the pennant, in a slightly bolder/tinted style.
    if (detailed) {
      ctx.fillStyle = M.labelColor;
      ctx.fillText(`${Math.round(wx)}m`, sx, topY - 4);
    }
  }
  ctx.restore();
}

export default { drawParallax, drawDistanceMarkers };
