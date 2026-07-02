/*
 * rl/trainer-core.js — ParallelTrainer: N synchronous actors, ONE brain.
 * ========================================================================
 * This is a PURE training core (no DOM, no Worker) that runs unchanged in
 * plain node AND inside a Web Worker. It de-risks parallel experience
 * collection WITHOUT touching the existing single-env `Trainer` (agent.js):
 * both classes share the SAME PPO/GAE math, the SAME nn/policy/value/env
 * modules, and — critically — the SAME serialize() JSON shape, so a brain is
 * fully interchangeable between them.
 *
 * IDEA
 * ----
 * One GaussianPolicy (actor) + one ValueNet (critic) + one Normalizer are
 * SHARED across `instances` independent Envs (each its own Sim of a CLONE of
 * the same creature). Every control step we advance EVERY env by one step,
 * pushing each transition into that env's OWN buffer. When the TOTAL number of
 * buffered transitions across all envs reaches `horizon`, we run ONE PPO update
 * over the combined batch:
 *   1. GAE(λ) + returns are computed PER ENV over that env's contiguous
 *      trajectory (respecting done boundaries; the tail is bootstrapped with
 *      V(current obs) exactly like agent.js does for its single env).
 *   2. All envs' (obs, u, oldLogp, adv, ret) are concatenated into one batch.
 *   3. Advantages are standardized (mean 0 / std 1) across the WHOLE batch.
 *   4. `epochs` of minibatch SGD (clipped surrogate + value MSE + optional
 *      entropy) run over the combined batch — identical clip/grad logic to
 *      agent.js. All per-env buffers are then cleared.
 *
 * Because `instances` envs each contribute a transition per collectStep(), the
 * trainer gathers ~N× the env-steps per wall-clock second and fills a horizon
 * (and therefore triggers a network update) far sooner in real time.
 *
 * Determinism / safety: same as agent.js — Math.random() is the sole
 * randomness source (policy noise + minibatch shuffle) and NaNs are guarded at
 * every boundary (log-ratio clamp here, Adam gradient guard in nn.js).
 */

import { CONFIG } from '../config.js';
import { cloneCreature } from '../creature.js';
import { Sim } from '../physics/sim.js';
import { Adam, Normalizer } from './nn.js';
import { GaussianPolicy } from './policy.js';
import { ValueNet } from './value.js';
import { Env, obsSize, actSize } from './env.js';
import { RL_DEFAULTS } from './agent.js';

// Keep in lock-step with agent.js's Trainer so serialized brains interoperate.
const SERIALIZE_VERSION = 1;

/** Fisher–Yates shuffle in place, using Math.random (matches agent.js). */
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
  return arr;
}

/** High-resolution clock if available (Worker/browser), else wall clock. */
function nowMs() {
  return typeof performance !== 'undefined' && performance.now
    ? performance.now()
    : Date.now();
}

export class ParallelTrainer {
  /**
   * @param {object} creature  a Creature (shared schema); each env gets a clone.
   * @param {object} [opts]
   * @param {number} [opts.instances=8]  number of parallel envs (>=1).
   * @param {object} [opts.config={}]    overrides layered over CONFIG.RL over RL_DEFAULTS.
   */
  constructor(creature, { instances = 8, config = {} } = {}) {
    this.creature = cloneCreature(creature); // pristine template for clones
    // Effective config: RL_DEFAULTS < CONFIG.RL < explicit config (like Trainer).
    this.cfg = Object.assign({}, RL_DEFAULTS, CONFIG.RL, config);

    // --- Build the env pool first; size the shared brain off a real Sim. ---
    const n = Math.max(1, Math.floor(instances));
    this._envs = [];
    for (let i = 0; i < n; i++) this._envs.push(this._makeEnvState());
    this.instances = n;

    const sim0 = this._envs[0].env.sim;
    this.obsSize = obsSize(sim0);
    this.actSize = actSize(sim0);

    // --- ONE shared actor / critic / normalizer / optimizers. ---
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

    // --- Aggregate stats (across all envs). ---
    this.episode = 0; // total episodes finished across all envs
    this.stepCount = 0; // total control steps across all envs
    this.updates = 0; // number of PPO updates performed
    this.lastReturn = 0; // return of the most-recently-finished episode
    this.bestDistance = 0; // best net forward distance over all envs/episodes
    this.returnHistory = []; // recent finished-episode returns (capped)

    // --- Throughput bookkeeping. ---
    this._t0 = nowMs();
  }

  /**
   * _makeEnvState() — a fresh env with its own Sim(clone) and its own rollout
   * buffer + per-episode accumulators. `obs` is the current RAW observation.
   */
  _makeEnvState() {
    const env = new Env(new Sim(cloneCreature(this.creature)));
    return {
      env,
      obs: env.reset(),
      epReturn: 0,
      epDistance: 0,
      buf: { obs: [], u: [], logp: [], rew: [], val: [], done: [] },
    };
  }

