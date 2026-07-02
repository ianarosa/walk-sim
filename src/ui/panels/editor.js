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
 *   btn-editor-spawn, btn-editor-load, btn-editor-clear.
 */

import { registerPanel } from '../registry.js';
import { Editor } from '../editor.js';

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
  },
});
