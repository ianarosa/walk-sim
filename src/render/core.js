/*
 * render/core.js — the per-sim draw entry point + ground band.
 * ================================================================
 * Pure drawing: given a canvas context, a Sim, and a Camera, paint a soft
 * translucent lane "card", a gentle ground band, and every body as a rounded,
 * softly-shadowed segment. No physics mutation happens here.
 *
 * The canvas is TRANSPARENT over the page's animated gradient sky (main.js
 * clears it each frame with clearRect), so everything we paint is translucent
 * glass on top of that gradient — the physics view and the UI feel like one
 * cohesive frosted-glass design.
 *
 * GRID-AWARE: a Camera carries its own viewport RECT (offsetX/offsetY +
 * viewW/viewH, see camera.js). `drawSim` clips to a rounded version of that
 * rect so many lanes tile one canvas, each in its own glass cell. The classic
 * fullscreen path is just a camera with offset 0,0 covering the whole canvas;
 * `drawScene` is kept as a back-compat alias.
 *
 * World meters are converted to screen pixels via the camera (which applies
 * the y-flip and its own PPM). Colors/softness come from CONFIG.theme.
 */

import { CONFIG } from '../config.js';
import { drawParallax, drawDistanceMarkers } from '../scenery.js';
import { roundRectPath } from './shape.js';
import { drawBody } from './creature.js';

/**
 * drawSim(ctx, sim, camera) — render one sim into the camera's glass cell.
 * Assumes ctx is already scaled for devicePixelRatio (we draw in CSS pixels)
 * and that the canvas has been cleared for this frame by the caller.
 */
export function drawSim(ctx, sim, camera) {
  const T = CONFIG.theme;
  const ox = camera.offsetX || 0;
  const oy = camera.offsetY || 0;
  const inset = 4; // small gap so cells read as separate floating cards

  ctx.save();
  // Rounded translucent cell "card", clipped so lanes don't bleed together.
  roundRectPath(ctx, ox + inset, oy + inset, camera.viewW - 2 * inset, camera.viewH - 2 * inset, T.cellRadius);
  ctx.save();
  ctx.clip();
  ctx.fillStyle = T.cellPanel;
  ctx.fillRect(ox, oy, camera.viewW, camera.viewH);

  // --- Parallax backdrop (behind the ground + creature) ---
  // Far hills -> clouds -> mid trees -> near bushes, each drifting at its own
  // rate so the creature visibly travels past a stable, deterministic field.
  drawParallax(ctx, camera);

  drawGround(ctx, camera, T);

  // --- Ground distance markers (on top of the ground band, behind bodies) ---
  // Fixed-world "Nm" ticks + a START line that scroll past as the camera chases
  // the root, giving a concrete read on how far the walker has gone.
  drawDistanceMarkers(ctx, camera);

  // --- Bodies (soft, rounded, gently shadowed) ---
  for (const [, body] of sim.bodies) {
    const ud = body.getUserData() || {};
    let color = T.limb;
    if (ud.isRoot) color = T.root;
    else if (ud.isFoot) color = T.foot;
    drawBody(ctx, camera, body, color, T);
  }

  // --- Joint markers (subtle) ---
  ctx.fillStyle = T.joint;
  for (const [, joint] of sim.joints) {
    const a = joint.getAnchorA();
    const s = camera.worldToScreen(a.x, a.y);
    ctx.beginPath();
    ctx.arc(s.x, s.y, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore(); // end clip

  // Glass edge around the cell.
  roundRectPath(ctx, ox + inset, oy + inset, camera.viewW - 2 * inset, camera.viewH - 2 * inset, T.cellRadius);
  ctx.strokeStyle = T.cellBorder;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}

// Back-compat name for callers that render a single fullscreen sim.
export const drawScene = drawSim;

/** Soft translucent ground band with a gentle highlight line. */
function drawGround(ctx, camera, T) {
  const gy = CONFIG.ground.y;
  const surfaceY = camera.worldToScreen(0, gy).y;
  const ox = camera.offsetX || 0;
  const oy = camera.offsetY || 0;
  const bottom = oy + camera.viewH;
  if (surfaceY < bottom) {
    const grad = ctx.createLinearGradient(0, surfaceY, 0, bottom);
    grad.addColorStop(0, T.groundBand);
    grad.addColorStop(1, 'rgba(255,255,255,0.02)');
    ctx.fillStyle = grad;
    ctx.fillRect(ox, surfaceY, camera.viewW, bottom - surfaceY);
  }
  ctx.strokeStyle = T.groundEdge;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(ox, surfaceY);
  ctx.lineTo(ox + camera.viewW, surfaceY);
  ctx.stroke();
}
