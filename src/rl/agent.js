/*
 * rl/agent.js — the Trainer: PPO (clip) with GAE(λ) over one Sim lane.
 * ========================================================================
 * This is the SURFACE the app drives. One Trainer owns one Sim, one actor
 * (GaussianPolicy), one critic (ValueNet), an observation Normalizer, and a
 * rollout buffer. The app calls tick() once per animation frame; internally
 * we collect a transition each call and, once `horizon` transitions have
 * piled up, run a full PPO update and clear the buffer.
 *
 * PPO (Schulman et al. 2017) in one screen:
 *   ratio_t   = exp( logπ_new(a_t|s_t) - logπ_old(a_t|s_t) )
 *   L_clip    = E[ min( ratio_t·Â_t, clip(ratio_t, 1-ε, 1+ε)·Â_t ) ]
 *   maximize L_clip  (+ entropy bonus)  and  minimize  0.5·(V(s_t)-R_t)^2
 * Advantages Â come from GAE(λ) (Schulman et al. 2015):
 *   δ_t = r_t + γ·V(s_{t+1}) - V(s_t)
 *   Â_t = δ_t + γλ·Â_{t+1}          (zeroed across episode boundaries)
 *   R_t = Â_t + V(s_t)              (critic target)
 * Advantages are standardized (mean 0, std 1) across the batch before use.
 *
 * Determinism: all randomness is Math.random() (policy noise + minibatch
 * shuffling via shuffle() below). NaNs are guarded at every boundary.
 */

import { CONFIG } from '../config.js';
import { Adam, Normalizer } from './nn.js';
import { GaussianPolicy } from './policy.js';
import { ValueNet } from './value.js';
import { Env, obsSize, actSize } from './env.js';

/**
 * RL_DEFAULTS — full hyperparameter set. CONFIG.RL is merged OVER this, so
 * the config file only needs to override what it cares about. (config.js in
 * this project does fill CONFIG.RL, but this keeps agent.js self-sufficient
 * and satisfies the "read CONFIG.RL merged over RL_DEFAULTS" fallback.)
 */
export const RL_DEFAULTS = Object.freeze({
  hiddenSizes: [64, 64],
  lr: 3e-4,
  gamma: 0.99,
  lambda: 0.95,
  clip: 0.2,
  epochs: 10,
  minibatch: 64,
  horizon: 2048,
  maxEpisodeSteps: 1000,
  frameSkip: 4,
  maxMotorSpeed: 8,
  fallHeight: 0.6,
  maxTilt: 1.0,
  wProgress: 60,
  aliveBonus: 0.1,
  wEnergy: 0.02,
  wUpright: 0.3,
  speedScale: 0.1,
  entCoef: 0.0,
  vfCoef: 0.5,
  maxGradNorm: 0.5, // global L2 grad-norm clip (0/non-finite = disabled, un-clipped path)
  initLogStd: -0.5,
  returnHistoryCap: 300,
});

const SERIALIZE_VERSION = 1;

/** Fisher–Yates shuffle in place, using Math.random (stays deterministic). */
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
  return arr;
}

export class Trainer {
  /**
   * @param {Sim} sim   a built Sim (obs/act sizes are inferred from it)
   * @param {object} [config]  overrides layered over CONFIG.RL over RL_DEFAULTS
   */
  constructor(sim, config = {}) {
    this.sim = sim;
    // Effective config: RL_DEFAULTS < CONFIG.RL < explicit config arg.
    this.cfg = Object.assign({}, RL_DEFAULTS, CONFIG.RL, config);

    this.obsSize = obsSize(sim);
    this.actSize = actSize(sim);

    this.policy = new GaussianPolicy(
      this.obsSize,
      this.actSize,
      this.cfg.hiddenSizes,
      this.cfg.initLogStd
    );
    this.value = new ValueNet(this.obsSize, this.cfg.hiddenSizes);
    this.normalizer = new Normalizer(this.obsSize);

    this.adamPolicy = new Adam(this.cfg.lr);
    this.adamValue = new Adam(this.cfg.lr);

    this.env = new Env(sim);

    // --- Rollout buffer (parallel arrays, one entry per control step) ---
    this._buf = {
      obs: [], // normalized observation (Float64Array)
      u: [], // pre-squash action (Float64Array)
      logp: [], // log-prob under the behavior policy (number)
      rew: [], // reward (number)
      val: [], // V(s) at collection time (number)
      done: [], // episode terminated on this step (bool)
    };

    // --- Live state ---
    this.exploit = false; // when true: greedy action, no learning
    this._obs = this.env.reset(); // current RAW observation

    // --- Stats ---
    this.episode = 0;
    this.stepCount = 0;
    this.lastReturn = 0;
    this.bestDistance = 0;
    this.returnHistory = [];
    this._epReturn = 0;
    this._epDistance = 0;
  }

