/*
 * render.js — draw the sim onto a 2D canvas.
 * ==========================================
 * Pure drawing: given a canvas context, a Sim, and a Camera, paint the
 * ground and every body. No physics mutation happens here.
 *
 * Bodies are drawn by reading each planck Body's live transform
 * (position + angle) and its fixture shape. We support box (polygon) and
 * circle fixtures — the two shapes the creature schema allows. World meters
 * are converted to screen pixels via the camera (which applies the y-flip).
 *
 * Coloring follows CONFIG.colors: root, foot, and generic limb are distinct,
 * and each joint pivot gets a small dot so the articulation is visible.
 */

import { CONFIG } from './config.js';

// planck global (for shape type sniffing via getType()).
const planck = /** @type {any} */ (globalThis).planck;

/**
 * drawScene(ctx, sim, camera) — render one frame. Assumes ctx is already
 * scaled for devicePixelRatio (so we can draw in CSS pixels).
 */
export function drawScene(ctx, sim, camera) {
  const C = CONFIG.colors;

  // --- Clear background ---
  ctx.save();
  ctx.fillStyle = C.background;
  ctx.fillRect(0, 0, camera.viewW, camera.viewH);

  // --- Ground: a filled slab from y=0 down to the bottom of the screen. ---
  drawGround(ctx, camera, C);

  // --- Bodies ---
  for (const [id, body] of sim.bodies) {
    const ud = body.getUserData() || {};
    let color = C.limb;
    if (ud.isRoot) color = C.root;
    else if (ud.isFoot) color = C.foot;
    drawBody(ctx, camera, body, color, C.outline);
  }

  // --- Joint pivot dots ---
  ctx.fillStyle = C.joint;
  for (const [id, joint] of sim.joints) {
    // Anchor A in world space tracks the shared pivot.
    const a = joint.getAnchorA();
    const s = camera.worldToScreen(a.x, a.y);
    ctx.beginPath();
    ctx.arc(s.x, s.y, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

/** Fill everything below world y=0 as ground, with a bright surface line. */
function drawGround(ctx, camera, C) {
  const gy = CONFIG.ground.y;
  const left = camera.worldToScreen(-CONFIG.ground.halfWidth, gy);
  const right = camera.worldToScreen(CONFIG.ground.halfWidth, gy);
  const surfaceY = left.y; // both ends share the same y at constant world y
  ctx.fillStyle = C.ground;
  ctx.fillRect(0, surfaceY, camera.viewW, camera.viewH - surfaceY);
  ctx.strokeStyle = C.groundLine;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, surfaceY);
  ctx.lineTo(camera.viewW, surfaceY);
  ctx.stroke();
}

/** Draw a single dynamic body (box polygon or circle) at its live transform. */
function drawBody(ctx, camera, body, fill, stroke) {
  const pos = body.getPosition();
  const angle = body.getAngle();

  for (let f = body.getFixtureList(); f; f = f.getNext()) {
    const shape = f.getShape();
    const type = shape.getType(); // 'polygon' | 'circle' | 'edge' | 'chain'

    if (type === 'circle') {
      // Circle: transform its local center by the body pose, then draw.
      const lc = shape.getCenter ? shape.getCenter() : shape.m_p;
      const world = bodyPointToWorld(pos, angle, lc.x, lc.y);
      const c = camera.worldToScreen(world.x, world.y);
      const rpx = shape.getRadius() * CONFIG.PPM;
      ctx.beginPath();
      ctx.arc(c.x, c.y, rpx, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      // A little radius spoke so rotation is visible.
      const edge = bodyPointToWorld(pos, angle, lc.x + shape.getRadius(), lc.y);
      const e = camera.worldToScreen(edge.x, edge.y);
      ctx.beginPath();
      ctx.moveTo(c.x, c.y);
      ctx.lineTo(e.x, e.y);
      ctx.stroke();
    } else if (type === 'polygon') {
      // Polygon (our boxes): map each vertex through the body pose.
      const verts = shape.m_vertices || (shape.getVertex && collectVerts(shape));
      ctx.beginPath();
      for (let i = 0; i < verts.length; i++) {
        const v = verts[i];
        const world = bodyPointToWorld(pos, angle, v.x, v.y);
        const p = camera.worldToScreen(world.x, world.y);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    // 'edge'/'chain' fixtures (the ground) are drawn separately by drawGround.
  }
}

/** Collect polygon vertices when only getVertex(i)/m_count is available. */
function collectVerts(shape) {
  const out = [];
  const n = shape.m_count != null ? shape.m_count : shape.getVertexCount();
  for (let i = 0; i < n; i++) out.push(shape.getVertex(i));
  return out;
}

/** Rotate+translate a body-local point (lx,ly) into world space. */
function bodyPointToWorld(pos, angle, lx, ly) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return {
    x: pos.x + (c * lx - s * ly),
    y: pos.y + (s * lx + c * ly),
  };
}

export default drawScene;
