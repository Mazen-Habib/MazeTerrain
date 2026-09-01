/**
 * FIT decoding.
 *
 * There is no sample `.fit` in the repo, so the fixtures are built here byte by
 * byte. That is the better test anyway: a recorded file exercises whatever one
 * device happened to write, while a builder can produce the cases that actually
 * break parsers — a big-endian definition, developer fields, a compressed
 * timestamp header, a missing GPS fix — none of which appear in a clean ride.
 *
 * The constants are stated here independently of the module. If
 * `SEMICIRCLE_DEG` or the FIT epoch is wrong in one place, these disagree.
 */
import { describe, expect, it } from 'vitest';
import { FitParseError, parseFit } from '../src/data/gpx/fit';

// --- fixture builder -------------------------------------------------------

/** Base type ids, with the 0x80 "endian ability" bit the spec sets on them. */
const T_UINT8 = 0x02;
const T_UINT16 = 0x84;
const T_SINT32 = 0x85;
const T_UINT32 = 0x86;

interface Field {
  number: number;
  size: number;
  baseType: number;
}

function definition(
  localType: number,
  globalNumber: number,
  fields: Field[],
  options: { littleEndian?: boolean; developerFields?: Array<{ size: number }> } = {},
): number[] {
  const littleEndian = options.littleEndian ?? true;
  const dev = options.developerFields ?? [];
  const header = 0x40 | localType | (dev.length > 0 ? 0x20 : 0);

  const global = littleEndian
    ? [globalNumber & 0xff, (globalNumber >> 8) & 0xff]
    : [(globalNumber >> 8) & 0xff, globalNumber & 0xff];

  const out = [header, 0, littleEndian ? 0 : 1, ...global, fields.length];
  for (const f of fields) out.push(f.number, f.size, f.baseType);
  if (dev.length > 0) {
    out.push(dev.length);
    // field number, size, developer data index
    for (const d of dev) out.push(0, d.size, 0);
  }
  return out;
}

function int(value: number, size: number, littleEndian = true): number[] {
  const buf = new ArrayBuffer(size);
  const view = new DataView(buf);
  if (size === 1) view.setUint8(0, value & 0xff);
  else if (size === 2) view.setUint16(0, value & 0xffff, littleEndian);
  else view.setUint32(0, value >>> 0, littleEndian);
  return Array.from(new Uint8Array(buf));
}

/** Wrap record bytes in a valid 12-byte FIT header plus a CRC placeholder. */
function fitFile(body: number[], overrides: { dataSize?: number; signature?: string } = {}): ArrayBuffer {
  const dataSize = overrides.dataSize ?? body.length;
  const signature = overrides.signature ?? '.FIT';
  const header = [12, 0x20, 0x00, 0x00, ...int(dataSize, 4), ...signature.split('').map((c) => c.charCodeAt(0))];
  const bytes = Uint8Array.from([...header, ...body, 0, 0]);
  return bytes.buffer;
}

// --- the numbers, stated independently of the module -----------------------

/** Zermatt, 46.0207 N 7.7491 E, in semicircles (degrees x 2^31 / 180). */
const ZERMATT_LAT_SEMI = 549048337;
const ZERMATT_LON_SEMI = 92450364;

/** 1620 m, stored as (metres + 500) x 5. */
const ALT_1620_RAW = (1620 + 500) * 5;

/** The FIT epoch is 1989-12-31T00:00:00Z. */
const FIT_EPOCH_MS = Date.UTC(1989, 11, 31);

const RECORD_FIELDS: Field[] = [
  { number: 0, size: 4, baseType: T_SINT32 }, // position_lat
  { number: 1, size: 4, baseType: T_SINT32 }, // position_long
  { number: 2, size: 2, baseType: T_UINT16 }, // altitude
  { number: 253, size: 4, baseType: T_UINT32 }, // timestamp
];

function recordData(
  lat: number,
  lon: number,
  alt: number,
  timestamp: number,
  littleEndian = true,
  localType = 0,
): number[] {
  return [
    localType,
    ...int(lat, 4, littleEndian),
    ...int(lon, 4, littleEndian),
    ...int(alt, 2, littleEndian),
    ...int(timestamp, 4, littleEndian),
  ];
}

// --- tests -----------------------------------------------------------------

