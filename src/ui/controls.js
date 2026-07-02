/*
 * ui/controls.js — the SIDEBAR controller (the app's only chrome).
 * ===============================================================
 * Ties the frosted-glass sidebar to the three features:
 *
 *   MODE      #btn-mode-train / #btn-mode-editor toggle the app between the
 *             training grid and the creature editor (shows one panel, hides
 *             the other, and flips app.mode which main.js reads each frame).
 *
 *   TRAIN     #btn-train-all pauses/resumes ALL lanes (loop.paused);
 *             #btn-add-lane spawns a fresh default-biped lane;
 *             #slider-speed sets control-steps-per-frame per lane;
 *             #lane-list is a live list of lanes (focus / exploit / reset /
 *             remove); #hud + #reward-graph show the FOCUSED lane's stats and
 *             its reward curve (trainer.returnHistory).
 *
 *   SAVE/LOAD #slot-name + #btn-save-creature / #btn-save-bundle write
 *             localStorage slots; #slot-list loads/deletes them; #btn-export
 *             downloads a .walkbrain.json; #file-import restores from a file.
 *
 * This module owns NO physics; it calls into the LaneManager, the Editor and
 * the storage helpers. It re-reads the current lanes/slots via refresh().
 */

import { CONFIG } from '../config.js';
import { defaultBiped } from '../creature.js';
import * as storage from '../app/storage.js';

export class Sidebar {
  /**
   * @param {object} deps
   * @param {import('../app/lanes.js').LaneManager} deps.laneManager
   * @param {import('./editor.js').Editor} deps.editor
   * @param {import('./loop.js').Loop} deps.loop
   * @param {{mode:string}} deps.app - shared app state (mode is read by main)
   */
  constructor({ laneManager, editor, loop, app }) {
    this.lanes = laneManager;
    this.editor = editor;
    this.loop = loop;
    this.app = app;

    // --- DOM ---
    this.btnModeTrain = document.getElementById('btn-mode-train');
    this.btnModeEditor = document.getElementById('btn-mode-editor');
    this.panelTrain = document.getElementById('panel-train');
    this.panelEditor = document.getElementById('panel-editor');

    this.btnTrainAll = document.getElementById('btn-train-all');
    this.btnAddLane = document.getElementById('btn-add-lane');
    this.slider = document.getElementById('slider-speed');
    this.valSpeed = document.getElementById('val-speed');
    this.laneList = document.getElementById('lane-list');
    this.hud = document.getElementById('hud');
    this.graph = document.getElementById('reward-graph');
    this.graphCtx = this.graph ? this.graph.getContext('2d') : null;

    this.slotName = document.getElementById('slot-name');
    this.btnSaveCreature = document.getElementById('btn-save-creature');
    this.btnSaveBundle = document.getElementById('btn-save-bundle');
    this.slotList = document.getElementById('slot-list');
    this.btnExport = document.getElementById('btn-export');
    this.fileImport = document.getElementById('file-import');

    this.msg = document.getElementById('msg');

    // Mobile slide-up drawer: the ☰ button + scrim (hidden on desktop via CSS).
    this.btnMenu = document.getElementById('btn-menu');
    this.scrim = document.getElementById('drawer-scrim');

    this._initGraphCanvas();
    this._wire();
    this.setMode('train');
    this.refresh();
  }

  // ---- Messaging ---------------------------------------------------------

  setMsg(text, kind) {
    if (!this.msg) return;
    this.msg.textContent = text || '';
    this.msg.dataset.kind = kind || '';
  }

  // ---- Mobile drawer -----------------------------------------------------
  // The sidebar element is styled as a bottom sheet under the CSS breakpoint;
  // toggling the `open` class slides it in/out. On desktop the class is inert
  // (the sheet transform only exists inside the media query), so this is safe
  // to call anywhere. `sidebar` here is the <aside> element itself.

