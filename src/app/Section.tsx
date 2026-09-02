/**
 * A collapsible sidebar group.
 *
 * The settings panel had ten stacked sections and about eighteen numeric
 * controls in one continuous scroll. Everything was reachable and nothing was
 * findable — which is the specific failure the owner described as "too
 * overwhelming".
 *
 * Groups follow the order a model is actually built in: place, route, layers,
 * model, terrain, export. A first-time user can work top to bottom without
 * knowing what any of it means yet, which is the whole argument for ordering by
 * workflow rather than by what the settings technically affect.
 *
 * **One open at a time.** An accordion that lets everything open is just the old
 * scroll with extra clicks. The cost is that comparing two groups means
 * switching between them; the benefit is that the panel always fits on screen,
 * so the thing you are working on is never half below the fold.
 *
 * Accessibility, because this is a disclosure widget and they are easy to get
 * wrong: the header is a real `<button>` (keyboard and screen-reader reachable
 * for free), it carries `aria-expanded`, and it points at the region it
 * controls with `aria-controls`. Collapsed content is removed from the DOM
 * rather than hidden with CSS, so nothing inside it can take focus.
 */
import { useEffect, useRef, type ReactNode } from 'react';

export type GroupId = 'place' | 'route' | 'layers' | 'model' | 'terrain' | 'export';

const STORAGE_KEY = 'mazeterrain.openGroup';

/** Which group is open on a first visit: the first step of the workflow. */
export const DEFAULT_GROUP: GroupId = 'place';

export function readOpenGroup(): GroupId | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === '') return null;
    if (
      stored === 'place' ||
      stored === 'route' ||
      stored === 'layers' ||
      stored === 'model' ||
      stored === 'terrain' ||
      stored === 'export'
    ) {
      return stored;
    }
  } catch {
    // Storage denied or full. The default is still a correct answer.
  }
  return DEFAULT_GROUP;
}

export function writeOpenGroup(id: GroupId | null): void {
  try {
    localStorage.setItem(STORAGE_KEY, id ?? '');
  } catch {
    // The choice still holds for this session.
  }
}

interface SectionProps {
  id: GroupId;
  title: string;
  /** One line under the title, shown only while the group is closed. */
  hint?: string | undefined;
  /** A count or short status on the right of the header, e.g. "3 routes". */
  badge?: ReactNode | undefined;
  /** True when this group has something the user should look at. */
  attention?: boolean | undefined;
  icon: ReactNode;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}

export function Section({
  id,
  title,
  hint,
  badge,
  attention,
  icon,
  open,
  onToggle,
  children,
}: SectionProps) {
  const body = useRef<HTMLDivElement>(null);

  /**
   * Bring a newly opened group into view.
   *
   * Opening the last group in a scrolled panel otherwise expands content the
   * user cannot see, and the panel looks like it did nothing. Deliberately
   * `nearest`: scrolling the header to the top would yank the page on every
   * toggle, which is worse than the problem.
   */
  useEffect(() => {
    if (!open || !body.current) return;
    const timer = setTimeout(() => {
      body.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }, 180);
    return () => clearTimeout(timer);
  }, [open]);

  return (
    <section className={`group${open ? ' group--open' : ''}`}>
      <button
        type="button"
        className="group__head"
        aria-expanded={open}
        aria-controls={`group-${id}`}
        onClick={onToggle}
      >
        <span className="group__icon" aria-hidden>
          {icon}
        </span>
        <span className="group__title">
          {title}
          {attention ? <span className="group__dot" aria-label="needs attention" /> : null}
        </span>
        {/* One value on the right, on one line.
            The header used to stack a hint under the title, which made rows
            32px or 46px depending on whether they had one — and a list whose
            rows are different heights for reasons the reader cannot see has no
            rhythm. A count is more use than a description when there is one, so
            the badge wins and the hint fills in otherwise. */}
        {badge ? (
          <span className="group__value group__value--badge">{badge}</span>
        ) : hint && !open ? (
          <span className="group__value">{hint}</span>
        ) : null}
        <Chevron />
      </button>

      {open ? (
        <div className="group__body" id={`group-${id}`} ref={body}>
          {children}
        </div>
      ) : null}
    </section>
  );
}

