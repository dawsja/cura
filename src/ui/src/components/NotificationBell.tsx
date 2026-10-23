import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, CreditCard, Receipt } from 'lucide-react';
import { api } from '../lib/api';
import { formatMoney } from '../lib/format';
import { useReviews } from './ReviewsProvider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';

interface NotificationsResponse {
  reviews: { count: number; visible: boolean };
  upcoming: {
    key: string;
    merchant: string;
    amount: number;
    frequency: 'weekly' | 'monthly' | 'yearly';
    nextDate: string;
    daysUntil: number;
  }[];
  badgeCount: number;
}

function daysLabel(days: number): string {
  if (days < 0) return `${Math.abs(days)}d overdue`;
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}

export function NotificationBell() {
  const qc = useQueryClient();
  const { openModal } = useReviews();

  const notifQ = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.get<NotificationsResponse>('/api/notifications'),
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });

  const clearMut = useMutation({
    mutationFn: () => api.post<{ ok: true }>('/api/notifications/clear', {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['notifications'] });
    },
  });

  const badge = notifQ.data?.badgeCount ?? 0;
  const reviews = notifQ.data?.reviews;
  const upcoming = notifQ.data?.upcoming ?? [];
  const hasItems = (reviews?.visible ?? false) || upcoming.length > 0;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="relative size-11 md:size-11"
          aria-label={badge > 0 ? `${badge} notification${badge === 1 ? '' : 's'}` : 'Notifications'}
        >
          <Bell />
          {badge > 0 ? (
            <Badge className="absolute top-1 right-1 h-[18px] min-w-[18px] px-1 text-[10px]">
              {badge > 99 ? '99+' : badge}
            </Badge>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 max-w-[calc(100vw-1.5rem)]">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Notifications</DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        {!hasItems ? (
          <Empty className="border-0 p-4">
            <EmptyHeader>
              <EmptyTitle>You&apos;re all caught up</EmptyTitle>
              <EmptyDescription>No reviews or upcoming charges.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <DropdownMenuGroup>
            {reviews?.visible ? (
              <DropdownMenuItem
                onClick={() => openModal()}
                className="items-start"
              >
                <Receipt />
                <span className="flex min-w-0 flex-col">
                  <span>
                    You have {reviews.count} transaction{reviews.count === 1 ? '' : 's'} that need to be reviewed
                  </span>
                  <span className="text-xs text-muted-foreground">Tap to review</span>
                </span>
              </DropdownMenuItem>
            ) : null}
            {upcoming.map((u) => (
              <DropdownMenuItem key={u.key} className="items-start" disabled>
                <CreditCard />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{u.merchant} charge coming up</span>
                  <span className="text-xs text-muted-foreground">
                    {formatMoney(u.amount)} · {daysLabel(u.daysUntil)} · {u.frequency}
                  </span>
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem
            disabled={!hasItems || clearMut.isPending}
            onClick={() => clearMut.mutate()}
          >
            {clearMut.isPending ? 'Clearing…' : 'Clear'}
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
