/*
 * ui/loop.js — a fixed-timestep game loop with an accumulator.
 * ===========================================================
 * Physics wants a constant dt for determinism; the browser gives us variable
 * frame times via requestAnimationFrame. The classic fix is an accumulator:
 * we bank real elapsed time and spend it in fixed CONFIG.dt chunks.
 *
 * Extra knobs this slice needs:
 *   - paused:  freeze stepping without tearing down rAF.
 *   - speed:   integer "physics steps per rendered frame" multiplier. At
 *              speed=1 we run real-time; higher values fast-forward the sim
 *              (useful later for fast RL training). It multiplies how many
 *              fixed steps we allow to drain per frame.
 *   - fps / simTime: light telemetry for the UI.
 *
 * The loop is agnostic about WHAT it steps: the owner passes an onStep(dt)
 * (advance physics once) and an onRender() (draw). We call onStep exactly
 * (speed * n) fixed times, then onRender once.
 */

import { CONFIG } from '../config.js';

export class Loop {
  /**
   * @param {(dt:number)=>void} onStep   - advance sim by one fixed dt.
   * @param {()=>void}          onRender  - draw one frame.
   */
  constructor(onStep, onRender) {
    this.onStep = onStep;
    this.onRender = onRender;

    this.dt = CONFIG.dt;
    this.paused = false;
    this.speed = 1; // physics-steps-per-frame multiplier (>=1)

    this._acc = 0; // banked real time, seconds
    this._last = 0; // timestamp of previous frame, seconds
    this._raf = 0; // requestAnimationFrame handle
    this._running = false;

    // Telemetry.
    this.fps = 0;
    this.simTime = 0; // total simulated seconds
    this._fpsAcc = 0;
    this._fpsFrames = 0;

    this._frame = this._frame.bind(this);
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._last = performance.now() / 1000;
    this._raf = requestAnimationFrame(this._frame);
  }

  stop() {
    this._running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
  }

  setPaused(p) {
    this.paused = !!p;
  }

  togglePaused() {
    this.paused = !this.paused;
    return this.paused;
  }

  setSpeed(n) {
    // Clamp to [1, CONFIG.loop.maxSpeed] and force an integer.
    const v = Math.round(n);
    this.speed = Math.max(1, Math.min(CONFIG.loop.maxSpeed, v));
    return this.speed;
  }

  _frame(nowMs) {
    if (!this._running) return;
    const now = nowMs / 1000;
    let frameTime = now - this._last;
    this._last = now;

    // Guard against huge gaps (tab was backgrounded).
    if (frameTime > 0.25) frameTime = 0.25;

    // FPS telemetry (updated ~4x/sec).
    this._fpsAcc += frameTime;
    this._fpsFrames += 1;
    if (this._fpsAcc >= 0.25) {
      this.fps = this._fpsFrames / this._fpsAcc;
      this._fpsAcc = 0;
      this._fpsFrames = 0;
    }

    if (!this.paused) {
      this._acc += frameTime;
      // Each real dt we take `speed` physics steps. Cap total steps per
      // frame to avoid a spiral of death when the tab is slow.
      const maxSteps = CONFIG.loop.maxAccumulatedSteps * this.speed;
      let steps = 0;
      while (this._acc >= this.dt && steps < maxSteps) {
        for (let s = 0; s < this.speed; s++) {
          this.onStep(this.dt);
          this.simTime += this.dt;
        }
        this._acc -= this.dt;
        steps += 1;
      }
      // If we hit the cap, drop the backlog so we don't run away next frame.
      if (steps >= maxSteps) this._acc = 0;
    }

    this.onRender();
    this._raf = requestAnimationFrame(this._frame);
  }
}

export default Loop;
