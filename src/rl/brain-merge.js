/*
 * rl/brain-merge.js — PURE weight-averaging of serialized brains.
 * ==============================================================
 * No DOM, no Worker, no imports — just array math, so it is trivially unit-
 * testable in plain node and safe to run on either the main thread or inside a
 * worker.
 *
 * WHY AVERAGE WEIGHTS?
 * -------------------
 * To use ALL the CPU cores for one lane we shard its parallel training across
 * several Web Workers. Each worker runs its own ParallelTrainer (its own actor,
 * critic, normalizer and Adam state) on a slice of the total instances, so the
 * shards would otherwise drift into DIFFERENT brains. Periodically (every
 * CONFIG.RL.mergeMs) we pull each shard's full serialized brain, take the
 * ELEMENT-WISE MEAN of all their parameters, and push that single averaged
 * brain back into every shard (ParallelTrainer.applyMergedBrain, in place).
 *
 * This is the classic "local SGD with periodic model averaging" / EASGD-style
 * scheme (Zhang et al. 2015; Stich 2018): each worker takes many independent
 * gradient steps, then the fleet is periodically pulled back toward a common
 * average. Averaging the value net and the observation normalizer alongside the
 * policy keeps the whole apparatus consistent across shards. The apply step is
 * IN PLACE (copy into existing arrays) specifically so each shard's Adam moment
 * estimates — which are keyed to those array slots — survive the merge and the
 * optimizer keeps its momentum. The net effect: N cores' worth of experience
 * converging on ONE brain, and a single shard dying/restarting only perturbs
 * the average by its share, never resetting the others.
 *
 * This module produces EXACTLY the shape ParallelTrainer.applyMergedBrain reads:
 *   {
 *     policy:     { mlp: { layers: [ { W:number[], b:number[] } ] } },
 *     logStd:     number[],
 *     value:      { mlp: { layers: [ { W:number[], b:number[] } ] } },
 *     normalizer: { mean:number[], M2:number[], count:number },
 *   }
 * All plain arrays (JSON/postMessage-safe).
 */

/** Mean of a list of same-length numeric arrays; NaN falls back to arrays0[i]. */
function meanArray(arrays, fallback) {
  const n = arrays.length;
  const len = arrays[0].length;
  const out = new Array(len);
  for (let i = 0; i < len; i++) {
    let sum = 0;
    for (let a = 0; a < n; a++) sum += arrays[a][i];
    const m = sum / n;
    out[i] = Number.isFinite(m) ? m : fallback[i];
  }
  return out;
}

/** Element-wise mean of the [{W,b}] layer lists of several MLP serializations. */
function meanLayers(layerLists) {
  const ref = layerLists[0]; // reference shape (already length-checked upstream)
  const out = new Array(ref.length);
  for (let l = 0; l < ref.length; l++) {
    out[l] = {
      W: meanArray(
        layerLists.map((ls) => ls[l].W),
        ref[l].W
      ),
      b: meanArray(
        layerLists.map((ls) => ls[l].b),
        ref[l].b
      ),
    };
  }
  return out;
}

/** logStd of a brain: prefer policy.logStd, else the top-level logStd. */
function brainLogStd(b) {
  return (b.policy && b.policy.logStd) || b.logStd || [];
}

/**
 * Shape a single valid brain into the exact merged output shape (used when only
 * one shard is alive — the "average of one" is just that brain, reduced).
 */
function reduceOne(b) {
  return {
    policy: {
      mlp: {
        layers: b.policy.mlp.layers.map((L) => ({
          W: Array.from(L.W),
          b: Array.from(L.b),
        })),
      },
    },
    logStd: Array.from(brainLogStd(b)),
    value: {
      mlp: {
        layers: b.value.mlp.layers.map((L) => ({
          W: Array.from(L.W),
          b: Array.from(L.b),
        })),
      },
    },
    normalizer: {
      mean: Array.from(b.normalizer.mean),
      M2: Array.from(b.normalizer.M2),
      count: b.normalizer.count,
    },
  };
}

/**
 * averageBrains(brains) — element-wise mean of several full serialize() objects.
 *
 * @param {Array<object|null>} brains  ParallelTrainer.serialize() results.
 * @returns {object|null}  merged brain (shape above), or null if none are valid.
 *
 * Filters out null/undefined and any brain whose obsSize/actSize (or layer
 * shapes) don't match the first valid brain — a mismatched shard is simply
 * excluded rather than corrupting the average. 0 valid -> null; 1 valid -> that
 * brain reduced to the merged shape; otherwise the mean of policy MLP W/b, the
 * logStd vector, value MLP W/b, normalizer mean/M2, and the mean of counts.
 * Any non-finite averaged element falls back to brains[0]'s value there.
 */
export function averageBrains(brains) {
  if (!Array.isArray(brains)) return null;

  // Keep only structurally-complete brains.
  const complete = brains.filter(
    (b) =>
      b &&
      b.policy &&
      b.policy.mlp &&
      Array.isArray(b.policy.mlp.layers) &&
      b.value &&
      b.value.mlp &&
      Array.isArray(b.value.mlp.layers) &&
      b.normalizer &&
      Array.isArray(b.normalizer.mean) &&
      Array.isArray(b.normalizer.M2)
  );
  if (complete.length === 0) return null;

  const ref = complete[0];
  const pLayerN = ref.policy.mlp.layers.length;
  const vLayerN = ref.value.mlp.layers.length;
  const logStdN = brainLogStd(ref).length;
  const meanN = ref.normalizer.mean.length;

  // Same-shape check vs the reference; drop any that differ.
  const sameShape = (b) => {
    if (b.obsSize !== ref.obsSize || b.actSize !== ref.actSize) return false;
    if (b.policy.mlp.layers.length !== pLayerN) return false;
    if (b.value.mlp.layers.length !== vLayerN) return false;
    if (brainLogStd(b).length !== logStdN) return false;
    if (b.normalizer.mean.length !== meanN) return false;
    if (b.normalizer.M2.length !== ref.normalizer.M2.length) return false;
    for (let l = 0; l < pLayerN; l++) {
      if (b.policy.mlp.layers[l].W.length !== ref.policy.mlp.layers[l].W.length)
        return false;
      if (b.policy.mlp.layers[l].b.length !== ref.policy.mlp.layers[l].b.length)
        return false;
    }
    for (let l = 0; l < vLayerN; l++) {
      if (b.value.mlp.layers[l].W.length !== ref.value.mlp.layers[l].W.length)
        return false;
      if (b.value.mlp.layers[l].b.length !== ref.value.mlp.layers[l].b.length)
        return false;
    }
    return true;
  };

  const valid = complete.filter(sameShape);
  if (valid.length === 0) return null;
  if (valid.length === 1) return reduceOne(valid[0]);

  const refLogStd = brainLogStd(ref);
  return {
    policy: { mlp: { layers: meanLayers(valid.map((b) => b.policy.mlp.layers)) } },
    logStd: meanArray(valid.map(brainLogStd), refLogStd),
    value: { mlp: { layers: meanLayers(valid.map((b) => b.value.mlp.layers)) } },
    normalizer: {
      mean: meanArray(
        valid.map((b) => b.normalizer.mean),
        ref.normalizer.mean
      ),
      M2: meanArray(
        valid.map((b) => b.normalizer.M2),
        ref.normalizer.M2
      ),
      count:
        valid.reduce((s, b) => s + (b.normalizer.count || 0), 0) / valid.length,
    },
  };
}

export default averageBrains;