  openDrawer() {
    this._sidebarEl().classList.add('open');
    if (this.scrim) this.scrim.classList.add('open');
    if (this.btnMenu) this.btnMenu.classList.add('active');
  }
  closeDrawer() {
    this._sidebarEl().classList.remove('open');
    if (this.scrim) this.scrim.classList.remove('open');
    if (this.btnMenu) this.btnMenu.classList.remove('active');
  }
  toggleDrawer() {
    if (this._sidebarEl().classList.contains('open')) this.closeDrawer();
    else this.openDrawer();
  }
  _sidebarEl() {
    if (!this._aside) this._aside = document.getElementById('sidebar');
    return this._aside;
  }

  // ---- Mode --------------------------------------------------------------

  setMode(mode) {
    this.app.mode = mode === 'editor' ? 'editor' : 'train';
    const editing = this.app.mode === 'editor';
    if (this.panelTrain) this.panelTrain.style.display = editing ? 'none' : '';
    if (this.panelEditor) this.panelEditor.style.display = editing ? '' : 'none';
    if (this.btnModeTrain) this.btnModeTrain.classList.toggle('active', !editing);
    if (this.btnModeEditor) this.btnModeEditor.classList.toggle('active', editing);
  }

  // ---- Wiring ------------------------------------------------------------

  _wire() {
    // Mobile drawer toggle + tap-scrim-to-close.
    if (this.btnMenu)
      this.btnMenu.addEventListener('click', () => this.toggleDrawer());
    if (this.scrim)
      this.scrim.addEventListener('click', () => this.closeDrawer());

    if (this.btnModeTrain)
      this.btnModeTrain.addEventListener('click', () => this.setMode('train'));
    if (this.btnModeEditor)
      this.btnModeEditor.addEventListener('click', () => this.setMode('editor'));

    if (this.btnTrainAll)
      this.btnTrainAll.addEventListener('click', () => {
        const paused = this.loop.togglePaused();
        this.btnTrainAll.textContent = paused ? 'Train all' : 'Pause all';
        this.btnTrainAll.classList.toggle('active', !paused);
      });

    if (this.btnAddLane)
      this.btnAddLane.addEventListener('click', () => this._addLane(defaultBiped()));

    if (this.slider) {
      this.slider.min = '1';
      this.slider.max = String(CONFIG.loop.maxSpeed);
      this.slider.step = '1';
      this.slider.value = String(this.loop.speed);
      this.slider.addEventListener('input', () => {
        const v = this.loop.setSpeed(Number(this.slider.value));
        this.slider.value = String(v);
        this._syncSpeed();
      });
      this._syncSpeed();
    }

    if (this.btnSaveCreature)
      this.btnSaveCreature.addEventListener('click', () => this._saveCreature());
    if (this.btnSaveBundle)
      this.btnSaveBundle.addEventListener('click', () => this._saveBundle());
    if (this.btnExport)
      this.btnExport.addEventListener('click', () => this._export());
    if (this.fileImport)
      this.fileImport.addEventListener('change', () => this._import());

    // The default-biped starting lane is added by main; ensure the toggle
    // label matches the initial (running) state.
    if (this.btnTrainAll) this.btnTrainAll.textContent = 'Pause all';
  }

  _syncSpeed() {
    if (this.valSpeed) this.valSpeed.textContent = `${this.loop.speed}×`;
  }

  // ---- Lane operations ---------------------------------------------------

  /** Add a lane, optionally with a saved/imported brain; focus + report. */
  _addLane(creature, opts = {}) {
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
  }

  // ---- Save / load -------------------------------------------------------

  _focused() {
    return this.lanes.focusedLane();
  }
  _slotName(fallback) {
    const v = this.slotName && this.slotName.value.trim();
    return v || fallback || 'creature';
  }

  _saveCreature() {
    const lane = this._focused();
    if (!lane) return this.setMsg('No lane to save.', 'err');
    const name = this._slotName(lane.name);
    storage.saveCreature(name, lane.creature);
    this.refresh();
    this.setMsg(`Saved body "${name}".`, 'ok');
  }

