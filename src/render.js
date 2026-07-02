/*
 * render.js — BARREL. Draw a sim onto a 2D canvas, glass-on-gradient style.
 * ================================================================
 * The implementation was split into cohesive modules under ./render/:
 *   - ./render/core.js     — cell/clip setup, the world->screen draw entry
 *                            (drawSim/drawScene), and the ground band.
 *   - ./render/creature.js — drawBody: the compound-fixture merged/seamless
 *                            shape + circle spokes.
 *   - ./render/shape.js    — the shared roundRectPath path helper.
 * Scenery is still delegated to ./scenery.js from within ./render/core.js.
 *
 * This file re-exports the exact same public API so no importer changes:
 *   drawSim, drawScene (back-compat alias), and default (= drawSim).
 */

import { drawSim, drawScene } from './render/core.js';

export { drawSim, drawScene };

export default drawSim;
