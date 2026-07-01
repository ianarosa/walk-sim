/*
 * ui/editor.js — the CREATURE EDITOR: draw a body, hinge it, LIMIT the
 * hinges, then spawn it into a training lane.
 * =====================================================================
 * This is an in-app MODE (toggled from the sidebar). While active it takes
 * over the canvas: the training grid is hidden and the user draws directly.
 *
 * SCREEN <-> METERS (the editor's own fixed mapping, NOT the training camera)
 * -------------------------------------------------------------------------
 * The editor never pans or zooms; it uses a fixed origin + scale so drawing is
 * predictable. For a canvas of {viewW, viewH} CSS pixels:
 *
 *     origin = ( viewW/2 , viewH * editor.groundFrac )   // where world (0,0) is
 *     ppm    = editor.ppm                                // pixels per meter
 *
 *     screen.x = origin.x + world.x * ppm
 *     screen.y = origin.y - world.y * ppm     // y FLIPPED (world y is UP)
 *
 *     world.x  = (screen.x - origin.x) / ppm
 *     world.y  = (origin.y - screen.y) / ppm
 *
 * So world y=0 is a fixed "ground" line ~72% down the canvas, +x is right and
 * +y is up — matching planck. Everything the editor stores is already in the
 * Creature schema's units (METERS, y-UP), so `toCreature()` is a near-direct
 * copy that we then run through `validateCreature`.
 *
 * TOOLS (radio buttons in the sidebar):
 *   select — click a body to select/move it; click a joint's arc handles to
 *            drag its angle limits, or its pivot to move the anchor.
 *   box    — click-drag a rectangle to create a box segment.
 *   circle — click-drag from center outward to create a circle segment.
 *   joint  — click two bodies to hinge them; the pivot defaults to the
 *            midpoint of their centers and is draggable afterwards.
 *
 * Each joint draws its ALLOWED ANGULAR RANGE as an arc (with two draggable
 * limit handles for the selected joint) so the user SEES the movement limits.
 */

import { CONFIG } from '../config.js';
import { validateCreature, defaultBiped } from '../creature.js';

// Normalize an angle to (-PI, PI].
function norm(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a <= -Math.PI) a += 2 * Math.PI;
  return a;
}
const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;

// Default sizes for CLICK-TO-PLACE creation (meters). Kept local to the editor
// so no CONFIG keys are added; the body panel lets the user resize afterwards.
const DEFAULT_BOX = { w: 0.4, h: 0.4 };
const DEFAULT_CIRCLE_R = 0.2;

export class Editor {
  /**
   * @param {object} deps
   * @param {(creature:object)=>void} deps.onSpawn   - "Spawn / Train this"
   * @param {(msg:string, kind?:string)=>void} deps.onMessage - status line
   */
  constructor({ onSpawn, onMessage } = {}) {
    this.onSpawn = onSpawn || (() => {});
    this.onMessage = onMessage || (() => {});

    // --- Model (plain data, already in schema units) ---
    /** @type {Array<object>} bodies: {id,shape,x,y,w,h,r,angle,density,friction,isRoot,isFoot} */
    this.bodies = [];
    /** @type {Array<object>} joints: {id,bodyA,bodyB,anchor:{x,y},lowerAngle,upperAngle,maxMotorTorque,motorized} */
    this.joints = [];
    this._bodyN = 0; // id counters for freshly-drawn parts
    this._jointN = 0;

    // --- Interaction state ---
    this.tool = 'select';
    this.snap = false;
    this.selection = null; // {type:'body'|'joint', id} | null
    this.pendingA = null; // bodyId of first pick while placing a joint
    this.drag = null; // active drag descriptor (see onPointerDown)

    // --- Viewport (set by setViewport on resize) ---
    this.viewW = 1;
    this.viewH = 1;
    this.ppm = CONFIG.editor.ppm;

    this._wireDom();
    this.updatePanel();
  }

  // ---- Coordinate helpers ------------------------------------------------

