/*
 * ui/controls.js — wire the floating sidebar to the sim & loop.
 * ============================================================
 * The sidebar is the ONLY UI in this slice. This module queries the DOM
 * elements by id (they must exist in index.html) and connects them:
 *
 *   #btn-reset   -> rebuild the sim, snap camera
 *   #btn-pause   -> toggle loop.paused (label flips Pause/Play)
 *   #chk-flail   -> Flail toggle: while on, each physics step gets random
 *                   motor speeds so joints visibly move within their limits
 *   #slider-speed-> physics steps per frame (1..CONFIG.loop.maxSpeed)
 *   #val-speed   -> shows the current speed
 *   #hud         -> optional telemetry text (fps / sim time)
 *
 * The "flail" behavior is provided as a callback the main loop calls every
 * step (applyControl). It's intentionally dumb: this slice has NO RL.
 */

import { CONFIG } from '../config.js';

export class Controls {
  /**
   * @param {object} deps
   * @param {import('../physics/sim.js').Sim} deps.sim  - current sim (mutable ref via getSim)
   * @param {() => import('../physics/sim.js').Sim} deps.getSim - fresh sim getter
   * @param {import('./loop.js').Loop} deps.loop
   * @param {() => void} deps.onReset - rebuild the sim; returns nothing
   */
  constructor({ getSim, loop, onReset }) {
    this.getSim = getSim;
    this.loop = loop;
    this.onReset = onReset;
    this.flailing = false;

    // --- DOM lookups (ids must match index.html) ---
    this.btnReset = document.getElementById('btn-reset');
    this.btnPause = document.getElementById('btn-pause');
    this.chkFlail = document.getElementById('chk-flail');
    this.slider = document.getElementById('slider-speed');
    this.valSpeed = document.getElementById('val-speed');
    this.hud = document.getElementById('hud');

    this._wire();
    this._syncSpeedLabel();
  }

  _wire() {
    if (this.btnReset) {
      this.btnReset.addEventListener('click', () => {
        this.onReset();
      });
    }

    if (this.btnPause) {
      this.btnPause.addEventListener('click', () => {
        const paused = this.loop.togglePaused();
        this.btnPause.textContent = paused ? 'Play' : 'Pause';
        this.btnPause.classList.toggle('active', paused);
      });
    }

    if (this.chkFlail) {
      this.flailing = !!this.chkFlail.checked;
      this.chkFlail.addEventListener('change', () => {
        this.flailing = !!this.chkFlail.checked;
        // When flailing turns OFF, zero the motors so joints settle.
        if (!this.flailing) {
          const sim = this.getSim();
          sim.setMotorSpeeds(sim.motorized.map(() => 0));
        }
      });
    }

    if (this.slider) {
      // Configure range from CONFIG.
      this.slider.min = '1';
      this.slider.max = String(CONFIG.loop.maxSpeed);
      this.slider.step = '1';
      this.slider.value = String(this.loop.speed);
      this.slider.addEventListener('input', () => {
        const v = this.loop.setSpeed(Number(this.slider.value));
        this.slider.value = String(v);
        this._syncSpeedLabel();
      });
    }
  }

  _syncSpeedLabel() {
    if (this.valSpeed) this.valSpeed.textContent = `${this.loop.speed}x`;
  }

  /**
   * applyControl(sim, dt) — called by the loop BEFORE each physics step.
   * When flailing, sets a fresh random motor target for every motorized
   * joint within [-range, +range] rad/s; the joint limits keep motion sane.
   */
  applyControl(sim) {
    if (!this.flailing) return;
    const range = CONFIG.flail.range;
    const speeds = new Array(sim.motorized.length);
    for (let i = 0; i < speeds.length; i++) {
      speeds[i] = (Math.random() * 2 - 1) * range;
    }
    sim.setMotorSpeeds(speeds);
  }

  /** updateHud() — refresh the telemetry line each rendered frame. */
  updateHud(sim) {
    if (!this.hud) return;
    const fps = this.loop.fps.toFixed(0);
    const t = this.loop.simTime.toFixed(1);
    const rp = sim.rootPosition();
    this.hud.textContent =
      `${fps} fps  ·  sim ${t}s  ·  x ${rp.x.toFixed(2)}m  ·  ${this.loop.speed}x` +
      (this.loop.paused ? '  ·  PAUSED' : '');
  }

  /** Called after a reset() so any per-sim UI state re-syncs. */
  onSimRebuilt() {
    // Nothing persistent to reset in this slice, but keep the hook for RL.
  }
}

export default Controls;