  _saveBundle() {
    const lane = this._focused();
    if (!lane) return this.setMsg('No lane to save.', 'err');
    const name = this._slotName(lane.name);
    let brain = null;
    try {
      brain = lane.trainer.serialize();
    } catch (e) {
      return this.setMsg(`Could not serialize brain: ${e.message || e}`, 'err');
    }
    storage.saveBundle(name, lane.creature, brain);
    this.refresh();
    this.setMsg(`Saved body + brain "${name}".`, 'ok');
  }

  _export() {
    const lane = this._focused();
    if (!lane) return this.setMsg('No lane to export.', 'err');
    let brain = null;
    try {
      brain = lane.trainer.serialize();
    } catch {
      brain = null; // export body-only if the brain can't be serialized
    }
    storage.exportBundle(lane.creature, brain);
    this.setMsg('Exported .walkbrain.json.', 'ok');
  }

  _import() {
    const file = this.fileImport && this.fileImport.files && this.fileImport.files[0];
    if (!file) return;
    storage
      .importFile(file)
      .then(({ creature, brain, name }) => {
        this._addLane(creature, { name, brain: brain || undefined });
      })
      .catch((e) => this.setMsg(`Import failed: ${e.message || e}`, 'err'))
      .finally(() => {
        if (this.fileImport) this.fileImport.value = '';
      });
  }

  _loadSlot(key) {
    const rec = storage.loadSlot(key);
    if (!rec) return this.setMsg('Slot is missing or corrupt.', 'err');
    this._addLane(rec.creature, {
      name: rec.name,
      brain: rec.kind === 'bundle' ? rec.brain : undefined,
    });
  }

  // ---- List rendering ----------------------------------------------------

  /** refresh() — rebuild the lane list and slot list DOM from current state. */
  refresh() {
    this._renderLanes();
    this._renderSlots();
  }

  _renderLanes() {
    if (!this.laneList) return;
    this.laneList.innerHTML = '';
    if (this.lanes.lanes.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'muted-line';
      empty.textContent = 'No lanes. Add one, or spawn from the editor.';
      this.laneList.appendChild(empty);
      return;
    }
    for (const lane of this.lanes.lanes) {
      const row = document.createElement('div');
      row.className = 'lane-row';
      if (lane.id === this.lanes.focusId) row.classList.add('focused');

      const name = document.createElement('button');
      name.className = 'lane-name';
      name.type = 'button';
      name.textContent = lane.name;
      name.title = 'Focus this lane';
      name.addEventListener('click', () => {
        this.lanes.focus(lane.id);
        this.refresh();
      });

      const exploit = document.createElement('label');
      exploit.className = 'lane-exploit';
      exploit.title = 'Exploit: show the best gait (no exploration)';
      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.checked = !!lane.trainer.exploit;
      chk.addEventListener('change', () => this.lanes.setExploit(lane.id, chk.checked));
      exploit.appendChild(chk);
      exploit.appendChild(document.createTextNode('E'));

      const reset = document.createElement('button');
      reset.className = 'icon-btn';
      reset.type = 'button';
      reset.textContent = '⟲';
      reset.title = 'Reset this lane (fresh brain)';
      reset.addEventListener('click', () => {
        this.lanes.resetLane(lane.id);
        this.setMsg(`Reset "${lane.name}".`);
      });

      const del = document.createElement('button');
      del.className = 'icon-btn';
      del.type = 'button';
      del.textContent = '✕';
      del.title = 'Remove this lane';
      del.addEventListener('click', () => {
        this.lanes.removeLane(lane.id);
        this.refresh();
      });

      row.appendChild(name);
      row.appendChild(exploit);
      row.appendChild(reset);
      row.appendChild(del);
      this.laneList.appendChild(row);
    }
  }