  setViewport(w, h) {
    this.viewW = w;
    this.viewH = h;
  }
  get originX() {
    return this.viewW / 2;
  }
  get originY() {
    return this.viewH * CONFIG.editor.groundFrac;
  }
  /** world meters (y-up) -> canvas CSS pixels (y-down). */
  m2s(mx, my) {
    return { x: this.originX + mx * this.ppm, y: this.originY - my * this.ppm };
  }
  /** canvas CSS pixels -> world meters. */
  s2m(sx, sy) {
    return { x: (sx - this.originX) / this.ppm, y: (this.originY - sy) / this.ppm };
  }
  _snap(v) {
    if (!this.snap) return v;
    const g = CONFIG.editor.grid;
    return Math.round(v / g) * g;
  }

  // ---- Model queries -----------------------------------------------------

  bodyById(id) {
    return this.bodies.find((b) => b.id === id) || null;
  }
  jointById(id) {
    return this.joints.find((j) => j.id === id) || null;
  }
  selectedBody() {
    return this.selection && this.selection.type === 'body'
      ? this.bodyById(this.selection.id)
      : null;
  }
  selectedJoint() {
    return this.selection && this.selection.type === 'joint'
      ? this.jointById(this.selection.id)
      : null;
  }

  /** topmost body under a world point, or null. */
  _bodyAt(m) {
    for (let i = this.bodies.length - 1; i >= 0; i--) {
      const b = this.bodies[i];
      if (b.shape === 'circle') {
        if (Math.hypot(m.x - b.x, m.y - b.y) <= b.r) return b;
      } else {
        if (Math.abs(m.x - b.x) <= b.w / 2 && Math.abs(m.y - b.y) <= b.h / 2)
          return b;
      }
    }
    return null;
  }

  /** rest direction (radians) of the "arm" a joint's limits are measured from
   * (anchor -> bodyB center). Falls back to +x if bodies missing. */
  _restDir(j) {
    const b = this.bodyById(j.bodyB);
    if (!b) return 0;
    return Math.atan2(b.y - j.anchor.y, b.x - j.anchor.x);
  }
  /** world point on a joint's limit arc at relative angle `a`. */
  _armPoint(j, a) {
    const rd = this._restDir(j);
    const R = CONFIG.editor.handleRadius;
    return { x: j.anchor.x + R * Math.cos(rd + a), y: j.anchor.y + R * Math.sin(rd + a) };
  }

  // ---- Pointer handling --------------------------------------------------
  // Coordinates arrive as canvas CSS pixels (main.js converts from the event).

  onPointerDown(sx, sy) {
    const m = this.s2m(sx, sy);

    if (this.tool === 'box' || this.tool === 'circle') {
      // CLICK-TO-PLACE: a single click drops a default-sized segment at the
      // click point; there is no drag-to-size. The user resizes afterwards via
      // the body panel's width/height/radius inputs.
      this._placeBody(this.tool, m);
      this.updatePanel();
      return;
    }

    if (this.tool === 'joint') {
      const b = this._bodyAt(m);
      if (!b) {
        this.pendingA = null; // clicked empty -> cancel a pending pick
        return;
      }
      if (!this.pendingA) {
        this.pendingA = b.id; // first body
      } else if (this.pendingA !== b.id) {
        this._createJoint(this.pendingA, b.id); // second body -> hinge them
        this.pendingA = null;
      } else {
        this.pendingA = null; // same body twice -> cancel
      }
      this.updatePanel();
      return;
    }

    // --- select tool ---
    // 1) If a joint is selected, prefer its handles/anchor (small targets).
    const j = this.selectedJoint();
    if (j) {
      const pad = CONFIG.editor.hitPad;
      const lo = this.m2s(...Object.values(this._armPoint(j, j.lowerAngle)));
      const hi = this.m2s(...Object.values(this._armPoint(j, j.upperAngle)));
      const an = this.m2s(j.anchor.x, j.anchor.y);
      if (Math.hypot(sx - lo.x, sy - lo.y) <= pad + 4) {
        this.drag = { mode: 'limit', jointId: j.id, which: 'lower' };
        return;
      }
      if (Math.hypot(sx - hi.x, sy - hi.y) <= pad + 4) {
        this.drag = { mode: 'limit', jointId: j.id, which: 'upper' };
        return;
      }
      if (Math.hypot(sx - an.x, sy - an.y) <= pad + 4) {
        this.drag = { mode: 'anchor', jointId: j.id };
        return;
      }
    }

    // 2) Otherwise hit-test a body to select + move it.
    const b = this._bodyAt(m);
    if (b) {
      this.selection = { type: 'body', id: b.id };
      this.drag = {
        mode: 'move',
        bodyId: b.id,
        off: { x: b.x - m.x, y: b.y - m.y },
      };
    } else {
      this.selection = null; // clicked empty space -> deselect
    }
    this.updatePanel();
  }

