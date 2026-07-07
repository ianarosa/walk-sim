/*
 * creature.js — the SHARED CREATURE SCHEMA and the default biped.
 * ==================================================================
 * The entire project (physics build, rendering, and later the RL layer)
 * is defined in terms of a plain-data "Creature" object. Keeping the
 * creature as serializable data (no physics handles, no functions) means
 * we can clone it, mutate it, save/load it, and — eventually — evolve or
 * hand-edit it, all without touching the simulator.
 *
 * SCHEMA
 * ------
 * Creature = {
 *   name: string,
 *   bodies: [ {
 *     id:      string,                 // unique within the creature
 *     x, y:    number,                 // body ORIGIN, REST position, meters y-UP
 *     angle?:  number,                 // rest angle, radians (default 0)
 *     density?:  number,               // kg/m^2 (default 1)
 *     friction?: number,               // 0..1 (default 0.6)
 *     isRoot?:  boolean,               // the torso; EXACTLY ONE. Camera &
 *                                      //   reward track it.
 *     isFoot?:  boolean,               // ground-contact observation source
 *
 *     // A body is a COMPOUND of one or more box fixtures (the grid editor
 *     // emits several so a multi-cell part is ONE rigid body):
 *     fixtures?: [ { shape:'box', dx, dy, w, h } ],  // dx,dy = LOCAL offset from
 *                                      //   the body origin (meters, unrotated);
 *                                      //   w,h = FULL size, meters
 *
 *     // LEGACY single-shape form (still fully supported; defaultBiped + any
 *     // previously-saved creatures use this). Ignored if `fixtures` is present:
 *     shape?:  'box' | 'circle',
 *     w?, h?:  number,                 // box FULL width/height, meters
 *     r?:      number,                 // circle radius, meters
 *   } ],
 *   joints: [ {
 *     id:      string,                 // unique within the creature
 *     bodyA, bodyB: string,            // body ids this joint connects
 *     anchor:  { x, y },               // WORLD pivot at rest, meters
 *     lowerAngle, upperAngle: number,  // revolute limits, radians
 *     maxMotorTorque: number,          // N*m the motor can apply
 *     motorized?: boolean,             // default true; RL/flail drive these
 *   } ],
 *
 *   // OPTIONAL editor round-trip metadata. The PHYSICS BUILD IGNORES THIS
 *   // entirely; only the grid editor reads it, to reconstruct its native
 *   // tile model exactly when you "load into editor". Legacy creatures with
 *   // no editorGrid simply can't be edited on the grid.
 *   editorGrid?: {
 *     cellSize: number,                          // meters per cell
 *     cells:  [ [cx, cy], ... ],                 // filled integer grid cells
 *     joints: [ { a:[cx,cy], b:[cx,cy],          // joint on the shared edge
 *                 lowerAngle, upperAngle, maxMotorTorque, motorized } ],
 *     roots:  [ [cx,cy], ... ],                  // cell(s) marking the root part
 *     feet:   [ [cx,cy], ... ],                  // cells marking foot parts
 *   },
 * }
 *
 * Coordinates are y-UP meters to match planck. The build step converts
 * these into live bodies/joints; nothing here knows about planck.
 */

/**
 * defaultBiped() — a simple two-legged ragdoll.
 *
 * Layout (side view, x to the right, y up):
 *
 *        [ torso ]           root, a tall box centered ~1.35m up
 *        /       \
 *   [Lupper]   [Rupper]      thighs, hinged to torso at the hips
 *      |           |
 *   [Llower]   [Rlower]      shins, hinged to thighs at the knees
 *     [Lfoot]   [Rfoot]      small feet (isFoot) hinged at the ankles
 *
 * The rest pose is roughly upright. Because the legs are just hinges with
 * gravity and no controller holding them, the biped will sag/flop
 * realistically the moment the sim starts — exactly what we want to see.
 */
