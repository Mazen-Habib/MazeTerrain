/**
 * One Export control instead of three download buttons.
 *
 * The bar carried "Download parts (ZIP)", "Download 3MF" and "Download STL"
 * side by side, which is three equal-weight buttons for one decision and left
 * Generate — the thing you actually press — competing with them.
 *
 * The more useful change is what the menu can say that a button cannot. STL
 * carries no colour at all; 3MF carries a material per part and a filament slot
 * per object. That difference decides whether a model prints in colour, and
 * before this the only place it was written down was a `title` tooltip on one
 * of three buttons. Now it sits next to the choice, at the moment the choice is
 * made.
 */
import { useEffect, useRef, useState } from 'react';

interface ExportMenuProps {
  disabled: boolean;
  /** True when the model comes apart into pieces that print separately. */
  separateParts: boolean;
  onDownloadStl: () => void;
  onDownload3mf: () => void;
  onDownloadParts: () => void;
}

export function ExportMenu({
  disabled,
  separateParts,
  onDownloadStl,
  onDownload3mf,
  onDownloadParts,
}: ExportMenuProps) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  /**
   * Close on an outside click or Escape.
   *
   * `pointerdown` rather than `click`: a menu that closes on click swallows the
   * first press anywhere else on the page, so dismissing it costs two clicks.
   */
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // A disabled menu must not stay open if the model is invalidated under it.
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const pick = (run: () => void) => () => {
    setOpen(false);
    run();
  };

  return (
    <div className="exportmenu" ref={wrap}>
      <button
        type="button"
        className="btn"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        Export
        <svg
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M4 6l4 4 4-4" />
        </svg>
      </button>

      {open ? (
        <div className="exportmenu__pop" role="menu">
          <button className="exportmenu__item" role="menuitem" onClick={pick(onDownload3mf)}>
            <span className="exportmenu__name">3MF</span>
            <span className="exportmenu__desc">
              Keeps colours. Every layer is its own object with its own filament slot.
            </span>
          </button>

          <button className="exportmenu__item" role="menuitem" onClick={pick(onDownloadStl)}>
            <span className="exportmenu__name">STL</span>
            <span className="exportmenu__desc">
              Geometry only — the format carries no colour at all.
            </span>
          </button>

          {separateParts ? (
            <button className="exportmenu__item" role="menuitem" onClick={pick(onDownloadParts)}>
              <span className="exportmenu__name">Parts as ZIP</span>
              <span className="exportmenu__desc">
                One STL per piece, laid flat on the bed, with a note on assembly.
              </span>
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
