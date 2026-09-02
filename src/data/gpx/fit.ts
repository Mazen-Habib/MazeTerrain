/**
 * FIT -> route points.
 *
 * Garmin and Wahoo devices write `.fit` natively. Today a user with a watch has
 * to convert the file somewhere else before Peakora will look at it, which
 * is exactly the friction a Strava import was supposed to remove — and Strava's
 * 2026 developer tiers put that out of reach (OPEN-QUESTIONS Q4). Reading the
 * file directly needs nobody's permission and helps people who never touch
 * Strava.
 *
 * ## Why this is hand-rolled
 *
 * The official SDK decodes the entire FIT profile: hundreds of message types,
 * developer fields, every unit conversion. We want **four fields of one message
 * type** — latitude, longitude, altitude and timestamp of `record` (global
 * message 20). The rest of the file is skipped by declared field length without
 * ever being interpreted, which is what keeps this short enough to read.
 *
 * ## The format, briefly
 *
 * A 12- or 14-byte header, then a stream of records. Every record starts with
 * one header byte saying whether it is a *definition* (here is the shape of
 * local type N) or *data* (here is a value of local type N). A definition
 * carries its own byte order, so the same file can mix endiannesses — that is
 * not a hypothetical, it is per-message in the spec.
 *
 * Positions are **semicircles**: a signed 32-bit integer covering the full
 * circle, so degrees = value x 180 / 2^31. Getting this constant wrong puts the
 * route in the wrong hemisphere rather than slightly off, so it is checked in
 * `tests/fit.test.ts` against a known coordinate.
 */
import type { RoutePoint } from './types';

export class FitParseError extends Error {
  readonly userMessage: string;
  constructor(userMessage: string) {
    super(userMessage);
    this.name = 'FitParseError';
    this.userMessage = userMessage;
  }
}

/** Global message number for `record`, the one that carries track points. */
const MESG_RECORD = 20;

/** Field definition numbers within `record`. */
const FIELD_POSITION_LAT = 0;
const FIELD_POSITION_LONG = 1;
const FIELD_ALTITUDE = 2;
const FIELD_TIMESTAMP = 253;
/**
 * `enhanced_altitude` — same quantity, wider range.
 *
 * Devices that record below sea level or above 6 553 m write this instead,
 * because plain `altitude` is a uint16 that cannot hold either. Files often
 * carry both; enhanced wins where present.
 */
const FIELD_ENHANCED_ALTITUDE = 78;

/** Semicircles to degrees. */
const SEMICIRCLE_DEG = 180 / 2 ** 31;

/**
 * FIT epoch: 1989-12-31T00:00:00Z, in milliseconds since the Unix epoch.
 *
 * Twenty years and change off Unix. A file read against the wrong epoch still
 * parses and still draws — the points are simply dated 1970, which is only
 * visible if something downstream uses time. The spike filter does.
 */
const FIT_EPOCH_MS = Date.UTC(1989, 11, 31);

// There is deliberately no base-type size table here. Every field carries its
// own declared size in the definition message, and that is the authority: an
// array field (say three uint16s) has base type uint16 and size 6, so a table
// lookup would skip four bytes and desynchronise the rest of the message.

/**
 * The "no reading" sentinel for each base type.
 *
 * FIT has no nulls. Every base type reserves its top value to mean "this field
 * was in the message but the device had nothing to put in it" — a GPS fix not
 * yet acquired, most often at the very start of a ride. Treating those as real
 * would put the first few points of a route at latitude 214 degrees.
 */
const INVALID: Record<number, number> = {
  0: 0xff, // enum
  1: 0x7f, // sint8
  2: 0xff, // uint8
  3: 0x7fff, // sint16
  4: 0xffff, // uint16
  5: 0x7fffffff, // sint32
  6: 0xffffffff, // uint32
  10: 0x00, // uint8z — zero is the invalid one for the z types
  11: 0x0000, // uint16z
  12: 0x00000000, // uint32z
};

interface FieldDef {
  number: number;
  size: number;
  baseType: number;
}

interface MessageDef {
  globalNumber: number;
  littleEndian: boolean;
  fields: FieldDef[];
  /** Total bytes of developer fields, which are skipped wholesale. */
  developerBytes: number;
}

/** Read one integer field, or null if it is the base type's invalid value. */
function readInt(
  view: DataView,
  offset: number,
  field: FieldDef,
  littleEndian: boolean,
): number | null {
  const type = field.baseType & 0x1f;
  let value: number;
  switch (type) {
    case 0:
    case 2:
    case 10:
      value = view.getUint8(offset);
      break;
    case 1:
      value = view.getInt8(offset);
      break;
    case 3:
      value = view.getInt16(offset, littleEndian);
      break;
    case 4:
    case 11:
      value = view.getUint16(offset, littleEndian);
      break;
    case 5:
      value = view.getInt32(offset, littleEndian);
      break;
    case 6:
    case 12:
      value = view.getUint32(offset, littleEndian);
      break;
    case 8:
      value = view.getFloat32(offset, littleEndian);
      return Number.isFinite(value) ? value : null;
    case 9:
      value = view.getFloat64(offset, littleEndian);
      return Number.isFinite(value) ? value : null;
    default:
      // A string, a byte array, or a 64-bit type. Not something `record`
      // carries in the four fields we read, and skipped by size by the caller.
      return null;
  }
  const invalid = INVALID[type];
  return invalid !== undefined && value === invalid ? null : value;
}