function Chevron() {
  return (
    <svg
      className="group__chevron"
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M6 4l4 4-4 4" />
    </svg>
  );
}

/**
 * The group icons.
 *
 * Drawn here rather than pulled from an icon package: six 16px glyphs is not
 * worth a dependency, and hand-rolling them keeps the stroke weight matched to
 * the type. All on a 16 grid, 1.5 stroke, round caps.
 */
const svg = (children: ReactNode) => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    {children}
  </svg>
);

export const ICONS = {
  place: svg(
    <>
      <path d="M8 14s4.5-4.2 4.5-7.5a4.5 4.5 0 10-9 0C3.5 9.8 8 14 8 14z" />
      <circle cx="8" cy="6.5" r="1.6" />
    </>,
  ),
  route: svg(
    <>
      <circle cx="3.5" cy="12.5" r="1.6" />
      <circle cx="12.5" cy="3.5" r="1.6" />
      <path d="M5 11.5c2.5-1 1-4 3.5-4.5S12 6 12 5.2" />
    </>,
  ),
  layers: svg(
    <>
      <path d="M8 2l6 3-6 3-6-3 6-3z" />
      <path d="M2 8l6 3 6-3" />
      <path d="M2 11.5l6 3 6-3" />
    </>,
  ),
  model: svg(
    <>
      <path d="M8 1.8l5.5 3v6.4L8 14.2l-5.5-3V4.8l5.5-3z" />
      <path d="M2.5 4.8L8 7.8l5.5-3" />
      <path d="M8 7.8v6.4" />
    </>,
  ),
  terrain: svg(
    <>
      <path d="M1.5 12.5l4-6 2.5 3.5 2-2.8 4.5 5.3z" />
      <circle cx="11.5" cy="3.5" r="1.5" />
    </>,
  ),
  export: svg(
    <>
      <path d="M8 10V2.5" />
      <path d="M5 5.5L8 2.5l3 3" />
      <path d="M2.5 10v2.5a1 1 0 001 1h9a1 1 0 001-1V10" />
    </>,
  ),
};

/**
 * The collapsed sidebar: six icons and nothing else.
 *
 * Worth having because the map and the 3D preview are the point of the app,
 * and 340px of settings is a lot of screen to spend once they are set. Clicking
 * an icon expands the panel AND opens that group, so the rail is a shortcut
 * rather than a mode you have to get back out of first.
 *
 * The buttons keep their accessible names through `title` and `aria-label`,
 * because an icon with no text is unusable to a screen reader and unguessable
 * to everyone else on first sight.
 */
const RAIL_ITEMS: Array<{ id: GroupId; label: string; icon: keyof typeof ICONS }> = [
  { id: 'place', label: 'Place', icon: 'place' },
  { id: 'route', label: 'Route', icon: 'route' },
  { id: 'layers', label: 'Map layers', icon: 'layers' },
  { id: 'model', label: 'Model', icon: 'model' },
  { id: 'terrain', label: 'Terrain', icon: 'terrain' },
  { id: 'export', label: 'Print & export', icon: 'export' },
];

export function Rail({
  openGroup,
  onPick,
}: {
  openGroup: GroupId | null;
  onPick: (id: GroupId) => void;
}) {
  return (
    <nav className="rail" aria-label="Settings">
      {RAIL_ITEMS.map((item) => (
        <button
          key={item.id}
          type="button"
          className={`rail__btn${openGroup === item.id ? ' rail__btn--on' : ''}`}
          title={item.label}
          aria-label={item.label}
          onClick={() => onPick(item.id)}
        >
          {ICONS[item.icon]}
        </button>
      ))}
    </nav>
  );
}
