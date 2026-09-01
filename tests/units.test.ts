/**
 * Display units (Q14, "split").
 *
 * The conversions are trivial arithmetic; what is worth testing is that the
 * split holds. Print millimetres must not appear anywhere in here, and the
 * imperial numbers have to match what a person would actually recognise — a
 * marathon is 26.2 miles, and a reader who gets 26.1 back will not trust the
 * rest of the readout either.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  defaultUnit,
  formatArea,
  formatDistance,
  formatElevation,
  formatElevationRange,
  formatExtent,
  formatGroundLength,
  readUnit,
  writeUnit,
} from '../src/config/units';

describe('distances', () => {
  /** The numbers people already know, checked against their known answers. */
  it('gives a marathon back as 26.2 miles', () => {
    expect(formatDistance(42195, 'imperial')).toBe('26.2 mi');
    expect(formatDistance(42195, 'metric')).toBe('42.2 km');
  });

  it('gives a 5k back as 3.1 miles', () => {
    expect(formatDistance(5000, 'imperial')).toBe('3.1 mi');
  });

  it('does not print NaN at the user', () => {
    expect(formatDistance(NaN, 'metric')).toBe('—');
    expect(formatElevation(Infinity, 'imperial')).toBe('—');
    expect(formatArea(NaN, 'metric')).toBe('—');
    expect(formatExtent(1, NaN, 'metric')).toBe('—');
    expect(formatGroundLength(NaN, 'imperial')).toBe('—');
    expect(formatElevationRange(0, NaN, 'metric')).toBe('—');
  });
});

describe('elevations', () => {
  /** Mont Blanc, 4808 m, is 15 774 ft. */
  it('converts a summit', () => {
    expect(formatElevation(4808, 'imperial')).toBe('15774 ft');
    expect(formatElevation(4808, 'metric')).toBe('4808 m');
  });

  /** A range carries ONE unit label, at the end. */
  it('labels a range once', () => {
    expect(formatElevationRange(200, 1500, 'metric')).toBe('200 – 1500 m');
    expect(formatElevationRange(200, 1500, 'imperial')).toBe('656 – 4921 ft');
  });
});

describe('ground lengths', () => {
  /**
   * The decimal matters below ten: this readout is how a user checks whether a
   * road width is survivable, and 3 m against 3.4 m is that check.
   */
  it('keeps a decimal on small values and drops it on large', () => {
    expect(formatGroundLength(3.4, 'metric')).toBe('3.4 m');
    expect(formatGroundLength(24, 'metric')).toBe('24 m');
    expect(formatGroundLength(3.048, 'imperial')).toBe('10 ft');
    expect(formatGroundLength(1.524, 'imperial')).toBe('5.0 ft');
  });
});

describe('areas and extents', () => {
  it('converts square kilometres to square miles', () => {
    expect(formatArea(2.589988110336, 'imperial')).toBe('1.0 sq mi');
    expect(formatArea(458, 'metric')).toBe('458.0 km²');
  });

  it('converts both sides of an extent', () => {
    expect(formatExtent(1.609344, 1.609344, 'imperial')).toBe('1.0 × 1.0 mi');
    expect(formatExtent(12.4, 8.1, 'metric')).toBe('12.4 × 8.1 km');
  });
});

describe('the stored preference', () => {
  const store = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('round-trips', () => {
    writeUnit('imperial');
    expect(readUnit()).toBe('imperial');
    writeUnit('metric');
    expect(readUnit()).toBe('metric');
  });

  it('ignores a value that is not a unit', () => {
    store.set('mazeterrain.units', 'furlongs');
    expect(['metric', 'imperial']).toContain(readUnit());
  });

  /**
   * A browser with storage denied still has to render a number. This is the
   * same failure the preset code handles, and for the same reason.
   */
  it('survives storage throwing', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    });
    expect(() => writeUnit('imperial')).not.toThrow();
    expect(['metric', 'imperial']).toContain(readUnit());
  });
});

describe('the locale default', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const withLanguages = (languages: string[]) =>
    vi.stubGlobal('navigator', { languages, language: languages[0] });

  it('picks imperial for the US', () => {
    withLanguages(['en-US']);
    expect(defaultUnit()).toBe('imperial');
  });

  /**
   * The deliberate one: en-GB reads race distances in miles and hill heights in
   * metres, so a single flag is wrong either way. Metric plus a visible toggle
   * beats guessing.
   */
  it('picks metric for the UK', () => {
    withLanguages(['en-GB']);
    expect(defaultUnit()).toBe('metric');
  });

  it('resolves a bare language tag', () => {
    withLanguages(['en']);
    expect(defaultUnit()).toBe('imperial');
    withLanguages(['de']);
    expect(defaultUnit()).toBe('metric');
  });

  it('falls back to metric when the locale is unreadable', () => {
    withLanguages(['not a locale']);
    expect(defaultUnit()).toBe('metric');
  });

  it('falls back to metric when navigator has nothing to say', () => {
    vi.stubGlobal('navigator', { languages: [], language: '' });
    expect(defaultUnit()).toBe('metric');
  });
});
