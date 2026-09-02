/**
 * 3MF writer (docs/06-export-formats.md).
 *
 * This is the format that delivers the multicolour promise: STL has no concept
 * of parts, so a city model exported as STL is one grey blob and the user has
 * to split it by hand. 3MF keeps each layer as its own object with its own
 * material, which slicers turn into pre-assigned filament slots.
 *
 * The single detail that matters most is `pid` + `pindex` on the `<object>`
 * element. Without it Bambu Studio and PrusaSlicer both open the file as one
 * grey blob even though the materials are present and correct — prior art in
 * this space shipped that bug and took a release to notice
 * (docs/06-export-formats.md, "Critical details").
 */
import { zipSync, type Zippable } from 'fflate';
import { TERRAIN_BANDS } from '../geometry/palette';
import type { MeshPart } from '../geometry/types';

const CORE_NS = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
const MATERIAL_NS = 'http://schemas.microsoft.com/3dmanufacturing/material/2015/02';

/** Resource id of the one basematerials group. Object ids start after it. */
const MATERIALS_ID = 1;

/**
 * Deflate level. docs/06-export-formats.md: 6 is the size/time knee — 9 doubles
 * the time for about 2% on mesh XML, which is already highly repetitive.
 */
const DEFLATE_LEVEL = 6;

/** Attribution is legally required, not decorative (CLAUDE.md, Data). */
export function attributionText(version = '0.1.0'): string {
  return (
    `Made with Peakora ${version}.\n\n` +
    `Map data © OpenStreetMap contributors, available under the Open Database ` +
    `License (ODbL). https://www.openstreetmap.org/copyright\n\n` +
    `Elevation: Copernicus DEM © DLR e.V. 2010-2014 and © Airbus Defence and ` +
    `Space GmbH 2014-2018, provided under COPERNICUS by the European Union and ` +
    `ESA, all rights reserved.\n`
  );
}

/** A layer name a person would recognise on a filament slot. */
function materialName(part: MeshPart): string {
  if (part.name.startsWith('route:')) {
    const index = Number(part.name.slice('route:'.length));
    return Number.isFinite(index) ? `Route ${index + 1}` : 'Route';
  }
  return part.name.charAt(0).toUpperCase() + part.name.slice(1);
}

/**
 * `#RRGGBB` to the `#RRGGBBAA` 3MF wants.
 *
 * The alpha byte is not optional in practice: some parsers reject a six-digit
 * displaycolor outright (docs/06-export-formats.md).
 */
