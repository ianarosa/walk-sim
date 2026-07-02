/*
 * ui/editor.js — the CREATURE EDITOR, now a GRID / TILE model.
 * ===========================================================
 * You build creatures on a square grid instead of free-drawing boxes:
 *
 *   • Tap an EMPTY cell to fill it with a unit box; tap a FILLED cell to clear
 *     it. Binary per cell, so overlaps are impossible.
 *   • Adjacent filled cells FUSE into ONE rigid body, drawn as a single merged
 *     shape with no internal seams ("two boxes become one rectangle").
 *   • JOINTS live on the grid LINES — the shared edge between two adjacent
 *     filled cells. Tap a line to place a joint; tap again to remove it. A
 *     joint BREAKS the fusion across that edge, so the two sides become
 *     separate parts that pivot at the line (anchor = edge midpoint).
 *
 * CONNECTED-COMPONENTS RULE
 * -------------------------
 * Two 4-adjacent filled cells are connected UNLESS a joint sits on their shared
 * edge. Each connected component becomes ONE planck body (a compound of box
 * fixtures at the cell centers). For each joint edge we add a revolute joint
 * between the component on either side, anchored at the edge midpoint. If a
 * jointed edge's two cells end up in the SAME component (a loop reconnects them
 * elsewhere), that joint is skipped with a friendly warning.
 *
 * SELECTION / FLAGS
 * -----------------
 *   Select tool: tap a cell to select its whole COMPONENT (mark ROOT — exactly
 *   one — or FEET, or delete it). Tap a joint marker to select it and edit its
 *   limits (drag-handle arc + numeric degrees), maxMotorTorque and motorized.
 *
 * SCREEN <-> METERS (fixed; the editor never pans/zooms)
 * ------------------------------------------------------
 *     origin = ( viewW/2 , viewH * editor.groundFrac )   // world (0,0)
 *     ppm    = editor.ppm
 *     screen.x = origin.x + world.x * ppm
 *     screen.y = origin.y - world.y * ppm                 // y FLIPPED (world up)
 * A cell (cx,cy) has its CENTER at world { x: cx*cellSize, y: (cy+0.5)*cellSize }
 * so the bottom row (cy=0) rests on the ground line (world y=0).
 */

import { CONFIG } from '../config.js';
import { validateCreature } from '../creature.js';

// Normalize an angle to (-PI, PI].
function norm(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a <= -Math.PI) a += 2 * Math.PI;
  return a;
}
const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;

// Default cell size (meters). Local so no CONFIG keys are added; a loaded grid
// creature may override via its editorGrid.cellSize.
const DEFAULT_CELL = 0.34;

const cellKey = (cx, cy) => `${cx},${cy}`;
const parseKey = (k) => k.split(',').map(Number);

