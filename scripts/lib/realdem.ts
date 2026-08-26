/**
 * A heightfield over a bbox from real elevation tiles, for Node diagnostics.
 *
 * The app's own DEM path goes through createImageBitmap, which does not exist
 * in Node, so this mosaics terrarium PNGs directly. Same encoding, same data —
 * only the decode differs. AWS Tilezen is used because Mapterhorn serves WebP.
 */
import { decodePng } from './png';
import { decodePixels } from '../../src/data/dem/datasets';
import type { Heightfield } from '../../src/geometry/heightfield';
import type { BBox } from '../../src/geometry/types';

const lon2x = (lon: number, z: number) => ((lon + 180) / 360) * 2 ** z;
const lat2y = (lat: number, z: number) =>
  ((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) *
  2 ** z;

export async function realHeightfield(bbox: BBox, zoom: number, cells: number): Promise<Heightfield> {
  const x0 = Math.floor(lon2x(bbox.west, zoom));
  const x1 = Math.floor(lon2x(bbox.east, zoom));
  const y0 = Math.floor(lat2y(bbox.north, zoom));
  const y1 = Math.floor(lat2y(bbox.south, zoom));

  const tiles = new Map<string, Float32Array>();
  let size = 256;
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${zoom}/${tx}/${ty}.png`;
      const res = await fetch(url, { headers: { 'User-Agent': 'MazeTerrain/0.1 (dev)' } });
      if (!res.ok) continue;
      const png = decodePng(new Uint8Array(await res.arrayBuffer()));
      size = png.width;
      const elev = new Float32Array(png.width * png.height);
      decodePixels(png.data as unknown as Uint8ClampedArray, elev, 'terrarium');
      tiles.set(`${tx},${ty}`, elev);
    }
  }
  console.log(`  ${tiles.size} DEM tiles at z${zoom}`);

  /** Bilinear, never nearest-neighbour (CLAUDE.md). */
  const sample = (lon: number, lat: number): number => {
    const fx = lon2x(lon, zoom) * size;
    const fy = lat2y(lat, zoom) * size;
    const read = (px: number, py: number): number => {
      const tx = Math.floor(px / size);
      const ty = Math.floor(py / size);
      const t = tiles.get(`${tx},${ty}`);
      if (!t) return 0;
      const i = Math.min(size - 1, Math.max(0, px - tx * size));
      const j = Math.min(size - 1, Math.max(0, py - ty * size));
      return t[j * size + i];
    };
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    const sx = fx - ix;
    const sy = fy - iy;
    const a = read(ix, iy), b = read(ix + 1, iy), c = read(ix, iy + 1), d = read(ix + 1, iy + 1);
    return a * (1 - sx) * (1 - sy) + b * sx * (1 - sy) + c * (1 - sx) * sy + d * sx * sy;
  };

  const data = new Float32Array(cells * cells);
  let min_m = Infinity;
  let max_m = -Infinity;
  for (let j = 0; j < cells; j++) {
    // Row 0 is the SOUTH edge: north is +Y (CLAUDE.md).
    const lat = bbox.south + ((bbox.north - bbox.south) * j) / (cells - 1);
    for (let i = 0; i < cells; i++) {
      const lon = bbox.west + ((bbox.east - bbox.west) * i) / (cells - 1);
      const v = sample(lon, lat);
      data[j * cells + i] = v;
      if (v < min_m) min_m = v;
      if (v > max_m) max_m = v;
    }
  }

  const midLat = (bbox.north + bbox.south) / 2;
  const width_m = (bbox.east - bbox.west) * 111320 * Math.cos((midLat * Math.PI) / 180);
  const height_m = (bbox.north - bbox.south) * 110574;

  return {
    cols: cells, rows: cells, data,
    spacingX_m: width_m / (cells - 1),
    spacingY_m: height_m / (cells - 1),
    min_m, max_m,
  };
}