describe('a plain FIT track', () => {
  const seconds = 1_150_000_000;
  const file = fitFile([
    ...definition(0, 20, RECORD_FIELDS),
    ...recordData(ZERMATT_LAT_SEMI, ZERMATT_LON_SEMI, ALT_1620_RAW, seconds),
    ...recordData(ZERMATT_LAT_SEMI + 100_000, ZERMATT_LON_SEMI, ALT_1620_RAW + 50, seconds + 5),
  ]);

  const points = parseFit(file, 'ride.fit');

  /**
   * The constant that matters most. A wrong semicircle factor does not nudge a
   * route — it puts it in a different hemisphere, and the model builds happily
   * around empty ocean.
   */
  it('converts semicircles to degrees', () => {
    expect(points).toHaveLength(2);
    expect(points[0].lat).toBeCloseTo(46.0207, 4);
    expect(points[0].lon).toBeCloseTo(7.7491, 4);
  });

  /** Scale AND offset. Applying only the scale puts the route 500 m up. */
  it('applies the altitude scale and offset', () => {
    expect(points[0].ele).toBeCloseTo(1620, 6);
    expect(points[1].ele).toBeCloseTo(1630, 6);
  });

  it('reads timestamps against the FIT epoch, not the Unix one', () => {
    expect(points[0].t).toBe(FIT_EPOCH_MS + seconds * 1000);
  });
});

describe('the cases that break parsers', () => {
  const seconds = 1_150_000_000;

  /**
   * Byte order is declared PER DEFINITION MESSAGE, so one file can hold both.
   * A parser that reads the header's endianness once and applies it everywhere
   * gets coordinates that are wrong by orders of magnitude, not slightly.
   */
  it('honours a big-endian definition', () => {
    const file = fitFile([
      ...definition(0, 20, RECORD_FIELDS, { littleEndian: false }),
      ...recordData(ZERMATT_LAT_SEMI, ZERMATT_LON_SEMI, ALT_1620_RAW, seconds, false),
      ...recordData(ZERMATT_LAT_SEMI, ZERMATT_LON_SEMI, ALT_1620_RAW, seconds, false),
    ]);
    const points = parseFit(file, 'be.fit');
    expect(points[0].lat).toBeCloseTo(46.0207, 4);
    expect(points[0].lon).toBeCloseTo(7.7491, 4);
  });

  /**
   * Developer fields are extra bytes on every data message of that local type.
   * Not counting them desynchronises the stream: the next record is read from
   * the middle of this one, and the coordinates that come out are garbage that
   * still looks like numbers.
   */
  it('skips developer fields without losing alignment', () => {
    const file = fitFile([
      ...definition(0, 20, RECORD_FIELDS, { developerFields: [{ size: 4 }] }),
      ...recordData(ZERMATT_LAT_SEMI, ZERMATT_LON_SEMI, ALT_1620_RAW, seconds),
      ...int(0, 4),
      ...recordData(ZERMATT_LAT_SEMI, ZERMATT_LON_SEMI, ALT_1620_RAW + 50, seconds + 5),
      ...int(0, 4),
    ]);
    const points = parseFit(file, 'dev.fit');
    expect(points).toHaveLength(2);
    expect(points[1].lat).toBeCloseTo(46.0207, 4);
    expect(points[1].ele).toBeCloseTo(1630, 6);
  });

  /**
   * A compressed timestamp header is a DATA message whose local type lives in
   * bits 5-6, not 0-3. Read from the wrong bits it names a local type that was
   * never defined, and the parse stops at the first such record.
   */
  it('reads a compressed timestamp header as data', () => {
    const compressedHeader = 0x80 | (0 << 5) | 5;
    const file = fitFile([
      ...definition(0, 20, RECORD_FIELDS),
      ...recordData(ZERMATT_LAT_SEMI, ZERMATT_LON_SEMI, ALT_1620_RAW, seconds),
      compressedHeader,
      ...int(ZERMATT_LAT_SEMI + 50_000, 4),
      ...int(ZERMATT_LON_SEMI, 4),
      ...int(ALT_1620_RAW, 2),
      ...int(seconds + 1, 4),
    ]);
    const points = parseFit(file, 'compressed.fit');
    expect(points).toHaveLength(2);
  });

  /**
   * No fix yet. FIT has no nulls — the top value of the base type means "no
   * reading" — and taking 0x7FFFFFFF at face value gives latitude 180.
   */
  it('drops points with no GPS fix rather than placing them at 180 degrees', () => {
    const file = fitFile([
      ...definition(0, 20, RECORD_FIELDS),
      ...recordData(0x7fffffff, 0x7fffffff, 0xffff, seconds),
      ...recordData(ZERMATT_LAT_SEMI, ZERMATT_LON_SEMI, ALT_1620_RAW, seconds + 1),
      ...recordData(ZERMATT_LAT_SEMI + 100, ZERMATT_LON_SEMI, ALT_1620_RAW, seconds + 2),
    ]);
    const points = parseFit(file, 'nofix.fit');
    expect(points).toHaveLength(2);
    for (const p of points) {
      expect(Math.abs(p.lat)).toBeLessThanOrEqual(90);
      expect(Math.abs(p.lon)).toBeLessThanOrEqual(180);
    }
  });

  /** An invalid altitude must not become -500 m. */
  it('leaves elevation unset when the device had none', () => {
    const file = fitFile([
      ...definition(0, 20, RECORD_FIELDS),
      ...recordData(ZERMATT_LAT_SEMI, ZERMATT_LON_SEMI, 0xffff, seconds),
      ...recordData(ZERMATT_LAT_SEMI + 100, ZERMATT_LON_SEMI, 0xffff, seconds + 1),
    ]);
    const points = parseFit(file, 'noalt.fit');
    expect(points[0].ele).toBeUndefined();
  });

  /**
   * Messages we do not care about are the bulk of a real file — device info,
   * laps, heart rate zones. They must be skipped by declared length, not by
   * guessing at their contents.
   */
  it('walks past message types it does not read', () => {
    const file = fitFile([
      ...definition(1, 23, [{ number: 0, size: 1, baseType: T_UINT8 }]),
      1,
      7,
      ...definition(0, 20, RECORD_FIELDS),
      ...recordData(ZERMATT_LAT_SEMI, ZERMATT_LON_SEMI, ALT_1620_RAW, seconds),
      1,
      9,
      ...recordData(ZERMATT_LAT_SEMI + 100, ZERMATT_LON_SEMI, ALT_1620_RAW, seconds + 1),
    ]);
    expect(parseFit(file, 'mixed.fit')).toHaveLength(2);
  });
});

