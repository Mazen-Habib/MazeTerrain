/**
 * Slider paired with a numeric input.
 *
 * docs/07-ui-spec.md, accessibility: "Every slider has a paired numeric input.
 * Sliders alone are unusable for precise mm values."
 */
interface NumberFieldProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  hint?: string;
  disabled?: boolean;
  onChange: (value: number) => void;
}

export function NumberField({
  label,
  value,
  min,
  max,
  step,
  unit,
  hint,
  disabled = false,
  onChange,
}: NumberFieldProps) {
  const id = `field-${label.replace(/\s+/g, '-').toLowerCase()}`;

  return (
    <div className={`field${disabled ? ' field--disabled' : ''}`}>
      <label className="field__label" htmlFor={id}>
        {label}
        {unit ? <span className="field__unit">{unit}</span> : null}
      </label>
      <div className="field__row">
        <input
          className="field__slider"
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          aria-label={`${label} slider`}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <input
          className="field__number"
          id={id}
          type="number"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          onChange={(e) => {
            const next = Number(e.target.value);
            if (Number.isFinite(next)) onChange(next);
          }}
        />
      </div>
      {hint ? <p className="field__hint">{hint}</p> : null}
    </div>
  );
}
