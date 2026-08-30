/**
 * Filament, cost and time estimate (docs/02-feature-spec.md F9).
 *
 * The honest framing first: **this is not a slicer.** A slicer decides the real
 * numbers by generating toolpaths, and it accounts for things no closed-form
 * model can — supports, brims, seams, ironing, variable layer height, adaptive
 * infill, retraction, acceleration limits. What this does is turn the mesh into
 * a defensible arithmetic estimate so the user knows whether they are about to
 * spend 20 g or 200 g before they open one.
 *
 * The split matters:
 *
 * - `measureParts` walks the triangles once, in the worker, next to validation
 *   which already walks them. It produces volume and area, which depend only on
 *   the geometry.
 * - `estimateFilament` is arithmetic over those measurements. It runs on the
 *   main thread on every settings change, so dragging the infill slider updates
 *   the number without rebuilding anything — generation stays manual and gated
 *   behind the Generate button, as the hard rules require.
 */
import type { MeshPart } from '../geometry/types';

/** Geometry-derived quantities. Independent of any printer setting. */
export interface PartMeasure {
  name: string;
  /** Enclosed volume, print mm³. Zero or less means the part is not a solid. */
  volume_mm3: number;
  /**
   * Area of faces a slicer covers with SOLID layers — those facing up or down.
   *
   * Split from the walls because the two get different thicknesses: solid
   * layers are counted in layer heights, perimeters in line widths, and on a
   * terrain model the up-facing area is most of the surface.
   */
  solidArea_mm2: number;
  /** Area of near-vertical faces, which a slicer covers with perimeter loops. */
  wallArea_mm2: number;
}

/**
 * Printer and material settings the estimate needs.
 *
 * Everything here is a slicer setting rather than a model setting, which is why
 * none of it lives in GenerateConfig: changing any of it must not mark the
 * model dirty, because none of it changes a single vertex.
 */
export interface FilamentProfile {
  layerHeight_mm: number;
  nozzleDiameter_mm: number;
  /** Perimeter loops per wall. Slicer default is 2. */
  wallLoops: number;
  /** Solid layers at the top and at the bottom, counted once each. */
  solidLayers: number;
  /** 0-1. The single setting that moves the number most. */
  infill: number;
  filamentDiameter_mm: number;
  /** g/cm³. PLA 1.24, PETG 1.27, ABS 1.04. */
  density_g_cm3: number;
  /** Price of a kilogram, in whatever currency the user is thinking in. */
  pricePerKg: number;
  /** Nominal print speed, mm/s. */
  speed_mm_s: number;
}

export interface Estimate {
  /** Solid volume of the mesh — what it would use at 100% infill. */
  volume_mm3: number;
  /** Volume of plastic actually laid down. */
  material_mm3: number;
  mass_g: number;
  length_m: number;
  cost: number;
  hours: number;
  /** Fraction of the solid volume that ends up as plastic, 0-1. */
  fill: number;
}

/**
 * A slicer lays a line wider than the nozzle bore.
 *
 * 1.125 is the ratio behind the familiar defaults — 0.45 mm from a 0.4 mm
 * nozzle, 0.68 from 0.6. Getting this wrong scales the whole shell term.
 */
const LINE_WIDTH_RATIO = 1.125;

/**
 * How much longer a print takes than the extrusion arithmetic alone says.
 *
 * Travel moves, wipes, retraction, seams, and the fact that the nominal speed
 * is a ceiling the printer only reaches on long straight runs. A terrain model
 * is nearly all short segments, so it spends much of its life accelerating.
 *
 * **Calibrated 2026-08-30** against a sliced MazeTerrain model — a 23.13 g
 * city-and-route disc with the route as a separate insert. Its per-line-type
 * breakdown:
 *
 *     travel        13m21s   19.3%
 *     wipe           2m26s    3.5%
 *     seams          2m27s    3.6%
 *     unretract      1m34s    2.3%
 *     retract        1m01s    1.5%
 *     ----------------------------
 *     non-extruding 20m49s   30.1%   of 69m10s total
 *
 * So 1 / (1 − 0.301) = 1.431. The previous value, 1.35, was a guess that
 * implied 26% and ran the estimate short.
 *
 * One model is one data point, and this one is dense with short segments — a
 * smoother, larger model would travel proportionally less. The time stays
 * labelled "rough" in the UI for that reason. The mass does not: the same
 * slicer run put 23.13 g at 7.75 m of 1.75 mm filament, against 7.76 m from
 * this module's arithmetic.
 */
const TRAVEL_FACTOR = 1.431;

/** Faces steeper than this count as walls rather than as solid top or bottom. */
const WALL_COS_LIMIT = Math.cos((50 * Math.PI) / 180);

