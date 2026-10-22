import { useState, type ReactElement } from 'react';
import { NavLink } from 'react-router-dom';
import {
  House,
  BarChart3,
  TrendingDown,
  Receipt,
  PiggyBank,
  FileText,
  Coffee,
  Wallet,
  FolderTree,
  ScrollText,
  RefreshCw,
  PanelLeftClose,
  PanelLeftOpen,
  type LucideIcon,
} from 'lucide-react';
import { cn } from 'cn';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

// Top group: daily working surfaces. Order matters — this is the order
// users see in the sidebar. Home first, then transactions, budget,
// paydown, then the planning surfaces (save up, reports).
const primaryItems = [
  { to: '/', label: 'Home', icon: House },
  { to: '/transactions', label: 'Transactions', icon: Receipt },
  { to: '/budget', label: 'Budget', icon: BarChart3 },
  { to: '/paydown', label: 'Pay down', icon: TrendingDown },
  { to: '/saveup', label: 'Save up', icon: PiggyBank },
  { to: '/reports', label: 'Reports', icon: FileText },
  { to: '/recurring', label: 'Recurring', icon: RefreshCw },
];

// Bottom group: settings-shaped destinations. A horizontal divider
// above this group keeps it visually separated from the working
// surfaces above (per the AGENTS.md UI constraint).
const settingsItems = [
  { to: '/accounts', label: 'Accounts', icon: Wallet },
  { to: '/categories', label: 'Categories', icon: FolderTree },
  { to: '/rules', label: 'Rules', icon: ScrollText },
];

const ONBOARDING_TARGETS: Record<string, string> = {
  '/transactions': 'nav-transactions',
  '/budget': 'nav-budget',
  '/accounts': 'nav-accounts',
};

const EXPANDED_KEY = 'cura.sidebar.expanded';

function storedExpanded(): boolean {
  try {
    return localStorage.getItem(EXPANDED_KEY) === 'true';
  } catch {
    return false;
  }
}

/**
 * Sidebar — icon-rail navigation.
 *
 * Collapsed to icons by default. Hovering or focusing the logo turns it
 * into an "open sidebar" button; the expanded panel has its own close
 * button. The choice is remembered per browser. Collapsed items show
 * their label in a tooltip.
 */
export function Sidebar() {
  const [expanded, setExpandedState] = useState(storedExpanded);
  const setExpanded = (next: boolean) => {
    setExpandedState(next);
    try {
      localStorage.setItem(EXPANDED_KEY, String(next));
    } catch {
      // Private windows can block storage; the sidebar still toggles.
    }
  };

  return (
    <aside
      // `h-full` fills the Layout frame. The brand and support link are
      // `shrink-0` so they stay pinned; the middle <nav> scrolls if it
      // ever overflows.
      className={cn(
        'hidden h-full min-h-0 shrink-0 flex-col overflow-hidden bg-page transition-[width] duration-200 md:flex',
        expanded ? 'w-60' : 'w-[72px]',
      )}
      aria-label="Main navigation"
    >
      <div className={cn('flex shrink-0 items-center gap-2 py-4', expanded ? 'justify-between px-4' : 'justify-center')}>
        {expanded ? (
          <>
            <img src="/logo.png" alt="Cura Money" className="size-8 shrink-0" />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button type="button" variant="ghost" size="icon" aria-label="Close sidebar" onClick={() => setExpanded(false)}>
                  <PanelLeftClose />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">Close sidebar</TooltipContent>
            </Tooltip>
          </>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                aria-label="Open sidebar"
                onClick={() => setExpanded(true)}
                className="group/logo size-10 p-0 md:size-10"
              >
                <img src="/logo.png" alt="" className="size-8 group-hover/logo:hidden group-focus-visible/logo:hidden" />
                <PanelLeftOpen className="hidden size-5 group-hover/logo:block group-focus-visible/logo:block" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">Open sidebar</TooltipContent>
          </Tooltip>
        )}
      </div>

      <nav className="hide-scrollbar flex min-h-0 min-w-0 flex-1 flex-col gap-1 overflow-x-clip overflow-y-auto overscroll-y-contain p-2 pt-4">
        {primaryItems.map((it) => (
          <SidebarLink key={it.to} {...it} expanded={expanded} />
        ))}
        <div className="min-w-0 px-2 py-2">
          <Separator />
        </div>
        {settingsItems.map((it) => (
          <SidebarLink key={it.to} {...it} expanded={expanded} />
        ))}
      </nav>

      {/* Support link stays pinned to the bottom of the icon rail. */}
      <div className="min-w-0 shrink-0 overflow-hidden p-2">
        <SidebarTip label="Buy me a coffee" expanded={expanded}>
          <a
            href="https://buymeacoffee.com/curamoney"
            target="_blank"
            rel="noopener noreferrer"
            className={cn(
              'flex w-full min-w-0 items-center gap-3 overflow-hidden rounded-lg px-3 py-2 text-sm font-medium text-amber-300 transition-colors hover:bg-amber-900/30',
              expanded ? 'justify-start' : 'justify-center',
            )}
            aria-label="Buy me a coffee"
          >
            <Coffee className="coffee-accent size-5 shrink-0" />
            {expanded && <span className="min-w-0 truncate">Buy me a coffee</span>}
          </a>
        </SidebarTip>
      </div>
    </aside>
  );
}

function SidebarLink({ to, label, icon: Icon, expanded }: { to: string; label: string; icon: LucideIcon; expanded: boolean }) {
  return (
    <SidebarTip label={label} expanded={expanded}>
      <NavLink
        to={to}
        data-onboarding-target={ONBOARDING_TARGETS[to]}
        end={to === '/'}
        onClick={(event) => event.currentTarget.blur()}
        className={({ isActive }) =>
          cn(
            'flex min-w-0 items-center gap-3 overflow-hidden rounded-lg px-3 py-2 text-sm font-medium transition-colors',
            expanded ? 'justify-start' : 'justify-center',
            isActive ? 'bg-amber-900/30 text-amber-300' : 'fg-secondary hover:bg-muted hover:text-foreground',
          )
        }
        aria-label={label}
      >
        <Icon className="size-5 shrink-0" />
        {expanded && <span className="min-w-0 truncate">{label}</span>}
      </NavLink>
    </SidebarTip>
  );
}

/** Collapsed rail items name themselves in a tooltip; expanded ones show their label. */
function SidebarTip({ label, expanded, children }: { label: string; expanded: boolean; children: ReactElement }) {
  if (expanded) return children;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}
