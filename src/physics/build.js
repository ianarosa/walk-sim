/*
 * physics/build.js — turn a Creature (plain data) into a live planck world.
 * ========================================================================
 * This is the ONLY module that talks to the planck (Box2D) API directly for
 * *construction*. It reads the shared Creature schema and produces the set of
 * physics handles the Sim class drives.
 *
 * planck coordinate/units reminder: METERS, y-UP, gravity (0,-10). planck's
 * `Box(hx, hy)` takes HALF-extents, so full width/height from the schema are
 * halved here. `Circle(r)` takes a radius. Revolute joints pivot around a
 * single WORLD anchor point shared by both bodies.
 *
 * planck is loaded as a plain <script>, so it lives on window.planck (global).
 */

import { CONFIG } from '../config.js';

// Grab the global exposed by vendor/planck.min.js.
const planck = /** @type {any} */ (globalThis).planck;

/**
 * buildWorld(creature) -> {
 *   world,                       // planck.World
 *   bodies:   Map<id, Body>,     // dynamic bodies by creature id
 *   joints:   Map<id, Joint>,    // revolute joints by creature id
 *   motorized: string[],         // joint ids whose motor RL/flail drives
 *   footBodyIds: string[],       // body ids flagged isFoot
 *   rootId:   string,            // the isRoot body's id
 *   ground,                      // the static ground body (for completeness)
 *   contacts: Set<string>,       // foot body ids CURRENTLY touching ground
 * }
 *
 * The `contacts` set is kept live by begin-contact/end-contact listeners.
 */
export function buildWorld(creature) {
  if (!planck) {
    throw new Error(
      'planck global not found — ensure vendor/planck.min.js loads before main.js'
    );
  }
  const { Vec2, World, Box, Circle, Edge } = planck;

  // --- The world --------------------------------------------------------
  const world = new World(new Vec2(CONFIG.gravity.x, CONFIG.gravity.y));

  // --- Static ground: a long thin box whose TOP face sits at ground.y ---
  // We center the box so its top edge is exactly at CONFIG.ground.y.
  const g = CONFIG.ground;
  const ground = world.createBody({ type: 'static' });
  ground.createFixture({
    shape: new Box(g.halfWidth, g.halfHeight, new Vec2(0, g.y - g.halfHeight)),
    friction: g.friction,
  });
  // Also lay an Edge exactly on the surface for a crisp contact line and to
  // exercise the Edge API. Fixtures stack fine on one body.
  ground.createFixture({
    shape: new Edge(new Vec2(-g.halfWidth, g.y), new Vec2(g.halfWidth, g.y)),
    friction: g.friction,
  });
  ground.setUserData({ kind: 'ground', id: '__ground__' });

  // --- Dynamic bodies ---------------------------------------------------
  const bodies = new Map();
  const footBodyIds = [];
  let rootId = null;

  for (const b of creature.bodies) {
    const body = world.createBody({
      type: 'dynamic',
      position: new Vec2(b.x, b.y),
      angle: b.angle || 0,
    });

    let shape;
    if (b.shape === 'box') {
      shape = new Box(b.w / 2, b.h / 2); // schema is FULL w/h; planck wants HALF
    } else {
      shape = new Circle(b.r);
    }

    body.createFixture({
      shape,
      density: b.density != null ? b.density : 1,
      friction: b.friction != null ? b.friction : 0.6,
    });

    // userData lets contact listeners map fixtures back to creature ids.
    body.setUserData({
      kind: 'body',
      id: b.id,
      isFoot: !!b.isFoot,
      isRoot: !!b.isRoot,
    });

    bodies.set(b.id, body);
    if (b.isFoot) footBodyIds.push(b.id);
    if (b.isRoot) rootId = b.id;
  }

  // --- Revolute joints --------------------------------------------------
  const joints = new Map();
  const motorized = [];

  for (const j of creature.joints) {
    const bodyA = bodies.get(j.bodyA);
    const bodyB = bodies.get(j.bodyB);
    const isMotor = j.motorized !== false; // default true

    // planck.RevoluteJoint(def, bodyA, bodyB, worldAnchor). The def carries
    // limit & motor configuration; the anchor is a single world point.
    const joint = world.createJoint(
      new planck.RevoluteJoint(
        {
          enableLimit: true,
          lowerAngle: j.lowerAngle,
          upperAngle: j.upperAngle,
          enableMotor: isMotor,
          maxMotorTorque: j.maxMotorTorque,
          motorSpeed: 0,
        },
        bodyA,
        bodyB,
        new Vec2(j.anchor.x, j.anchor.y)
      )
    );

    joints.set(j.id, joint);
    if (isMotor) motorized.push(j.id);
  }

  // --- Contact tracking for feet ---------------------------------------
  // `contacts` holds the ids of foot bodies currently touching the ground.
  const contacts = new Set();
  const footSet = new Set(footBodyIds);

  // Given a contact, if exactly one side is the ground and the other is a
  // tracked foot, return that foot's id; otherwise null.
  const footIdForContact = (contact) => {
    const a = contact.getFixtureA().getBody().getUserData();
    const b = contact.getFixtureB().getBody().getUserData();
    if (!a || !b) return null;
    const aGround = a.kind === 'ground';
    const bGround = b.kind === 'ground';
    if (aGround === bGround) return null; // both ground or neither: ignore
    const other = aGround ? b : a;
    return footSet.has(other.id) ? other.id : null;
  };

  world.on('begin-contact', (contact) => {
    const id = footIdForContact(contact);
    if (id) contacts.add(id);
  });

  world.on('end-contact', (contact) => {
    const id = footIdForContact(contact);
    if (id) contacts.delete(id);
  });

  return {
    world,
    bodies,
    joints,
    motorized,
    footBodyIds,
    rootId,
    ground,
    contacts,
  };
}

export default buildWorld;