  /**
   * tick() — advance exactly ONE control step on this lane's sim. Called every
   * animation frame by the app. Returns a light status object for the UI.
   * In exploit mode we just show the greedy gait and skip all learning.
   */
  tick() {
    if (this.exploit) return this._tickExploit();

    const obsN = this.normalizer.normalize(this._obs);
    // Grow the running statistics with the raw observation we actually saw.
    this.normalizer.update(this._obs);

    const { u, squashed, logProb } = this.policy.act(obsN, { explore: true });
    const v = this.value.forward(obsN);

    const { obs: nextRaw, reward, done, distance } = this.env.stepWith(squashed);

    // Store the transition.
    this._buf.obs.push(obsN);
    this._buf.u.push(u);
    this._buf.logp.push(logProb);
    this._buf.rew.push(reward);
    this._buf.val.push(v);
    this._buf.done.push(done);

    this.stepCount += 1;
    this._epReturn += reward;
    this._epDistance = distance;
    this._obs = nextRaw;

    if (done) this._endEpisode();

    // Full buffer => PPO update, then wipe it.
    if (this._buf.rew.length >= this.cfg.horizon) this._update();

    return {
      reward,
      done,
      distance: this._epDistance,
      episode: this.episode,
    };
  }

  /** Exploit-mode step: deterministic gait, no buffering, no learning. */
  _tickExploit() {
    const obsN = this.normalizer.normalize(this._obs);
    const squashed = this.policy.greedy(obsN);
    const { obs: nextRaw, reward, done, distance } = this.env.stepWith(squashed);
    this._obs = nextRaw;
    this._epDistance = distance;
    if (done) {
      this._obs = this.env.reset();
      this._epDistance = 0;
    }
    return { reward, done, distance, episode: this.episode };
  }

  /** actGreedy(rawObs) -> squashed action (means, no exploration). */
  actGreedy(rawObs) {
    return this.policy.greedy(this.normalizer.normalize(rawObs));
  }

  /** Bookkeeping at the end of an episode; resets the env for the next one. */
  _endEpisode() {
    this.episode += 1;
    this.lastReturn = this._epReturn;
    this.returnHistory.push(this._epReturn);
    if (this.returnHistory.length > this.cfg.returnHistoryCap)
      this.returnHistory.shift();
    if (this._epDistance > this.bestDistance)
      this.bestDistance = this._epDistance;
    this._epReturn = 0;
    this._epDistance = 0;
    this._obs = this.env.reset();
  }

  // --- PPO update -------------------------------------------------------

