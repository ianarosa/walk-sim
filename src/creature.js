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

export default defaultBiped;