  onPointerMove(sx, sy) {
    if (!this.drag) return;
    const m = this.s2m(sx, sy);

    if (this.drag.mode === 'move') {
      const b = this.bodyById(this.drag.bodyId);
      if (b) {
        b.x = this._snap(m.x + this.drag.off.x);
        b.y = this._snap(m.y + this.drag.off.y);
      }
      return;
    }
    if (this.drag.mode === 'anchor') {
      const j = this.jointById(this.drag.jointId);
      if (j) {
        j.anchor.x = this._snap(m.x);
        j.anchor.y = this._snap(m.y);
      }
      return;
    }
    if (this.drag.mode === 'limit') {
      const j = this.jointById(this.drag.jointId);
      if (j) {
        const rd = this._restDir(j);
        let a = norm(Math.atan2(m.y - j.anchor.y, m.x - j.anchor.x) - rd);
        if (this.drag.which === 'lower') j.lowerAngle = Math.min(a, j.upperAngle);
        else j.upperAngle = Math.max(a, j.lowerAngle);
        this._syncJointInputs();
      }
      return;
    }
  }

  onPointerUp() {
    this.drag = null;
    this.updatePanel();
  }

  // ---- Model mutations ---------------------------------------------------

  /** _placeBody(shape, m) — CLICK-TO-PLACE a default-sized segment centered at
   *  world point `m`. The user resizes afterwards via the body panel's
   *  width/height/radius inputs. Defaults live here (no config keys added). */
  _placeBody(shape, m) {
    const x = this._snap(m.x);
    const y = this._snap(m.y);
    let body;
    if (shape === 'box') {
      body = {
        id: `b${++this._bodyN}`,
        shape: 'box',
        x,
        y,
        w: DEFAULT_BOX.w, // 0.4m
        h: DEFAULT_BOX.h, // 0.4m
        angle: 0,
        density: 1,
        friction: 0.6,
      };
    } else {
      body = {
        id: `b${++this._bodyN}`,
        shape: 'circle',
        x,
        y,
        r: DEFAULT_CIRCLE_R, // 0.2m
        angle: 0,
        density: 1,
        friction: 0.6,
      };
    }
    // First body placed becomes the ROOT (torso) automatically.
    if (!this.bodies.some((b) => b.isRoot)) body.isRoot = true;
    this.bodies.push(body);
    // Select it so the body panel opens for immediate tweaking.
    this.selection = { type: 'body', id: body.id };
  }

  _createJoint(bodyAId, bodyBId) {
    const a = this.bodyById(bodyAId);
    const b = this.bodyById(bodyBId);
    if (!a || !b) return;
    // Default the pivot to the midpoint of the two body centers.
    const j = {
      id: `j${++this._jointN}`,
      bodyA: bodyAId,
      bodyB: bodyBId,
      anchor: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      lowerAngle: -0.8,
      upperAngle: 0.8,
      maxMotorTorque: CONFIG.editor.defaultTorque,
      motorized: true,
    };
    this.joints.push(j);
    this.selection = { type: 'joint', id: j.id };
  }

  _deleteBody(id) {
    this.bodies = this.bodies.filter((b) => b.id !== id);
    // Drop any joints that referenced it.
    this.joints = this.joints.filter((j) => j.bodyA !== id && j.bodyB !== id);
    if (this.selection && this.selection.id === id) this.selection = null;
  }

  _deleteJoint(id) {
    this.joints = this.joints.filter((j) => j.id !== id);
    if (this.selection && this.selection.id === id) this.selection = null;
  }

