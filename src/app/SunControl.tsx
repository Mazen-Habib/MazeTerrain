/**
 * Sun position dial (docs/02-feature-spec.md F3.2).
 *
 * A compass rose you drag a sun around. It drives the hillshade on the live
 * terrain, which is the only lighting the map has — so this is how a user makes
 * a ridge read as a ridge rather than a smudge. Low sun across the slope throws
 * long shadows and shows every fold; sun overhead flattens the map completely,
 * which is exactly the default MapLibre ships and exactly why relief is so hard
 * to read before touching this.
 *
 * The dial is polar, and the mapping is the one a sun actually makes:
 *
 * - **Angle** is the azimuth, the compass bearing the light comes FROM.
 *   North at the top, clockwise, because that is what every compass does and
 *   because the model's own +Y is north (CLAUDE.md).
 * - **Radius** is the altitude, inverted: the CENTRE is the sun overhead at 90
 *   degrees, the RIM is the sun on the horizon at 0. Centre-is-noon is the
 *   convention every sun-path diagram uses, and it puts the flattest lighting
 *   at the point that is hardest to hit by accident.
 *
 * It is deliberately not a pair of sliders. Azimuth and altitude are one
 * physical thing, and two sliders make the user do the trigonometry in their
 * head to answer "where is the light coming from".
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export interface SunPosition {
  /** Compass bearing the light comes FROM, degrees clockwise from north. */
  azimuth_deg: number;
  /** Height above the horizon, degrees. 90 is overhead. */
  altitude_deg: number;
}

/**
 * Late-afternoon light from the north-west.
 *
 * Not overhead, which is MapLibre's default and renders relief nearly flat, and
 * not on the horizon, which throws shadows so long the map goes to mush. 45
 * degrees up and across the usual grain of a valley is the light a relief map
 * is drawn under, and it is the one that makes the terrain legible with no
 * fiddling at all.
 *
 * North-west specifically because of a quirk of perception: shading lit from
 * the upper left reads as raised, and the same image lit from the lower right
 * reads as hollow. Every printed relief map in the last century lights from the
 * north-west for this reason.
 */
export const DEFAULT_SUN: SunPosition = { azimuth_deg: 315, altitude_deg: 45 };

/** Compass points, for the readout. */
function compassName(azimuth_deg: number): string {
  const points = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const index = Math.round(((azimuth_deg % 360) + 360) % 360 / 45) % 8;
  return points[index];
}

/** How high the sun reads, in words. */
function altitudeName(altitude_deg: number): string {
  if (altitude_deg < 15) return 'LOW';
  if (altitude_deg > 70) return 'HIGH';
  return 'MID';
}

interface SunControlProps {
  sun: SunPosition;
  onChange: (sun: SunPosition) => void;
  /** Whether the live terrain this lights is switched on. */
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
}

/** Dial radius in the SVG's own units. The viewBox is 2 x this, plus margin. */
export const R = 100;
const MARGIN = 18;
const SIZE = (R + MARGIN) * 2;

/**
 * Dial offset from the centre -> sun position.
 *
 * Pure, exported and tested, because this is where the arithmetic lives and
 * arithmetic on angles is where the mistakes are. One already happened here:
 * `atan2(0, -0)` is pi rather than zero, so a drag through the exact centre
 * snapped the compass to due south on the way past.
 */
export function sunFromDial(x: number, y: number, current: SunPosition): SunPosition {
  // Radius is altitude, inverted and clamped: past the rim is still horizon.
  const radius = Math.min(1, Math.hypot(x, y) / R);
  const altitude = (1 - radius) * 90;

  // At the very centre the sun is overhead and its bearing means nothing, so
  // the last one is kept.
  if (radius < 0.02) {
    return { azimuth_deg: current.azimuth_deg, altitude_deg: Math.round(altitude) };
  }

  // atan2(x, -y) gives 0 at the top and grows clockwise, which is a compass.
  const azimuth = (((Math.atan2(x, -y) * 180) / Math.PI) + 360) % 360;

  return { azimuth_deg: Math.round(azimuth), altitude_deg: Math.round(altitude) };
}

