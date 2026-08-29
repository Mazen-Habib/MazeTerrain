/**
 * Does the route channel cut through the bottom of the model?
 *
 * The channel has a FLAT floor, placed `depth_mm` below the lowest ground the
 * route crosses (OPEN-QUESTIONS Q10). The lowest ground the route crosses is
 * often the lowest ground in the model, which sits exactly on top of the base
 * slab — so the floor lands `depth_mm` INTO the base, and if the base is thin
 * enough it comes out the other side. That would leave a slot in the underside
 * shaped exactly like the route: a line from the rim towards the middle,
 * drawn by the slicer as an internal perimeter on the first layer.
 */
import { readFileSync } from 'node:fs';
import { realHeightfield } from './lib/realdem';
import { buildRouteSolid } from '../src/geometry/route';
import { selectionRingWorld } from '../src/geometry/selection';
import { scaleFor } from '../tests/helpers';
import type { Route, RoutePoint } from '../src/data/gpx/types';
import type { SelectionShape } from '../src/geometry/selection';

const gpx = process.argv[2] ?? 'C:/Users/Mazen/Downloads/Milo_Marathon_2026.gpx';
const baseThickness_mm = Number(process.argv[3] ?? 3);
const depth_mm = Number(process.argv[4] ?? 1);

const xml = readFileSync(gpx, 'utf8');
const points: RoutePoint[] = [];
const re = /lat="([-0-9.]+)"\s+lon="([-0-9.]+)"/g;
let m: RegExpExecArray | null;
while ((m = re.exec(xml))) points.push({ lat: Number(m[1]), lon: Number(m[2]) });

let sLat = 0;
let sLon = 0;
for (const p of points) {
  sLat += p.lat;
  sLon += p.lon;
}
const LAT = sLat / points.length;
const LON = sLon / points.length;

// The circle the app draws around a route on first upload.
let west = Infinity;
let east = -Infinity;
let south = Infinity;
let north = -Infinity;
for (const p of points) {
  west = Math.min(west, p.lon);
  east = Math.max(east, p.lon);
  south = Math.min(south, p.lat);
  north = Math.max(north, p.lat);
}
const halfW_m = ((east - west) / 2) * 111320 * Math.cos((LAT * Math.PI) / 180);
const halfH_m = ((north - south) / 2) * 110574;
const radius_m = Math.hypot(halfW_m, halfH_m) * 1.15;

const halfLat = (radius_m * 1.02) / 110574;
const halfLon = halfLat / Math.cos((LAT * Math.PI) / 180);
const bbox = { west: LON - halfLon, east: LON + halfLon, south: LAT - halfLat, north: LAT + halfLat };

console.log(`\ncircle radius ${radius_m.toFixed(0)} m around ${LAT.toFixed(3)}, ${LON.toFixed(3)}`);
const hf = await realHeightfield(bbox, 13, 500);
const scale = scaleFor(hf, { bbox, baseThickness_mm, verticalExaggeration: 1.5 });
console.log(`relief ${hf.min_m.toFixed(0)}..${hf.max_m.toFixed(0)} m`);
console.log(`base ${baseThickness_mm} mm, so the lowest ground sits at z = ${baseThickness_mm} mm`);

const shape: SelectionShape = { kind: 'circle', lon: LON, lat: LAT, radius_m };
const ring = selectionRingWorld(shape, scale.origin);

const route: Route = {
  id: 'r',
  name: 'Milo Marathon 2026',
  source: 'gpx',
  smoothing: 0,
  points,
  distance_m: 0,
  elevationGain_m: null,
  bbox: { west, south, east, north },
  style: {
    color: '#FF0D00',
    width_mm: 1.5,
    height_mm: 2,
    profile: 'raised',
    elevationSource: 'dem',
    demBlend: 0,
    visible: true,
  },
};

const tool = buildRouteSolid(route, {
  heightfield: hf,
  scale,
  selection: ring,
  nozzleDiameter_mm: 0.4,
  baseThickness_mm,
  cut: { kind: 'cut', depth_mm, proud_mm: 1, clearance_mm: 0.15, toolTop_mm: 40 },
});

const floor = tool.stats.flatBottom_mm ?? NaN;
const [lowGround, highGround] = tool.stats.groundRange_mm ?? [NaN, NaN];

console.log(`\nground under the route: ${lowGround.toFixed(2)} .. ${highGround.toFixed(2)} mm`);
console.log(`channel floor: ${floor.toFixed(2)} mm  (lowest ground minus the ${depth_mm} mm depth)`);
console.log(`build plate is z = 0`);

if (floor < 0) {
  console.log(
    `\nTHE CHANNEL CUTS THROUGH THE BOTTOM by ${(-floor).toFixed(2)} mm.\n` +
      `The underside gets a slot shaped like the route.`,
  );
} else {
  console.log(
    `\nThe floor stops ${floor.toFixed(2)} mm above the build plate — ` +
      `${((floor / baseThickness_mm) * 100).toFixed(0)}% of the base survives under it.`,
  );
}

// How thin does the base get under the route, in base-thickness terms?
console.log(
  `\nMaterial left under the channel: ${floor.toFixed(2)} mm, ` +
    `which is ${(floor / 0.2).toFixed(1)} layers at 0.2 mm.`,
);