  clear() {
    this.bodies = [];
    this.joints = [];
    this.selection = null;
    this.pendingA = null;
    this._bodyN = 0;
    this._jointN = 0;
    this.updatePanel();
    this.onMessage('Editor cleared.');
  }

  /** loadCreature(c) — populate the editor from an existing creature so it can
   *  be tweaked and re-spawned. Copies fields defensively. */
  loadCreature(c) {
    this.bodies = c.bodies.map((b) => ({
      id: b.id,
      shape: b.shape,
      x: b.x,
      y: b.y,
      w: b.w,
      h: b.h,
      r: b.r,
      angle: b.angle || 0,
      density: b.density != null ? b.density : 1,
      friction: b.friction != null ? b.friction : 0.6,
      isRoot: !!b.isRoot,
      isFoot: !!b.isFoot,
    }));
    this.joints = c.joints.map((j) => ({
      id: j.id,
      bodyA: j.bodyA,
      bodyB: j.bodyB,
      anchor: { x: j.anchor.x, y: j.anchor.y },
      lowerAngle: j.lowerAngle,
      upperAngle: j.upperAngle,
      maxMotorTorque: j.maxMotorTorque,
      motorized: j.motorized !== false,
    }));
    // Advance counters so new parts don't collide with loaded ids.
    this._bodyN = this.bodies.length;
    this._jointN = this.joints.length;
    this.selection = null;
    this.pendingA = null;
    if (this._nameInput) this._nameInput.value = c.name || 'Custom Creature';
    this.updatePanel();
    this.onMessage(`Loaded "${c.name || 'creature'}" into the editor.`);
  }

  /** toCreature() — assemble + validate a Creature from the editor model.
   *  Throws (with a friendly message) if the structure is invalid. */
  toCreature() {
    const name = (this._nameInput && this._nameInput.value.trim()) || 'Custom Creature';
    const creature = {
      name,
      bodies: this.bodies.map((b) => {
        const out = {
          id: b.id,
          shape: b.shape,
          x: b.x,
          y: b.y,
          angle: b.angle || 0,
          density: b.density,
          friction: b.friction,
        };
        if (b.shape === 'box') {
          out.w = b.w;
          out.h = b.h;
        } else {
          out.r = b.r;
        }
        if (b.isRoot) out.isRoot = true;
        if (b.isFoot) out.isFoot = true;
        return out;
      }),
      joints: this.joints.map((j) => ({
        id: j.id,
        bodyA: j.bodyA,
        bodyB: j.bodyB,
        anchor: { x: j.anchor.x, y: j.anchor.y },
        lowerAngle: j.lowerAngle,
        upperAngle: j.upperAngle,
        maxMotorTorque: j.maxMotorTorque,
        motorized: j.motorized !== false,
      })),
    };
    return validateCreature(creature);
  }

  // ---- DOM panel ---------------------------------------------------------

