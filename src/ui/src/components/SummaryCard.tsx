import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';

export type SummaryTone = 'slate' | 'emerald' | 'amber' | 'rose' | 'violet';

export function toneTextClass(tone: SummaryTone): string {
  switch (tone) {
    case 'rose': return 'text-rose-400';
    case 'amber': return 'text-amber-400';
    case 'emerald': return 'text-emerald-400';
    case 'violet': return 'text-violet-400';
    case 'slate': return 'text-foreground';
  }
}

export function SummaryCard({
  label,
  value,
  sub,
  tone,
  icon,
}: {
  label: string;
  value: string;
  sub?: string;
  tone: SummaryTone;
  icon?: ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardDescription>{label}</CardDescription>
        {icon ? <div className="text-muted-foreground">{icon}</div> : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-1">
        <div className={cn('text-2xl font-bold tabular-nums', toneTextClass(tone))}>
          {value}
        </div>
        {sub ? <div className="text-xs text-muted-foreground">{sub}</div> : null}
      </CardContent>
    </Card>
  );
}
