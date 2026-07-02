/*
 * app/worker-lane.js — WorkerLane: ORCHESTRATES sharded background training.
 * ==========================================================================
 * Phase 2 moved training off the render thread. Phase 3 shards ONE lane's
 * training across MANY Web Workers (one per CPU core, capped) so a lane can use
 * all cores, up to CONFIG.RL.maxInstances (128) total parallel envs — while
 * still converging on ONE brain via periodic weight-AVERAGING.
 *
 *   WORK  — up to 8 worker shards (src/rl/worker.js), each a ParallelTrainer on
 *           a SLICE of the total instances, all training flat-out off-thread.
 *   MERGE — every CONFIG.RL.mergeMs we pull each shard's full brain, average
 *           them (rl/brain-merge.js), and push the average back into every shard
 *           (applyMergedBrain, in place — preserves each shard's Adam state).
 *   SHOW  — ONE main-thread preview sim, rendered from the current (merged, or
 *           pre-merge snapshot) greedy brain.
 *
 * FAULT ISOLATION: a shard that dies (worker onerror / error message) is
 * terminated ALONE — siblings, the merged brain, and the preview are untouched.
 * The dead shard is respawned ONCE and immediately handed the merged brain so it
 * rejoins with the fleet's learned progress; a second death drops it for good.
 * If EVERY shard is gone we fall back to a main-thread ParallelTrainer.
 *
 * It stays a DROP-IN for what lanes.js + graph.js read off `lane.trainer`:
 *   sim, tick()->{done,distance}, exploit, episode, bestDistance, lastReturn,
 *   stepCount, returnHistory, stepsPerSec, setInstances, setRunning, async
 *   serialize(), async loadBrain(json), dispose(), warn — PLUS new: `workers`
 *   (count of live shards, for the throughput readout).
 *
 * FALLBACK: if Worker is unavailable (undefined / construction throws for the
 * first shard, or all shards die), we run a ParallelTrainer on the MAIN thread
 * behind the same interface, so the app still works (with the old at-speed
 * stutter). node has no Worker, so the fallback is what the headless tests hit.
 */

import { Sim } from '../physics/sim.js';
import { Env, obsSize, actSize } from '../rl/env.js';
import { GaussianPolicy } from '../rl/policy.js';
import { Normalizer } from '../rl/nn.js';
import { ParallelTrainer } from '../rl/trainer-core.js';
import { averageBrains } from '../rl/brain-merge.js';
import { cloneCreature } from '../creature.js';
import { CONFIG } from '../config.js';

// Steps trained per preview tick when running the main-thread FALLBACK. Small,
// so the fallback stays responsive (it is a degraded mode, not the norm).
const FALLBACK_STEPS = 8;
const BRAIN_TIMEOUT_MS = 5000; // guard for a lost getBrain reply
const MAX_WORKERS = 1; // cap on worker shards per lane (1 = single worker; the
// sharding/weight-averaging code stays intact and reactivates if raised >1)