/** Sun position -> dial offset from the centre. The inverse of the above. */
export function dialFromSun(sun: SunPosition): { x: number; y: number } {
  const radius = (1 - sun.altitude_deg / 90) * R;
  const angle = ((sun.azimuth_deg - 90) * Math.PI) / 180;
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

export function SunControl({ sun, onChange, enabled, onEnabledChange }: SunControlProps) {
  const svg = useRef<SVGSVGElement>(null);
  const [dragging, setDragging] = useState(false);

  /** Screen point -> sun position. The inverse of the placement below. */
  const positionFromPoint = useCallback((clientX: number, clientY: number): SunPosition => {
    const el = svg.current;
    if (!el) return sun;
    const box = el.getBoundingClientRect();

    // Into the SVG's own coordinates, centred on the dial.
    const x = ((clientX - box.left) / box.width) * SIZE - (R + MARGIN);
    const y = ((clientY - box.top) / box.height) * SIZE - (R + MARGIN);
    return sunFromDial(x, y, sun);
  }, [sun]);

  // Listeners on the window, not the dial: a drag that leaves the little circle
  // must keep working, and must end wherever the button comes up.
  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => {
      e.preventDefault();
      onChange(positionFromPoint(e.clientX, e.clientY));
    };
    const up = () => setDragging(false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, [dragging, onChange, positionFromPoint]);

  const { x: sunX, y: sunY } = dialFromSun(sun);

  /**
   * Arrow keys move the sun, because a dial that only takes a drag is unusable
   * to anyone not using a mouse — and a keyboard is better than a drag for
   * nudging an azimuth by five degrees anyway.
   */
  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 1 : 5;
    let next: SunPosition | null = null;
    if (e.key === 'ArrowLeft') next = { ...sun, azimuth_deg: (sun.azimuth_deg - step + 360) % 360 };
    if (e.key === 'ArrowRight') next = { ...sun, azimuth_deg: (sun.azimuth_deg + step) % 360 };
    if (e.key === 'ArrowUp') {
      next = { ...sun, altitude_deg: Math.min(90, sun.altitude_deg + step) };
    }
    if (e.key === 'ArrowDown') {
      next = { ...sun, altitude_deg: Math.max(0, sun.altitude_deg - step) };
    }
    if (next) {
      e.preventDefault();
      onChange(next);
    }
  };

  return (
    <section className="sun">
      <div className="sun__head">
        <h2 className="sun__title">Sun position</h2>
        <label className="checkbox sun__toggle">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => onEnabledChange(e.target.checked)}
          />
          Live terrain
        </label>
      </div>

      <div className={`sun__dialWrap${enabled ? '' : ' sun__dialWrap--off'}`}>
        <svg
          ref={svg}
          className="sun__dial"
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          role="slider"
          tabIndex={0}
          aria-label="Sun position"
          aria-valuetext={`Azimuth ${sun.azimuth_deg} degrees ${compassName(sun.azimuth_deg)}, altitude ${sun.altitude_deg} degrees`}
          aria-valuenow={sun.azimuth_deg}
          aria-valuemin={0}
          aria-valuemax={359}
          onKeyDown={onKeyDown}
          onPointerDown={(e) => {
            if (!enabled) return;
            e.preventDefault();
            (e.currentTarget as SVGSVGElement).focus();
            setDragging(true);
            onChange(positionFromPoint(e.clientX, e.clientY));
          }}
        >
          <defs>
            {/* Night at the rim, day at the centre: the gradient IS the altitude
                axis, so the sun's height reads before the numbers do. */}
            <radialGradient id="sunSky" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="var(--sun-sky-0)" />
              <stop offset="55%" stopColor="var(--sun-sky-1)" />
              <stop offset="100%" stopColor="var(--sun-sky-2)" />
            </radialGradient>
            <radialGradient id="sunGlow" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#ffd9a3" />
              <stop offset="60%" stopColor="#ffab4d" />
              <stop offset="100%" stopColor="var(--accent)" />
            </radialGradient>
          </defs>

          <g transform={`translate(${R + MARGIN} ${R + MARGIN})`}>
            <circle r={R} fill="url(#sunSky)" />

            {/* Altitude rings at 30 and 60 degrees up. */}
            <circle r={R * (1 / 3)} className="sun__ring" />
            <circle r={R * (2 / 3)} className="sun__ring" />
            <circle r={R} className="sun__rim" />

            <line x1={-R} y1={0} x2={R} y2={0} className="sun__cross" />
            <line x1={0} y1={-R} x2={0} y2={R} className="sun__cross" />

            <text x={0} y={-R - 5} className="sun__cardinal sun__cardinal--n">N</text>
            <text x={R + 9} y={4} className="sun__cardinal">E</text>
            <text x={0} y={R + 14} className="sun__cardinal">S</text>
            <text x={-R - 9} y={4} className="sun__cardinal">W</text>

            <circle cx={0} cy={0} r={2} className="sun__centre" />
            <circle cx={sunX} cy={sunY} r={16} className="sun__halo" />
            <circle cx={sunX} cy={sunY} r={10} fill="url(#sunGlow)" className="sun__disc" />
          </g>
        </svg>
      </div>

      <dl className="sun__readout">
        <div>
          <dd>
            {sun.azimuth_deg}°<span className="sun__hint">{compassName(sun.azimuth_deg)}</span>
          </dd>
          <dt>Azimuth</dt>
        </div>
        <div>
          <dd>
            {sun.altitude_deg}°<span className="sun__hint">{altitudeName(sun.altitude_deg)}</span>
          </dd>
          <dt>Altitude</dt>
        </div>
      </dl>

      <p className="field__hint">
        {enabled
          ? 'Drag the sun, or use the arrow keys. Low sun across a slope throws the longest shadows; overhead flattens the relief. Lighting only — it does not change the printed model.'
          : 'Switch Live terrain on to shade the map with it.'}
      </p>
    </section>
  );
}
