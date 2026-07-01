/*
 * physics/sim.js — the Sim class: the stable surface the rest of the app
 * (render, camera, and LATER the RL agent) consumes.
 * ========================================================================
 * The Sim wraps a built planck world and exposes a small, GENERIC API that
 * does not assume any particular creature. Body/joint counts are variable;
 * observations are returned as plain arrays/objects keyed by creature id so
 * the RL layer can consume them for any morphology.
 *
 * Design intent: the Sim is the ONLY thing RL will touch. It offers
 * observations (root pose/velocity, joint angles/speeds, foot contacts) and
 * one action channel (setMotorSpeeds). Reward/observation *shaping* lives in
 * the future RL module, not here.
 */

import { buildWorld } from './build.js';
import { validateCreature, cloneCreature } from '../creature.js';
import { CONFIG } from '../config.js';

export class Sim {
  /**
   * @param {object} creature - a Creature per the shared schema.
   */
  constructor(creature) {
    // Keep a pristine clone so reset() always rebuilds from the original,
    // even if callers later mutate their copy.
    this._creature = cloneCreature(validateCreature(creature));
    this.time = 0; // accumulated simulated seconds
    this._build();
  }

  /** (re)construct the live world from the stored creature definition. */
  _build() {
    const w = buildWorld(this._creature);
    this.world = w.world;
    this.bodies = w.bodies; // Map<id, Body>
    this.joints = w.joints; // Map<id, Joint>
    this.motorized = w.motorized; // string[] of joint ids (stable order)
    this.footBodyIds = w.footBodyIds;
    this.rootId = w.rootId;
    this.contacts = w.contacts; // Set<id> live foot contacts
    this.ground = w.ground;
    this._root = this.bodies.get(this.rootId);
    // Stable ordering for index-based action/observation vectors.
    this.jointOrder = Array.from(this.joints.keys());
  }

  /** advance the simulation by dt seconds (one fixed physics step). */
  step(dt = CONFIG.dt) {
    this.world.step(dt, CONFIG.velIters, CONFIG.posIters);
    this.time += dt;
  }

  /** tear down and rebuild the world; clears time and contacts. */
  reset() {
    this.time = 0;
    this._build();
  }

  /**
   * setMotorSpeeds(arrayOrMap) — apply target motor speeds (rad/s) to the
   * MOTORIZED joints only. Accepts either:
   *   - an Array indexed by motorized-joint order (this.motorized), or
   *   - an object/Map keyed by joint id.
   * Non-motorized joints and unknown ids are ignored.
   */
  setMotorSpeeds(arrayOrMap) {
    if (Array.isArray(arrayOrMap)) {
      for (let i = 0; i < this.motorized.length; i++) {
        const v = arrayOrMap[i];
        if (v == null) continue;
        this.joints.get(this.motorized[i]).setMotorSpeed(v);
      }
      return;
    }
    const get =
      arrayOrMap instanceof Map
        ? (k) => arrayOrMap.get(k)
        : (k) => arrayOrMap[k];
    for (const id of this.motorized) {
      const v = get(id);
      if (v == null) continue;
      this.joints.get(id).setMotorSpeed(v);
    }
  }

  // --- Observations -----------------------------------------------------

  /** root world position, meters, y-up: {x, y}. */
  rootPosition() {
    const p = this._root.getPosition();
    return { x: p.x, y: p.y };
  }

  /** root body angle, radians. */
  rootAngle() {
    return this._root.getAngle();
  }

  /** root linear velocity, m/s: {x, y}. */
  rootVelocity() {
    const v = this._root.getLinearVelocity();
    return { x: v.x, y: v.y };
  }

  /** current angle (radians) of every joint, keyed by joint id. */
  jointAngles() {
    const out = {};
    for (const [id, j] of this.joints) out[id] = j.getJointAngle();
    return out;
  }

  /** current angular speed (rad/s) of every joint, keyed by joint id. */
  jointSpeeds() {
    const out = {};
    for (const [id, j] of this.joints) out[id] = j.getJointSpeed();
    return out;
  }

  /**
   * footContacts() — for each isFoot body id, true if it is currently
   * touching the ground. Returns an object keyed by foot body id.
   */
  footContacts() {
    const out = {};
    for (const id of this.footBodyIds) out[id] = this.contacts.has(id);
    return out;
  }
}

export default Sim;
