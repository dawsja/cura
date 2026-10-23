import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Button } from '../ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '../ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';

/** Searchable merchant filter (Popover + Command), with "Any merchant" first. */
export function MerchantPicker({ merchants, value, onChange }: { merchants: string[]; value: string; onChange: (merchant: string) => void }) {
  const [open, setOpen] = useState(false);
  const pick = (merchant: string) => {
    onChange(merchant);
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label="Merchant filter"
          className="w-full justify-between bg-inset font-normal"
        >
          <span className="truncate">{value || 'Any merchant'}</span>
          <ChevronDown data-icon="inline-end" className="text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 gap-0 p-0">
        <Command>
          <CommandInput placeholder="Search merchants" />
          <CommandList>
            <CommandEmpty>No merchant matches.</CommandEmpty>
            <CommandGroup>
              <CommandItem value="Any merchant" data-checked={!value} onSelect={() => pick('')}>Any merchant</CommandItem>
              {merchants.map((merchant) => (
                <CommandItem key={merchant} value={merchant} data-checked={merchant === value} onSelect={() => pick(merchant)}>
                  {merchant}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