export function defaultFilamentProfile(
  layerHeight_mm: number,
  nozzleDiameter_mm: number,
): FilamentProfile {
  return {
    layerHeight_mm,
    nozzleDiameter_mm,
    wallLoops: 2,
    solidLayers: 4,
    infill: 0.15,
    filamentDiameter_mm: 1.75,
    density_g_cm3: 1.24,
    pricePerKg: 20,
    speed_mm_s: 60,
  };
}

/**
 * Volume and classified area of one part, in a single pass.
 *
 * Volume is the divergence theorem over the triangles: the signed volume of the
 * tetrahedron each triangle makes with the origin, summed. It is only
 * meaningful on a closed mesh, which every part is by the time it gets here —
 * `assemble` validates them all at Stage 9.
 */
export function measurePart(part: MeshPart): PartMeasure {
  const P = part.positions;
  const I = part.indices;

  let volume6 = 0;
  let solidArea2 = 0;
  let wallArea2 = 0;

  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3;
    const b = I[t + 1] * 3;
    const c = I[t + 2] * 3;

    const ax = P[a];
    const ay = P[a + 1];
    const az = P[a + 2];
    const bx = P[b];
    const by = P[b + 1];
    const bz = P[b + 2];
    const cx = P[c];
    const cy = P[c + 1];
    const cz = P[c + 2];

    // Six times the signed tetrahedron volume: a · (b × c).
    volume6 +=
      ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);

    // Twice the area, as the cross product of two edges.
    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const vx = cx - ax;
    const vy = cy - ay;
    const vz = cz - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const twiceArea = Math.hypot(nx, ny, nz);
    if (twiceArea <= 0) continue;

    if (Math.abs(nz) / twiceArea >= WALL_COS_LIMIT) solidArea2 += twiceArea;
    else wallArea2 += twiceArea;
  }

  return {
    name: part.name,
    volume_mm3: volume6 / 6,
    solidArea_mm2: solidArea2 / 2,
    wallArea_mm2: wallArea2 / 2,
  };
}

export function measureParts(parts: MeshPart[]): PartMeasure[] {
  return parts.map(measurePart);
}

/**
 * Turn measurements into grams, metres, money and hours.
 *
 * The model is the one a slicer follows to first order: a solid shell, and an
 * interior filled to the infill density.
 *
 *     shell    = walls × loops × lineWidth  +  solid faces × layers × layerHeight
 *     interior = volume − shell
 *     material = shell + interior × infill
 *
 * It over-counts slightly where a wall meets a top face and both terms claim
 * the same corner, and it does not know about supports or a brim. Both push the
 * same way — the real number is a little higher — so this reads as a floor
 * rather than as a promise.
 */
export function estimateFilament(
  measures: readonly PartMeasure[],
  profile: FilamentProfile,
): Estimate {
  const lineWidth_mm = profile.nozzleDiameter_mm * LINE_WIDTH_RATIO;
  const infill = Math.max(0, Math.min(1, profile.infill));

  let volume_mm3 = 0;
  let material_mm3 = 0;

  for (const m of measures) {
    // A negative volume means an inverted mesh, which validation blocks
    // separately; treating it as zero here keeps one bad part from making the
    // whole estimate nonsense.
    const volume = Math.max(0, m.volume_mm3);
    if (volume <= 0) continue;

    const shell = Math.min(
      volume,
      m.wallArea_mm2 * profile.wallLoops * lineWidth_mm +
        m.solidArea_mm2 * profile.solidLayers * profile.layerHeight_mm,
    );
    const interior = Math.max(0, volume - shell);

    volume_mm3 += volume;
    material_mm3 += shell + interior * infill;
  }

  const mass_g = (material_mm3 * profile.density_g_cm3) / 1000;
  const crossSection_mm2 = Math.PI * (profile.filamentDiameter_mm / 2) ** 2;
  const length_m = crossSection_mm2 > 0 ? material_mm3 / crossSection_mm2 / 1000 : 0;

  const flow_mm3_s = lineWidth_mm * profile.layerHeight_mm * profile.speed_mm_s;
  const hours = flow_mm3_s > 0 ? (material_mm3 / flow_mm3_s) * TRAVEL_FACTOR / 3600 : 0;

  return {
    volume_mm3,
    material_mm3,
    mass_g,
    length_m,
    cost: (mass_g / 1000) * profile.pricePerKg,
    hours,
    fill: volume_mm3 > 0 ? material_mm3 / volume_mm3 : 0,
  };
}

/** "2 h 45 m", or "18 m" under the hour. */
export function formatDuration(hours: number): string {
  if (!Number.isFinite(hours) || hours <= 0) return '—';
  const total = Math.round(hours * 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h} h ${m} m` : `${m} m`;
}
