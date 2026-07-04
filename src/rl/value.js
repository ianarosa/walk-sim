/*
 * rl/value.js — the CRITIC: a state-value function V(s).
 * ========================================================================
 * A plain MLP mapping a (normalized) observation to a single scalar estimate
 * of expected discounted return from that state. PPO uses V(s) two ways:
 *   1. as the baseline in the GAE advantage estimator (reduces gradient
 *      variance without adding bias), and
 *   2. as a bootstrap value at the end of a truncated rollout.
 *
 * Training target is the GAE return R_t = A_t + V_old(s_t); the loss is the
 * usual half-squared error 0.5*(V(s) - R)^2, whose gradient w.r.t. the output
 * is simply (V(s) - R). We keep it deliberately minimal (no value clipping);
 * the small linear-output init in nn.js keeps early V near zero.
 */

import { MLP } from './nn.js';

export class ValueNet {
  constructor(obsSize, hidden = [64, 64]) {
    this.obsSize = obsSize;
    this.mlp = new MLP([obsSize, ...hidden, 1], 'tanh');
  }

  /** forward(obs) -> scalar V(s); caches for a following backward(). */
  forward(obs) {
    return this.mlp.forward(obs)[0];
  }

  /**
   * backward(dV) — accumulate gradients for a scalar upstream derivative
   * dLoss/dV (typically (V - target) already scaled by vfCoef/batchSize).
   * Must follow a forward(obs) for the same sample.
   */
  backward(dV) {
    this.mlp.backward(Float64Array.of(dV));
  }

  parameters() {
    return this.mlp.parameters();
  }

  applyGrads(adam) {
    adam.update(this.parameters());
  }

  /** gradNormSq() — ‖g‖² over the critic's accumulated grads. A pure read. */
  gradNormSq() {
    return this.mlp.gradNormSq();
  }

  /** scaleGrads(factor) — scale every critic grad in place (grad-norm clip). */
  scaleGrads(factor) {
    this.mlp.scaleGrads(factor);
  }

  serialize() {
    return { obsSize: this.obsSize, mlp: this.mlp.serialize() };
  }

  load(obj) {
    this.mlp.load(obj.mlp);
    return this;
  }
}

export default ValueNet;