/**
 * Decode a FIT file into track points.
 *
 * Points with no GPS fix are dropped rather than interpolated — a device that
 * did not know where it was is not a data point, and inventing one puts a
 * straight line across the map from wherever the ride started.
 */
export function parseFit(buffer: ArrayBuffer, filename: string): RoutePoint[] {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  if (bytes.length < 14) {
    throw new FitParseError(`${filename} is too short to be a FIT file.`);
  }

  // Signature BEFORE header size, because the common mistake is a renamed GPX
  // and it fails both checks. Byte 0 of `<?xml` is 60, so a size-first order
  // reports "does not start with a FIT header" — true, unhelpful, and no clue
  // that the fix is to rename the file back. The ".FIT" signature sits at byte
  // 8 of the header rather than at the start of the file.
  const signature = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
  if (signature !== '.FIT') {
    throw new FitParseError(
      `${filename} is not a FIT file — it may be a GPX or TCX with the wrong extension.`,
    );
  }

  const headerSize = bytes[0];
  if (headerSize !== 12 && headerSize !== 14) {
    throw new FitParseError(`${filename} has a FIT signature but an unreadable header.`);
  }

  const dataSize = view.getUint32(4, true);
  // Trust whichever is smaller. A truncated download reports the length it was
  // supposed to have, and reading to it walks off the end of the buffer.
  const end = Math.min(headerSize + dataSize, bytes.length);

  const definitions = new Map<number, MessageDef>();
  const points: RoutePoint[] = [];

  let offset = headerSize;
  while (offset < end) {
    const header = bytes[offset++];

    // Bit 7 set means a compressed timestamp header, which is always a DATA
    // message and packs the local type into bits 5-6 rather than 0-3. Files
    // from older devices are full of these; reading the local type from the
    // wrong bits picks up a definition that does not exist and the parse ends
    // one record in.
    const compressed = (header & 0x80) !== 0;
    const isDefinition = !compressed && (header & 0x40) !== 0;
    const localType = compressed ? (header >> 5) & 0x03 : header & 0x0f;

    if (isDefinition) {
      if (offset + 5 > end) break;
      offset++; // reserved
      const littleEndian = bytes[offset++] === 0;
      const globalNumber = view.getUint16(offset, littleEndian);
      offset += 2;
      const fieldCount = bytes[offset++];

      const fields: FieldDef[] = [];
      for (let i = 0; i < fieldCount && offset + 3 <= end; i++) {
        fields.push({
          number: bytes[offset],
          size: bytes[offset + 1],
          baseType: bytes[offset + 2],
        });
        offset += 3;
      }

      // Developer fields: application-defined values appended to a standard
      // message. We never read them, but their bytes are in every data message
      // of this local type and must be counted or every field after them is
      // read at the wrong offset.
      let developerBytes = 0;
      if ((header & 0x20) !== 0 && offset < end) {
        const devCount = bytes[offset++];
        for (let i = 0; i < devCount && offset + 3 <= end; i++) {
          developerBytes += bytes[offset + 1];
          offset += 3;
        }
      }

      definitions.set(localType, { globalNumber, littleEndian, fields, developerBytes });
      continue;
    }

    const def = definitions.get(localType);
    if (!def) {
      // A data message for a local type never defined. The stream is no longer
      // interpretable — there is no way to know how many bytes to skip — so
      // stop and keep what was read rather than guessing and returning noise.
      break;
    }

    // A compressed-timestamp record carries its 5-bit offset in the header
    // byte, which is already consumed. Nothing else changes about the body.
    let cursor = offset;
    let lat: number | null = null;
    let lon: number | null = null;
    let altitude: number | null = null;
    let enhanced: number | null = null;
    let timestamp: number | null = null;

    for (const field of def.fields) {
      if (cursor + field.size > end) {
        cursor = end;
        break;
      }
      if (def.globalNumber === MESG_RECORD) {
        switch (field.number) {
          case FIELD_POSITION_LAT:
            lat = readInt(view, cursor, field, def.littleEndian);
            break;
          case FIELD_POSITION_LONG:
            lon = readInt(view, cursor, field, def.littleEndian);
            break;
          case FIELD_ALTITUDE:
            altitude = readInt(view, cursor, field, def.littleEndian);
            break;
          case FIELD_ENHANCED_ALTITUDE:
            enhanced = readInt(view, cursor, field, def.littleEndian);
            break;
          case FIELD_TIMESTAMP:
            timestamp = readInt(view, cursor, field, def.littleEndian);
            break;
        }
      }
      cursor += field.size;
    }

    offset = Math.min(cursor + def.developerBytes, end);

    if (def.globalNumber !== MESG_RECORD || lat === null || lon === null) continue;

    const point: RoutePoint = {
      lon: lon * SEMICIRCLE_DEG,
      lat: lat * SEMICIRCLE_DEG,
    };

    // Both altitude fields are stored as (metres + 500) x 5, so a reading of
    // 2500 is sea level. Applying the scale without the offset puts every
    // route half a kilometre in the air.
    const raw = enhanced ?? altitude;
    if (raw !== null) point.ele = raw / 5 - 500;
    if (timestamp !== null) point.t = FIT_EPOCH_MS + timestamp * 1000;

    // A device with no fix writes the invalid sentinel, which `readInt` already
    // turned into null. This catches the other failure: a plausible integer
    // that is not a plausible place.
    if (Math.abs(point.lat) > 90 || Math.abs(point.lon) > 180) continue;

    points.push(point);
  }

  if (points.length < 2) {
    throw new FitParseError(
      `${filename} contains no GPS track — it may be an indoor or trainer activity.`,
    );
  }

  return points;
}