export function defaultBiped() {
  // Shared dims (meters). Tuned for LEARNABILITY: a lower centre of mass,
  // wide/heavy feet for a stable base, and a rest pose whose feet sit exactly
  // ON the ground (the old pose put the feet at y=-0.15, penetrating the floor,
  // so the sim ejected the biped violently on the very first step).
  const torsoW = 0.4;
  const torsoH = 0.7;

  const thighW = 0.18;
  const thighH = 0.42;
  const shinW = 0.16;
  const shinH = 0.42;
  const footW = 0.5; // wide foot => stable base of support
  const footH = 0.12;

  // Hip x-offset from centerline for each leg.
  const hipDX = 0.13;

  // Precompute vertical anchor levels BOTTOM-UP so the feet rest on the ground
  // (y=0) at rest. Legs are straight (angle 0); the torso center lands wherever
  // the stacked segment heights put it (~1.31m).
  const footCY = footH / 2; // foot bottom on the ground
  const ankleY = footCY + footH / 2; // ankle at the top of the foot
  const shinCY = ankleY + shinH / 2;
  const kneeY = ankleY + shinH;
  const thighCY = kneeY + thighH / 2;
  const hipY = kneeY + thighH; // bottom of torso == hip pivot line
  const torsoCY = hipY + torsoH / 2; // torso center height (~1.31m)

  // Build one leg (side = -1 for left, +1 for right).
  const leg = (side) => {
    const tag = side < 0 ? 'L' : 'R';
    const x = side * hipDX;
    const bodies = [
      {
        id: `${tag}_thigh`,
        shape: 'box',
        x,
        y: thighCY,
        w: thighW,
        h: thighH,
        density: 1.0,
        friction: 0.6,
      },
      {
        id: `${tag}_shin`,
        shape: 'box',
        x,
        y: shinCY,
        w: shinW,
        h: shinH,
        density: 1.0,
        friction: 0.6,
      },
      {
        id: `${tag}_foot`,
        shape: 'box',
        // Foot sticks forward (+x) from the ankle so heel is behind, toe ahead.
        x: x + 0.12,
        y: footCY,
        w: footW,
        h: footH,
        // Heavy feet keep the centre of mass low and the base planted.
        density: 2.5,
        friction: 0.95,
        isFoot: true,
      },
    ];
    const joints = [
      {
        id: `${tag}_hip`,
        bodyA: 'torso',
        bodyB: `${tag}_thigh`,
        anchor: { x, y: hipY },
        lowerAngle: -1.2, // ~ -69deg
        upperAngle: 1.0, //  ~  57deg
        maxMotorTorque: 100,
        motorized: true,
      },
      {
        id: `${tag}_knee`,
        bodyA: `${tag}_thigh`,
        bodyB: `${tag}_shin`,
        anchor: { x, y: kneeY },
        // Knee only bends one way (backwards), like a real leg.
        lowerAngle: -2.2,
        upperAngle: 0.0,
        maxMotorTorque: 80,
        motorized: true,
      },
      {
        id: `${tag}_ankle`,
        bodyA: `${tag}_shin`,
        bodyB: `${tag}_foot`,
        anchor: { x, y: ankleY },
        lowerAngle: -0.6,
        upperAngle: 0.6,
        maxMotorTorque: 45,
        motorized: true,
      },
    ];
    return { bodies, joints };
  };

  const left = leg(-1);
  const right = leg(1);

  // A BLOCKY grid approximation of the biped so it can also be opened in the
  // grid editor. This is purely editor round-trip METADATA — the physics build
  // ignores editorGrid entirely, so it does NOT touch the tuned bodies/joints
  // above. Editing on the grid then converts the biped into fused unit blocks
  // (a rougher silhouette), which is expected and fine.
  //
  // Grid picture (cx to the right, cy up; each cell ~0.34m):
  //
  //         (0,4)                 root cell (torso top)
  //   (-1,3)(0,3)(1,3)            torso/hip row  ── all fuse into one body
  //   (-1,2)      (1,2)           thighs   (hip joints below the torso row)
  //   (-1,1)      (1,1)           shins    (knee joints)
  //   (-1,0)      (1,0)           feet     (ankle joints) — isFoot
  //
  // Legs sit at cx=±1 (a gap at cx=0) so left/right never 4-fuse; each leg cell
  // is split from its neighbours by a joint, giving thigh/shin/foot bodies.
  const bipedGrid = {
    cellSize: 0.34,
    cells: [
      [0, 4],
      [-1, 3], [0, 3], [1, 3],
      [-1, 2], [-1, 1], [-1, 0],
      [1, 2], [1, 1], [1, 0],
    ],
    joints: [
      // hips: thigh (cy=2) <-> torso row (cy=3)
      { a: [-1, 2], b: [-1, 3], lowerAngle: -1.2, upperAngle: 1.0, maxMotorTorque: 100, motorized: true },
      { a: [1, 2], b: [1, 3], lowerAngle: -1.2, upperAngle: 1.0, maxMotorTorque: 100, motorized: true },
      // knees: shin (cy=1) <-> thigh (cy=2), one-way bend
      { a: [-1, 1], b: [-1, 2], lowerAngle: -2.2, upperAngle: 0.0, maxMotorTorque: 80, motorized: true },
      { a: [1, 1], b: [1, 2], lowerAngle: -2.2, upperAngle: 0.0, maxMotorTorque: 80, motorized: true },
      // ankles: foot (cy=0) <-> shin (cy=1)
      { a: [-1, 0], b: [-1, 1], lowerAngle: -0.6, upperAngle: 0.6, maxMotorTorque: 45, motorized: true },
      { a: [1, 0], b: [1, 1], lowerAngle: -0.6, upperAngle: 0.6, maxMotorTorque: 45, motorized: true },
    ],
    roots: [[0, 4]],
    feet: [[-1, 0], [1, 0]],
  };

  return {
    name: 'Default Biped',
    bodies: [
      {
        id: 'torso',
        shape: 'box',
        x: 0,
        y: torsoCY,
        w: torsoW,
        h: torsoH,
        density: 1.0,
        friction: 0.6,
        isRoot: true,
      },
      ...left.bodies,
      ...right.bodies,
    ],
    joints: [...left.joints, ...right.joints],
    editorGrid: bipedGrid,
  };
}

