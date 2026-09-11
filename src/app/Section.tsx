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
 * **Groups open independently** (owner's call, 2026-09-11). This started as a
 * one-open-at-a-time accordion, on the argument that the panel would then
 * always fit on screen. What it actually bought was a panel that moved under
 * the cursor: opening a group closed the one above it, so the header you had
 * just clicked slid up the screen by the height of whatever collapsed — and
 * since the groups are ordered the way a model is built, working top to bottom
 * hit that on every single step. Reported as "the dropdowns open from the
 * middle ... the button should stay in place and the contents should go down".
 *
 * With no auto-close the headers above the one you click cannot move, because
 * nothing above it changed. The old risk is real — open all six and the panel
 * is long again — but a long panel the user chose beats a short one that
 * rearranges itself.
 *
 * Accessibility, because this is a disclosure widget and they are easy to get
 * wrong: the header is a real `<button>` (keyboard and screen-reader reachable
 * for free), it carries `aria-expanded`, and it points at the region it
 * controls with `aria-controls`. Collapsed content is removed from the DOM
 * rather than hidden with CSS, so nothing inside it can take focus.
 */
import { useLayoutEffect, useRef, type ReactNode } from 'react';

export type GroupId =
  | 'place'
  | 'route'
  | 'layers'
  | 'model'
  | 'terrain'
  | 'keychain'
  | 'export';

/**
 * Still singular, and deliberately.
 *
 * The key predates groups opening independently, and renaming it would silently
 * reset the panel for everyone who has used the app. A comma-separated list
 * parses a previously stored single id as a one-element list, so old state
 * survives the change without a migration.
 */
const STORAGE_KEY = 'mazeterrain.openGroup';

/** The groups in the order they appear in the panel, which is the order a model
    is actually built in. Exported so a stored list can be written in panel order
    rather than in whatever order the user happened to click. */
export const GROUP_ORDER: readonly GroupId[] = [
  'place',
  'route',
  'layers',
  'model',
  'terrain',
  'keychain',
  'export',
];

function isGroupId(v: string): v is GroupId {
  return (GROUP_ORDER as readonly string[]).includes(v);
}

/** What is open on a first visit: the first step of the workflow, alone. */
export const DEFAULT_GROUPS: readonly GroupId[] = ['place'];

export function readOpenGroups(): GroupId[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === '') return [];
    if (stored !== null) {
      const ids = stored.split(',').filter(isGroupId);
      // A stored value that parses to nothing is corrupt, not "all closed" —
      // "all closed" is the empty string, handled above.
      if (ids.length > 0) return [...new Set(ids)];
    }
  } catch {
    // Storage denied or full. The default is still a correct answer.
  }
  return [...DEFAULT_GROUPS];
}

export function writeOpenGroups(ids: readonly GroupId[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, ids.join(','));
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
  const head = useRef<HTMLButtonElement>(null);

  /**
   * Where this header sat at the moment it was clicked.
   *
   * Only the header the user actually pressed gets one, which is what keeps the
   * group that is CLOSING from fighting the group that is opening — both
   * re-render on the same click, but only one of them has an anchor.
   */
  const anchor = useRef<number | null>(null);

  /**
   * Keep the clicked header under the cursor.
   *
   * Measured on the old single-open accordion: opening the last group moved its
   * own header **619px up the screen**. 326px of that was a `scrollIntoView` on
   * the newly opened BODY — for a body taller than the panel, `block: 'nearest'`
   * aligns its top edge with the top of the scrollport, which drags the header
   * out of view entirely. It was trying to reveal the content and threw away
   * the one landmark the user was looking at. That call is gone.
   *
   * The other 292px was the auto-close, and dropping that (see the note at the
   * top of this file) is what actually fixes the reported problem: nothing above
   * the clicked header changes, so the header cannot move.
   *
   * What is left for this effect is the case neither of those covers. Closing a
   * group while the panel is scrolled down shortens the content, the browser
   * clamps `scrollTop` to the new maximum, and everything slides. So: measure
   * the header before the toggle, let React commit, and put the offset back.
   *
   * `useLayoutEffect`, not `useEffect`: this has to happen before the browser
   * paints, or the jump is visible and then corrected, which reads as a flinch.
   */
  useLayoutEffect(() => {
    const was = anchor.current;
    anchor.current = null;
    const el = head.current;
    if (was === null || !el) return;
    const scroller = el.closest('.panel__scroll');
    if (!scroller) return;

    // Reading a rect forces layout, so each step sees the previous one.
    const drift = el.getBoundingClientRect().top - was;
    if (drift !== 0) scroller.scrollTop += drift;

    /*
     * Closing the last group shortens the panel, and the browser clamps
     * scrollTop to the new maximum — so the anchor cannot always be honoured
     * exactly. Whatever is left, the header must at least still be on screen.
     */
    const headBox = el.getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    if (headBox.top < view.top) scroller.scrollTop -= view.top - headBox.top;
    else if (headBox.bottom > view.bottom) scroller.scrollTop += headBox.bottom - view.bottom;
  }, [open]);

  return (
    <section className={`group${open ? ' group--open' : ''}`}>
      <button
        type="button"
        className="group__head"
        ref={head}
        aria-expanded={open}
        aria-controls={`group-${id}`}
        onClick={() => {
          anchor.current = head.current?.getBoundingClientRect().top ?? null;
          onToggle();
        }}
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
        <div className="group__body" id={`group-${id}`}>
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
  keychain: svg(
    <>
      <path d="M2.5 5a1.5 1.5 0 011.5-1.5h8A1.5 1.5 0 0113.5 5v6a1.5 1.5 0 01-1.5 1.5H4A1.5 1.5 0 012.5 11z" />
      <circle cx="5" cy="5.8" r="0.9" />
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
  { id: 'keychain', label: 'Keychain', icon: 'keychain' },
  { id: 'export', label: 'Print & export', icon: 'export' },
];

export function Rail({
  openGroups,
  onPick,
}: {
  /** Every group currently open, since more than one can be. */
  openGroups: ReadonlySet<GroupId>;
  onPick: (id: GroupId) => void;
}) {
  return (
    <nav className="rail" aria-label="Settings">
      {RAIL_ITEMS.map((item) => (
        <button
          key={item.id}
          type="button"
          className={`rail__btn${openGroups.has(item.id) ? ' rail__btn--on' : ''}`}
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
