/*
 * app/gait-meter.js — live GAIT-QUALITY metering for the on-canvas HUD.
 * ====================================================================
 * The training reward already rewards a flat, whole-body gait and penalizes
 * rearing up — but from the outside you can't SEE that. A real travelling-wave
 * slither and a lazy 2-joint hump look similar at a glance until you stare. This
 * meter turns the gait into two watchable 0..1 numbers, sampled once per PREVIEW
 * control step, so the sidebar/overlay can render what the creature is doing:
 *
 *   engagement — the fraction of joints actually WORKING (angle-std over a short
 *                rolling window above ACTIVE_STD). A stiff hump drives ~2 joints;
 *                a real travelling wave lights up most of the body. Higher = the
 *                whole body is contributing.
 *   posture    — how far the creature is REARING up, 0 (flat on the ground) to 1
 *                (a body has risen curlMargin above its rest height — the point
 *                the env ends the episode as a "scorpion" curl). Higher = worse;
 *                a flat crawler sits near 0.
 *
 * Pure read-only measurement — it never touches the physics or the reward, so it
 * cannot change what the creature learns; it only reports what it is doing. The
 * std is kept O(1) per joint per sample with a ring buffer plus a running sum and
 * sum-of-squares, so sampling every frame across many joints stays cheap.
 */

const WINDOW = 72; // preview ticks in the rolling std window (~1.2 s at 60 fps)
const ACTIVE_STD = 0.15; // rad; a joint counts as "working" above this angle-std
const POSTURE_SMOOTH = 0.2; // EMA weight for the posture readout (anti-flicker)

export class GaitMeter {
  /** @param {number} nJoints number of joints (jointOrder length). */
  constructor(nJoints) {
    this.n = Math.max(0, nJoints | 0);
    // Per-joint ring buffer of recent angles + running sum & sum-of-squares, so
    // each sample updates the std in O(1) instead of rescanning the window.
    this._hist = Array.from({ length: this.n }, () => new Float64Array(WINDOW));
    this._sum = new Float64Array(this.n);
    this._sumSq = new Float64Array(this.n);
    this._pos = 0; // next write index into every ring buffer
    this._count = 0; // filled slots (0..WINDOW)
    // Public readouts (0..1). Mirrored onto the lane by the caller each tick.
    this.engagement = 0;
    this.activeJoints = 0;
    this.posture = 0;
  }

  /** Clear the window (call when the episode resets so the snap-back to the start
   *  pose does not register as a burst of motion). Keeps buffers allocated. */
  reset() {
    this._sum.fill(0);
    this._sumSq.fill(0);
    for (const h of this._hist) h.fill(0);
    this._pos = 0;
    this._count = 0;
    this.engagement = 0;
    this.activeJoints = 0;
    this.posture = 0;
  }

  /**
   * sample(angles, rear) — fold one control step into the meters.
   * @param {number[]} angles joint angles (rad) in jointOrder, length n.
   * @param {number}   rear   instantaneous rear fraction: 0 (flat) .. 1 (a body
   *                          curlMargin above rest); clamped into posture.
   */
  sample(angles, rear) {
    if (this.n === 0) {
      this.engagement = 0;
      this.activeJoints = 0;
      this.posture += (clamp01(rear) - this.posture) * POSTURE_SMOOTH;
      return;
    }
    const full = this._count === WINDOW;
    let active = 0;
    for (let j = 0; j < this.n; j++) {
      const a = Number.isFinite(angles[j]) ? angles[j] : 0;
      const buf = this._hist[j];
      const old = buf[this._pos];
      if (full) {
        this._sum[j] -= old;
        this._sumSq[j] -= old * old;
      }
      buf[this._pos] = a;
      this._sum[j] += a;
      this._sumSq[j] += a * a;
      const cnt = full ? WINDOW : this._count + 1;
      const mean = this._sum[j] / cnt;
      const varr = this._sumSq[j] / cnt - mean * mean;
      const std = varr > 0 ? Math.sqrt(varr) : 0;
      if (std > ACTIVE_STD) active++;
    }
    this._pos = (this._pos + 1) % WINDOW;
    if (this._count < WINDOW) this._count++;
    this.activeJoints = active;
    this.engagement = active / this.n;
    this.posture += (clamp01(rear) - this.posture) * POSTURE_SMOOTH;
  }
}

function clamp01(v) {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export default GaitMeter;