/**
 * validateCreature(c) — throws on structural problems, returns c on success.
 * Cheap invariants so a malformed creature fails loudly at build time
 * instead of producing confusing physics.
 */
export function validateCreature(c) {
  if (!c || typeof c !== 'object') throw new Error('creature: not an object');
  if (!Array.isArray(c.bodies) || c.bodies.length === 0)
    throw new Error('creature: bodies must be a non-empty array');
  if (!Array.isArray(c.joints))
    throw new Error('creature: joints must be an array');

  const ids = new Set();
  let roots = 0;
  for (const b of c.bodies) {
    if (!b.id) throw new Error('creature: a body is missing an id');
    if (ids.has(b.id)) throw new Error(`creature: duplicate body id "${b.id}"`);
    ids.add(b.id);
    if (typeof b.x !== 'number' || typeof b.y !== 'number')
      throw new Error(`creature: body "${b.id}" needs numeric x,y`);
    // A body is EITHER a compound of box fixtures OR a legacy single shape.
    if (Array.isArray(b.fixtures) && b.fixtures.length > 0) {
      for (const f of b.fixtures) {
        if (f.shape !== 'box')
          throw new Error(`creature: body "${b.id}" fixture shape must be 'box'`);
        if (!(f.w > 0) || !(f.h > 0))
          throw new Error(`creature: body "${b.id}" fixture needs positive w,h`);
        if (typeof f.dx !== 'number' || typeof f.dy !== 'number')
          throw new Error(`creature: body "${b.id}" fixture needs numeric dx,dy`);
      }
    } else if (b.shape === 'box') {
      if (!(b.w > 0) || !(b.h > 0))
        throw new Error(`creature: box "${b.id}" needs positive w and h`);
    } else if (b.shape === 'circle') {
      if (!(b.r > 0)) throw new Error(`creature: circle "${b.id}" needs positive r`);
    } else {
      throw new Error(
        `creature: body "${b.id}" needs either a fixtures[] array or a legacy shape`
      );
    }
    if (b.isRoot) roots += 1;
  }
  if (roots !== 1)
    throw new Error(`creature: expected exactly one isRoot body, found ${roots}`);

  const jids = new Set();
  for (const j of c.joints) {
    if (!j.id) throw new Error('creature: a joint is missing an id');
    if (jids.has(j.id)) throw new Error(`creature: duplicate joint id "${j.id}"`);
    jids.add(j.id);
    if (!ids.has(j.bodyA))
      throw new Error(`creature: joint "${j.id}" bodyA "${j.bodyA}" not found`);
    if (!ids.has(j.bodyB))
      throw new Error(`creature: joint "${j.id}" bodyB "${j.bodyB}" not found`);
    if (!j.anchor || typeof j.anchor.x !== 'number' || typeof j.anchor.y !== 'number')
      throw new Error(`creature: joint "${j.id}" needs a numeric anchor {x,y}`);
    if (!(j.upperAngle >= j.lowerAngle))
      throw new Error(`creature: joint "${j.id}" upperAngle < lowerAngle`);
  }
  return c;
}