  _wireDom() {
    // Tool radios (name="editor-tool").
    this._toolRadios = Array.from(
      document.querySelectorAll('input[name="editor-tool"]')
    );
    for (const r of this._toolRadios) {
      r.addEventListener('change', () => {
        if (r.checked) {
          this.tool = r.value;
          this.pendingA = null;
          this.updatePanel();
        }
      });
    }

    this._snapChk = document.getElementById('chk-snap');
    if (this._snapChk)
      this._snapChk.addEventListener('change', () => {
        this.snap = !!this._snapChk.checked;
      });

    this._nameInput = document.getElementById('editor-name');

    // Selected-body panel.
    this._bodyPanel = document.getElementById('editor-body-panel');
    this._bodyTitle = document.getElementById('editor-body-title');
    this._chkRoot = document.getElementById('chk-body-root');
    this._chkFoot = document.getElementById('chk-body-foot');
    this._btnBodyDel = document.getElementById('btn-body-delete');

    // Size controls (resize a placed segment). Box uses w/h, circle uses r;
    // updatePanel() shows exactly one of these two rows for the selection.
    this._sizeBoxRow = document.getElementById('editor-body-size-box');
    this._sizeCircleRow = document.getElementById('editor-body-size-circle');
    this._inBodyW = document.getElementById('editor-body-w');
    this._inBodyH = document.getElementById('editor-body-h');
    this._inBodyR = document.getElementById('editor-body-r');
    const clampSize = (v) => Math.max(CONFIG.editor.minSize, Number(v) || 0);
    if (this._inBodyW)
      this._inBodyW.addEventListener('input', () => {
        const b = this.selectedBody();
        if (b && b.shape === 'box') b.w = clampSize(this._inBodyW.value);
      });
    if (this._inBodyH)
      this._inBodyH.addEventListener('input', () => {
        const b = this.selectedBody();
        if (b && b.shape === 'box') b.h = clampSize(this._inBodyH.value);
      });
    if (this._inBodyR)
      this._inBodyR.addEventListener('input', () => {
        const b = this.selectedBody();
        if (b && b.shape === 'circle') b.r = clampSize(this._inBodyR.value);
      });
    if (this._chkRoot)
      this._chkRoot.addEventListener('change', () => {
        const b = this.selectedBody();
        if (!b) return;
        if (this._chkRoot.checked) {
          // Exactly one root: clear it on every other body.
          for (const o of this.bodies) o.isRoot = false;
          b.isRoot = true;
        } else {
          b.isRoot = false;
        }
      });
    if (this._chkFoot)
      this._chkFoot.addEventListener('change', () => {
        const b = this.selectedBody();
        if (b) b.isFoot = !!this._chkFoot.checked;
      });
    if (this._btnBodyDel)
      this._btnBodyDel.addEventListener('click', () => {
        const b = this.selectedBody();
        if (b) this._deleteBody(b.id);
        this.updatePanel();
      });

    // Selected-joint panel.
    this._jointPanel = document.getElementById('editor-joint-panel');
    this._jointTitle = document.getElementById('editor-joint-title');
    this._inLower = document.getElementById('editor-joint-lower');
    this._inUpper = document.getElementById('editor-joint-upper');
    this._inTorque = document.getElementById('editor-joint-torque');
    this._valTorque = document.getElementById('editor-joint-torque-val');
    this._chkMotor = document.getElementById('chk-joint-motor');
    this._btnJointDel = document.getElementById('btn-joint-delete');
    const readAngles = () => {
      const j = this.selectedJoint();
      if (!j) return;
      let lo = (Number(this._inLower.value) || 0) * RAD;
      let hi = (Number(this._inUpper.value) || 0) * RAD;
      // Clamp to a sane range and keep lower <= upper.
      lo = Math.max(-Math.PI, Math.min(Math.PI, lo));
      hi = Math.max(-Math.PI, Math.min(Math.PI, hi));
      if (hi < lo) hi = lo;
      j.lowerAngle = lo;
      j.upperAngle = hi;
    };
    if (this._inLower) this._inLower.addEventListener('input', readAngles);
    if (this._inUpper) this._inUpper.addEventListener('input', readAngles);
    if (this._inTorque)
      this._inTorque.addEventListener('input', () => {
        const j = this.selectedJoint();
        if (j) j.maxMotorTorque = Number(this._inTorque.value) || 0;
        if (this._valTorque)
          this._valTorque.textContent = `${this._inTorque.value} N·m`;
      });
    if (this._chkMotor)
      this._chkMotor.addEventListener('change', () => {
        const j = this.selectedJoint();
        if (j) j.motorized = !!this._chkMotor.checked;
      });
    if (this._btnJointDel)
      this._btnJointDel.addEventListener('click', () => {
        const j = this.selectedJoint();
        if (j) this._deleteJoint(j.id);
        this.updatePanel();
      });

    // Action buttons.
    const spawn = document.getElementById('btn-editor-spawn');
    if (spawn)
      spawn.addEventListener('click', () => {
        try {
          const c = this.toCreature();
          this.onSpawn(c);
          this.onMessage(`Spawned "${c.name}" into a lane.`, 'ok');
        } catch (e) {
          this.onMessage(`Can't spawn: ${e.message || e}`, 'err');
        }
      });
    const clr = document.getElementById('btn-editor-clear');
    if (clr) clr.addEventListener('click', () => this.clear());
    const loadDef = document.getElementById('btn-editor-load');
    if (loadDef)
      loadDef.addEventListener('click', () => this.loadCreature(defaultBiped()));
  }

