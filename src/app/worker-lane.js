/*
 * app/worker-lane.js — WorkerLane: a DROP-IN for the per-lane trainer object.
 * ==========================================================================
 * Phase 2 splits WORK from SHOW:
 *   • WORK  — a src/rl/worker.js background worker trains a ParallelTrainer
 *             (N envs, one shared brain) flat-out, off the render thread.
 *   • SHOW  — this object renders ONE live preview on the main thread, driven
 *             by the current brain (greedy actions), and reports the worker's
 *             training stats through mirrored fields.
 *
 * It is a DROP-IN for what lanes.js reads off `lane.trainer` today:
 *   sim            — the display Sim (lanes.js follows sim.rootPosition().x)
 *   tick()         — advance the preview ONE control step -> { done, distance }
 *   exploit        — kept for API compat (preview is always greedy)
 *   episode / bestDistance / lastReturn / stepCount / returnHistory / stepsPerSec
 *                  — mirrored from the worker's stats broadcasts
 *   serialize()    — ASYNC: requests the worker's full brain, resolves the JSON
 *
 * Plus the lane-management surface lanes.js drives:
 *   setInstances(n) / setRunning(on) / loadBrain(json) / dispose()
 *   warn           — set (synchronously) when a supplied brain doesn't fit
 *
 * PREVIEW LOOP (tick): observe the display sim -> normalize -> greedy action
 * (tanh(mlp.forward)) -> Env.stepWith scales by CONFIG.RL.maxMotorSpeed and
 * steps frameSkip physics steps -> on a fall/timeout, reset the display sim so
 * the preview shows the CURRENT skill and the fall->reset->retry loop. The
 * greedy brain is a LOCAL GaussianPolicy+Normalizer rebuilt from each snapshot.
 *
 * FALLBACK: if Worker is unavailable (undefined or construction throws), we run
 * a ParallelTrainer on the MAIN thread (a little training per tick) behind the
 * exact same interface, so the app still works (with the old at-speed stutter).
 */

import { Sim } from '../physics/sim.js';
import { Env, obsSize, actSize } from '../rl/env.js';
import { GaussianPolicy } from '../rl/policy.js';
import { Normalizer } from '../rl/nn.js';
import { ParallelTrainer } from '../rl/trainer-core.js';
import { cloneCreature } from '../creature.js';
import { CONFIG } from '../config.js';

// Steps trained per preview tick when running the main-thread FALLBACK. Small,
// so the fallback stays responsive (it is a degraded mode, not the norm).
const FALLBACK_STEPS = 8;
const BRAIN_TIMEOUT_MS = 5000; // guard for a lost getBrain reply

export class WorkerLane {
  /**
   * @param {object} creature  a Creature (plain data); each env gets a clone.
   * @param {object} [opts]
   * @param {number} [opts.instances=8]  parallel training envs in the worker.
   * @param {object|null} [opts.brain]   a serialized brain to restore (optional).
   */
  constructor(creature, { instances = 8, brain = null } = {}) {
    this.creature = cloneCreature(creature);
    this.instances = Math.max(1, Math.floor(instances));
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

    // --- Local greedy brain for the preview (rebuilt from snapshots) ---
    this._policy = null;
    this._normalizer = null;

    // --- Display sim + env (main thread), the thing lanes.js renders ---
    this._env = new Env(new Sim(cloneCreature(this.creature)));
    this.sim = this._env.sim;
    this._obs = this._env.reset();

    // --- Worker plumbing ---
    this._worker = null;
    this._fallback = null;
    this._running = true; // training enabled (worker loop / fallback trainSteps)
    this._reqSeq = 1;
    this._pending = new Map(); // reqId -> {resolve, reject}
    this._pendingBrain = null; // brain to send to the worker after init
    this._error = null;

    // Synchronous size check so a mismatched brain behaves EXACTLY like the old
    // Trainer.fromJSON path (fresh brain + a friendly warn), no async surprise.
    if (brain) {
      const oS = obsSize(this.sim);
      const aS = actSize(this.sim);
      if (brain.obsSize === oS && brain.actSize === aS) {
        this._pendingBrain = brain;
        this._syncFromBrain(brain); // instant preview from the loaded weights
      } else {
        this.warn =
          `brain didn't fit this body (brain obs=${brain.obsSize} act=${brain.actSize}, ` +
          `sim obs=${oS} act=${aS}) — started a fresh one`;
      }
    }

    this._spawnWorker();
  }

  // --- Worker lifecycle --------------------------------------------------