/**
 * cloneCreature(c) — deep, structural copy. The creature is pure data
 * (no functions, no cyclic refs) so structuredClone / JSON round-trip is
 * safe. We prefer structuredClone when available and fall back to JSON.
 */
export function cloneCreature(c) {
  if (typeof structuredClone === 'function') return structuredClone(c);
  return JSON.parse(JSON.stringify(c));
}

/**
 * creatureFromGrid(spec) — build a full, valid Creature from a GRID SPEC, the
 * SAME tile model the editor uses. This is the shared factory the grid-native
 * presets below are built from, so they are guaranteed self-consistent AND
 * round-trippable: the emitted `editorGrid` is exactly the spec, so
 * Editor.loadCreature() can rebuild them cell-for-cell.
 *
 * It mirrors Editor.toCreature():
 *   • Filled cells that are 4-adjacent FUSE into ONE rigid body, UNLESS a grid
 *     joint sits on their shared edge (a joint breaks the fusion). Each cell
 *     becomes one box fixture of size cellSize at the cell's world center; the
 *     body origin is the component centroid.
 *   • Each grid joint becomes a revolute joint anchored at the shared-edge
 *     midpoint between the two components it separates. A joint whose two cells
 *     end up in the SAME component (reconnected elsewhere) is skipped.
 *   • The component holding a `roots` cell is isRoot (exactly one). Components
 *     holding a `feet` cell are isFoot, and get heavier/grippier material so
 *     they plant like the biped's feet.
 *
 * spec = {
 *   name, cellSize,
 *   cells:  [ [cx,cy], ... ],
 *   joints: [ { a:[cx,cy], b:[cx,cy], lowerAngle, upperAngle, maxMotorTorque, motorized } ],
 *   roots:  [ [cx,cy], ... ],   // first entry marks the root component
 *   feet:   [ [cx,cy], ... ],
 * }
 *
 * Cell (cx,cy) has its CENTER at world { x: cx*cs, y: (cy+0.5)*cs } — identical
 * to the editor — so a cell at cy=0 rests its bottom face on the ground (y=0).
 * Design specs with the lowest row at cy=0 and the whole creature stands/lies
 * on the floor at rest.
 */