  _renderSlots() {
    if (!this.slotList) return;
    this.slotList.innerHTML = '';
    const slots = storage.listSlots();
    if (slots.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'muted-line';
      empty.textContent = 'No saved slots yet.';
      this.slotList.appendChild(empty);
      return;
    }
    for (const s of slots) {
      const row = document.createElement('div');
      row.className = 'slot-row';

      const load = document.createElement('button');
      load.className = 'slot-name';
      load.type = 'button';
      load.textContent = `${s.kind === 'bundle' ? '🧠 ' : '🦿 '}${s.name}`;
      load.title = s.kind === 'bundle' ? 'Load body + brain' : 'Load body';
      load.addEventListener('click', () => this._loadSlot(s.key));

      const del = document.createElement('button');
      del.className = 'icon-btn';
      del.type = 'button';
      del.textContent = '✕';
      del.title = 'Delete slot';
      del.addEventListener('click', () => {
        storage.deleteSlot(s.key);
        this.refresh();
      });

      row.appendChild(load);
      row.appendChild(del);
      this.slotList.appendChild(row);
    }
  }

  // ---- Per-frame HUD + reward graph -------------------------------------

  _initGraphCanvas() {
    if (!this.graph) return;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const w = this.graph.clientWidth || 212;
    const h = this.graph.clientHeight || 66;
    this.graph.width = Math.round(w * dpr);
    this.graph.height = Math.round(h * dpr);
    this._gw = w;
    this._gh = h;
    if (this.graphCtx) this.graphCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** updateHud() — called each rendered frame: focused-lane stats + graph. */
  updateHud() {
    const lane = this._focused();
    if (this.hud) {
      if (!lane) {
        this.hud.textContent = 'No lane focused.';
      } else {
        const t = lane.trainer;
        const ep = t.episode != null ? t.episode : 0;
        const best = t.bestDistance != null ? t.bestDistance : 0;
        const ret = t.lastReturn != null ? t.lastReturn : 0;
        const steps = t.stepCount != null ? t.stepCount : 0;
        this.hud.textContent =
          `${lane.name}\n` +
          `attempts ${ep}  ·  best ${Number(best).toFixed(2)} m\n` +
          `last return ${Number(ret).toFixed(1)}  ·  steps ${steps}` +
          `  ·  ${this.loop.paused ? 'PAUSED' : this.loop.speed + '×'}` +
          (t.exploit ? '  ·  exploit' : '');
      }
    }
    this._drawGraph(lane);
  }

  _drawGraph(lane) {
    const g = this.graphCtx;
    if (!g) return;
    const W = this._gw;
    const H = this._gh;
    g.clearRect(0, 0, W, H);
    // Frosted panel backdrop.
    g.fillStyle = 'rgba(255,255,255,0.05)';
    g.fillRect(0, 0, W, H);

    const hist = lane && lane.trainer && lane.trainer.returnHistory;
    if (!hist || hist.length < 2) {
      g.fillStyle = CONFIG.theme.labelMuted;
      g.font = '10px system-ui, sans-serif';
      g.textBaseline = 'middle';
      g.fillText('reward curve — collecting…', 8, H / 2);
      return;
    }
    let min = Infinity;
    let max = -Infinity;
    for (const v of hist) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (min === max) {
      min -= 1;
      max += 1;
    }
    const pad = 6;
    const x = (i) => pad + (i / (hist.length - 1)) * (W - 2 * pad);
    const y = (v) => H - pad - ((v - min) / (max - min)) * (H - 2 * pad);

    // Zero baseline (if in range).
    if (min < 0 && max > 0) {
      g.strokeStyle = 'rgba(255,255,255,0.12)';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(pad, y(0));
      g.lineTo(W - pad, y(0));
      g.stroke();
    }

    g.strokeStyle = CONFIG.theme.accent;
    g.lineWidth = 1.75;
    g.beginPath();
    for (let i = 0; i < hist.length; i++) {
      const px = x(i);
      const py = y(hist[i]);
      if (i === 0) g.moveTo(px, py);
      else g.lineTo(px, py);
    }
    g.stroke();

    g.fillStyle = CONFIG.theme.labelMuted;
    g.font = '10px system-ui, sans-serif';
    g.textBaseline = 'top';
    g.fillText(`max ${max.toFixed(1)}`, 6, 4);
  }
}

export default Sidebar;
