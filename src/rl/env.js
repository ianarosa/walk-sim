/*
 * rl/env.js — the observation/action contract + reward & episode logic.
 * ========================================================================
 * This is the ONLY place that reads meaning out of a Sim for learning: it
 * turns the Sim's generic getters into a fixed-order observation vector,
 * turns a policy's squashed action into motor commands, and scores each step
 * with a reward. Everything here is written GENERICALLY over `sim.jointOrder`
 * / `sim.footBodyIds` / `sim.motorized`, so it works for ANY morphology, not
 * just the default biped.
 *
 * OBSERVATION VECTOR (Float64Array), fixed order:
 *   root:  sin(rootAngle), cos(rootAngle), rootAngVel, rootHeight(y),
 *          rootVx, rootVy                                          (6 values)
 *   per joint in sim.jointOrder:
 *          normalizedAngle = clamp(((a-lo)/(hi-lo))*2 - 1, -1, 1),
 *          jointSpeed * speedScale                            (2 per joint)
 *   per foot in sim.footBodyIds:
 *          contact ? 1 : 0                                     (1 per foot)
 *
 * ACTION VECTOR: length sim.motorized.length. The policy emits one squashed
 * value in [-1,1] per motorized joint (sim.motorized order); we scale by
 * CONFIG.RL.maxMotorSpeed and hand it to sim.setMotorSpeeds (an Array is
 * interpreted in sim.motorized order by the Sim).
 *
 * JOINT-LIMIT SOURCE: planck's RevoluteJoint exposes getLowerLimit()/
 * getUpperLimit(), reported in the SAME reference frame as getJointAngle().
 * We read them straight off `sim.joints.get(id)` (see jointLimits() below).
 * If a joint ever lacks those methods we fall back to a symmetric +/-PI so
 * normalization still produces a finite value.
 */

import { CONFIG } from '../config.js';

// --- Joint limits --------------------------------------------------------

/**
 * jointLimits(sim) -> Map<jointId, {lo, hi}> for EVERY joint in jointOrder.
 * Uses the planck joint accessors; getJointAngle() and getLowerLimit()/
 * getUpperLimit() share a frame, so (angle-lo)/(hi-lo) is a clean 0..1.
 */
export function jointLimits(sim) {
  const out = new Map();
  for (const id of sim.jointOrder) {
    const j = sim.joints.get(id);
    let lo = -Math.PI;
    let hi = Math.PI;
    if (j && typeof j.getLowerLimit === 'function') {
      lo = j.getLowerLimit();
      hi = j.getUpperLimit();
    }
    // Degenerate limit (lo==hi) would divide by zero; widen a hair.
    if (!(hi > lo)) {
      lo -= 1e-3;
      hi += 1e-3;
    }
    out.set(id, { lo, hi });
  }
  return out;
}

// --- Sizes ---------------------------------------------------------------

/** obsSize(sim) — 6 root + 2 per joint + 1 per foot. */
export function obsSize(sim) {
  return 6 + 2 * sim.jointOrder.length + sim.footBodyIds.length;
}

/** actSize(sim) — one action channel per motorized joint. */
export function actSize(sim) {
  return sim.motorized.length;
}

// --- Observation ---------------------------------------------------------

/**
 * observe(sim, limits?) -> Float64Array, the RAW (un-normalized) observation
 * in the fixed order documented above. Pass a precomputed `limits` map (from
 * jointLimits) to avoid rebuilding it every control step.
 */
