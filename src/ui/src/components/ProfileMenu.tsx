import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { CircleHelp, LogOut, Settings } from 'lucide-react';
import { fetchMe, signOut, SIGNOUT_FLAG_KEY } from '../lib/auth';
import { useFinancialOnboarding } from './FinancialOnboardingProvider';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
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

export function ProfileMenu() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const onboarding = useFinancialOnboarding();
  const me = useQuery({ queryKey: ['me'], queryFn: fetchMe });

  const onSignOut = async () => {
    await signOut();
    sessionStorage.setItem(SIGNOUT_FLAG_KEY, '1');
    qc.invalidateQueries({ queryKey: ['me'] });
  };

  const name = me.data ? displayName(me.data.user) : '—';
  const email = me.data?.user.email ?? '';
  const initials = me.data ? initialsFor(name) : '?';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="icon" className="size-11 md:size-11" aria-label="Open profile menu">
          <Avatar>
            <AvatarFallback className="bg-primary/15 text-sm text-primary">{initials}</AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel>
            <div className="font-semibold">{name}</div>
            <div className="truncate text-xs font-normal text-muted-foreground" title={email}>
              {email}
            </div>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={() => navigate('/settings')}>
            <Settings />
            Settings
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={onboarding.isSaving}
            onClick={() => onboarding.restart()}
          >
            <CircleHelp />
            Tutorial
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onClick={() => void onSignOut()}>
            <LogOut />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function displayName(user: { name: string; email: string }): string {
  const n = user.name?.trim();
  if (n) return n;
  const local = user.email?.split('@')[0]?.trim();
  if (local) return local;
  return 'User';
}

function initialsFor(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]![0]!.toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}