  /**
   * collectStep() — advance EVERY env by exactly one control step, buffering a
   * transition per env and updating the shared normalizer with each raw obs.
   * Triggers a PPO update once the TOTAL buffered transitions reach `horizon`.
   */
  collectStep() {
    for (const es of this._envs) {
      const obsN = this.normalizer.normalize(es.obs);
      // Fold the raw observation into the shared running statistics.
      this.normalizer.update(es.obs);

      const { u, squashed, logProb } = this.policy.act(obsN, { explore: true });
      const v = this.value.forward(obsN);

      const { obs: nextRaw, reward, done, distance } = es.env.stepWith(squashed);

      const B = es.buf;
      B.obs.push(obsN);
      B.u.push(u);
      B.logp.push(logProb);
      B.rew.push(reward);
      B.val.push(v);
      B.done.push(done);

      this.stepCount += 1;
      es.epReturn += reward;
      es.epDistance = distance;
      es.obs = nextRaw;

      if (done) this._endEpisode(es);
    }

    // Total buffered across all envs => PPO update when the horizon fills.
    let total = 0;
    for (const es of this._envs) total += es.buf.rew.length;
    if (total >= this.cfg.horizon) this._update();
  }

  /**
   * trainSteps(k) — run collectStep() k times (an update fires automatically
   * whenever the horizon fills). Returns a light stats snapshot.
   */
  trainSteps(k = 1) {
    for (let i = 0; i < k; i++) this.collectStep();
    return this.stats();
  }

  /** actGreedy(rawObs) -> squashed action (means, no exploration). */
  actGreedy(rawObs) {
    return this.policy.greedy(this.normalizer.normalize(rawObs));
  }

  /** Per-env end-of-episode bookkeeping; resets THAT env for the next episode. */
  _endEpisode(es) {
    this.episode += 1;
    this.lastReturn = es.epReturn;
    this.returnHistory.push(es.epReturn);
    if (this.returnHistory.length > this.cfg.returnHistoryCap)
      this.returnHistory.shift();
    if (es.epDistance > this.bestDistance) this.bestDistance = es.epDistance;
    es.epReturn = 0;
    es.epDistance = 0;
    es.obs = es.env.reset();
  }

  // --- PPO update -------------------------------------------------------

  /**
   * _update() — per-env GAE(λ) + returns, then ONE clipped-PPO pass over the
   * combined batch. Mirrors agent.js's math exactly, once per env for GAE and
   * once for the shared SGD. Clears every buffer at the end.
   */
  _update() {
    const cfg = this.cfg;

    // --- Per-env GAE(λ) + returns, concatenated into one batch. ---
    const bObs = []; // Float64Array[]  normalized observations
    const bU = []; // Float64Array[]  pre-squash actions
    const bLogp = []; // number[]        behavior-policy log-probs
    const advParts = []; // Float64Array[]  per-env advantage slices
    const retParts = []; // Float64Array[]  per-env return slices

    for (const es of this._envs) {
      const B = es.buf;
      const N = B.rew.length;
      if (N === 0) continue;

      // Bootstrap the tail: 0 if this env's last step terminated, else V(sT).
      const lastDone = B.done[N - 1];
      const bootstrap = lastDone
        ? 0
        : this.value.forward(this.normalizer.normalize(es.obs));

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

      for (let t = 0; t < N; t++) {
        bObs.push(B.obs[t]);
        bU.push(B.u[t]);
        bLogp.push(B.logp[t]);
      }
      advParts.push(adv);
      retParts.push(ret);
    }

    const M = bObs.length;
    if (M === 0) return; // nothing buffered (all envs empty) — no-op

    // Flatten advantages/returns into single arrays aligned with bObs/bU/bLogp.
    const adv = new Float64Array(M);
    const ret = new Float64Array(M);
    let w = 0;
    for (let p = 0; p < advParts.length; p++) {
      const a = advParts[p];
      const r = retParts[p];
      for (let i = 0; i < a.length; i++) {
        adv[w] = a[i];
        ret[w] = r[i];
        w++;
      }
    }

    // --- Standardize advantages across the WHOLE combined batch. ---
    let mean = 0;
    for (let t = 0; t < M; t++) mean += adv[t];
    mean /= M;
    let varAcc = 0;
    for (let t = 0; t < M; t++) varAcc += (adv[t] - mean) * (adv[t] - mean);
    const std = Math.sqrt(varAcc / M) || 1;
    for (let t = 0; t < M; t++) adv[t] = (adv[t] - mean) / (std + 1e-8);

    // --- N epochs of minibatch SGD (identical to agent.js). ---
    const clip = cfg.clip;
    const mb = cfg.minibatch;
    const idx = new Array(M);
    for (let i = 0; i < M; i++) idx[i] = i;

    for (let epoch = 0; epoch < cfg.epochs; epoch++) {
      shuffle(idx);
      for (let start = 0; start < M; start += mb) {
        const end = Math.min(start + mb, M);
        const count = end - start;
        const invCount = 1 / count;

        for (let s = start; s < end; s++) {
          const i = idx[s];
          const obs = bObs[i];
          const u = bU[i];
          const A = adv[i];

          // --- Actor: clipped surrogate gradient ---
          const { mean: pm, std: ps } = this.policy.distParams(obs);
          const logpNew = this.policy.logProb(pm, ps, u);
          let dlogp = logpNew - bLogp[i];
          if (dlogp > 20) dlogp = 20;
          else if (dlogp < -20) dlogp = -20;
          const ratio = Math.exp(dlogp);

          const unclipped = ratio * A;
          const clipped = Math.max(1 - clip, Math.min(1 + clip, ratio)) * A;
          const dLogpLoss = unclipped <= clipped ? -A * ratio * invCount : 0;
          this.policy.backwardLogp(pm, ps, u, dLogpLoss);
          if (cfg.entCoef !== 0)
            this.policy.accumEntropyGrad(-cfg.entCoef * invCount);

          // --- Critic: MSE gradient (V - R) ---
          const V = this.value.forward(obs);
          const dV = cfg.vfCoef * (V - ret[i]) * invCount;
          this.value.backward(dV);
        }

        this.policy.applyGrads(this.adamPolicy);
        this.value.applyGrads(this.adamValue);
      }
    }

    // Clear every env's buffer for the next horizon of collection.
    for (const es of this._envs) {
      const B = es.buf;
      B.obs.length = 0;
      B.u.length = 0;
      B.logp.length = 0;
      B.rew.length = 0;
      B.val.length = 0;
      B.done.length = 0;
    }
    this.updates += 1;
  }

