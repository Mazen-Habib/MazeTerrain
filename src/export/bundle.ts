/**
 * Multi-part STL bundle (docs/09-roadmap.md, Phase 3).
 *
 * Phase 3's definition of done is "a user with a single-extruder printer
 * produces a two-tone route model by printing two parts and pressing them
 * together". A single STL cannot express that: it has no concept of parts, so
 * the terrain and the insert would arrive merged into one body and the user
 * would have to separate them by hand — which is precisely the work the cutout
 * mode exists to save.
 *
 * So the cutout modes export a ZIP: one STL per body, plus a README that says
 * which is which and how they go together. 3MF would carry the same geometry in
 * one file, but a single-extruder workflow is two separate prints in two
 * filaments, and two files match that better than one file the user has to
 * split in the slicer.
 */
import { zipSync, type Zippable } from 'fflate';
import { writeBinarySTL, stlHeader } from './stl';
import { attributionText } from './threemf';
import type { MeshPart } from '../geometry/types';

/** A filename-safe version of a part name. */
function slugPart(name: string): string {
  return name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'part';
}

/** Human-readable name for a part, matching what the 3MF export calls it. */
function label(part: MeshPart): string {
  // `tile:A1:roads` reads as "Piece A1 — roads", not "Tile:A1:roads".
  if (part.name.startsWith('tile:')) {
    const [, piece, layer] = part.name.split(':');
    return layer ? `Piece ${piece} — ${layer}` : `Piece ${piece}`;
  }
  if (part.name.startsWith('insert:')) {
    const index = Number(part.name.slice('insert:'.length));
    return Number.isFinite(index) ? `Route insert ${index + 1}` : 'Route insert';
  }
  if (part.name.startsWith('route:')) {
    const index = Number(part.name.slice('route:'.length));
    return Number.isFinite(index) ? `Route ${index + 1}` : 'Route';
  }
  if (part.name === 'model') return 'Terrain';
  return part.name.charAt(0).toUpperCase() + part.name.slice(1);
}

export interface BundleOptions {
  slug: string;
  modelWidth_mm: number;
  clearance_mm: number;
  version?: string;
}

/**
 * The reassembly note.
 *
 * The clearance is the number that decides whether the insert seats, so it is
 * stated rather than left implicit — a print that comes out too tight is fixed
 * by changing it, and the user cannot do that without knowing what it was.
 */
export function readmeText(parts: MeshPart[], options: BundleOptions): string {
  const bodies = parts.map((p, i) => `  ${i + 1}. ${stlName(p, options.slug)} — ${label(p)}`);
  const hasInsert = parts.some((p) => p.name.startsWith('insert'));
  const tiles = [
    ...new Set(parts.filter((p) => p.name.startsWith('tile:')).map((p) => p.name.split(':')[1])),
  ].sort();

  // Each file is placed flat on the bed, so they no longer share one origin in
  // Z. The note here used to say they did, which stopped being true the day
  // separately-printed parts started being dropped onto the plate.
  const printing = [
    'How to print',
    '------------',
    'Print each file separately, in whichever filament you want that part to be.',
    'Each one is already sitting flat on the bed, so it needs no rotating and no',
    '"place on face" — but do NOT scale any of them, or nothing will fit.',
    '',
  ];

  const tileSection =
    tiles.length > 0
      ? [
          `This model is too big for one bed, so it is cut into ${tiles.length} pieces:`,
          `${tiles.join(', ')}. The letter is the column from the left and the number`,
          'is the row from the front, so A1 is the front-left piece.',
          '',
          'Joining the pieces',
          '------------------',
          'Each seam has alignment pins: a peg on one piece, a socket on the other,',
          'down in the base where they never show. Dry-fit the whole set before',
          'gluing — the pins locate it, so a piece that will not sit flush is a',
          'piece in the wrong place. They are a press fit with 0.15 mm clearance;',
          'if one is tight, a twist of sandpaper on the peg is enough.',
          '',
          'Glue the seams once the set is dry-fitted. Model cement or cyanoacrylate',
          'both work on PLA.',
          '',
        ]
      : [];

  const insertSection = hasInsert
    ? [
        'The route insert has a flat underside and sits in the channel cut into the',
        'terrain. It needs no supports.',
        '',
        'Assembly',
        '--------',
        `The insert is undersized by ${options.clearance_mm} mm per side, so it should press in`,
        'with light pressure. If it will not seat, increase the clearance and',
        're-export rather than forcing it. If it rattles, reduce the clearance.',
        'A drop of glue in the channel holds it permanently.',
        '',
      ]
    : [];

  return [
    `${options.slug} — ${Math.round(options.modelWidth_mm)} mm model`,
    '='.repeat(40),
    '',
    tiles.length > 0
      ? `This model prints as ${tiles.length} pieces, in ${parts.length} files ` +
        `(one per colour per piece):`
      : `This model prints as ${parts.length} separate ${parts.length === 1 ? 'part' : 'parts'}:`,
    '',
    ...bodies,
    '',
    ...printing,
    ...tileSection,
    ...insertSection,
    attributionText(options.version),
  ].join('\n');
}

function stlName(part: MeshPart, slug: string): string {
  return `${slug}-${slugPart(part.name)}.stl`;
}

/**
 * One STL per part, plus a README, in a ZIP.
 *
 * Each part is written as its own STL rather than merged, which is the entire
 * point — see the module note.
 */
export function writePartBundle(parts: MeshPart[], options: BundleOptions): ArrayBuffer {
  const encoder = new TextEncoder();
  const files: Zippable = {
    'README.txt': encoder.encode(readmeText(parts, options)),
  };

  for (const part of parts) {
    // Each STL keeps the attribution header, so a file that gets separated from
    // the ZIP still carries it.
    files[stlName(part, options.slug)] = new Uint8Array(
      writeBinarySTL([part], stlHeader(options.version)),
    );
  }

  const zipped = zipSync(files);
  return zipped.buffer.slice(
    zipped.byteOffset,
    zipped.byteOffset + zipped.byteLength,
  ) as ArrayBuffer;
}

export function bundleFilename(
  slug: string,
  modelWidth_mm: number,
  date = new Date(),
): string {
  return `${slug}-${Math.round(modelWidth_mm)}mm-${date.toISOString().slice(0, 10)}-parts.zip`;
}