  _spawnWorker() {
    if (typeof Worker === 'undefined') {
      this._startFallback();
      return;
    }
    try {
      this._worker = new Worker(new URL('../rl/worker.js', import.meta.url), {
        type: 'module',
      });
    } catch {
      this._worker = null;
      this._startFallback();
      return;
    }
    this._worker.onmessage = (ev) => this._onMessage(ev.data);
    this._worker.onerror = () => {
      // A load/runtime error in the worker — fall back once so the app survives.
      if (!this._fallback) {
        try {
          this._worker.terminate();
        } catch {
          /* ignore */
        }
        this._worker = null;
        this._startFallback();
      }
    };
    this._worker.postMessage({
      type: 'init',
      creature: this.creature,
      instances: this.instances,
      config: {},
    });
    if (this._pendingBrain) {
      // Fire-and-forget: sizes were screened in the ctor, so this should
      // succeed; swallow to avoid an unhandled rejection if it somehow doesn't.
      this.loadBrain(this._pendingBrain).catch(() => {});
      this._pendingBrain = null;
    }
    this._worker.postMessage({ type: 'setRunning', on: this._running });
  }

  /** Main-thread ParallelTrainer standing in for an unavailable worker. */
  _startFallback() {
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

  _onMessage(m) {
    if (!m) return;
    switch (m.type) {
      case 'ready':
        this._syncStats(m.stats);
        break;
      case 'stats':
        this._syncStats(m.stats);
        break;
      case 'brain':
        this._syncFromBrain(m.snapshot);
        break;
      case 'brainFull': {
        const r = this._pending.get(m.reqId);
        if (r) {
          this._pending.delete(m.reqId);
          r.resolve(m.json);
        }
        break;
      }
      case 'loaded': {
        const r = this._pending.get(m.reqId);
        if (r) {
          this._pending.delete(m.reqId);
          if (m.ok) r.resolve(true);
          else r.reject(new Error(m.error || 'loadBrain failed'));
        }
        break;
      }
      case 'error':
        this._error = m.error;
        break;
      default:
        break;
    }
  }

  // --- Mirror helpers ----------------------------------------------------

  _syncStats(s) {
    if (!s) return;
    this.episode = s.episode || 0;
    this.stepCount = s.stepCount || 0;
    this.updates = s.updates || 0;
    this.lastReturn = s.lastReturn || 0;
    this.bestDistance = s.bestDistance || 0;
    if (Array.isArray(s.returnHistory)) this.returnHistory = s.returnHistory;
    this.stepsPerSec = s.stepsPerSec || 0;
    if (s.instances) this.instances = s.instances;
  }

  /** Rebuild the LOCAL greedy policy + normalizer from a brain snapshot/serialize. */
  _syncFromBrain(snap) {
    if (!snap || !snap.policy || !snap.normalizer) return;
    try {
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

  // --- The per-frame preview step (drop-in for Trainer.tick) -------------

  /**
   * tick() — advance the PREVIEW one control step with the current greedy brain,
   * resetting the display sim on a fall/timeout so the retry loop is visible.
   * In FALLBACK mode it also trains a little on the main thread. Returns a light
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

    // No brain yet (worker still warming up) — hold the pose, no reset.
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

  setInstances(n) {
    this.instances = Math.max(1, Math.floor(n));
    if (this._worker)
      this._worker.postMessage({ type: 'setInstances', n: this.instances });
    if (this._fallback) this._fallback.setInstances(this.instances);
    return this.instances;
  }

  /** Start/stop training (worker loop or fallback trainSteps). Preview is
   *  driven separately by tick(), which the render loop gates on pause. */
  setRunning(on) {
    this._running = !!on;
    if (this._worker)
      this._worker.postMessage({ type: 'setRunning', on: this._running });
  }

  // --- Persistence -------------------------------------------------------

  /** serialize() -> Promise<brainJSON>. Requests the worker's full brain. */
  serialize() {
    if (this._worker) {
      const reqId = this._reqSeq++;
      return new Promise((resolve, reject) => {
        this._pending.set(reqId, { resolve, reject });
        this._worker.postMessage({ type: 'getBrain', reqId });
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
   * loadBrain(json) -> Promise<boolean>. Updates the LOCAL preview immediately
   * and forwards to the worker (or fallback). Rejects on a worker size mismatch.
   */
  loadBrain(json) {
    if (!json) return Promise.resolve(false);
    this._syncFromBrain(json); // instant preview from the loaded weights
    if (this._worker) {
      const reqId = this._reqSeq++;
      return new Promise((resolve, reject) => {
        this._pending.set(reqId, { resolve, reject });
        this._worker.postMessage({ type: 'loadBrain', reqId, json });
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

  /** Tear down the worker (and reject any in-flight requests). */
  dispose() {
    this._running = false;
    if (this._worker) {
      try {
        this._worker.postMessage({ type: 'dispose' });
      } catch {
        /* ignore */
      }
      try {
        this._worker.terminate();
      } catch {
        /* ignore */
      }
      this._worker = null;
    }
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
