import { DatePicker } from '../ui/date-picker';
import { Field, FieldGroup, FieldLabel } from '../ui/field';
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group';
import {
  EMPTY_DATE_RANGE,
  resolveDatePreset,
  type DatePreset,
  type DateRangeState,
} from '../../lib/transaction-filters';

const DATE_PRESETS: { value: Exclude<DatePreset, 'custom'>; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: '7d', label: '7D' },
  { value: '30d', label: '30D' },
  { value: '90d', label: '90D' },
  { value: 'month', label: 'This month' },
  { value: 'ytd', label: 'YTD' },
];

export function DateRangePanel({
  value,
  onChange,
}: {
  value: DateRangeState;
  onChange: (next: DateRangeState) => void;
}) {
  const pickPreset = (preset: Exclude<DatePreset, 'custom'>) => {
    if (preset === 'all') {
      onChange(EMPTY_DATE_RANGE);
      return;
    }
    const { from, to } = resolveDatePreset(preset);
    onChange({ preset, from, to });
  };

  const presetValue =
    value.preset === 'custom'
      ? undefined
      : (value.preset === 'all' || (!value.from && !value.to) ? 'all' : value.preset);

  return (
    <>
      <ToggleGroup
        type="single"
        variant="outline"
        value={presetValue}
        onValueChange={(next) => {
          if (!next) return;
          pickPreset(next as Exclude<DatePreset, 'custom'>);
        }}
        className="w-full flex-wrap"
        aria-label="Date presets"
      >
        {DATE_PRESETS.map((opt) => (
          <ToggleGroupItem key={opt.value} value={opt.value}>
            {opt.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      <FieldGroup className="grid grid-cols-2 gap-2">
        <Field>
          <FieldLabel>From</FieldLabel>
          <DatePicker value={value.from} onChange={(from) => onChange({ preset: 'custom', from, to: value.to })} aria-label="From date" />
        </Field>
        <Field>
          <FieldLabel>To</FieldLabel>
          <DatePicker value={value.to} onChange={(to) => onChange({ preset: 'custom', from: value.from, to })} aria-label="To date" />
        </Field>
      </FieldGroup>
    </>
  );
}
