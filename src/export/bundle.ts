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

  return (
    `${options.slug} — ${Math.round(options.modelWidth_mm)} mm model\n` +
    `${'='.repeat(40)}\n\n` +
    `This model prints as ${parts.length} separate ${parts.length === 1 ? 'part' : 'parts'}:\n\n` +
    `${bodies.join('\n')}\n\n` +
    `How to print\n` +
    `------------\n` +
    `Print each file separately, in whichever filament you want that part to be.\n` +
    `Every part shares one origin and is already in position, so do NOT move or\n` +
    `rotate them in the slicer if you want them to fit.\n\n` +
    `The route insert has a flat underside and sits in the channel cut into the\n` +
    `terrain. It needs no supports.\n\n` +
    `Assembly\n` +
    `--------\n` +
    `The insert is undersized by ${options.clearance_mm} mm per side, so it should press in\n` +
    `with light pressure. If it will not seat, increase the clearance and\n` +
    `re-export rather than forcing it. If it rattles, reduce the clearance.\n` +
    `A drop of glue in the channel holds it permanently.\n\n` +
    `${attributionText(options.version)}`
  );
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
