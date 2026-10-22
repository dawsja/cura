import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { formatDateLong, parseLocalDate, toLocalISODate, todayLocalISO } from '../../lib/format';

interface DatePickerProps {
  value: string;
  onChange: (ymd: string) => void;
  disabled?: boolean;
  className?: string;
  'aria-label'?: string;
}

export function DatePicker({
  value,
  onChange,
  disabled = false,
  className,
  'aria-label': ariaLabel = 'Pick a date',
}: DatePickerProps) {
  const [open, setOpen] = useState(false);
  const selected = parseLocalDate(value);
  const valid = !Number.isNaN(selected.getTime()) && Boolean(value);
  const label = valid ? formatDateLong(value) : 'Pick a date';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          aria-label={ariaLabel}
          data-empty={valid ? undefined : 'true'}
          className={cn('w-full justify-between bg-inset font-normal', !valid && 'text-muted-foreground', className)}
        >
          <span className="truncate">{label}</span>
          <ChevronDown data-icon="inline-end" className="text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto" align="start">
        <Calendar
          mode="single"
          selected={valid ? selected : undefined}
          onSelect={(date) => {
            if (!date) return;
            onChange(toLocalISODate(date));
            setOpen(false);
          }}
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="self-end"
          onClick={() => {
            onChange(todayLocalISO());
            setOpen(false);
          }}
        >
          Today
        </Button>
      </PopoverContent>
    </Popover>
  );
}
