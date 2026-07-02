/*
 * app/storage.js — SAVE / LOAD creatures and trained brains to the device.
 * =======================================================================
 * Two persistence surfaces, both dealing in the same plain-data artifacts:
 *
 *   1. localStorage "slots" — quick in-browser save/load. Each slot is one
 *      JSON blob under a namespaced key. A slot is either:
 *        - kind:'creature'  { creature }                — just the body, or
 *        - kind:'bundle'    { creature, brain }         — body + trained brain
 *      where `brain` is whatever `trainer.serialize()` resolved to (an opaque,
 *      JSON-safe object we never introspect — we just hand it back to the
 *      trainer to restore). As of Phase 2 `serialize()` is ASYNC (the brain is
 *      fetched from the background training worker), so callers AWAIT it before
 *      handing the resolved value to saveBundle()/exportBundle() here; the
 *      on-disk shape is unchanged.
 *
 *   2. File export/import — a portable `.walkbrain.json` artifact bundling
 *      { version, kind:'walkbrain', creature, brain }. Export builds a Blob
 *      and clicks a temporary <a download>; import reads a File via FileReader
 *      and JSON.parse. This is the shareable body+brain file.
 *
 * Nothing here imports Sim or Trainer — storage only moves plain data. The
 * caller (lanes/controls) is responsible for rebuilding a live lane from it.
 */

const NS = 'walksim.slot.'; // localStorage key prefix for slots
export const FILE_VERSION = 1; // bump if the on-disk shape ever changes

/** slugify a user name into a safe-ish filename stem. */
function slug(name) {
  return (
    String(name || 'creature')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'creature'
  );
}

/**
 * saveCreature(name, creature) — persist just the body under a slot.
 * Overwrites any slot with the same name.
 */
export function saveCreature(name, creature) {
  const rec = {
    version: FILE_VERSION,
    kind: 'creature',
    name: String(name || creature.name || 'creature'),
    savedAt: Date.now(),
    creature,
  };
  localStorage.setItem(NS + rec.name, JSON.stringify(rec));
  return rec;
}

/**
 * saveBundle(name, creature, brain) — persist body + serialized brain.
 * `brain` is the object returned by trainer.serialize().
 */
export function saveBundle(name, creature, brain) {
  const rec = {
    version: FILE_VERSION,
    kind: 'bundle',
    name: String(name || creature.name || 'creature'),
    savedAt: Date.now(),
    creature,
    brain,
  };
  localStorage.setItem(NS + rec.name, JSON.stringify(rec));
  return rec;
}

/** listSlots() — every saved slot, newest first: [{key, name, kind, savedAt}]. */
export function listSlots() {
  const out = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(NS)) continue;
    try {
      const rec = JSON.parse(localStorage.getItem(key));
      out.push({
        key,
        name: rec.name || key.slice(NS.length),
        kind: rec.kind || 'creature',
        savedAt: rec.savedAt || 0,
      });
    } catch {
      // Corrupt slot — skip it rather than crashing the list.
    }
  }
  out.sort((a, b) => b.savedAt - a.savedAt);
  return out;
}

/** loadSlot(key) — the full record {kind, name, creature, brain?} or null. */
export function loadSlot(key) {
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** deleteSlot(key) — remove a slot. */
export function deleteSlot(key) {
  localStorage.removeItem(key);
}

/**
 * exportBundle(creature, brain) — download a portable .walkbrain.json file
 * bundling the body and (optionally) the trained brain. Uses a Blob + a
 * throwaway <a download> click; no server involved.
 */
export function exportBundle(creature, brain) {
  const payload = {
    version: FILE_VERSION,
    kind: 'walkbrain',
    exportedAt: new Date().toISOString(),
    creature,
    brain: brain || null,
  };
  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${slug(creature && creature.name)}.walkbrain.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the click a tick to start, then release the object URL.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return payload;
}

/**
 * importFile(file) -> Promise<{creature, brain, name}>. Reads a File (from an
 * <input type=file>), parses JSON, and normalizes it to {creature, brain}.
 * Rejects if the file isn't valid JSON or has no `creature`.
 */
export function importFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('could not read file'));
    reader.onload = () => {
      try {
        const obj = JSON.parse(String(reader.result));
        if (!obj || !obj.creature) {
          reject(new Error('file has no "creature" field'));
          return;
        }
        resolve({
          creature: obj.creature,
          brain: obj.brain || null,
          name: obj.creature.name || 'imported',
        });
      } catch (e) {
        reject(new Error('not valid JSON: ' + (e.message || e)));
      }
    };
    reader.readAsText(file);
  });
}