  /** Run GAE + N epochs of clipped PPO over the buffer, then clear it. */
  _update() {
    const cfg = this.cfg;
    const B = this._buf;
    const N = B.rew.length;

    // --- Bootstrap value for the final state (0 if it terminated) ---
    const lastDone = B.done[N - 1];
    const bootstrap = lastDone
      ? 0
      : this.value.forward(this.normalizer.normalize(this._obs));

    // --- GAE(λ) advantages + returns (backwards pass) ---
    const adv = new Float64Array(N);
    const ret = new Float64Array(N);
    let lastGae = 0;
    for (let t = N - 1; t >= 0; t--) {
      const nonTerminal = B.done[t] ? 0 : 1;
      const nextV = t === N - 1 ? bootstrap : B.val[t + 1];
      const delta = B.rew[t] + cfg.gamma * nonTerminal * nextV - B.val[t];
      lastGae = delta + cfg.gamma * cfg.lambda * nonTerminal * lastGae;
      adv[t] = lastGae;
      ret[t] = lastGae + B.val[t];
    }

    // --- Standardize advantages (mean 0 / std 1) ---
    let mean = 0;
    for (let t = 0; t < N; t++) mean += adv[t];
    mean /= N;
    let varAcc = 0;
    for (let t = 0; t < N; t++) varAcc += (adv[t] - mean) * (adv[t] - mean);
    const std = Math.sqrt(varAcc / N) || 1;
    for (let t = 0; t < N; t++) adv[t] = (adv[t] - mean) / (std + 1e-8);

    // --- N epochs of minibatch SGD ---
    const clip = cfg.clip;
    const mb = cfg.minibatch;
    const idx = new Array(N);
    for (let i = 0; i < N; i++) idx[i] = i;

    for (let epoch = 0; epoch < cfg.epochs; epoch++) {
      shuffle(idx);
      for (let start = 0; start < N; start += mb) {
        const end = Math.min(start + mb, N);
        const count = end - start;
        const invCount = 1 / count;

        for (let s = start; s < end; s++) {
          const i = idx[s];
          const obs = B.obs[i];
          const u = B.u[i];
          const A = adv[i];

          // --- Actor: clipped surrogate gradient ---
          const { mean: pm, std: ps } = this.policy.distParams(obs);
          const logpNew = this.policy.logProb(pm, ps, u);
          // Guard the log-ratio before exp() to avoid Inf/NaN blowups.
          let dlogp = logpNew - B.logp[i];
          if (dlogp > 20) dlogp = 20;
          else if (dlogp < -20) dlogp = -20;
          const ratio = Math.exp(dlogp);

          const unclipped = ratio * A;
          const clipped =
            Math.max(1 - clip, Math.min(1 + clip, ratio)) * A;
          // Loss = -min(unclipped, clipped). Gradient w.r.t logpNew is
          // -A*ratio when the UNCLIPPED branch is the min, else 0 (the
          // clipped branch is constant in ratio inside the clip region).
          const dLogpLoss =
            unclipped <= clipped ? -A * ratio * invCount : 0;
          this.policy.backwardLogp(pm, ps, u, dLogpLoss);
          // Entropy bonus: maximize H => loss term -entCoef*H, grad on
          // logStd is -entCoef (per sample, averaged over the minibatch).
          if (cfg.entCoef !== 0)
            this.policy.accumEntropyGrad(-cfg.entCoef * invCount);

          // --- Critic: MSE gradient (V - R) ---
          const V = this.value.forward(obs);
          const dV = cfg.vfCoef * (V - ret[i]) * invCount;
          this.value.backward(dV);
        }

        // --- Global grad-norm clipping (config-gated, fully REVERSIBLE) ---
        // Standard PPO stabilizer: cap the L2 norm of the COMBINED actor+critic
        // gradient across ALL params before Adam steps, so one freak minibatch
        // can't blow up the weights. It only RESCALES the already-accumulated
        // gradient — the reward/objective is untouched. Contract: maxGradNorm<=0
        // (or non-finite) skips this block entirely, reproducing the un-clipped
        // path byte-for-byte; and even when enabled, a gradient already within
        // the cap is left exactly as-is (no scaling). Kept identical to trainer-core.js.
        if (cfg.maxGradNorm > 0) {
          const gnorm = Math.sqrt(
            this.policy.gradNormSq() + this.value.gradNormSq()
          );
          if (gnorm > cfg.maxGradNorm) {
            const scale = cfg.maxGradNorm / (gnorm + 1e-6);
            this.policy.scaleGrads(scale);
            this.value.scaleGrads(scale);
          }
        }

        // One optimizer step per minibatch (grads zero themselves inside).
        this.policy.applyGrads(this.adamPolicy);
        this.value.applyGrads(this.adamValue);
      }
    }

    // Clear the buffer for the next horizon of collection.
    B.obs.length = 0;
    B.u.length = 0;
    B.logp.length = 0;
    B.rew.length = 0;
    B.val.length = 0;
    B.done.length = 0;
  }

  // --- Persistence ------------------------------------------------------

  /**
   * serialize() -> JSON-safe brain bundle. Restore with Trainer.fromJSON or
   * an instance's load(). Includes sizes so a mismatch can be caught loudly.
   */
  serialize() {
    return {
      version: SERIALIZE_VERSION,
      obsSize: this.obsSize,
      actSize: this.actSize,
      policy: this.policy.serialize(),
      value: this.value.serialize(),
      logStd: Array.from(this.policy.logStd),
      normalizer: this.normalizer.serialize(),
      config: this.cfg,
      stats: {
        episode: this.episode,
        stepCount: this.stepCount,
        lastReturn: this.lastReturn,
        bestDistance: this.bestDistance,
        returnHistory: this.returnHistory.slice(),
      },
    };
  }

  /** load(json) — restore a brain onto THIS trainer's sim. Throws on mismatch. */
  load(json) {
    if (json.obsSize !== this.obsSize || json.actSize !== this.actSize) {
      throw new Error(
        `Trainer.load: size mismatch (brain obs=${json.obsSize} act=${json.actSize}, ` +
          `sim obs=${this.obsSize} act=${this.actSize}) — creature does not match this brain`
      );
    }
    this.policy.load(json.policy);
    this.value.load(json.value);
    if (json.logStd) this.policy.logStd = Float64Array.from(json.logStd);
    this.normalizer.load(json.normalizer);
    if (json.stats) {
      this.episode = json.stats.episode || 0;
      this.stepCount = json.stats.stepCount || 0;
      this.lastReturn = json.stats.lastReturn || 0;
      this.bestDistance = json.stats.bestDistance || 0;
      this.returnHistory = (json.stats.returnHistory || []).slice();
    }
    return this;
  }

  /** static fromJSON(sim, json) — build a fresh Trainer and restore into it. */
  static fromJSON(sim, json) {
    const t = new Trainer(sim, json.config || {});
    t.load(json);
    return t;
  }
}

export default Trainer;
