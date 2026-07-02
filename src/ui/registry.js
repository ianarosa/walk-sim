/*
 * ui/registry.js — the panel REGISTRY (the sidebar's plug-in socket).
 * ==================================================================
 * The sidebar is assembled from self-contained "panels". Each panel module
 * (src/ui/panels/*.js) calls `registerPanel(def)` at import time; main.js then
 * imports every panel (one line each) and the mount glue (controls.js) walks
 * this list to inject + wire them.
 *
 * A panel definition:
 *   {
 *     id:     string,                     // unique, for debugging
 *     order?: number,                     // sort key within its region (asc)
 *     region?: 'top' | 'train' | 'editor',// where it mounts (default 'top')
 *     mount(container, ctx)               // build DOM into `container`, wire it
 *   }
 *
 * `region` decides the DOM group:
 *   'top'    -> straight into #sidebar, above the mode panels
 *   'train'  -> into #panel-train  (shown only in TRAIN mode)
 *   'editor' -> into #panel-editor (shown only in EDITOR mode)
 *
 * Panels talk to the rest of the app ONLY through `ctx` (see controls.js).
 */

export const panels = [];

/** Register a sidebar panel. Called at module import time. */
export function registerPanel(def) {
  if (!def || typeof def.mount !== 'function') {
    throw new Error('registerPanel: def.mount must be a function');
  }
  panels.push(def);
  return def;
}

export default { panels, registerPanel };