  _syncJointInputs() {
    const j = this.selectedJoint();
    if (!j) return;
    if (this._inLower) this._inLower.value = (j.lowerAngle * DEG).toFixed(0);
    if (this._inUpper) this._inUpper.value = (j.upperAngle * DEG).toFixed(0);
  }

  /** updatePanel() — show/hide the body & joint subpanels and mirror the
   *  selected part's values into their inputs. Called on any selection or
   *  tool change. */
  updatePanel() {
    // Reflect the current tool onto the radios (e.g. after programmatic set).
    for (const r of this._toolRadios || [])
      r.checked = r.value === this.tool;

    const b = this.selectedBody();
    const j = this.selectedJoint();
    if (this._bodyPanel) this._bodyPanel.style.display = b ? '' : 'none';
    if (this._jointPanel) this._jointPanel.style.display = j ? '' : 'none';

    if (b) {
      if (this._bodyTitle)
        this._bodyTitle.textContent = `${b.id} (${b.shape})`;
      if (this._chkRoot) this._chkRoot.checked = !!b.isRoot;
      if (this._chkFoot) this._chkFoot.checked = !!b.isFoot;
      // Show the size row matching the shape and mirror current dimensions.
      const isBox = b.shape === 'box';
      if (this._sizeBoxRow) this._sizeBoxRow.style.display = isBox ? '' : 'none';
      if (this._sizeCircleRow)
        this._sizeCircleRow.style.display = isBox ? 'none' : '';
      if (isBox) {
        if (this._inBodyW) this._inBodyW.value = String(b.w);
        if (this._inBodyH) this._inBodyH.value = String(b.h);
      } else if (this._inBodyR) {
        this._inBodyR.value = String(b.r);
      }
    }
    if (j) {
      if (this._jointTitle)
        this._jointTitle.textContent = `${j.id}: ${j.bodyA} ↔ ${j.bodyB}`;
      if (this._inLower) this._inLower.value = (j.lowerAngle * DEG).toFixed(0);
      if (this._inUpper) this._inUpper.value = (j.upperAngle * DEG).toFixed(0);
      if (this._inTorque) this._inTorque.value = String(j.maxMotorTorque);
      if (this._valTorque)
        this._valTorque.textContent = `${Math.round(j.maxMotorTorque)} N·m`;
      if (this._chkMotor) this._chkMotor.checked = j.motorized !== false;
    }
  }

  // ---- Drawing -----------------------------------------------------------

  /** draw(ctx) — paint the whole editor scene onto the (full) canvas. The
   *  canvas is transparent over the page's gradient sky (main clears it), so
   *  we only paint the frosted grid, ground and creature. */
  draw(ctx) {
    ctx.save();
    this._drawGrid(ctx);
    this._drawGroundLine(ctx);

    // Bodies.
    for (const b of this.bodies) this._drawBody(ctx, b);

    // Joints: every joint shows its limit arc so all limits are always visible.
    for (const j of this.joints) this._drawJoint(ctx, j, j.id === (this.selection && this.selection.id));

    // Pending-joint hint: ring the first-picked body.
    if (this.pendingA) {
      const b = this.bodyById(this.pendingA);
      if (b) {
        const s = this.m2s(b.x, b.y);
        ctx.strokeStyle = CONFIG.theme.accent;
        ctx.setLineDash([5, 4]);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(s.x, s.y, 22, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    ctx.restore();
  }

  _drawGrid(ctx) {
    const g = CONFIG.editor.grid * this.ppm;
    if (g < 6) return; // too dense to be useful
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = this.originX % g; x < this.viewW; x += g) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, this.viewH);
    }
    for (let y = this.originY % g; y < this.viewH; y += g) {
      ctx.moveTo(0, y);
      ctx.lineTo(this.viewW, y);
    }
    ctx.stroke();
  }