describe('files that are not what they claim', () => {
  it('rejects a renamed GPX with a message that says so', () => {
    const xml = new TextEncoder().encode('<?xml version="1.0"?><gpx><trk/></gpx>'.padEnd(64, ' '));
    expect(() => parseFit(xml.buffer, 'ride.fit')).toThrow(FitParseError);
    try {
      parseFit(xml.buffer, 'ride.fit');
    } catch (err) {
      expect((err as FitParseError).userMessage).toMatch(/GPX or TCX/);
    }
  });

  it('rejects a file too short to hold a header', () => {
    expect(() => parseFit(new Uint8Array([12, 0x20]).buffer, 'stub.fit')).toThrow(FitParseError);
  });

  /**
   * A truncated download declares the length it was meant to have. Reading to
   * that length walks off the end of the buffer, so the smaller of the two
   * wins and whatever did arrive is kept.
   */
  it('keeps what arrived when the file is truncated', () => {
    const full = [
      ...definition(0, 20, RECORD_FIELDS),
      ...recordData(ZERMATT_LAT_SEMI, ZERMATT_LON_SEMI, ALT_1620_RAW, 1_150_000_000),
      ...recordData(ZERMATT_LAT_SEMI + 100, ZERMATT_LON_SEMI, ALT_1620_RAW, 1_150_000_005),
    ];
    // Claim far more data than is present.
    const file = fitFile(full, { dataSize: full.length + 4096 });
    expect(() => parseFit(file, 'cut.fit')).not.toThrow();
    expect(parseFit(file, 'cut.fit')).toHaveLength(2);
  });

  /**
   * An indoor ride is a valid FIT file with no `record` positions at all. The
   * message has to name that, because "no track points" reads as corruption.
   */
  it('explains an activity with no GPS track', () => {
    const file = fitFile([
      ...definition(0, 20, RECORD_FIELDS),
      ...recordData(0x7fffffff, 0x7fffffff, 0xffff, 1_150_000_000),
    ]);
    try {
      parseFit(file, 'trainer.fit');
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as FitParseError).userMessage).toMatch(/indoor or trainer/);
    }
  });

  /** A data message for an undefined local type ends the parse cleanly. */
  it('stops rather than guessing when a definition is missing', () => {
    const file = fitFile([
      ...definition(0, 20, RECORD_FIELDS),
      ...recordData(ZERMATT_LAT_SEMI, ZERMATT_LON_SEMI, ALT_1620_RAW, 1_150_000_000),
      ...recordData(ZERMATT_LAT_SEMI + 100, ZERMATT_LON_SEMI, ALT_1620_RAW, 1_150_000_001),
      3, // local type 3 was never defined
      0xde,
      0xad,
    ]);
    expect(parseFit(file, 'orphan.fit')).toHaveLength(2);
  });
});
