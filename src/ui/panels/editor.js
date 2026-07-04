/*
 * ui/panels/editor.js — EDITOR PANEL WRAPPER.
 * ===========================================
 * Injects the creature-editor's markup (the SAME ids that src/ui/editor.js
 * queries) into #panel-editor, then constructs the existing Editor class — its
 * constructor's _wireDom() finds the just-injected DOM. The editor instance is
 * stashed on ctx.editor so main.js can route canvas pointer events and draw it.
 *
 * This wrapper does NOT reimplement editor logic — it only owns the DOM + the
 * onSpawn/onMessage plumbing back into the app (ctx.addLane / setMode /
 * closeDrawer / setMsg).
 *
 * IDs owned: editor-name; editor-tool-select / -cell / -joint (radios,
 *   name="editor-tool"); editor-body-panel, editor-body-title, chk-body-root,
 *   chk-body-foot, btn-body-delete; editor-joint-panel, editor-joint-title,
 *   editor-joint-lower, editor-joint-upper, editor-joint-torque,
 *   editor-joint-torque-val, chk-joint-motor, btn-joint-delete;
 *   btn-editor-spawn, btn-editor-load, btn-editor-clear;
 *   select-editor-preset, btn-editor-edit-current (load an existing creature
 *   — a preset or the focused lane's build — into the editor to tweak it).
 */

import { registerPanel } from '../registry.js';
import { Editor } from '../editor.js';
// PRESETS lets the user start editing from a ready-made shape; cloneCreature
// gives us a throwaway copy so loading into the editor never mutates the
// original preset or a running lane's creature.
import { PRESETS, cloneCreature } from '../../creature.js';

registerPanel({
  id: 'editor',
  order: 10,
  region: 'editor',
  mount(container, ctx) {
    const root = document.createElement('div');
    root.style.display = 'contents';
    root.innerHTML = `
      <div class="section" style="border-top:none; padding-top:0;">
        <input id="editor-name" type="text" placeholder="creature name…" value="Custom Creature" />
        <div class="section-title">Tool</div>
        <div class="segmented">
          <label><input type="radio" name="editor-tool" id="editor-tool-select" value="select" checked /><span>Select</span></label>
          <label><input type="radio" name="editor-tool" id="editor-tool-cell" value="cell" /><span>Fill / Erase</span></label>
          <label><input type="radio" name="editor-tool" id="editor-tool-joint" value="joint" /><span>Joint (line)</span></label>
        </div>
        <p class="hint">Tap a grid cell to fill it (tap again to clear). Adjacent cells fuse into one part. In <b>Joint (line)</b> mode tap the line between two filled cells to hinge them — the joint splits that part in two. Pick <b>Select</b> to tap a part (mark root/feet or delete) or tap a joint and drag the <b>L</b>/<b>U</b> handles to set its limits.</p>
      </div>

      <!-- Selected part (fused component) -->
      <div class="section" id="editor-body-panel" style="display:none;">
        <div class="section-title">Part — <span id="editor-body-title"></span></div>
        <label class="toggle"><span>Root (torso)</span><input id="chk-body-root" type="checkbox" /></label>
        <label class="toggle"><span>Feet (ground sensor)</span><input id="chk-body-foot" type="checkbox" /></label>
        <button id="btn-body-delete" type="button">Delete part</button>
      </div>

      <!-- Selected joint -->
      <div class="section" id="editor-joint-panel" style="display:none;">
        <div class="section-title">Joint — <span id="editor-joint-title"></span></div>
        <div class="row">
          <div class="field">
            <div class="label-row"><label for="editor-joint-lower">Lower °</label></div>
            <input id="editor-joint-lower" type="number" step="5" value="-45" />
          </div>
          <div class="field">
            <div class="label-row"><label for="editor-joint-upper">Upper °</label></div>
            <input id="editor-joint-upper" type="number" step="5" value="45" />
          </div>
        </div>
        <div class="field">
          <div class="label-row">
            <label for="editor-joint-torque">Motor torque</label>
            <span class="val" id="editor-joint-torque-val">80 N·m</span>
          </div>
          <input id="editor-joint-torque" type="range" min="0" max="300" step="5" value="80" />
        </div>
        <label class="toggle"><span>Motorized (driven by the brain)</span><input id="chk-joint-motor" type="checkbox" checked /></label>
        <button id="btn-joint-delete" type="button">Delete joint</button>
      </div>

      <div class="section">
        <div class="row">
          <button id="btn-editor-spawn" type="button">Spawn / Train this</button>
        </div>
        <div class="row">
          <button id="btn-editor-load" type="button">Load example</button>
          <button id="btn-editor-clear" type="button">Clear</button>
        </div>
        <!-- Bring an EXISTING creature into the editor to tweak it. Either start
             from a ready-made preset (the <select>), or pull in the currently
             focused training lane's build ("Edit current"). Both load a COPY so
             the source is never mutated. -->
        <div class="row">
          <select id="select-editor-preset" title="Load a preset into the editor"></select>
          <button id="btn-editor-edit-current" type="button">Edit current</button>
        </div>
      </div>
    `;
    container.appendChild(root);

    // Now that the editor DOM exists, construct the real Editor (its _wireDom
    // binds to these ids) and expose it for main's pointer routing + drawing.
    const editor = new Editor({
      onSpawn: (creature) => {
        const lane = ctx.addLane(creature, { name: creature.name });
        if (lane) {
          ctx.setMode('train'); // jump to the grid to watch it train
          ctx.closeDrawer(); // on mobile, reveal the canvas
        }
      },
      onMessage: (msg, kind) => ctx.setMsg(msg, kind),
    });

    ctx.editor = editor;

    // ---- Load an existing creature INTO the editor -----------------------
    // (a) Preset picker. The first <option> is a non-value header so the
    // control reads like a "Load preset ▾" menu; picking a real entry loads a
    // clone into the editor and then resets back to the header (so the same
    // preset can be picked again to re-load a fresh copy).
    const selectEditorPreset = document.getElementById('select-editor-preset');
    if (selectEditorPreset) {
      const header = document.createElement('option');
      header.value = '';
      header.textContent = 'Load preset ▾';
      selectEditorPreset.appendChild(header);
      for (const preset of PRESETS) {
        const opt = document.createElement('option');
        opt.value = preset.id;
        opt.textContent = `${preset.emoji} ${preset.name}`;
        selectEditorPreset.appendChild(opt);
      }
      selectEditorPreset.addEventListener('change', () => {
        const preset = PRESETS.find((p) => p.id === selectEditorPreset.value);
        selectEditorPreset.value = ''; // snap back to the header
        if (!preset) return;
        // loadCreature messages on its own if the creature lacks editorGrid.
        editor.loadCreature(cloneCreature(preset.make()));
        ctx.setMsg(`Loaded "${preset.name}" into the editor.`);
      });
    }

    // (b) "Edit current" — pull the FOCUSED lane's creature (a copy of it) into
    // the editor. Editing a copy keeps the running lane untouched; the user
    // spawns to train the edited version as a new lane.
    const btnEditCurrent = document.getElementById('btn-editor-edit-current');
    if (btnEditCurrent) {
      btnEditCurrent.addEventListener('click', () => {
        const lane = ctx.lanes.focusedLane();
        if (!lane) {
          ctx.setMsg('No focused lane to edit.', 'err');
          return;
        }
        editor.loadCreature(cloneCreature(lane.creature));
        ctx.setMsg(`Editing "${lane.name}". Spawn to train the edited copy.`);
      });
    }
  },
});
