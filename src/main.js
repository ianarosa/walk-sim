/*
 * main.js — ENTRY POINT. Wires everything together and starts the loop.
 * =====================================================================
 * Responsibilities:
 *   1. Grab the fullscreen <canvas id="sim"> and its 2D context.
 *   2. Size the canvas to the viewport, honoring devicePixelRatio, and
 *      re-size on window resize.
 *   3. Build a Sim from defaultBiped().
 *   4. Create a Camera and a fixed-timestep Loop.
 *   5. Each frame: run the controller (flail) + step the sim `speed` times
 *      (handled inside Loop), then follow the root with the camera and draw.
 *   6. Wire the sidebar Controls (reset/pause/flail/speed).
 *
 * planck is expected on window.planck (loaded by a plain <script> before
 * this module). We never import planck; the physics modules read the global.
 */

import { CONFIG } from './config.js';
import { defaultBiped } from './creature.js';
import { Sim } from './physics/sim.js';
import { Camera } from './ui/camera.js';
import { Loop } from './ui/loop.js';
import { Controls } from './ui/controls.js';
import { drawScene } from './render.js';

// --- Canvas & context ---------------------------------------------------
const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('sim'));
const ctx = canvas.getContext('2d');

const camera = new Camera();

/**
 * resize() — match the canvas backing store to viewport * devicePixelRatio,
 * keep the CSS size at 100vw/100vh, and reset the transform so all drawing
 * happens in CSS-pixel space (we pre-scale by DPR here).
 */
function resize() {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const w = window.innerWidth;
  const h = window.innerHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  // Draw in CSS pixels; the transform bakes in the DPR scale.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  camera.setViewport(w, h);
}
window.addEventListener('resize', resize);
resize();

// --- Sim ---------------------------------------------------------------
// `sim` is a mutable module-level ref because Reset rebuilds it. Everyone
// who needs the current sim reads it through getSim().
let sim = new Sim(defaultBiped());
const getSim = () => sim;

// Snap the camera onto the root at startup.
camera.snap(sim.rootPosition().x);

// --- Loop --------------------------------------------------------------
// onStep advances physics once (Loop calls it `speed` times per frame).
// We apply the flail controller just before each step.
const loop = new Loop(
  (dt) => {
    controls.applyControl(sim);
    sim.step(dt);
  },
  () => {
    camera.follow(sim.rootPosition().x);
    drawScene(ctx, sim, camera);
    controls.updateHud(sim);
  }
);

// --- Controls (needs loop + a reset action) ----------------------------
const controls = new Controls({
  getSim,
  loop,
  onReset: () => {
    sim = new Sim(defaultBiped());
    camera.snap(sim.rootPosition().x);
    loop.simTime = 0;
    controls.onSimRebuilt();
  },
});

// --- Go ----------------------------------------------------------------
loop.start();

// Expose a couple of handles for debugging in the console.
// (Harmless; the whole thing is a static toy.)
window.walkSim = { get sim() { return sim; }, loop, camera, CONFIG };