export class WorkerLane {
  /**
   * @param {object} creature  a Creature (plain data); each env gets a clone.
   * @param {object} [opts]
   * @param {number} [opts.instances=8]  TOTAL parallel training envs (sharded).
   * @param {object|null} [opts.brain]   a serialized brain to restore (optional).
   */
  constructor(creature, { instances = 8, brain = null } = {}) {
    this.creature = cloneCreature(creature);
    const max = (CONFIG.RL && CONFIG.RL.maxInstances) || 128;
    this.instances = Math.max(1, Math.min(max, Math.floor(instances)));
    this.workers = 0; // count of LIVE worker shards (for the UI readout)
    this.warn = null;

    // --- API-compat / mirrored stat fields (read by lanes.js + graph panel) ---
    this.exploit = false; // preview is always greedy; kept for API compat
    this.episode = 0;
    this.stepCount = 0;
    this.updates = 0;
    this.lastReturn = 0;
    this.bestDistance = 0;
    this.returnHistory = [];
    this.stepsPerSec = 0;
    this._historyCap = (CONFIG.RL && CONFIG.RL.returnHistoryCap) || 300;

    // --- Local greedy brain for the preview (rebuilt from snapshots/merges) ---
    this._policy = null;
    this._normalizer = null;

    // --- Display sim + env (main thread), the thing lanes.js renders ---
    this._env = new Env(new Sim(cloneCreature(this.creature)));
    this.sim = this._env.sim;
    this._obs = this._env.reset();
    this._obsSize = obsSize(this.sim);
    this._actSize = actSize(this.sim);

    // --- Shard + merge orchestration state ---
    this._workers = []; // slots: {worker, instances, alive, retried, lastFull, stats}
    this._merged = null; // last averaged brain (brain-merge shape) or null
    this._mergeTimer = null;
    this._disposed = false;
    this._fallback = null;
    this._running = true; // training enabled (worker loops / fallback trainSteps)
    this._reqSeq = 1;
    this._pending = new Map(); // reqId -> {resolve, reject}
    this._pendingBrain = null; // brain to (re)send to workers on spawn
    this._error = null;

    // Synchronous size check so a mismatched brain behaves EXACTLY like the old
    // Trainer.fromJSON path (fresh brain + a friendly warn), no async surprise.
    if (brain) {
      if (brain.obsSize === this._obsSize && brain.actSize === this._actSize) {
        this._pendingBrain = brain;
        this._syncFromBrain(brain); // instant preview from the loaded weights
      } else {
        this.warn =
          `brain didn't fit this body (brain obs=${brain.obsSize} act=${brain.actSize}, ` +
          `sim obs=${this._obsSize} act=${this._actSize}) — started a fresh one`;
      }
    }

    this._spawnWorkers();
  }

  // --- Sharding helpers --------------------------------------------------

  _nextReq() {
    return this._reqSeq++;
  }

  _aliveSlots() {
    return this._workers.filter((s) => s.alive && s.worker);
  }

  /** Split `total` into `count` shards, each >=1 when total>=count, remainder
   *  over the first slots. When total<count the tail gets 0 (a worker clamps 0
   *  to 1, so effective min-instances is the live-worker count). */
  _distribute(total, count) {
    const base = Math.floor(total / count);
    let rem = total - base * count;
    const out = new Array(count);
    for (let i = 0; i < count; i++) {
      out[i] = base + (rem > 0 ? 1 : 0);
      if (rem > 0) rem--;
    }
    return out;
  }

  // --- Worker lifecycle --------------------------------------------------

