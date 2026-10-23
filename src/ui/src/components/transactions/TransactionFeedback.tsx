import { Receipt, X } from 'lucide-react';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Empty, EmptyContent, EmptyHeader, EmptyMedia, EmptyTitle } from '../ui/empty';

export function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <Badge variant="secondary" className="h-8 max-w-full gap-0.5 rounded-lg px-1.5">
      <span className="truncate">{label}</span>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onClick={onRemove}
        aria-label={`Remove filter ${label}`}
      >
        <X />
      </Button>
    </Badge>
  );
}

export function EmptyTransactions({
  filtered,
  onClear,
  onAdd,
  addDisabled,
}: {
  filtered: boolean;
  onClear: () => void;
  onAdd: () => void;
  addDisabled?: boolean;
}) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon"><Receipt /></EmptyMedia>
        <EmptyTitle>{filtered ? 'No transactions match.' : 'No transactions yet.'}</EmptyTitle>
      </EmptyHeader>
      <EmptyContent>
        {filtered ? (
          <Button type="button" variant="link" onClick={onClear}>Clear filters</Button>
        ) : (
          <Button type="button" variant="link" onClick={onAdd} disabled={addDisabled}>
            Add transaction
          </Button>
        )}
      </EmptyContent>
    </Empty>
  );
}
