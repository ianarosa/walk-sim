/*
 * ui/controls.js — sidebar MOUNT GLUE + shared app CONTEXT.
 * ========================================================
 * The sidebar used to be one monolithic `Sidebar` class that owned all the
 * markup and every handler. It is now assembled from self-contained panels
 * (src/ui/panels/*.js) registered via ui/registry.js. What's left here is the
 * genuinely cross-cutting glue that no single panel owns:
 *
 *   createCtx()   — builds the shared `ctx` handed to every panel's mount():
 *                     • app state:   canvas, ctx2d, lanes, editor, loop, app
 *                     • messaging:   setMsg()  -> #msg status line
 *                     • lane add:    addLane()  (used by train, editor, boot)
 *                     • refreshers:  onRefresh()/refresh() (lane + slot lists)
 *                     • frame hooks: onFrame()/frame()      (HUD + reward graph)
 *                     • mode/drawer: setMode()/openDrawer()/closeDrawer()/
 *                                    toggleDrawer() — real impls installed by
 *                                    the `mode` panel; safe no-ops until then.
 *
 *   mountPanels() — creates the #panel-train / #panel-editor regions and the
 *                   #msg line, then injects + wires every registered panel into
 *                   its region (sorted by `order`), and finally shows TRAIN mode
 *                   and refreshes the lists — exactly the old constructor order.
 *
 * This module owns NO physics and NO feature markup; panels call INTO the
 * LaneManager / Editor / storage themselves.
 */

import { CONFIG } from '../config.js';
import { panels } from './registry.js';

/**
 * Build the shared context object handed to every panel.
 * @param {object} base - { canvas, ctx2d, lanes, editor, loop, app }
 */
export function createCtx(base) {
  const ctx = {
    ...base,

    // --- registration hubs ---
    _refreshers: [],
    _framers: [],
    /** Register a list-rebuilder run on every ctx.refresh(). */
    onRefresh(fn) {
      if (typeof fn === 'function') this._refreshers.push(fn);
    },
    /** Register a per-rendered-frame callback run on every ctx.frame(). */
    onFrame(fn) {
      if (typeof fn === 'function') this._framers.push(fn);
    },
    /** Rebuild all registered lists (lane list, slot list, …). */
    refresh() {
      for (const fn of this._refreshers) fn();
    },
    /** Run all per-frame hooks (focused-lane HUD + reward graph). */
    frame() {
      for (const fn of this._framers) fn();
    },

    // --- shared status line (#msg) ---
    setMsg(text, kind) {
      const el = document.getElementById('msg');
      if (!el) return;
      el.textContent = text || '';
      el.dataset.kind = kind || '';
    },

    // --- lane add (shared by the train panel, the editor and boot) ---
    /** Add a lane, optionally with a saved/imported brain; focus + report. */
    addLane(creature, opts = {}) {
      if (this.lanes.lanes.length >= CONFIG.lanes.maxLanes) {
        this.setMsg(`Lane limit (${CONFIG.lanes.maxLanes}) reached.`, 'err');
        return null;
      }
      try {
        const { lane, warn } = this.lanes.addLane(creature, opts);
        this.lanes.focus(lane.id);
        this.refresh();
        if (warn) this.setMsg(warn, 'err');
        else this.setMsg(`Added lane "${lane.name}".`, 'ok');
        return lane;
      } catch (e) {
        this.setMsg(`Could not add lane: ${e.message || e}`, 'err');
        return null;
      }
    },

    // --- mode + mobile drawer: installed by the `mode` panel at mount time ---
    setMode() {},
    openDrawer() {},
    closeDrawer() {},
    toggleDrawer() {},
  };
  return ctx;
}

/**
 * Assemble the sidebar: create regions, inject + wire every panel, then show
 * the default (TRAIN) mode and refresh the lists.
 * @param {ReturnType<typeof createCtx>} ctx
 */
export function mountPanels(ctx) {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;

  const sorted = [...panels].sort((a, b) => (a.order || 0) - (b.order || 0));

  // Region wrappers + status line, in the SAME visual order as the old markup:
  //   [ top panels… ]  #panel-train  #panel-editor  #msg
  const trainWrap = document.createElement('div');
  trainWrap.id = 'panel-train';

  const editorWrap = document.createElement('div');
  editorWrap.id = 'panel-editor';
  editorWrap.style.display = 'none';

  const msg = document.createElement('div');
  msg.id = 'msg';

  // Top-region panels mount directly into the sidebar (header + mode toggle).
  for (const p of sorted) if ((p.region || 'top') === 'top') p.mount(sidebar, ctx);

  sidebar.appendChild(trainWrap);
  sidebar.appendChild(editorWrap);
  sidebar.appendChild(msg);

  for (const p of sorted) if (p.region === 'train') p.mount(trainWrap, ctx);
  for (const p of sorted) if (p.region === 'editor') p.mount(editorWrap, ctx);

  // Match the old Sidebar constructor tail: show train mode, build the lists.
  ctx.setMode('train');
  ctx.refresh();
}

export default { createCtx, mountPanels };
