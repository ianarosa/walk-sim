/*
 * rl/policy.js — the ACTOR: a squashed-Gaussian stochastic policy.
 * ========================================================================
 * The policy maps an observation to a distribution over PRE-squash actions:
 *   mean  = MLP(obs)                       (state-dependent)
 *   std   = exp(logStd)                    (state-INDEPENDENT, learned vector)
 *   u     ~ Normal(mean, std)              (the "raw" action we store)
 *   a     = tanh(u) in (-1,1)              (the action actually applied)
 *
 * Because we squash with tanh, the log-probability of the SQUASHED action
 * needs the change-of-variables (log-det-Jacobian) correction (SAC, Haarnoja
 * et al. 2018, appendix C):
 *   log p(a) = log N(u; mean, std) - Σ_i log(1 - tanh(u_i)^2)
 * We add a tiny epsilon inside the log for numerical safety.
 *
 * Note for PPO: the correction term depends ONLY on u (which is fixed once
 * sampled), so it is identical for the old and new policies and cancels in
 * the ratio exp(logp_new - logp_old). We still include it everywhere so the
 * reported log-probs are true log-densities and everything stays consistent.
 *
 * Gradients we expose (derived analytically, no autodiff):
 *   ∂ logN/∂mean_i   = (u_i - mean_i)/std_i^2
 *   ∂ logN/∂logStd_i = ((u_i - mean_i)/std_i)^2 - 1
 * The mean-gradient is backpropped through the MLP; the logStd-gradient is
 * accumulated directly onto the logStd parameter vector.
 */

import { MLP, gaussian } from './nn.js';

const LOG_2PI = Math.log(2 * Math.PI);
// Clamp logStd so std stays in ~[0.007, 7.4]: prevents both a collapsed
// (deterministic, no exploration) and an exploding (NaN) policy.
const LOG_STD_MIN = -5;
const LOG_STD_MAX = 2;

export class GaussianPolicy {
  /**
   * @param {number} obsSize
   * @param {number} actSize
   * @param {number[]} hidden  hidden layer sizes, e.g. [64,64]
   * @param {number} initLogStd  initial log-std for every action dim
   */
  constructor(obsSize, actSize, hidden = [64, 64], initLogStd = -0.5) {
    this.obsSize = obsSize;
    this.actSize = actSize;
    this.mlp = new MLP([obsSize, ...hidden, actSize], 'tanh');
    this.logStd = new Float64Array(actSize).fill(initLogStd);
    this.gLogStd = new Float64Array(actSize); // grad accumulator for logStd
  }

  /** exp(logStd) as a fresh Float64Array. */
  std() {
    const s = new Float64Array(this.actSize);
    for (let i = 0; i < this.actSize; i++) s[i] = Math.exp(this.logStd[i]);
    return s;
  }

  /**
   * act(obs, {explore}) -> { u, squashed, logProb }
   *   u        = pre-squash action (stored in the rollout buffer)
   *   squashed = tanh(u), the action applied to the sim
   *   logProb  = log density of the squashed action under this policy
   * With explore=false the mean is used directly (deterministic exploitation).
   */
  act(obs, { explore = true } = {}) {
    const mean = this.mlp.forward(obs);
    const std = this.std();
    const u = new Float64Array(this.actSize);
    for (let i = 0; i < this.actSize; i++) {
      u[i] = explore ? mean[i] + std[i] * gaussian() : mean[i];
    }
    const squashed = new Float64Array(this.actSize);
    for (let i = 0; i < this.actSize; i++) squashed[i] = Math.tanh(u[i]);
    return { u, squashed, logProb: logProbOf(mean, std, u, squashed) };
  }

  /** Deterministic action (means, tanh-squashed) — the current best gait. */
  greedy(obs) {
    const mean = this.mlp.forward(obs);
    const out = new Float64Array(this.actSize);
    for (let i = 0; i < this.actSize; i++) out[i] = Math.tanh(mean[i]);
    return out;
  }

  /**
   * distParams(obs) -> { mean, std } and caches the MLP forward pass so a
   * following backward() (via backwardLogp) can run. Used during PPO updates.
   */
  distParams(obs) {
    const mean = this.mlp.forward(obs);
    return { mean, std: this.std() };
  }

  /** logProb of squashed(u) under (mean,std) — recomputed during updates. */
  logProb(mean, std, u) {
    const squashed = new Float64Array(this.actSize);
    for (let i = 0; i < this.actSize; i++) squashed[i] = Math.tanh(u[i]);
    return logProbOf(mean, std, u, squashed);
  }