  _spawnWorkers() {
    if (typeof Worker === 'undefined') {
      this._startFallback();
      return;
    }
    const cores =
      (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
    const W = Math.max(1, Math.min(cores, this.instances, MAX_WORKERS));
    const shards = this._distribute(this.instances, W);

    for (let i = 0; i < W; i++) {
      const slot = {
        worker: null,
        instances: shards[i],
        alive: false,
        retried: false,
        lastFull: null,
        stats: null,
      };
      let w;
      try {
        w = new Worker(new URL('../rl/worker.js', import.meta.url), {
          type: 'module',
        });
      } catch {
        // First shard failed to even construct -> main-thread fallback.
        if (this._aliveSlots().length === 0 && this._workers.length === 0) {
          this._startFallback();
          return;
        }
        this._workers.push(slot); // permanently-dead slot; keep the record
        continue;
      }
      slot.worker = w;
      slot.alive = true;
      w.onmessage = (ev) => this._onSlotMessage(slot, ev.data);
      w.onerror = () => this._handleSlotDeath(slot);
      w.postMessage({
        type: 'init',
        creature: this.creature,
        instances: slot.instances,
        config: {},
      });
      if (this._pendingBrain)
        w.postMessage({ type: 'loadBrain', reqId: 0, json: this._pendingBrain });
      w.postMessage({ type: 'setRunning', on: this._running });
      this._workers.push(slot);
    }

    this.workers = this._aliveSlots().length;
    if (this.workers === 0) {
      this._startFallback();
      return;
    }
    this._pendingBrain = null;
    // Weight-averaging only makes sense across MULTIPLE shards. With a single
    // worker the "average" is its own ~mergeMs-stale brain, so re-applying it
    // would REVERT that interval of training every tick — so skip the merge
    // loop entirely and let the 100ms 'brain' snapshots drive the preview.
    if (this._aliveSlots().length > 1) this._startMergeTimer();
  }

  /**
   * _handleSlotDeath(slot) — FAULT ISOLATION. Kill ONLY this shard; leave every
   * sibling, the merged brain and the preview untouched. Respawn it once (and
   * immediately re-seed it with the merged brain so it rejoins with progress);
   * a second death drops it permanently. If nothing is left alive, fall back.
   */
  _handleSlotDeath(slot) {
    if (!slot.alive) return; // already handled
    slot.alive = false;
    try {
      if (slot.worker) slot.worker.terminate();
    } catch {
      /* ignore */
    }
    slot.worker = null;
    slot.stats = null;

    if (!slot.retried && !this._disposed) {
      slot.retried = true;
      this._respawnSlot(slot); // brings the slot back alive if it can
    }

    if (this._aliveSlots().length === 0 && !this._disposed) {
      this._startFallback();
    }
    this.workers = this._aliveSlots().length;
    this._recomputeAggregate();
  }

  /** Bring a dead slot back with a fresh worker + the current merged brain. */
  _respawnSlot(slot) {
    let w;
    try {
      w = new Worker(new URL('../rl/worker.js', import.meta.url), {
        type: 'module',
      });
    } catch {
      slot.alive = false;
      slot.worker = null;
      return; // permanent drop
    }
    slot.worker = w;
    slot.alive = true;
    slot.lastFull = null;
    slot.stats = null;
    w.onmessage = (ev) => this._onSlotMessage(slot, ev.data);
    w.onerror = () => this._handleSlotDeath(slot);
    w.postMessage({
      type: 'init',
      creature: this.creature,
      instances: slot.instances,
      config: {},
    });
    w.postMessage({ type: 'setRunning', on: this._running });
    // Rejoin with the fleet's learned progress rather than from scratch.
    if (this._merged) w.postMessage({ type: 'mergeBrain', merged: this._merged });
    this.workers = this._aliveSlots().length;
  }

  /** Main-thread ParallelTrainer standing in for unavailable/dead workers. */
  _startFallback() {
    if (this._fallback) return;
    try {
      this._fallback = new ParallelTrainer(this.creature, {
        instances: this.instances,
        config: {},
      });
      if (this._pendingBrain) {
        try {
          this._fallback.load(this._pendingBrain);
        } catch {
          /* size mismatch already screened in the ctor */
        }
        this._pendingBrain = null;
      }
      this._syncFromBrain(this._fallback.snapshotBrain());
      this._syncStats(this._fallback.stats());
    } catch (e) {
      this._fallback = null;
      this._error = String((e && e.message) || e);
    }
  }

  // --- Merge loop --------------------------------------------------------

  _startMergeTimer() {
    if (this._mergeTimer || this._disposed) return;
    const mergeMs = (CONFIG.RL && CONFIG.RL.mergeMs) || 1000;
    const tick = () => {
      this._mergeTimer = null;
      if (this._disposed) return;
      this._doMerge();
      this._mergeTimer = setTimeout(tick, mergeMs);
    };
    this._mergeTimer = setTimeout(tick, mergeMs);
  }

  /**
   * _doMerge() — average every alive shard's latest full brain, push the average
   * back into each shard, and rebuild the local preview brain from it. No env or
   * optimizer reset happens anywhere — shards adopt the average IN PLACE.
   */
  _doMerge() {
    const alive = this._aliveSlots();
    const brains = [];
    for (const slot of alive) if (slot.lastFull) brains.push(slot.lastFull);
    if (brains.length === 0) return;
    const merged = averageBrains(brains);
    if (!merged) return;
    this._merged = merged;
    for (const slot of alive) {
      try {
        slot.worker.postMessage({ type: 'mergeBrain', merged });
      } catch {
        /* ignore a transient post failure; the next merge retries */
      }
    }
    this._syncFromMerged(merged);
  }

  // --- Message routing ---------------------------------------------------

  _onSlotMessage(slot, m) {
    if (!m) return;
    // Request replies must resolve even if the slot has just been marked dead.
    if (m.type === 'brainFull' || m.type === 'loaded') {
      this._resolvePending(m);
      return;
    }
    if (!slot.alive) return;
    switch (m.type) {
      case 'ready':
        slot.stats = m.stats;
        if (m.stats && m.stats.episode != null) slot._prevEpisode = m.stats.episode;
        this._recomputeAggregate();
        break;
      case 'stats':
        this._onSlotStats(slot, m.stats);
        break;
      case 'brain':
        // Pre-merge preview seeding; once merges start, the merged brain drives.
        if (!this._merged) this._syncFromBrain(m.snapshot);
        break;
      case 'full':
        slot.lastFull = m.json;
        if (m.json) {
          if (this._obsSize == null) this._obsSize = m.json.obsSize;
          if (this._actSize == null) this._actSize = m.json.actSize;
        }
        break;
      case 'error':
        this._error = m.error;
        this._handleSlotDeath(slot);
        break;
      default:
        break;
    }
  }

  _resolvePending(m) {
    const r = this._pending.get(m.reqId);
    if (!r) return;
    this._pending.delete(m.reqId);
    if (m.type === 'brainFull') r.resolve(m.json);
    else if (m.ok) r.resolve(true);
    else r.reject(new Error(m.error || 'loadBrain failed'));
  }

  // --- Stat aggregation --------------------------------------------------

  _onSlotStats(slot, s) {
    if (!s) return;
    slot.stats = s;
    // A finished episode on this shard (episode counter advanced) contributes
    // its return to the shared, capped reward-history graph.
    if (s.episode != null) {
      if (slot._prevEpisode != null && s.episode > slot._prevEpisode) {
        this.returnHistory.push(s.lastReturn || 0);
        if (this.returnHistory.length > this._historyCap)
          this.returnHistory.shift();
        this.lastReturn = s.lastReturn || 0;
      }
      slot._prevEpisode = s.episode;
    }
    this._recomputeAggregate();
  }

  /** Recompute mirrored fields as an aggregate across ALIVE shards. */
  _recomputeAggregate() {
    let stepCount = 0;
    let stepsPerSec = 0;
    let episode = 0;
    let updates = 0;
    let best = 0;
    let n = 0;
    for (const slot of this._workers) {
      if (!slot.alive || !slot.stats) continue;
      n++;
      const s = slot.stats;
      stepCount += s.stepCount || 0;
      stepsPerSec += s.stepsPerSec || 0;
      episode += s.episode || 0;
      updates += s.updates || 0;
      if ((s.bestDistance || 0) > best) best = s.bestDistance || 0;
    }
    if (n > 0) {
      this.stepCount = stepCount;
      this.stepsPerSec = stepsPerSec;
      this.episode = episode;
      this.updates = updates;
      // bestDistance is a monotonic "best ever" readout.
      if (best > this.bestDistance) this.bestDistance = best;
    }
    this.workers = this._aliveSlots().length;
  }

  /** Fallback-mode stat mirror (single ParallelTrainer.stats()). */
  _syncStats(s) {
    if (!s) return;
    this.episode = s.episode || 0;
    this.stepCount = s.stepCount || 0;
    this.updates = s.updates || 0;
    this.lastReturn = s.lastReturn || 0;
    if ((s.bestDistance || 0) > this.bestDistance)
      this.bestDistance = s.bestDistance || 0;
    if (Array.isArray(s.returnHistory)) this.returnHistory = s.returnHistory;
    this.stepsPerSec = s.stepsPerSec || 0;
    if (s.instances) this.instances = s.instances;
  }

  // --- Preview brain reconstruction --------------------------------------

  /** Rebuild the LOCAL greedy policy + normalizer from a brain SNAPSHOT or full
   *  serialize (both carry policy{...,mlp,logStd} + normalizer + obsSize). */
  _syncFromBrain(snap) {
    if (!snap || !snap.policy || !snap.normalizer) return;
    try {
      if (snap.obsSize != null) this._obsSize = snap.obsSize;
      if (snap.actSize != null) this._actSize = snap.actSize;
      if (!this._policy || this._policy.obsSize !== snap.obsSize) {
        this._policy = new GaussianPolicy(
          snap.obsSize,
          snap.actSize,
          CONFIG.RL.hiddenSizes,
          CONFIG.RL.initLogStd
        );
      }
      this._policy.load(snap.policy);
      if (!this._normalizer || this._normalizer.dim !== snap.obsSize) {
        this._normalizer = new Normalizer(snap.obsSize);
      }
      this._normalizer.load(snap.normalizer);
    } catch {
      /* malformed snapshot — keep the previous preview brain */
    }
  }

  /** Rebuild the LOCAL greedy brain from an AVERAGED brain (brain-merge shape:
   *  policy.mlp + logStd + normalizer{mean,M2,count}, no obs/act sizes). */
  _syncFromMerged(merged) {
    if (!merged || !merged.policy || !merged.normalizer) return;
    if (this._obsSize == null || this._actSize == null) return;
    try {
      if (!this._policy || this._policy.obsSize !== this._obsSize) {
        this._policy = new GaussianPolicy(
          this._obsSize,
          this._actSize,
          CONFIG.RL.hiddenSizes,
          CONFIG.RL.initLogStd
        );
      }
      // GaussianPolicy.load reads {mlp, logStd}; Normalizer.load reads
      // {dim, mean, M2, count}. Reshape the merged brain into those.
      this._policy.load({ mlp: merged.policy.mlp, logStd: merged.logStd });
      if (!this._normalizer || this._normalizer.dim !== this._obsSize) {
        this._normalizer = new Normalizer(this._obsSize);
      }
      this._normalizer.load({
        dim: this._obsSize,
        mean: merged.normalizer.mean,
        M2: merged.normalizer.M2,
        count: merged.normalizer.count,
      });
    } catch {
      /* malformed merged brain — keep the previous preview brain */
    }
  }

  // --- The per-frame preview step (drop-in for Trainer.tick) -------------

  /**
   * tick() — advance the PREVIEW one control step with the current greedy brain,
   * resetting the display sim on a fall/tilt so the retry loop is visible. In
   * FALLBACK mode it also trains a little on the main thread. Returns a light
   * status object; lanes.js reads `.done` to flash the RESET badge.
   */
  tick() {
    // Fallback: advance training on the main thread and refresh preview brain.
    if (this._fallback && this._running) {
      try {
        this._fallback.trainSteps(FALLBACK_STEPS);
        this._syncFromBrain(this._fallback.snapshotBrain());
        this._syncStats(this._fallback.stats());
      } catch (e) {
        this._error = String((e && e.message) || e);
      }
    }

    // No brain yet (workers still warming up) — hold the pose, no reset.
    if (!this._policy || !this._normalizer) {
      return { done: false, distance: 0 };
    }

    let res;
    try {
      const obsN = this._normalizer.normalize(this._obs);
      const squashed = this._policy.greedy(obsN); // tanh(mlp.forward(obsN))
      res = this._env.stepWith(squashed); // scales by maxMotorSpeed, steps frameSkip
      this._obs = res.obs;
    } catch (e) {
      this._error = String((e && e.message) || e);
      return { done: false, distance: 0 };
    }

    if (res.done) {
      this._obs = this._env.reset();
      return { done: true, distance: res.distance };
    }
    return { done: false, distance: res.distance };
  }

  // --- Controls ----------------------------------------------------------

  /** setInstances(total) — clamp to [1, maxInstances] and RESHARD across the
   *  current (live) workers. Worker COUNT is not changed live (simpler/robust). */
  setInstances(total) {
    const max = (CONFIG.RL && CONFIG.RL.maxInstances) || 128;
    this.instances = Math.max(1, Math.min(max, Math.floor(total)));
    const alive = this._aliveSlots();
    if (alive.length > 0) {
      const shards = this._distribute(this.instances, alive.length);
      alive.forEach((slot, i) => {
        slot.instances = shards[i];
        try {
          slot.worker.postMessage({ type: 'setInstances', n: shards[i] });
        } catch {
          /* ignore */
        }
      });
    }
    if (this._fallback) this._fallback.setInstances(this.instances);
    return this.instances;
  }

  /** Start/stop training on every shard (and the fallback via tick()). */
  setRunning(on) {
    this._running = !!on;
    for (const slot of this._aliveSlots()) {
      try {
        slot.worker.postMessage({ type: 'setRunning', on: this._running });
      } catch {
        /* ignore */
      }
    }
  }

  // --- Persistence -------------------------------------------------------

  /** serialize() -> Promise<brainJSON>. Any alive shard ~= the shared brain
   *  (merged ~1/s), so we ask ONE of them for a full brain. */
  serialize() {
    const alive = this._aliveSlots();
    if (alive.length > 0) {
      const slot = alive[0];
      const reqId = this._nextReq();
      return new Promise((resolve, reject) => {
        this._pending.set(reqId, { resolve, reject });
        try {
          slot.worker.postMessage({ type: 'getBrain', reqId });
        } catch (e) {
          this._pending.delete(reqId);
          reject(new Error(String((e && e.message) || e)));
          return;
        }
        setTimeout(() => {
          if (this._pending.has(reqId)) {
            this._pending.delete(reqId);
            reject(new Error('brain request timed out'));
          }
        }, BRAIN_TIMEOUT_MS);
      });
    }
    if (this._fallback) return Promise.resolve(this._fallback.serialize());
    return Promise.resolve(null);
  }

  /**
   * loadBrain(json) -> Promise<boolean>. Updates the LOCAL preview immediately,
   * clears the merged brain (so the next merge reseeds from the loaded weights),
   * and forwards to ALL alive shards. Resolves when at least one acks.
   */
  loadBrain(json) {
    if (!json) return Promise.resolve(false);
    this._syncFromBrain(json); // instant preview from the loaded weights
    this._merged = null; // next merge reseeds from the freshly loaded brain
    const alive = this._aliveSlots();
    if (alive.length > 0) {
      const acks = alive.map(
        (slot) =>
          new Promise((resolve, reject) => {
            const reqId = this._nextReq();
            this._pending.set(reqId, {
              resolve: () => resolve(true),
              reject: (e) => reject(e),
            });
            try {
              slot.worker.postMessage({ type: 'loadBrain', reqId, json });
            } catch (e) {
              this._pending.delete(reqId);
              reject(e);
            }
          })
      );
      return Promise.allSettled(acks).then((rs) => {
        if (rs.some((r) => r.status === 'fulfilled')) return true;
        throw new Error('loadBrain failed on all shards');
      });
    }
    if (this._fallback) {
      try {
        this._fallback.load(json);
        this._syncFromBrain(this._fallback.snapshotBrain());
        return Promise.resolve(true);
      } catch (e) {
        return Promise.reject(new Error(String((e && e.message) || e)));
      }
    }
    return Promise.resolve(true);
  }

  /** Tear down every shard + the merge timer (and reject in-flight requests). */
  dispose() {
    this._disposed = true;
    this._running = false;
    if (this._mergeTimer) {
      clearTimeout(this._mergeTimer);
      this._mergeTimer = null;
    }
    for (const slot of this._workers) {
      if (slot.worker) {
        try {
          slot.worker.postMessage({ type: 'dispose' });
        } catch {
          /* ignore */
        }
        try {
          slot.worker.terminate();
        } catch {
          /* ignore */
        }
      }
      slot.worker = null;
      slot.alive = false;
    }
    this._workers = [];
    this.workers = 0;
    this._fallback = null;
    for (const { reject } of this._pending.values()) {
      try {
        reject(new Error('lane disposed'));
      } catch {
        /* ignore */
      }
    }
    this._pending.clear();
  }
}

export default WorkerLane;
