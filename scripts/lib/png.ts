/**
 * Minimal PNG reader, for diagnostics only.
 *
 * The app decodes DEM tiles with `createImageBitmap`, which does not exist in
 * Node, so none of the elevation path can be measured from a script. This is
 * enough of a decoder to read an 8-bit RGB(A) terrarium tile: inflate the IDAT
 * stream (fflate is already a dependency) and undo the per-scanline filters.
 *
 * Not for production — the app should keep using the platform decoder.
 */
import { unzlibSync } from 'fflate';

export interface DecodedPng {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel. */
  data: Uint8Array;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function decodePng(bytes: Uint8Array): DecodedPng {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (const [i, b] of [137, 80, 78, 71, 13, 10, 26, 10].entries()) {
    if (bytes[i] !== b) throw new Error('not a PNG');
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Uint8Array[] = [];

  let offset = 8;
  while (offset < bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const body = bytes.subarray(offset + 8, offset + 8 + length);

    if (type === 'IHDR') {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      bitDepth = bytes[offset + 16];
      colorType = bytes[offset + 17];
      if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`);
      if (colorType !== 2 && colorType !== 6) throw new Error(`unsupported colour type ${colorType}`);
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  const merged = new Uint8Array(idat.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const chunk of idat) {
    merged.set(chunk, at);
    at += chunk.length;
  }

  const raw = unzlibSync(merged);
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const out = new Uint8Array(width * height * 4);
  const line = new Uint8Array(stride);
  const previous = new Uint8Array(stride);

  let src = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[src++];
    line.set(raw.subarray(src, src + stride));
    src += stride;

    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = previous[i];
      const c = i >= channels ? previous[i - channels] : 0;
      switch (filter) {
        case 1: line[i] = (line[i] + a) & 0xff; break;
        case 2: line[i] = (line[i] + b) & 0xff; break;
        case 3: line[i] = (line[i] + ((a + b) >> 1)) & 0xff; break;
        case 4: line[i] = (line[i] + paeth(a, b, c)) & 0xff; break;
        default: break; // 0: none
      }
    }

    for (let x = 0; x < width; x++) {
      const s = x * channels;
      const d = (y * width + x) * 4;
      out[d] = line[s];
      out[d + 1] = line[s + 1];
      out[d + 2] = line[s + 2];
      out[d + 3] = channels === 4 ? line[s + 3] : 255;
    }
    previous.set(line);
  }

  return { width, height, data: out };
}