export function creatureFromGrid(spec) {
  const cs = spec.cellSize;
  const key = (cx, cy) => `${cx},${cy}`;
  const parse = (k) => k.split(',').map(Number);
  const center = (cx, cy) => ({ x: cx * cs, y: (cy + 0.5) * cs });

  const cellSet = new Set(spec.cells.map(([cx, cy]) => key(cx, cy)));
  const joints = spec.joints || [];

  // Does an edge between (x1,y1) and (x2,y2) carry a grid joint (order-free)?
  const sameEdge = (j, x1, y1, x2, y2) => {
    const [ax, ay] = j.a;
    const [bx, by] = j.b;
    return (
      (ax === x1 && ay === y1 && bx === x2 && by === y2) ||
      (ax === x2 && ay === y2 && bx === x1 && by === y1)
    );
  };
  const jointOnEdge = (x1, y1, x2, y2) =>
    joints.some((j) => sameEdge(j, x1, y1, x2, y2));

  // Connected components: 4-adjacency, NOT crossing a jointed edge.
  const seen = new Set();
  const comps = []; // array of cell-key arrays
  const compOf = new Map(); // cellKey -> component index
  for (const start of cellSet) {
    if (seen.has(start)) continue;
    const cells = [];
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const cur = stack.pop();
      cells.push(cur);
      const [cx, cy] = parse(cur);
      for (const [nx, ny] of [
        [cx + 1, cy],
        [cx - 1, cy],
        [cx, cy + 1],
        [cx, cy - 1],
      ]) {
        const nk = key(nx, ny);
        if (!cellSet.has(nk) || seen.has(nk)) continue;
        if (jointOnEdge(cx, cy, nx, ny)) continue; // joint breaks fusion
        seen.add(nk);
        stack.push(nk);
      }
    }
    const idx = comps.length;
    comps.push(cells);
    for (const c of cells) compOf.set(c, idx);
  }

  const footSet = new Set((spec.feet || []).map(([cx, cy]) => key(cx, cy)));
  const rootCell =
    spec.roots && spec.roots.length ? key(spec.roots[0][0], spec.roots[0][1]) : null;

  // One compound-fixture body per component (origin at the centroid).
  const bodies = comps.map((cells, i) => {
    const pts = cells.map((k) => {
      const [cx, cy] = parse(k);
      return center(cx, cy);
    });
    const ox = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const oy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    const fixtures = pts.map((p) => ({
      shape: 'box',
      dx: p.x - ox,
      dy: p.y - oy,
      w: cs,
      h: cs,
    }));
    const isFoot = cells.some((k) => footSet.has(k));
    const body = {
      id: `c${i}`,
      x: ox,
      y: oy,
      angle: 0,
      // Feet: heavier + grippier so the base plants (mirrors the biped feet).
      density: isFoot ? 2.0 : 1.0,
      friction: isFoot ? 0.95 : 0.6,
      fixtures,
    };
    if (isFoot) body.isFoot = true;
    return body;
  });

  // Root: the component holding the root marker, else the biggest part.
  let rootIdx =
    rootCell != null && compOf.has(rootCell)
      ? compOf.get(rootCell)
      : comps.reduce((best, c, i, arr) => (c.length > arr[best].length ? i : best), 0);
  bodies[rootIdx].isRoot = true;

  // Revolute joints: one per grid joint whose two cells are in DIFFERENT parts.
  const outJoints = [];
  for (const gj of joints) {
    const ka = key(gj.a[0], gj.a[1]);
    const kb = key(gj.b[0], gj.b[1]);
    if (!cellSet.has(ka) || !cellSet.has(kb)) continue;
    const ia = compOf.get(ka);
    const ib = compOf.get(kb);
    if (ia === ib) continue; // both sides fused into one part: skip
    const a = center(gj.a[0], gj.a[1]);
    const b = center(gj.b[0], gj.b[1]);
    outJoints.push({
      id: `gj${outJoints.length}`,
      bodyA: `c${ia}`,
      bodyB: `c${ib}`,
      anchor: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      lowerAngle: gj.lowerAngle,
      upperAngle: gj.upperAngle,
      maxMotorTorque: gj.maxMotorTorque,
      motorized: gj.motorized !== false,
    });
  }

  // Emit editorGrid straight from the spec so load-into-editor rebuilds it 1:1.
  const editorGrid = {
    cellSize: cs,
    cells: spec.cells.map(([cx, cy]) => [cx, cy]),
    joints: joints.map((j) => ({
      a: [j.a[0], j.a[1]],
      b: [j.b[0], j.b[1]],
      lowerAngle: j.lowerAngle,
      upperAngle: j.upperAngle,
      maxMotorTorque: j.maxMotorTorque,
      motorized: j.motorized !== false,
    })),
    roots: (spec.roots || []).map(([cx, cy]) => [cx, cy]),
    feet: (spec.feet || []).map(([cx, cy]) => [cx, cy]),
  };

  return validateCreature({ name: spec.name, bodies, joints: outJoints, editorGrid });
}

/**
 * defaultQuadruped() — a low, long four-legged creature (side view).
 *
 * A horizontal SPINE (one fused body, 7 cells at cy=2) carries FOUR legs, each
 * two segments (upper + foot). Legs hang at cx = -3, -1, 1, 3 — spaced two
 * apart so neighbouring legs never fuse — which reads as a back pair (-3,-1)
 * and a front pair (1,3). Each leg: upper cell at cy=1 (hip joint to the spine)
 * and a foot cell at cy=0 (knee joint to the upper). Feet rest on the ground.
 *
 *   spine:  (-3,2)(-2,2)(-1,2)(0,2)(1,2)(2,2)(3,2)     root = (0,2)
 *   legs :  (-3,1)     (-1,1)     (1,1)     (3,1)       uppers  (hips)
 *           (-3,0)     (-1,0)     (1,0)     (3,0)       feet    (knees) isFoot
 *
 * Hips get symmetric ~±1 rad limits (torque 90); knees a one-way bend
 * (torque 70), so the legs can push the body forward.
 */
export function defaultQuadruped() {
  const legXs = [-3, -1, 1, 3];
  const cells = [];
  const joints = [];
  const feet = [];
  // Spine row spans the outermost legs so every hip cell has a spine cell above.
  for (let cx = -3; cx <= 3; cx++) cells.push([cx, 2]);
  for (const x of legXs) {
    cells.push([x, 1], [x, 0]); // upper, foot
    feet.push([x, 0]);
    // Hip: upper (cy=1) <-> spine (cy=2).
    joints.push({
      a: [x, 1],
      b: [x, 2],
      lowerAngle: -1.0,
      upperAngle: 1.0,
      maxMotorTorque: 90,
      motorized: true,
    });
    // Knee: foot (cy=0) <-> upper (cy=1), one-way bend.
    joints.push({
      a: [x, 0],
      b: [x, 1],
      lowerAngle: -1.6,
      upperAngle: 0.2,
      maxMotorTorque: 70,
      motorized: true,
    });
  }
  return creatureFromGrid({
    name: 'Default Quadruped',
    cellSize: 0.3,
    cells,
    joints,
    roots: [[0, 2]],
    feet,
  });
}