export function displayColor(hex: string): string {
  const clean = hex.trim().replace(/^#/, '');
  const rgb = clean.length === 3
    ? clean.split('').map((c) => c + c).join('')
    : clean.slice(0, 6).padEnd(6, '0');
  return `#${rgb.toUpperCase()}FF`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Trim float noise without losing print precision: 1 µm is far below a nozzle. */
function num(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return (Math.round(value * 1000) / 1000).toString();
}

/**
 * Collects XML as UTF-8, encoding each chunk as it arrives.
 *
 * Deliberately not building one string and encoding at the end. A 750 000
 * triangle model is 134 MB of XML, and holding that as a JavaScript string
 * *and* as bytes at the same time is the documented way to run the tab out of
 * memory (docs/06-export-formats.md, "ZIP writing"). Encoding on push means
 * each string is collectable as soon as it has been written.
 */
class XmlSink {
  private readonly encoder = new TextEncoder();
  private readonly parts: Uint8Array[] = [];
  private length = 0;

  push(chunk: string): void {
    const bytes = this.encoder.encode(chunk);
    this.parts.push(bytes);
    this.length += bytes.length;
  }

  toBytes(): Uint8Array {
    const out = new Uint8Array(this.length);
    let offset = 0;
    for (const bytes of this.parts) {
      out.set(bytes, offset);
      offset += bytes.length;
    }
    return out;
  }
}

/**
 * Vertices and triangles for one part, as XML chunks.
 *
 * @param bandBase index of the first hypsometric material in the base-materials
 *   list, or null when this part carries no bands. A banded part writes `pid`
 *   and `p1` on every triangle; the object's own `pindex` is then just a
 *   fallback for a reader that ignores per-triangle properties.
 */
function meshChunks(part: MeshPart, chunks: XmlSink, bandBase: number | null): void {
  const { positions, indices } = part;

  chunks.push('   <mesh>\n    <vertices>\n');
  // One chunk per few thousand vertices: small enough not to hold a huge string,
  // large enough that the per-chunk overhead stays irrelevant.
  let buffer = '';
  for (let i = 0; i < positions.length; i += 3) {
    buffer +=
      `     <vertex x="${num(positions[i])}" y="${num(positions[i + 1])}" ` +
      `z="${num(positions[i + 2])}"/>\n`;
    if (buffer.length > 65536) {
      chunks.push(buffer);
      buffer = '';
    }
  }
  if (buffer) chunks.push(buffer);

  chunks.push('    </vertices>\n    <triangles>\n');
  buffer = '';
  const bands = bandBase !== null ? part.bands : undefined;
  for (let i = 0; i < indices.length; i += 3) {
    const face = `v1="${indices[i]}" v2="${indices[i + 1]}" v3="${indices[i + 2]}"`;
    // `pid` + `p1` per triangle is how 3MF says "this face is that material",
    // which is what puts a snowline on a model without splitting the mesh.
    buffer += bands
      ? `     <triangle ${face} pid="${MATERIALS_ID}" p1="${(bandBase ?? 0) + (bands[i / 3] ?? 0)}"/>\n`
      : `     <triangle ${face}/>\n`;
    if (buffer.length > 65536) {
      chunks.push(buffer);
      buffer = '';
    }
  }
  if (buffer) chunks.push(buffer);

  chunks.push('    </triangles>\n   </mesh>\n');
}

export interface ThreeMFOptions {
  version?: string;
  /** Overrides the generated description, for tests. */
  description?: string;
}

/** The `3D/3dmodel.model` document. Exported so tests can read it directly. */
export function buildModelXml(parts: MeshPart[], options: ThreeMFOptions = {}): Uint8Array {
  const version = options.version ?? '0.1.0';
  const description =
    options.description ??
    '© OpenStreetMap contributors; Copernicus DEM © DLR e.V. / Airbus DS';

  const chunks = new XmlSink();
  chunks.push(
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
      `<model unit="millimeter" xml:lang="en-US" xmlns="${CORE_NS}" xmlns:m="${MATERIAL_NS}">\n` +
      ` <metadata name="Application">Peakora ${escapeXml(version)}</metadata>\n` +
      ` <metadata name="Description">${escapeXml(description)}</metadata>\n` +
      ' <metadata name="LicenseTerms">Map data ODbL, © OpenStreetMap contributors</metadata>\n' +
      ' <resources>\n',
  );

  // One material per part, then — when anything is banded — one per hypsometric
  // band appended AFTER them. Appended rather than interleaved so a part's own
  // material index stays equal to its position in `parts`, which the object's
  // `pindex` below depends on.
  const banded = parts.some((part) => part.bands && part.bands.length > 0);
  const bandBase = banded ? parts.length : null;

  chunks.push(`  <m:basematerials id="${MATERIALS_ID}">\n`);
  for (const part of parts) {
    chunks.push(
      `   <m:base name="${escapeXml(materialName(part))}" ` +
        `displaycolor="${displayColor(part.color)}"/>\n`,
    );
  }
  if (banded) {
    for (const band of TERRAIN_BANDS) {
      chunks.push(
        `   <m:base name="${escapeXml(band.name)}" ` +
          `displaycolor="${displayColor(band.color)}"/>\n`,
      );
    }
  }
  chunks.push('  </m:basematerials>\n');

  parts.forEach((part, index) => {
    const objectId = MATERIALS_ID + 1 + index;
    // pid/pindex here, on the object, is what pre-assigns the filament.
    chunks.push(
      `  <object id="${objectId}" type="model" name="${escapeXml(materialName(part))}" ` +
        `pid="${MATERIALS_ID}" pindex="${index}">\n`,
    );
    meshChunks(part, chunks, part.bands && part.bands.length > 0 ? bandBase : null);
    chunks.push('  </object>\n');
  });

  chunks.push(' </resources>\n <build>\n');
  parts.forEach((_, index) => {
    // No transform: every part is already in its final position in one shared
    // frame, and slicers handle per-item transforms inconsistently.
    chunks.push(`  <item objectid="${MATERIALS_ID + 1 + index}"/>\n`);
  });
  chunks.push(' </build>\n</model>\n');

  return chunks.toBytes();
}

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n' +
  ' <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n' +
  ' <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n' +
  ' <Default Extension="txt" ContentType="text/plain"/>\n' +
  '</Types>\n';

const RELS =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n' +
  ' <Relationship Id="rel0" Target="/3D/3dmodel.model" ' +
  'Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n' +
  '</Relationships>\n';

/**
 * Write parts as a 3MF container.
 *
 * Parts keep their identity: one object and one material each, so a slicer
 * opens the model with the layers already separated.
 */
export function writeThreeMF(parts: MeshPart[], options: ThreeMFOptions = {}): ArrayBuffer {
  const encoder = new TextEncoder();

  const files: Zippable = {
    // Order matters to some readers: the content types and relationships are
    // expected before the payload they describe.
    '[Content_Types].xml': [encoder.encode(CONTENT_TYPES), { level: DEFLATE_LEVEL }],
    '_rels/.rels': [encoder.encode(RELS), { level: DEFLATE_LEVEL }],
    '3D/3dmodel.model': [buildModelXml(parts, options), { level: DEFLATE_LEVEL }],
    'README.txt': [encoder.encode(attributionText(options.version)), { level: DEFLATE_LEVEL }],
  };

  const zipped = zipSync(files);
  // Hand back a plain ArrayBuffer, so callers can Blob it without a copy.
  return zipped.buffer.slice(
    zipped.byteOffset,
    zipped.byteOffset + zipped.byteLength,
  ) as ArrayBuffer;
}

/** Same naming rules as the STL export, different extension. */
export function threeMFFilename(
  placeSlug: string,
  modelWidth_mm: number,
  date = new Date(),
): string {
  const stamp = date.toISOString().slice(0, 10);
  return `${placeSlug}-${Math.round(modelWidth_mm)}mm-${stamp}.3mf`;
}