  _drawGroundLine(ctx) {
    const T = CONFIG.theme;
    const y = this.originY;
    const grad = ctx.createLinearGradient(0, y, 0, this.viewH);
    grad.addColorStop(0, T.groundBand);
    grad.addColorStop(1, 'rgba(255,255,255,0.02)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, y, this.viewW, this.viewH - y);
    ctx.strokeStyle = T.groundEdge;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(this.viewW, y);
    ctx.stroke();
  }

  _bodyColor(b) {
    const T = CONFIG.theme;
    if (b.isRoot) return T.root;
    if (b.isFoot) return T.foot;
    return T.limb;
  }

  _drawBody(ctx, b) {
    const T = CONFIG.theme;
    const selected = this.selection && this.selection.type === 'body' && this.selection.id === b.id;
    ctx.save();
    ctx.shadowColor = T.shadow;
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 3;
    ctx.fillStyle = this._bodyColor(b);
    if (b.shape === 'circle') {
      const c = this.m2s(b.x, b.y);
      const rpx = b.r * this.ppm;
      ctx.beginPath();
      ctx.arc(c.x, c.y, rpx, 0, Math.PI * 2);
      ctx.fill();
    } else {
      const w = b.w * this.ppm;
      const h = b.h * this.ppm;
      const c = this.m2s(b.x, b.y);
      const rad = Math.min(w, h) * T.bodyRadiusFrac;
      this._roundRect(ctx, c.x - w / 2, c.y - h / 2, w, h, rad);
      ctx.fill();
    }
    // Stroke without shadow so the outline stays crisp.
    ctx.shadowColor = 'transparent';
    ctx.strokeStyle = selected ? '#ffffff' : T.outline;
    ctx.lineWidth = selected ? 2.5 : 1.5;
    ctx.stroke();
    ctx.restore();
  }

  _roundRect(ctx, x, y, w, h, r) {
    const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, rr);
      return;
    }
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  /** Draw a joint's pivot + its allowed angular range as a filled arc, with
   *  draggable limit handles + a rest-arm line when it's the selected joint. */
  _drawJoint(ctx, j, selected) {
    const an = this.m2s(j.anchor.x, j.anchor.y);
    const R = CONFIG.editor.handleRadius;
    const rd = this._restDir(j);

    // Filled sector between lower and upper (sampled in meters so the y-flip
    // is handled by m2s — no manual angle inversion needed).
    ctx.beginPath();
    ctx.moveTo(an.x, an.y);
    const steps = 24;
    for (let i = 0; i <= steps; i++) {
      const a = j.lowerAngle + (j.upperAngle - j.lowerAngle) * (i / steps);
      const p = this.m2s(
        j.anchor.x + R * Math.cos(rd + a),
        j.anchor.y + R * Math.sin(rd + a)
      );
      ctx.lineTo(p.x, p.y);
    }
    ctx.closePath();
    ctx.fillStyle = selected ? 'rgba(124,196,255,0.22)' : 'rgba(124,196,255,0.10)';
    ctx.fill();
    ctx.strokeStyle = selected ? 'rgba(124,196,255,0.8)' : 'rgba(124,196,255,0.35)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Pivot dot.
    ctx.fillStyle = CONFIG.theme.joint;
    ctx.beginPath();
    ctx.arc(an.x, an.y, selected ? 5 : 3, 0, Math.PI * 2);
    ctx.fill();

    if (selected) {
      // Rest arm (the "0" the limits are measured from).
      const rest = this.m2s(j.anchor.x + R * Math.cos(rd), j.anchor.y + R * Math.sin(rd));
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(an.x, an.y);
      ctx.lineTo(rest.x, rest.y);
      ctx.stroke();

      // Two draggable limit handles.
      const drawHandle = (a, label) => {
        const p = this.m2s(
          j.anchor.x + R * Math.cos(rd + a),
          j.anchor.y + R * Math.sin(rd + a)
        );
        ctx.beginPath();
        ctx.moveTo(an.x, an.y);
        ctx.lineTo(p.x, p.y);
        ctx.strokeStyle = '#7cc4ff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.fillStyle = '#7cc4ff';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#05070c';
        ctx.font = '700 9px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, p.x, p.y);
        ctx.textAlign = 'start';
      };
      drawHandle(j.lowerAngle, 'L');
      drawHandle(j.upperAngle, 'U');
    }
  }
}

export default Editor;