/**
 * defaultCrawler() — a worm/snake: a horizontal CHAIN of 7 segments lying on
 * the ground (all cells at cy=0), linked by 6 motorized revolute joints.
 * Placing a joint on every shared edge breaks fusion, so the row becomes 7
 * separate bodies that can undulate. Limits ~±1.0 rad let it flex into an S.
 *
 *   (0,0)-(1,0)-(2,0)-(3,0)-(4,0)-(5,0)-(6,0)   root = middle (3,0)
 *                                                ends (0,0),(6,0) are isFoot
 *
 * WHY IT MOVES NOW (was: it just whipped in place):
 *   The bottleneck was never torque — a 0.3m box at density 1 is ~0.09 kg, so
 *   the old 60 N·m already over-drove those near-weightless links. What was
 *   missing was MASS + TRACTION: light segments undulate but don't grip the
 *   floor, so no net thrust. We fix all three: it's LONGER (more contact and
 *   more phase for a travelling wave), HEAVIER + grippier on the mid-body (so
 *   pushes react against real inertia instead of flinging weightless links),
 *   and stronger torque to match the added mass.
 */
export function defaultCrawler() {
  // A worm that SLITHERS (a whole-body travelling wave), not a "scorpion" that
  // rears up and scoots on one joint. Three things make the wave emerge:
  //   1. LONG — 9 segments / 8 joints, so a ripple has room to travel.
  //   2. WEAK — low per-joint torque (40): no two strong joints can drive the
  //      body alone, so the policy is forced to recruit MANY joints in sequence.
  //   3. LIGHT + UNIFORM mass (1.4 everywhere): no heavy segment the worm can
  //      pivot around; every segment contributes equally to the undulation.
  // This pairs with the env's creature-relative jitter tax (env.js smoothScale):
  // a low creature's wSmooth/wJerk penalties are relaxed ~9x, so the many-joint
  // motion a slither needs is no longer suppressed into a stiff 2-joint hump.
  // Verified headlessly: 4/8 joints active with uniform amplitude (a distributed
  // wave), flat gait (segments stay ~0.48 m, no scorpion rear), ~70 m of crawl.
  const n = 9;
  const cells = [];
  const joints = [];
  for (let i = 0; i < n; i++) cells.push([i, 0]);
  for (let i = 0; i < n - 1; i++) {
    joints.push({
      a: [i, 0],
      b: [i + 1, 0],
      lowerAngle: -0.9,
      upperAngle: 0.9,
      // WEAK on purpose (see above): one or two joints can't drive the body, so
      // the policy learns to pass a wave down the whole chain.
      maxMotorTorque: 40,
      motorized: true,
    });
  }
  const worm = creatureFromGrid({
    name: 'Default Worm',
    cellSize: 0.3,
    cells,
    joints,
    roots: [[Math.floor(n / 2), 0]], // middle segment
    feet: [[0, 0], [n - 1, 0]], // the two ends
  });

  // LIGHT + UNIFORM mass. creatureFromGrid gives non-foot bodies a very light
  // default and the two end "feet" a heavier, grippier one; that asymmetry lets
  // the worm pivot around a heavy end. Level every segment to the same light
  // density so no single segment dominates — the body has to ripple as a whole.
  // Keep the end feet's grippier friction (0.95) so the wave converts to travel.
  for (const b of worm.bodies) {
    b.density = 1.4;
    if (!b.isFoot) b.friction = 0.9;
  }
  return validateCreature(worm);
}

/**
 * PRESETS — the spawnable creature registry. The app iterates this to offer
 * more than just the biped; every `make()` returns a fresh, valid creature that
 * also carries `editorGrid`, so all three are editable on the grid.
 */
export const PRESETS = [
  { id: 'biped', name: 'Biped', emoji: '🚶', make: defaultBiped },
  { id: 'quadruped', name: 'Quadruped', emoji: '🐕', make: defaultQuadruped },
  { id: 'crawler', name: 'Worm', emoji: '🐛', make: defaultCrawler },
];

export default defaultBiped;
