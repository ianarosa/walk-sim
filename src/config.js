/*
 * config.js — single source of truth for tunable constants — BARREL.
 * ------------------------------------------------------------------
 * Everything that is a "magic number" anywhere else in the sim should live
 * here so the rest of the code reads declaratively. The constants used to live
 * in one monolith; they were split by domain into src/config/*.js so that
 * parallel feature work can edit a single small domain file (e.g. RL tuning ->
 * config/rl.js, scenery -> config/scenery.js) without touching the others.
 *
 * This barrel re-assembles the partials into the SAME single frozen CONFIG
 * object the rest of the codebase already imports:
 *
 *     import { CONFIG } from '../config.js';   // (or './config.js')
 *
 * Nothing else changed: same top-level keys, same values, same nested shape,
 * and the same freezing behavior (top-level CONFIG frozen; each sub-object
 * frozen as before; `gravity` intentionally left unfrozen; `RL.hiddenSizes`
 * left an ordinary mutable array — exactly as the monolith had them).
 *
 * Coordinate note: planck.js (Box2D) is METERS, y-UP, with gravity pointing in
 * -y. The canvas is PIXELS, y-DOWN. PPM (pixels-per-meter) is the scale factor;
 * the y-flip is applied in the render transform.
 */
import { worldConfig } from './config/world.js';
import { cameraConfig } from './config/camera.js';
import { renderConfig } from './config/render.js';
import { simUiConfig } from './config/sim-ui.js';
import { editorConfig } from './config/editor.js';
import { themeConfig } from './config/theme.js';
import { sceneryConfig } from './config/scenery.js';
import { lanesConfig } from './config/lanes.js';
import { rlConfig } from './config/rl.js';

// Object spread silently overwrites on duplicate top-level keys, so if two
// domain partials ever export the same constant name the later one in merge
// order wins with no error — a subtle hazard for parallel editors. We merge the
// partials in the exact same order a spread would (so the resulting CONFIG is
// byte-for-byte identical in shape and values to the old monolith) but warn
// loudly on any collision so it surfaces instead of silently overriding.
//
// Merge order below preserves the original monolith's top-level key order:
//   PPM, gravity, dt, velIters, posIters, ground, camera, colors, flail, loop,
//   editor, theme, scenery, lanes, RL.
const _partials = [
  ['world', worldConfig],
  ['camera', cameraConfig],
  ['render', renderConfig],
  ['sim-ui', simUiConfig],
  ['editor', editorConfig],
  ['theme', themeConfig],
  ['scenery', sceneryConfig],
  ['lanes', lanesConfig],
  ['rl', rlConfig],
];

const _merged = {};
const _seenIn = {};
for (const [name, partial] of _partials) {
  for (const key of Object.keys(partial)) {
    if (Object.prototype.hasOwnProperty.call(_merged, key)) {
      // eslint-disable-next-line no-console
      console.warn(
        `[config] duplicate CONFIG key "${key}": config/${name}.js overrides ` +
        `config/${_seenIn[key]}.js`
      );
    }
    _seenIn[key] = name;
  }
  Object.assign(_merged, partial);
}

// Freeze the top-level object, matching the monolith's Object.freeze(CONFIG).
// Sub-objects keep whatever freeze state their partial gave them (the values
// are copied by reference, so their identity/freeze state is preserved).
export const CONFIG = Object.freeze({ ..._merged });

export default CONFIG;