export function observe(sim, limits) {
  const lims = limits || jointLimits(sim);
  const speedScale = CONFIG.RL.speedScale;
  const out = new Float64Array(obsSize(sim));

  // --- Root block ---
  const ang = sim.rootAngle();
  const pos = sim.rootPosition();
  const vel = sim.rootVelocity();
  const angVel = sim._root ? sim._root.getAngularVelocity() : 0;
  let k = 0;
  out[k++] = Math.sin(ang);
  out[k++] = Math.cos(ang);
  out[k++] = angVel;
  out[k++] = pos.y;
  out[k++] = vel.x;
  out[k++] = vel.y;

  // --- Per-joint block (jointOrder) ---
  const angles = sim.jointAngles();
  const speeds = sim.jointSpeeds();
  for (const id of sim.jointOrder) {
    const { lo, hi } = lims.get(id);
    let norm = ((angles[id] - lo) / (hi - lo)) * 2 - 1;
    if (norm > 1) norm = 1;
    else if (norm < -1) norm = -1;
    out[k++] = norm;
    out[k++] = speeds[id] * speedScale;
  }

  // --- Per-foot contact block (footBodyIds) ---
  const contacts = sim.footContacts();
  for (const id of sim.footBodyIds) out[k++] = contacts[id] ? 1 : 0;

  return out;
}

// --- Environment ---------------------------------------------------------

/**
 * Env — thin reward/episode wrapper around a Sim.
 *   reset()            -> raw observation of the fresh state
 *   stepWith(action)   -> { obs, reward, done, distance }
 *
 * `action` is the SQUASHED policy output in [-1,1] (sim.motorized order). We
 * scale it to motor speeds, advance the physics by CONFIG.RL.frameSkip fixed
 * sub-steps (a "control step"), then score the transition.
 *
 * REWARD — THREE PILLARS: go the FASTEST, the FURTHEST, and the SMOOTHEST.
 * Balance is no longer a goal; it is only the minimal PREREQUISITE that keeps
 * the other three honest (you can't be fast/far/smooth face-down).
 *
 *   reward = aliveBonus                       // minimal support: don't faceplant
 *          + wVel      * speed·G              // FASTEST: forward speed, UNCAPPED
 *          + wProgress * dx·G                 // FURTHEST: net forward ΔX this step
 *          - wSmooth   * mean(Δaction^2)      // SMOOTHEST: no frame-to-frame jitter
 *          - wJerk     * mean((Δjointspeed·speedScale)^2)  // SMOOTHEST: no twitching
 *          - wUpright  * rootAngle^2          // minimal balance support
 *          - wHeight   * (rootY - targetH)^2  // minimal height support (no crouch cheat)
 *          - wEnergy   * mean(action^2)       // tiny motor-effort tax
 *
 * where, with controlDt = frameSkip·dt and dx = ΔrootX this control step:
 *   avgVx = dx / controlDt      (average forward speed this control step)
 *   G     = 1 only while |rootAngle| < uprightThresh, else 0
 *   speed = G ? avgVx : 0                      // FASTEST term, SIGNED, no cap
 *   dx    = G ? ΔrootX : 0                      // FURTHEST term, SIGNED
 * The speed/progress terms are SIGNED while upright (forward paid, BACKWARD
 * penalized) so the deterministic greedy gait reliably faces forward. The
 * upright gate G keeps uprightness purely INSTRUMENTAL: the agent cannot win
 * the speed/distance terms by diving forward, but staying up is not itself the
 * objective — it is worth only the small aliveBonus. Removing the velocity cap
 * makes "faster is always better"; the explicit progress term makes "covering
 * ground is directly paid"; the strong smoothness+jerk penalties make the gait
 * un-twitchy. Speed + distance + smoothness dominate; balance is a floor, not a
 * ceiling. All knobs come from CONFIG.RL.
 *
 * done when the root falls below fallHeight, tilts past maxTilt, or the episode
 * reaches maxEpisodeSteps — so falling early directly costs distance (FURTHEST).
 */
export class Env {
  constructor(sim) {
    this.sim = sim;
    this.limits = jointLimits(sim);
    this.stepInEpisode = 0;
    this.startX = 0;
    this.prevX = 0;
    this.prevAction = null; // last squashed action, for the smoothness penalty
    this.prevSpeeds = null; // last joint speeds (by id), for the jerk penalty
  }

  /** Rebuild the sim to its rest pose and return the first observation. */
  reset() {
    this.sim.reset();
    // reset() rebuilds bodies/joints, so limits handles are stale — refresh.
    this.limits = jointLimits(this.sim);
    this.stepInEpisode = 0;
    const p = this.sim.rootPosition();
    this.startX = p.x;
    this.prevX = p.x;
    this.prevAction = null;
    this.prevSpeeds = null;
    return observe(this.sim, this.limits);
  }