export class Editor {
  /**
   * @param {object} deps
   * @param {(creature:object)=>void} deps.onSpawn   - "Spawn / Train this"
   * @param {(msg:string, kind?:string)=>void} deps.onMessage - status line
   */
  constructor({ onSpawn, onMessage } = {}) {
    this.onSpawn = onSpawn || (() => {});
    this.onMessage = onMessage || (() => {});

    // --- Grid model ---
    this.cellSize = DEFAULT_CELL;
    this.cells = new Set(); // Set<cellKey> of filled cells
    /** @type {Array<{a:number[],b:number[],lowerAngle:number,upperAngle:number,maxMotorTorque:number,motorized:boolean,id:string}>} */
    this.gridJoints = []; // joints on shared edges (a,b canonical cell pairs)
    this.rootMarker = null; // cellKey whose component is the ROOT (exactly one)
    this.footMarkers = new Set(); // cellKeys whose components are FEET
    this._jointN = 0;

    // --- Interaction ---
    this.tool = 'select'; // 'select' | 'cell' | 'joint'
    this.sel = null; // {type:'component', cell} | {type:'joint', id} | null
    this.drag = null; // active limit-handle drag

    // --- Viewport ---
    this.viewW = 1;
    this.viewH = 1;
    this.ppm = CONFIG.editor.ppm;

    // Fingers are imprecise: widen hit targets on coarse (touch) pointers.
    this._coarse =
      typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(pointer: coarse)').matches;

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
  m2s(mx, my) {
    return { x: this.originX + mx * this.ppm, y: this.originY - my * this.ppm };
  }
  s2m(sx, sy) {
    return { x: (sx - this.originX) / this.ppm, y: (this.originY - sy) / this.ppm };
  }
  _cellCenter(cx, cy) {
    return { x: cx * this.cellSize, y: (cy + 0.5) * this.cellSize };
  }
  _worldToCell(m) {
    return {
      cx: Math.round(m.x / this.cellSize),
      cy: Math.round(m.y / this.cellSize - 0.5),
    };
  }

  // ---- Grid graph --------------------------------------------------------

  /** Canonical (a,b) cell pair (sorted) for an edge between two cells. */
  _canon(c1, c2) {
    if (c1[0] < c2[0] || (c1[0] === c2[0] && c1[1] < c2[1])) return [c1, c2];
    return [c2, c1];
  }
  _sameEdge(j, x1, y1, x2, y2) {
    const [ax, ay] = j.a;
    const [bx, by] = j.b;
    return (
      (ax === x1 && ay === y1 && bx === x2 && by === y2) ||
      (ax === x2 && ay === y2 && bx === x1 && by === y1)
    );
  }
  _jointOnEdge(x1, y1, x2, y2) {
    return this.gridJoints.some((j) => this._sameEdge(j, x1, y1, x2, y2));
  }
  _jointForEdge(x1, y1, x2, y2) {
    return this.gridJoints.find((j) => this._sameEdge(j, x1, y1, x2, y2)) || null;
  }

  /** BFS the component of a cell, NOT crossing edges that carry a joint. */
  _componentOf(startKey) {
    if (!this.cells.has(startKey)) return [];
    const seen = new Set([startKey]);
    const out = [];
    const stack = [startKey];
    while (stack.length) {
      const cur = stack.pop();
      out.push(cur);
      const [cx, cy] = parseKey(cur);
      for (const [nx, ny] of [
        [cx + 1, cy],
        [cx - 1, cy],
        [cx, cy + 1],
        [cx, cy - 1],
      ]) {
        const nk = cellKey(nx, ny);
        if (!this.cells.has(nk) || seen.has(nk)) continue;
        if (this._jointOnEdge(cx, cy, nx, ny)) continue; // joint breaks fusion
        seen.add(nk);
        stack.push(nk);
      }
    }
    return out;
  }

  /** Partition all filled cells into components. Returns {comps, compOf}. */
  _components() {
    const comps = [];
    const compOf = new Map();
    const seen = new Set();
    for (const k of this.cells) {
      if (seen.has(k)) continue;
      const cells = this._componentOf(k);
      const idx = comps.length;
      comps.push({ cells });
      for (const c of cells) {
        seen.add(c);
        compOf.set(c, idx);
      }
    }
    return { comps, compOf };
  }

  // ---- Joint geometry (anchor derived from the grid edge) ----------------

  _jointAnchor(j) {
    const a = this._cellCenter(j.a[0], j.a[1]);
    const b = this._cellCenter(j.b[0], j.b[1]);
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }
  /** Rest direction the limits are measured from: anchor -> b-cell center. */
  _restDir(j) {
    const an = this._jointAnchor(j);
    const b = this._cellCenter(j.b[0], j.b[1]);
    return Math.atan2(b.y - an.y, b.x - an.x);
  }
  _armPoint(j, a) {
    const an = this._jointAnchor(j);
    const rd = this._restDir(j);
    const R = CONFIG.editor.handleRadius;
    return { x: an.x + R * Math.cos(rd + a), y: an.y + R * Math.sin(rd + a) };
  }

  selectedJoint() {
    if (!this.sel || this.sel.type !== 'joint') return null;
    return this.gridJoints.find((j) => j.id === this.sel.id) || null;
  }
  selectedComponent() {
    if (!this.sel || this.sel.type !== 'component') return null;
    if (!this.cells.has(this.sel.cell)) return null;
    return this._componentOf(this.sel.cell);
  }

  // ---- Pointer handling --------------------------------------------------

  onPointerDown(sx, sy) {
    const m = this.s2m(sx, sy);

    if (this.tool === 'cell') {
      this._toggleCell(this._worldToCell(m));
      this.updatePanel();
      return;
    }
    if (this.tool === 'joint') {
      this._toggleJointAt(m);
      this.updatePanel();
      return;
    }

    // --- select tool ---
    // 1) If a joint is selected, its limit handles win (small targets).
    const j = this.selectedJoint();
    if (j) {
      const pad = (this._coarse ? 18 : CONFIG.editor.hitPad) + 4;
      const lo = this._armPoint(j, j.lowerAngle);
      const hi = this._armPoint(j, j.upperAngle);
      const los = this.m2s(lo.x, lo.y);
      const his = this.m2s(hi.x, hi.y);
      if (Math.hypot(sx - los.x, sy - los.y) <= pad) {
        this.drag = { mode: 'limit', jointId: j.id, which: 'lower' };
        return;
      }
      if (Math.hypot(sx - his.x, sy - his.y) <= pad) {
        this.drag = { mode: 'limit', jointId: j.id, which: 'upper' };
        return;
      }
    }

    // 2) Tap a joint marker to select it.
    const hitJoint = this._jointNear(sx, sy);
    if (hitJoint) {
      this.sel = { type: 'joint', id: hitJoint.id };
      this.updatePanel();
      return;
    }

    // 3) Tap a filled cell to select its component; empty space deselects.
    const { cx, cy } = this._worldToCell(m);
    const k = cellKey(cx, cy);
    if (this.cells.has(k)) this.sel = { type: 'component', cell: k };
    else this.sel = null;
    this.updatePanel();
  }

  onPointerMove(sx, sy) {
    if (!this.drag || this.drag.mode !== 'limit') return;
    const j = this.selectedJoint();
    if (!j) return;
    const m = this.s2m(sx, sy);
    const an = this._jointAnchor(j);
    const rd = this._restDir(j);
    const a = norm(Math.atan2(m.y - an.y, m.x - an.x) - rd);
    if (this.drag.which === 'lower') j.lowerAngle = Math.min(a, j.upperAngle);
    else j.upperAngle = Math.max(a, j.lowerAngle);
    this._syncJointInputs();
  }

  onPointerUp() {
    this.drag = null;
    this.updatePanel();
  }

  /** Which joint marker (if any) is under a canvas point. */
  _jointNear(sx, sy) {
    const pad = this._coarse ? 22 : 12;
    for (const j of this.gridJoints) {
      const an = this._jointAnchor(j);
      const s = this.m2s(an.x, an.y);
      if (Math.hypot(sx - s.x, sy - s.y) <= pad) return j;
    }
    return null;
  }

  // ---- Grid mutations ----------------------------------------------------

  _toggleCell({ cx, cy }) {
    const k = cellKey(cx, cy);
    if (this.cells.has(k)) {
      // Clear: drop the cell, any joints touching it, and its flags.
      this.cells.delete(k);
      this.footMarkers.delete(k);
      if (this.rootMarker === k) this.rootMarker = null;
      this.gridJoints = this.gridJoints.filter(
        (j) => cellKey(...j.a) !== k && cellKey(...j.b) !== k
      );
      if (this.sel && this.sel.type === 'component') this.sel = null;
    } else {
      this.cells.add(k);
      this.sel = { type: 'component', cell: k };
    }
  }

  /** Place/remove a joint on the grid line nearest the pointer (world m). */
  _toggleJointAt(m) {
    const cs = this.cellSize;
    const fx = m.x / cs; // cell-x units (centers at integers)
    const fy = m.y / cs - 0.5; // cell-y units (centers at integers)
    // Nearest vertical line separates cx=kx and kx+1; nearest horizontal line
    // separates cy=ky and ky+1.
    const kx = Math.round(fx - 0.5);
    const ky = Math.round(fy - 0.5);
    const cyV = Math.round(fy);
    const cxH = Math.round(fx);
    const dV = Math.abs(fx - (kx + 0.5)); // distance to that vertical line
    const dH = Math.abs(fy - (ky + 0.5)); // distance to that horizontal line

    const vertical = { a: [kx, cyV], b: [kx + 1, cyV], d: dV };
    const horizontal = { a: [cxH, ky], b: [cxH, ky + 1], d: dH };
    const ordered = dV <= dH ? [vertical, horizontal] : [horizontal, vertical];

    let edge = null;
    for (const cand of ordered) {
      if (this.cells.has(cellKey(...cand.a)) && this.cells.has(cellKey(...cand.b))) {
        edge = cand;
        break;
      }
    }
    if (!edge) {
      this.onMessage('Tap a line between two filled cells to hinge them.', 'err');
      return;
    }
    const [a, b] = this._canon(edge.a, edge.b);
    const existing = this._jointForEdge(a[0], a[1], b[0], b[1]);
    if (existing) {
      this.gridJoints = this.gridJoints.filter((j) => j !== existing);
      if (this.sel && this.sel.type === 'joint' && this.sel.id === existing.id)
        this.sel = null;
    } else {
      const j = {
        id: `j${++this._jointN}`,
        a,
        b,
        lowerAngle: -0.8,
        upperAngle: 0.8,
        maxMotorTorque: CONFIG.editor.defaultTorque,
        motorized: true,
      };
      this.gridJoints.push(j);
      this.sel = { type: 'joint', id: j.id };
    }
  }

  clear() {
    this.cells.clear();
    this.gridJoints = [];
    this.footMarkers.clear();
    this.rootMarker = null;
    this.sel = null;
    this._jointN = 0;
    this.updatePanel();
    this.onMessage('Editor cleared.');
  }

  // ---- Load / export -----------------------------------------------------

  /** Build a small grid biped example (used by the "Load example" button). */
  loadExample() {
    this.cellSize = DEFAULT_CELL;
    this.cells = new Set([
      cellKey(0, 3), // torso top
      cellKey(-1, 2), cellKey(0, 2), cellKey(1, 2), // shoulders/torso row
      cellKey(-1, 1), cellKey(1, 1), // thighs
      cellKey(-1, 0), cellKey(1, 0), // feet
    ]);
    this._jointN = 0;
    const mk = (a, b, lo, hi, tq) => ({
      id: `j${++this._jointN}`,
      a,
      b,
      lowerAngle: lo,
      upperAngle: hi,
      maxMotorTorque: tq,
      motorized: true,
    });
    this.gridJoints = [
      mk([-1, 1], [-1, 2], -1.0, 1.0, 100), // left hip
      mk([1, 1], [1, 2], -1.0, 1.0, 100), // right hip
      mk([-1, 0], [-1, 1], -1.6, 0.2, 70), // left knee
      mk([1, 0], [1, 1], -1.6, 0.2, 70), // right knee
    ];
    this.rootMarker = cellKey(0, 3);
    this.footMarkers = new Set([cellKey(-1, 0), cellKey(1, 0)]);
    this.sel = null;
    if (this._nameInput) this._nameInput.value = 'Grid Biped';
    this.updatePanel();
    this.onMessage('Loaded a grid biped example.');
  }

  /** loadCreature(c) — reconstruct the grid model from editorGrid metadata.
   *  Legacy creatures (no editorGrid) can't be edited on the grid. */
  loadCreature(c) {
    const g = c && c.editorGrid;
    if (!g || !Array.isArray(g.cells)) {
      this.onMessage(
        `"${(c && c.name) || 'creature'}" wasn't built on the grid — can't edit it here.`,
        'err'
      );
      return false;
    }
    this.cellSize = g.cellSize || DEFAULT_CELL;
    this.cells = new Set(g.cells.map(([cx, cy]) => cellKey(cx, cy)));
    this._jointN = 0;
    this.gridJoints = (g.joints || []).map((j) => ({
      id: `j${++this._jointN}`,
      a: [j.a[0], j.a[1]],
      b: [j.b[0], j.b[1]],
      lowerAngle: j.lowerAngle,
      upperAngle: j.upperAngle,
      maxMotorTorque: j.maxMotorTorque,
      motorized: j.motorized !== false,
    }));
    this.rootMarker =
      Array.isArray(g.roots) && g.roots.length
        ? cellKey(g.roots[0][0], g.roots[0][1])
        : null;
    this.footMarkers = new Set((g.feet || []).map(([cx, cy]) => cellKey(cx, cy)));
    this.sel = null;
    if (this._nameInput) this._nameInput.value = c.name || 'Custom Creature';
    this.updatePanel();
    this.onMessage(`Loaded "${c.name || 'creature'}" into the editor.`);
    return true;
  }

  _editorGrid() {
    return {
      cellSize: this.cellSize,
      cells: [...this.cells].map(parseKey),
      joints: this.gridJoints.map((j) => ({
        a: [j.a[0], j.a[1]],
        b: [j.b[0], j.b[1]],
        lowerAngle: j.lowerAngle,
        upperAngle: j.upperAngle,
        maxMotorTorque: j.maxMotorTorque,
        motorized: j.motorized !== false,
      })),
      roots: this.rootMarker ? [parseKey(this.rootMarker)] : [],
      feet: [...this.footMarkers].map(parseKey),
    };
  }

  /** toCreature() — run connected-components + joints and emit the new schema
   *  (compound-fixture bodies + editorGrid). Throws (friendly) if invalid. */
  toCreature() {
    if (this.cells.size === 0)
      throw new Error('draw at least one cell first');

    const name =
      (this._nameInput && this._nameInput.value.trim()) || 'Custom Creature';
    const { comps, compOf } = this._components();
    const cs = this.cellSize;

    // One rigid body per component; fixtures at each cell center (offset from
    // the component centroid, which becomes the body origin).
    const bodies = comps.map((comp, i) => {
      const centers = comp.cells.map((k) => {
        const [cx, cy] = parseKey(k);
        return this._cellCenter(cx, cy);
      });
      const ox = centers.reduce((s, p) => s + p.x, 0) / centers.length;
      const oy = centers.reduce((s, p) => s + p.y, 0) / centers.length;
      const fixtures = centers.map((p) => ({
        shape: 'box',
        dx: p.x - ox,
        dy: p.y - oy,
        w: cs,
        h: cs,
      }));
      return { id: `c${i}`, x: ox, y: oy, angle: 0, density: 1, friction: 0.6, fixtures };
    });

    // Root: the component holding the root marker, else the largest part.
    let rootIdx =
      this.rootMarker != null && compOf.has(this.rootMarker)
        ? compOf.get(this.rootMarker)
        : -1;
    let warn = null;
    if (rootIdx < 0) {
      rootIdx = comps.reduce(
        (best, c, i, arr) => (c.cells.length > arr[best].cells.length ? i : best),
        0
      );
      warn = 'no root marked — used the largest part as root';
    }
    bodies[rootIdx].isRoot = true;

    // Feet: any component containing a foot marker.
    for (let i = 0; i < comps.length; i++) {
      if (comps[i].cells.some((k) => this.footMarkers.has(k))) bodies[i].isFoot = true;
    }

    // Joints: one revolute per joint edge whose two cells are in DIFFERENT
    // components. Same-component edges (a loop reconnects them) are skipped.
    const joints = [];
    let skipped = 0;
    for (const gj of this.gridJoints) {
      const ka = cellKey(...gj.a);
      const kb = cellKey(...gj.b);
      if (!this.cells.has(ka) || !this.cells.has(kb)) continue;
      const ia = compOf.get(ka);
      const ib = compOf.get(kb);
      if (ia === ib) {
        skipped += 1;
        continue;
      }
      const an = this._jointAnchor(gj);
      joints.push({
        id: gj.id,
        bodyA: `c${ia}`,
        bodyB: `c${ib}`,
        anchor: { x: an.x, y: an.y },
        lowerAngle: gj.lowerAngle,
        upperAngle: gj.upperAngle,
        maxMotorTorque: gj.maxMotorTorque,
        motorized: gj.motorized !== false,
      });
    }
    if (skipped > 0)
      this.onMessage(
        `${skipped} joint(s) skipped — both sides are one connected part.`,
        'err'
      );
    else if (warn) this.onMessage(warn);

    const creature = { name, bodies, joints, editorGrid: this._editorGrid() };
    return validateCreature(creature);
  }

  // ---- DOM panel ---------------------------------------------------------

  _wireDom() {
    this._toolRadios = Array.from(
      document.querySelectorAll('input[name="editor-tool"]')
    );
    for (const r of this._toolRadios) {
      r.addEventListener('change', () => {
        if (r.checked) {
          this.tool = r.value;
          this.updatePanel();
        }
      });
    }

    this._nameInput = document.getElementById('editor-name');

    // Part (component) panel — reuses the old body-panel ids.
    this._partPanel = document.getElementById('editor-body-panel');
    this._partTitle = document.getElementById('editor-body-title');
    this._chkRoot = document.getElementById('chk-body-root');
    this._chkFoot = document.getElementById('chk-body-foot');
    this._btnPartDel = document.getElementById('btn-body-delete');
    if (this._chkRoot)
      this._chkRoot.addEventListener('change', () => {
        const comp = this.selectedComponent();
        if (!comp) return;
        // Exactly one root: the marker is a single cell of this component.
        this.rootMarker = this._chkRoot.checked ? this.sel.cell : null;
      });
    if (this._chkFoot)
      this._chkFoot.addEventListener('change', () => {
        const comp = this.selectedComponent();
        if (!comp) return;
        if (this._chkFoot.checked) for (const k of comp) this.footMarkers.add(k);
        else for (const k of comp) this.footMarkers.delete(k);
      });
    if (this._btnPartDel)
      this._btnPartDel.addEventListener('click', () => {
        const comp = this.selectedComponent();
        if (comp) {
          for (const k of comp) {
            this.cells.delete(k);
            this.footMarkers.delete(k);
            if (this.rootMarker === k) this.rootMarker = null;
          }
          this.gridJoints = this.gridJoints.filter(
            (j) => this.cells.has(cellKey(...j.a)) && this.cells.has(cellKey(...j.b))
          );
          this.sel = null;
        }
        this.updatePanel();
      });

    // Joint panel (unchanged ids).
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
        if (j) {
          this.gridJoints = this.gridJoints.filter((x) => x !== j);
          this.sel = null;
        }
        this.updatePanel();
      });

