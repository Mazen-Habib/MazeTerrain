/**
 * Draw the stroke font to a PNG so it can be looked at.
 *
 * Glyph data is coordinates typed by hand. No test catches a letter that is
 * simply the wrong shape, so the only honest check is to render it and look.
 */
import { writeFileSync } from 'node:fs';
import { encodePng } from './lib/png';
import { layoutText } from '../src/geometry/strokeFont';

const lines = [
  'ABCDEFGHIJKLM',
  'NOPQRSTUVWXYZ',
  '0123456789',
  '.,-\u2013\'"\u00b0/():\u00d7+=!?&#_\u00b7',
  'MARGALLA TRAIL 5',
  '42.2 KM \u00b7 1,860 M GAIN',
  '33.7\u00b0N 73.1\u00b0E',
];

const cap = 26;
const gap = 18;
const pad = 16;

type Seg = [number, number, number, number];
const segments: Seg[] = [];
let y = pad + cap;
let widest = 0;

for (const line of lines) {
  const laid = layoutText(line, cap);
  widest = Math.max(widest, laid.width_mm);
  if (laid.missing.length > 0) console.log(`missing glyphs in "${line}": ${laid.missing.join(' ')}`);
  for (const path of laid.paths) {
    for (let i = 0; i + 1 < path.length; i++) {
      segments.push([pad + path[i][0], y - path[i][1], pad + path[i + 1][0], y - path[i + 1][1]]);
    }
  }
  y += cap + gap;
}

const width = Math.ceil(widest + pad * 2);
const height = Math.ceil(y);
const rgba = new Uint8Array(width * height * 4).fill(255);

/** Anti-aliased line, drawn by coverage over a small radius. */
function stroke(x0: number, y0: number, x1: number, y1: number, radius: number): void {
  const minX = Math.max(0, Math.floor(Math.min(x0, x1) - radius - 1));
  const maxX = Math.min(width - 1, Math.ceil(Math.max(x0, x1) + radius + 1));
  const minY = Math.max(0, Math.floor(Math.min(y0, y1) - radius - 1));
  const maxY = Math.min(height - 1, Math.ceil(Math.max(y0, y1) + radius + 1));
  const dx = x1 - x0;
  const dy = y1 - y0;
  const lenSq = dx * dx + dy * dy;

  for (let py = minY; py <= maxY; py++) {
    for (let px = minX; px <= maxX; px++) {
      const t = lenSq > 0 ? Math.max(0, Math.min(1, ((px + 0.5 - x0) * dx + (py + 0.5 - y0) * dy) / lenSq)) : 0;
      const d = Math.hypot(px + 0.5 - (x0 + dx * t), py + 0.5 - (y0 + dy * t));
      const cover = Math.max(0, Math.min(1, radius + 0.5 - d));
      if (cover <= 0) continue;
      const i = (py * width + px) * 4;
      for (let c = 0; c < 3; c++) rgba[i + c] = Math.round(rgba[i + c] * (1 - cover));
    }
  }
}

for (const [x0, y0, x1, y1] of segments) stroke(x0, y0, x1, y1, 1.1);

const out = process.argv[2] ?? 'font-proof.png';
writeFileSync(out, encodePng(width, height, rgba));
console.log(`wrote ${out}, ${width} x ${height}, ${segments.length} segments`);