  /**
   * stepWith(action) — apply a squashed action and advance one control step.
   * @param {Float64Array|number[]} action values in [-1,1], motorized order.
   */
  stepWith(action) {
    const rl = CONFIG.RL;

    // Squashed [-1,1] -> target motor speeds (rad/s), in sim.motorized order.
    const n = this.sim.motorized.length;
    const speeds = new Array(n);
    const clamped = new Float64Array(n); // clamped action, kept for smoothness
    let energy = 0;
    let smooth = 0;
    for (let i = 0; i < n; i++) {
      let a = action[i];
      if (!Number.isFinite(a)) a = 0;
      if (a > 1) a = 1;
      else if (a < -1) a = -1;
      clamped[i] = a;
      speeds[i] = a * rl.maxMotorSpeed;
      energy += a * a;
      const prev = this.prevAction ? this.prevAction[i] : a;
      const da = a - prev;
      smooth += da * da;
    }
    energy /= n || 1;
    smooth /= n || 1;
    this.prevAction = clamped;
    this.sim.setMotorSpeeds(speeds);

    // Advance frameSkip fixed physics steps under the held motor targets.
    for (let s = 0; s < rl.frameSkip; s++) this.sim.step(CONFIG.dt);
    this.stepInEpisode += 1;

    // Joint jerk: mean squared change in joint speed (rad/s) between control
    // steps — an angular-acceleration proxy that penalizes twitchy motors. We
    // scale by speedScale (same as the obs) to keep it O(1) alongside energy.
    const jointSpeeds = this.sim.jointSpeeds();
    let jerk = 0;
    let jc = 0;
    for (const id of this.sim.jointOrder) {
      const prev = this.prevSpeeds ? this.prevSpeeds[id] : jointSpeeds[id];
      const d = (jointSpeeds[id] - prev) * rl.speedScale;
      jerk += d * d;
      jc += 1;
    }
    jerk /= jc || 1;
    this.prevSpeeds = jointSpeeds;

    // --- Reward: FASTEST + FURTHEST + SMOOTHEST (see class docstring) ---
    const pos = this.sim.rootPosition();
    const ang = this.sim.rootAngle();
    const controlDt = rl.frameSkip * CONFIG.dt;
    const dxRaw = pos.x - this.prevX; // net forward advance this control step (m)
    const avgVx = dxRaw / controlDt; // average forward speed this step (m/s)
    this.prevX = pos.x;

    // Upright gate keeps speed/distance honest (no diving) WITHOUT making
    // balance an objective — being up is worth only the small aliveBonus. When
    // upright the speed/progress terms are SIGNED (forward paid, BACKWARD
    // penalized): this breaks the fwd/bwd symmetry so the DETERMINISTIC (greedy)
    // gait reliably faces forward instead of drifting into a backward-walking
    // basin. Uncapped, so faster forward is always strictly better.
    const upright = Math.abs(ang) < rl.uprightThresh;
    const speed = upright ? avgVx : 0; // FASTEST (uncapped, signed)
    const dx = upright ? dxRaw : 0; // FURTHEST (net progress, signed)
    const heightErr = pos.y - rl.targetHeight;

    const reward =
      rl.aliveBonus +
      rl.wVel * speed +
      rl.wProgress * dx -
      rl.wSmooth * smooth -
      rl.wJerk * jerk -
      rl.wUpright * ang * ang -
      rl.wHeight * heightErr * heightErr -
      rl.wEnergy * energy;

    // --- Termination ---
    const fell = pos.y < rl.fallHeight;
    const toppled = Math.abs(ang) > rl.maxTilt;
    const timeout = this.stepInEpisode >= rl.maxEpisodeSteps;
    const done = fell || toppled || timeout;

    return {
      obs: observe(this.sim, this.limits),
      reward,
      done,
      distance: pos.x - this.startX, // net forward distance this episode
    };
  }
}

export default Env;