  // --- Live parallelism control ----------------------------------------

  /**
   * setInstances(n) — grow or shrink the env pool at runtime, KEEPING the
   * shared network/normalizer/optimizers. New envs start fresh (reset, empty
   * buffer); removed envs (from the tail) discard their partial trajectory.
   */
  setInstances(n) {
    n = Math.max(1, Math.floor(n));
    if (n === this._envs.length) return this.instances;
    if (n > this._envs.length) {
      while (this._envs.length < n) this._envs.push(this._makeEnvState());
    } else {
      this._envs.length = n; // drop tail envs (and their buffers)
    }
    this.instances = n;
    return this.instances;
  }

  // --- Snapshots / stats -----------------------------------------------

  /**
   * snapshotBrain() — cheap, JSON-safe bundle with just enough to run GREEDY
   * actions on another thread (main-thread preview): policy weights + logStd +
   * normalizer stats. Rebuild with a GaussianPolicy.load + Normalizer.load.
   */
  snapshotBrain() {
    return {
      obsSize: this.obsSize,
      actSize: this.actSize,
      policy: this.policy.serialize(), // { obsSize, actSize, mlp, logStd }
      logStd: Array.from(this.policy.logStd),
      normalizer: this.normalizer.serialize(),
    };
  }

  /** Env-steps gathered per second since construction (throughput readout). */
  stepsPerSec() {
    const elapsed = (nowMs() - this._t0) / 1000;
    return elapsed > 0 ? this.stepCount / elapsed : 0;
  }

  /** Light stats snapshot aggregated across all envs. */
  stats() {
    let buffered = 0;
    for (const es of this._envs) buffered += es.buf.rew.length;
    return {
      instances: this.instances,
      episode: this.episode,
      stepCount: this.stepCount,
      updates: this.updates,
      lastReturn: this.lastReturn,
      bestDistance: this.bestDistance,
      returnHistory: this.returnHistory.slice(),
      buffered,
      elapsedMs: nowMs() - this._t0,
      stepsPerSec: this.stepsPerSec(),
    };
  }

  // --- Persistence (SAME JSON shape as agent.js's Trainer) --------------

  /**
   * serialize() -> JSON-safe brain bundle, byte-for-byte compatible with
   * agent.js's Trainer.serialize (version/obsSize/actSize/policy/value/logStd/
   * normalizer/config/stats), so brains are interchangeable between the two.
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

  /** load(json) — restore a brain onto THIS trainer. Throws on size mismatch. */
  load(json) {
    if (json.obsSize !== this.obsSize || json.actSize !== this.actSize) {
      throw new Error(
        `ParallelTrainer.load: size mismatch (brain obs=${json.obsSize} act=${json.actSize}, ` +
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

  /**
   * static fromJSON(creature, json[, opts]) — build a fresh ParallelTrainer and
   * restore a serialized brain (agent.js or ParallelTrainer format) into it.
   * `opts.instances` sets the env pool size (default 8, like the constructor).
   */
  static fromJSON(creature, json, opts = {}) {
    const t = new ParallelTrainer(creature, {
      instances: opts.instances != null ? opts.instances : 8,
      config: json.config || {},
    });
    t.load(json);
    return t;
  }
}

export default ParallelTrainer;