    // Actions.
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
    const loadEx = document.getElementById('btn-editor-load');
    if (loadEx) loadEx.addEventListener('click', () => this.loadExample());
  }

  _syncJointInputs() {
    const j = this.selectedJoint();
    if (!j) return;
    if (this._inLower) this._inLower.value = (j.lowerAngle * DEG).toFixed(0);
    if (this._inUpper) this._inUpper.value = (j.upperAngle * DEG).toFixed(0);
  }

  updatePanel() {
    for (const r of this._toolRadios || []) r.checked = r.value === this.tool;

    const comp = this.selectedComponent();
    const j = this.selectedJoint();
    if (this._partPanel) this._partPanel.style.display = comp ? '' : 'none';
    if (this._jointPanel) this._jointPanel.style.display = j ? '' : 'none';

    if (comp) {
      const isRoot = this.rootMarker != null && comp.includes(this.rootMarker);
      const isFoot = comp.some((k) => this.footMarkers.has(k));
      if (this._partTitle)
        this._partTitle.textContent =
          `${comp.length} cell${comp.length === 1 ? '' : 's'}` +
          (isRoot ? ' · root' : '') +
          (isFoot ? ' · feet' : '');
      if (this._chkRoot) this._chkRoot.checked = isRoot;
      if (this._chkFoot) this._chkFoot.checked = isFoot;
    }
    if (j) {
      if (this._jointTitle)
        this._jointTitle.textContent = `${j.id}: (${j.a}) ↔ (${j.b})`;
      if (this._inLower) this._inLower.value = (j.lowerAngle * DEG).toFixed(0);
      if (this._inUpper) this._inUpper.value = (j.upperAngle * DEG).toFixed(0);
      if (this._inTorque) this._inTorque.value = String(j.maxMotorTorque);
      if (this._valTorque)
        this._valTorque.textContent = `${Math.round(j.maxMotorTorque)} N·m`;
      if (this._chkMotor) this._chkMotor.checked = j.motorized !== false;
    }
  }

  // ---- Drawing -----------------------------------------------------------

  draw(ctx) {
    ctx.save();
    this._drawGrid(ctx);
    this._drawGroundLine(ctx);

    // Fused components as single merged shapes.
    const { comps, compOf } = this._components();
    const selCells = this.selectedComponent();
    const selSet = selCells ? new Set(selCells) : null;
    for (const comp of comps) {
      const color = this._componentColor(comp.cells);
      const selected = selSet != null && comp.cells.some((k) => selSet.has(k));
      this._fillComponent(ctx, comp.cells, color, selected);
    }

    // Joint markers on the lines.
    for (const j of this.gridJoints) {
      const sel = this.sel && this.sel.type === 'joint' && this.sel.id === j.id;
      this._drawJoint(ctx, j, sel);
    }

    ctx.restore();
    void compOf;
  }

  _drawGrid(ctx) {
    const g = this.cellSize * this.ppm;
    if (g < 8) return;
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    // Cell BOUNDARIES sit at half-integer cell coords: world x=(k+0.5)*cs, etc.
    const startX = this.originX % g;
    for (let x = startX; x < this.viewW; x += g) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, this.viewH);
    }
    const startY = this.originY % g;
    for (let y = startY; y < this.viewH; y += g) {
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

  _componentColor(cells) {
    const T = CONFIG.theme;
    if (this.rootMarker != null && cells.includes(this.rootMarker)) return T.root;
    if (cells.some((k) => this.footMarkers.has(k))) return T.foot;
    return T.limb;
  }

  /** Fill a component's cells as ONE merged shape (sticker-outline union),
   *  then highlight its outer boundary if selected. */
  _fillComponent(ctx, cells, color, selected) {
    const T = CONFIG.theme;
    const cs = this.cellSize;
    const wpx = cs * this.ppm;
    const k = 2;
    const single = cells.length === 1;
    const rad = wpx * T.bodyRadiusFrac;

    const rects = cells.map((key) => {
      const [cx, cy] = parseKey(key);
      const c = this._cellCenter(cx, cy);
      const s = this.m2s(c.x, c.y);
      return { x: s.x - wpx / 2, y: s.y - wpx / 2 };
    });

    // Pass 1: silhouette (outline color, enlarged) + soft shadow.
    ctx.save();
    ctx.shadowColor = T.shadow;
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 3;
    ctx.fillStyle = T.outline;
    for (const r of rects) {
      this._roundRect(ctx, r.x - k, r.y - k, wpx + 2 * k, wpx + 2 * k, rad + k);
      ctx.fill();
    }
    ctx.restore();

    // Pass 2: body fill (sharp for multi-cell so seams disappear).
    ctx.fillStyle = color;
    for (const r of rects) {
      if (single) this._roundRect(ctx, r.x, r.y, wpx, wpx, rad);
      else {
        ctx.beginPath();
        ctx.rect(r.x, r.y, wpx, wpx);
      }
      ctx.fill();
    }

    // Selected: trace the outer boundary in white.
    if (selected) {
      const set = new Set(cells);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (const key of cells) {
        const [cx, cy] = parseKey(key);
        const c = this._cellCenter(cx, cy);
        const s = this.m2s(c.x, c.y);
        const L = s.x - wpx / 2, R = s.x + wpx / 2, Tp = s.y - wpx / 2, B = s.y + wpx / 2;
        if (!set.has(cellKey(cx, cy + 1))) { ctx.moveTo(L, Tp); ctx.lineTo(R, Tp); } // up (world +y)
        if (!set.has(cellKey(cx, cy - 1))) { ctx.moveTo(L, B); ctx.lineTo(R, B); } // down
        if (!set.has(cellKey(cx - 1, cy))) { ctx.moveTo(L, Tp); ctx.lineTo(L, B); } // left
        if (!set.has(cellKey(cx + 1, cy))) { ctx.moveTo(R, Tp); ctx.lineTo(R, B); } // right
      }
      ctx.stroke();
    }
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

  /** Draw a joint marker ON its grid line; selected joints show the limit
   *  arc + two draggable handles (reused UI, now anchored on the line). */
  _drawJoint(ctx, j, selected) {
    const cs = this.cellSize;
    const an = this._jointAnchor(j);
    const anS = this.m2s(an.x, an.y);
    const T = CONFIG.theme;

    // The shared edge segment (perpendicular to the a->b axis).
    const horizNeighbors = j.a[1] === j.b[1]; // same row => vertical edge
    let e1, e2;
    if (horizNeighbors) {
      e1 = this.m2s(an.x, an.y - cs / 2);
      e2 = this.m2s(an.x, an.y + cs / 2);
    } else {
      e1 = this.m2s(an.x - cs / 2, an.y);
      e2 = this.m2s(an.x + cs / 2, an.y);
    }

    if (selected) {
      // Allowed-range arc (sampled in meters; m2s handles the y-flip).
      const rd = this._restDir(j);
      const R = CONFIG.editor.handleRadius;
      ctx.beginPath();
      ctx.moveTo(anS.x, anS.y);
      const steps = 24;
      for (let i = 0; i <= steps; i++) {
        const a = j.lowerAngle + (j.upperAngle - j.lowerAngle) * (i / steps);
        const p = this.m2s(an.x + R * Math.cos(rd + a), an.y + R * Math.sin(rd + a));
        ctx.lineTo(p.x, p.y);
      }
      ctx.closePath();
      ctx.fillStyle = 'rgba(143,211,255,0.22)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(143,211,255,0.8)';
      ctx.lineWidth = 1;
      ctx.stroke();

      // Rest arm.
      const rest = this.m2s(an.x + R * Math.cos(rd), an.y + R * Math.sin(rd));
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.beginPath();
      ctx.moveTo(anS.x, anS.y);
      ctx.lineTo(rest.x, rest.y);
      ctx.stroke();

      // Draggable L / U handles.
      const drawHandle = (a, label) => {
        const p = this.m2s(an.x + R * Math.cos(rd + a), an.y + R * Math.sin(rd + a));
        ctx.strokeStyle = T.accent;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(anS.x, anS.y);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
        ctx.fillStyle = T.accent;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
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

    // The line marker + pivot dot (always).
    ctx.strokeStyle = selected ? T.accent : T.joint;
    ctx.lineWidth = selected ? 4 : 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(e1.x, e1.y);
    ctx.lineTo(e2.x, e2.y);
    ctx.stroke();
    ctx.lineCap = 'butt';
    ctx.fillStyle = T.joint;
    ctx.beginPath();
    ctx.arc(anS.x, anS.y, selected ? 5 : 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

export default Editor;