  /**
   * backwardLogp(mean, std, u, dLogp) — push the scalar gradient dLoss/dLogp
   * back into the parameters. Uses the analytic Gaussian gradients above:
   * mean-grad is backpropped through the cached MLP forward; logStd-grad is
   * accumulated onto gLogStd. Call AFTER distParams(obs) for the same sample.
   */
  backwardLogp(mean, std, u, dLogp) {
    const dMean = new Float64Array(this.actSize);
    for (let i = 0; i < this.actSize; i++) {
      const inv = 1 / std[i];
      const zc = (u[i] - mean[i]) * inv; // standardized residual
      // dLogp * ∂logN/∂mean = dLogp * (u-mean)/std^2 = dLogp * zc/std
      dMean[i] = dLogp * zc * inv;
      // dLogp * ∂logN/∂logStd = dLogp * (zc^2 - 1)
      this.gLogStd[i] += dLogp * (zc * zc - 1);
    }
    this.mlp.backward(dMean);
  }

  /**
   * accumEntropyGrad(scale) — add `scale` to every logStd grad. The Gaussian
   * entropy is Σ_i (logStd_i + 0.5*log(2πe)), so ∂H/∂logStd_i = 1. Passing
   * scale = -entCoef/batch turns an entropy BONUS into the right descent grad.
   */
  accumEntropyGrad(scale) {
    for (let i = 0; i < this.actSize; i++) this.gLogStd[i] += scale;
  }

  /** Mean differential entropy of the current (pre-squash) Gaussian. */
  entropy() {
    let h = 0;
    for (let i = 0; i < this.actSize; i++)
      h += this.logStd[i] + 0.5 * (LOG_2PI + 1);
    return h;
  }

  /** Parameter slots for Adam: MLP params followed by the logStd vector. */
  parameters() {
    return [...this.mlp.parameters(), { w: this.logStd, g: this.gLogStd }];
  }

  /**
   * gradNormSq() — ‖g‖² over ALL of the actor's accumulated gradients: the
   * MLP's gW/gB PLUS the logStd grad vector. Mirrors ValueNet.gradNormSq so the
   * trainer can compute a combined actor+critic global grad norm. A pure read.
   */
  gradNormSq() {
    let s = this.mlp.gradNormSq();
    for (let i = 0; i < this.actSize; i++) s += this.gLogStd[i] * this.gLogStd[i];
    return s;
  }

  /**
   * scaleGrads(factor) — multiply EVERY actor gradient (MLP gW/gB and the
   * logStd grad) by `factor` in place, for global grad-norm clipping. factor=1
   * is a no-op.
   */
  scaleGrads(factor) {
    this.mlp.scaleGrads(factor);
    for (let i = 0; i < this.actSize; i++) this.gLogStd[i] *= factor;
  }

  /** Optimizer step, then clamp logStd into its safe range. */
  applyGrads(adam) {
    adam.update(this.parameters());
    for (let i = 0; i < this.actSize; i++) {
      if (this.logStd[i] < LOG_STD_MIN) this.logStd[i] = LOG_STD_MIN;
      else if (this.logStd[i] > LOG_STD_MAX) this.logStd[i] = LOG_STD_MAX;
    }
  }

  serialize() {
    return {
      obsSize: this.obsSize,
      actSize: this.actSize,
      mlp: this.mlp.serialize(),
      logStd: Array.from(this.logStd),
    };
  }

  load(obj) {
    this.mlp.load(obj.mlp);
    this.logStd = Float64Array.from(obj.logStd);
    this.gLogStd = new Float64Array(this.actSize);
    return this;
  }
}

/**
 * logProbOf(mean, std, u, squashed) — log density of the SQUASHED action:
 *   Σ_i [ -0.5*((u-mean)/std)^2 - log(std) - 0.5*log(2π) ]   (Gaussian)
 *   - Σ_i log(1 - tanh(u)^2 + 1e-6)                          (tanh Jacobian)
 */
export function logProbOf(mean, std, u, squashed) {
  let lp = 0;
  for (let i = 0; i < mean.length; i++) {
    const zc = (u[i] - mean[i]) / std[i];
    lp += -0.5 * zc * zc - Math.log(std[i]) - 0.5 * LOG_2PI;
    lp -= Math.log(1 - squashed[i] * squashed[i] + 1e-6);
  }
  return lp;
}

export default GaussianPolicy;
