/*
 * rl/worker.js — BACKGROUND TRAINING WORKER (module worker).
 * =========================================================
 * Phase 2: RL training moved OFF the render thread. This module worker owns a
 * `ParallelTrainer` (src/rl/trainer-core.js) and runs a self-scheduling
 * collect/learn loop at full speed. The main thread only renders ONE live
 * preview per lane, driven by periodic brain snapshots this worker broadcasts.
 * The net effect: (a) no micro-stutter at high speed (training never touches
 * the render thread), and (b) faster training (the worker is never gated by
 * rAF and gathers N× env-steps via the parallel envs).
 *
 * PLANCK LOADING (must be first, and lazy):
 *   physics/build.js does `const planck = globalThis.planck` at IMPORT TIME, so
 *   the global MUST exist before ANY sim/rl module is imported. vendor/planck
 *   is a UMD bundle; imported as a module it runs its wrapper and attaches the
 *   library to globalThis.planck (its globalThis branch). We therefore set
 *   globalThis.window = globalThis, dynamic-import the vendor bundle, THEN
 *   dynamic-import trainer-core. Nothing sim-related is imported statically.
 *
 * MESSAGE PROTOCOL (postMessage both ways):
 *   IN  init {creature, instances, config}   build a ParallelTrainer
 *       setInstances {n}                      grow/shrink the env pool
 *       setRunning {on}                       start/stop the training loop
 *       getBrain {reqId}                      -> brainFull {reqId, json}
 *       loadBrain {reqId, json}               -> loaded {reqId, ok, error?}
 *       dispose                               stop + self.close()
 *   OUT ready   {stats}                        init completed
 *       stats   {stats}                        ~every POST_MS while running
 *       brain   {snapshot}                     ~every POST_MS while running
 *       brainFull {reqId, json}                reply to getBrain (full serialize)
 *       loaded  {reqId, ok, error?}            reply to loadBrain
 *       error   {error}                        a training/handler error
 *
 * Robustness: safe to receive setRunning/getBrain BEFORE init (they no-op /
 * reply null); the loop only schedules once a trainer exists.
 */

let _core = null; // resolves to the trainer-core module namespace

/** Load planck (sets globalThis.planck) then the trainer-core module. Lazy. */
async function ensureCore() {
  if (_core) return _core;
  // Some sim code paths read window.planck; make window an alias of the global.
  globalThis.window = globalThis;
  await import(new URL('../../vendor/planck.min.js', import.meta.url));
  if (!globalThis.planck) {
    throw new Error(
      'worker: planck global not set after loading vendor/planck.min.js'
    );
  }
  _core = await import('./trainer-core.js');
  return _core;
}

// --- State ---------------------------------------------------------------
let ParallelTrainer = null;
let trainer = null;
let creatureDef = null;
let running = false;
let scheduled = false;
let lastPost = 0;

const CHUNK = 16; // collectSteps per inner batch
const BUDGET_MS = 15; // train up to this long before yielding to messages
const POST_MS = 100; // stats/brain broadcast cadence (ms)

function now() {
  return typeof performance !== 'undefined' && performance.now
    ? performance.now()
    : Date.now();
}

/** Self-schedule the next training batch (setTimeout(0) yields the event loop). */
function schedule() {
  if (scheduled) return;
  scheduled = true;
  setTimeout(runBatch, 0);
}

function maybeLoop() {
  if (running && trainer) schedule();
}

/**
 * runBatch() — train for up to BUDGET_MS, then yield so queued messages
 * (setInstances/getBrain/…) get processed, and broadcast stats+brain on a
 * ~POST_MS cadence. Re-schedules itself while running.
 */
function runBatch() {
  scheduled = false;
  if (!running || !trainer) return;
  const t0 = now();
  try {
    do {
      trainer.trainSteps(CHUNK);
    } while (now() - t0 < BUDGET_MS);
  } catch (err) {
    running = false;
    postMessage({ type: 'error', error: String((err && err.message) || err) });
    return;
  }
  const t = now();
  if (t - lastPost >= POST_MS) {
    lastPost = t;
    try {
      postMessage({ type: 'stats', stats: trainer.stats() });
      postMessage({ type: 'brain', snapshot: trainer.snapshotBrain() });
    } catch {
      /* transient postMessage failure — ignore, next tick retries */
    }
  }
  schedule();
}

self.onmessage = async (e) => {
  const m = (e && e.data) || {};
  try {
    switch (m.type) {
      case 'init': {
        const core = await ensureCore();
        ParallelTrainer = core.ParallelTrainer;
        creatureDef = m.creature;
        trainer = new ParallelTrainer(creatureDef, {
          instances: m.instances || 8,
          config: m.config || {},
        });
        lastPost = 0;
        postMessage({ type: 'ready', stats: trainer.stats() });
        maybeLoop();
        break;
      }
      case 'setInstances':
        if (trainer && m.n != null) trainer.setInstances(m.n);
        break;
      case 'setRunning':
        running = !!m.on;
        maybeLoop();
        break;
      case 'getBrain':
        postMessage({
          type: 'brainFull',
          reqId: m.reqId,
          json: trainer ? trainer.serialize() : null,
        });
        break;
      case 'loadBrain': {
        if (!trainer || !ParallelTrainer) {
          postMessage({
            type: 'loaded',
            reqId: m.reqId,
            ok: false,
            error: 'trainer not ready',
          });
          break;
        }
        try {
          // Restore onto a fresh trainer built from the CURRENT creature, so a
          // size mismatch throws loudly (guarded below) instead of corrupting.
          const restored = ParallelTrainer.fromJSON(creatureDef, m.json, {
            instances: trainer.instances,
          });
          trainer = restored;
          postMessage({ type: 'loaded', reqId: m.reqId, ok: true });
          maybeLoop();
        } catch (err) {
          postMessage({
            type: 'loaded',
            reqId: m.reqId,
            ok: false,
            error: String((err && err.message) || err),
          });
        }
        break;
      }
      case 'dispose':
        running = false;
        trainer = null;
        try {
          self.close();
        } catch {
          /* ignore */
        }
        break;
      default:
        break;
    }
  } catch (err) {
    postMessage({ type: 'error', error: String((err && err.message) || err) });
  }
};
