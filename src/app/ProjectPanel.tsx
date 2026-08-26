/**
 * Save, load, share and presets (docs/02-feature-spec.md F7.3,
 * docs/07-ui-spec.md).
 *
 * Three ways to keep work, deliberately different in what they carry:
 *
 *  - a `.mzt` file is the whole thing, routes included;
 *  - a share link is everything except the routes, because a GPX does not fit
 *    in a URL — so a link restores the model and asks for the track back;
 *  - a preset is settings only, so it can be applied to a different place.
 */
import { useEffect, useRef, useState } from 'react';
import {
  deletePreset,
  listPresets,
  savePreset,
  type NamedPreset,
  type Settings,
} from '../config/project';

interface ProjectPanelProps {
  busy: boolean;
  settings: Settings;
  /** How many routes the project holds, so the copy can say what a link drops. */
  routeCount: number;
  onSave: () => void;
  onLoad: (file: File) => void;
  onCopyLink: () => Promise<boolean>;
  onApplyPreset: (settings: Settings) => void;
}

export function ProjectPanel({
  busy,
  settings,
  routeCount,
  onSave,
  onLoad,
  onCopyLink,
  onApplyPreset,
}: ProjectPanelProps) {
  const input = useRef<HTMLInputElement>(null);
  const [presets, setPresets] = useState<NamedPreset[]>([]);
  const [selected, setSelected] = useState('');
  const [naming, setNaming] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [copied, setCopied] = useState(false);

  // Read once on mount rather than during render: localStorage is not
  // guaranteed to exist, and listPresets swallowing that is not a reason to
  // call it on every keystroke.
  useEffect(() => setPresets(listPresets()), []);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const commitName = () => {
    const name = draftName.trim();
    if (name.length === 0) {
      setNaming(false);
      return;
    }
    setPresets(savePreset(name, settings));
    setSelected(name);
    setDraftName('');
    setNaming(false);
  };

  return (
    <section>
      <h2>Project</h2>

      <div className="field__row projectRow">
        <button type="button" className="btn" disabled={busy} onClick={onSave}>
          Save project
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => input.current?.click()}
        >
          Load project
        </button>
      </div>
      <input
        ref={input}
        type="file"
        accept=".mzt,application/json"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onLoad(file);
          // Cleared so re-opening the same file fires a change event again.
          e.target.value = '';
        }}
      />
      <p className="field__hint">
        A <code>.mzt</code> file holds the area, every setting and the GPX tracks themselves.
      </p>

      <div className="field__row projectRow">
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => {
            void onCopyLink().then(setCopied);
          }}
        >
          {copied ? 'Link copied' : 'Copy share link'}
        </button>
      </div>
      <p className="field__hint">
        {routeCount > 0
          ? `The link carries the area and the settings. ${
              routeCount === 1 ? 'The route is' : 'The routes are'
            } too large for a URL, so whoever opens it re-uploads the GPX — save a project file to keep everything.`
          : 'The link carries the area and every setting, so it rebuilds this exact model.'}
      </p>

      <div className="field">
        <label className="field__label" htmlFor="settings-preset">
          Presets
        </label>
        <select
          id="settings-preset"
          className="select"
          value={selected}
          disabled={busy || presets.length === 0}
          onChange={(e) => {
            setSelected(e.target.value);
            const found = presets.find((p) => p.name === e.target.value);
            if (found) onApplyPreset(found.settings);
          }}
        >
          <option value="">{presets.length === 0 ? '— none saved —' : '— none —'}</option>
          {presets.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
            </option>
          ))}
        </select>
      </div>

      {naming ? (
        <div className="field__row projectRow">
          <input
            className="textInput"
            autoFocus
            placeholder="Gift 100 mm"
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitName();
              if (e.key === 'Escape') setNaming(false);
            }}
          />
          <button type="button" className="btn" onClick={commitName}>
            Save
          </button>
        </div>
      ) : (
        <div className="field__row projectRow">
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => {
              setDraftName(selected);
              setNaming(true);
            }}
          >
            Save current as…
          </button>
          {selected ? (
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => {
                setPresets(deletePreset(selected));
                setSelected('');
              }}
            >
              Delete
            </button>
          ) : null}
        </div>
      )}
      <p className="field__hint">
        A preset stores settings only — no area and no route — so it can be applied anywhere.
      </p>
    </section>
  );
}
