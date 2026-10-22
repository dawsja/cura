import { useEffect, useRef, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  BarChart3,
  FileText,
  FolderTree,
  House,
  LayoutGrid,
  PiggyBank,
  Receipt,
  RefreshCw,
  ScrollText,
  TrendingDown,
  Wallet,
  X,
} from 'lucide-react';
import clsx from 'clsx';

// Bottom nav for mobile (md- breakpoint). The four most-used destinations
// stay one tap away; the rightmost control opens the remaining destinations
// as a launcher-style grid sheet directly above the user's thumb.
const items = [
  { to: '/', label: 'Home', icon: House },
  { to: '/transactions', label: 'Transactions', icon: Receipt },
  { to: '/budget', label: 'Budget', icon: BarChart3 },
  { to: '/paydown', label: 'Pay down', icon: TrendingDown },
];

const menuItems = [
  { to: '/accounts', label: 'Accounts', icon: Wallet },
  { to: '/saveup', label: 'Save up', icon: PiggyBank },
  { to: '/reports', label: 'Reports', icon: FileText },
  { to: '/recurring', label: 'Recurring', icon: RefreshCw },
  { to: '/categories', label: 'Categories', icon: FolderTree },
  { to: '/rules', label: 'Rules', icon: ScrollText },
];

/** Spring used by the More sheet. */
const SPRING = { type: 'spring', stiffness: 500, damping: 38 } as const;

function TabContent({
  icon: Icon,
  label,
  active,
}: {
  icon: typeof House;
  label: string;
  active: boolean;
}) {
  return (
    <>
      <Icon className="h-[22px] w-[22px]" strokeWidth={active ? 2.4 : 2} />
      <span className={clsx(
        'max-w-full px-0.5 text-center font-semibold leading-none tracking-tight',
        label.length > 10 ? 'text-[9px]' : 'text-[10px]',
      )}>
        {label}
      </span>
    </>
  );
}

const TAB_CLS = 'relative flex h-full w-full min-w-0 flex-col items-center justify-center gap-1 rounded-xl px-1 pt-1 transition-[color,transform] duration-150 active:scale-[0.92] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-amber-500';

export function MobileBottomNav() {
  const [menuOpen, setMenuOpen] = useState(false);
  const navRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const location = useLocation();
  const reducedMotion = useReducedMotion() ?? false;
  const menuRouteActive = menuItems.some((item) => item.to === location.pathname);

  // Navigating away (via the pill or any in-page link) always closes the
  // sheet so it never lingers over a freshly rendered page.
  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!menuOpen) return;

    const closeOnOutsidePress = (event: PointerEvent) => {
      if (navRef.current && !navRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setMenuOpen(false);
      menuButtonRef.current?.focus();
    };

    document.addEventListener('pointerdown', closeOnOutsidePress);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePress);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [menuOpen]);

  return (
    <div ref={navRef} className="md:hidden fixed bottom-[calc(env(safe-area-inset-bottom,0px)+0.75rem)] left-3 right-3 z-30">
      {/* Scrim behind the More sheet. Lives inside the pill's stacking
          context so the pill + sheet stay interactive above it while the
          page content dims — the same layering a native tab-bar menu uses. */}
      <AnimatePresence>
        {menuOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reducedMotion ? 0 : 0.18 }}
            className="fixed inset-0 bg-black/45"
            aria-hidden="true"
            onClick={() => setMenuOpen(false)}
          />
        )}
      </AnimatePresence>

      {/* More sheet — a launcher-style grid that springs out of the pill.
          Every destination that is not one of the four primary tabs lives
          here, so the entire app remains reachable from the pill. */}
      <AnimatePresence>
        {menuOpen && (
          <motion.div
            id="mobile-more-pages"
            role="menu"
            aria-label="More pages"
            initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 14, scale: 0.96 }}
            animate={reducedMotion ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 14, scale: 0.96 }}
            transition={reducedMotion ? { duration: 0.1 } : SPRING}
            style={{ transformOrigin: 'bottom right' }}
            className="absolute bottom-full left-0 right-0 mb-3 max-h-[calc(100dvh-var(--app-header-height)-var(--app-tab-height)-3rem)] overflow-y-auto overscroll-contain rounded-[1.4rem] border border-default bg-surface/95 p-3 shadow-[0_12px_40px_rgba(0,0,0,0.45)] backdrop-blur-xl"
          >
            <div className="px-2 pb-2 pt-1 text-xs font-semibold uppercase tracking-wide fg-muted">
              More pages
            </div>
            <div className="grid grid-cols-3 gap-2">
              {menuItems.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  role="menuitem"
                  onClick={() => setMenuOpen(false)}
                  className={({ isActive }) => clsx(
                    'flex min-h-[4.75rem] flex-col items-center justify-center gap-1.5 rounded-2xl px-1 py-2 text-xs font-medium transition-[background-color,transform] active:scale-[0.94]',
                    isActive
                      ? 'bg-amber-900/30 text-amber-300'
                      : 'bg-canvas-subtle fg-secondary',
                  )}
                >
                  <item.icon className="h-6 w-6 shrink-0" strokeWidth={2} />
                  <span className="max-w-full truncate">{item.label}</span>
                </NavLink>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <nav aria-label="Primary navigation" className="app-tab-bar relative rounded-[1.4rem] border border-default bg-surface/92 shadow-[0_12px_40px_rgba(0,0,0,0.45)] backdrop-blur-xl">
        <ul className="grid h-[var(--app-tab-height)] grid-cols-5 px-1">
          {items.map((it) => (
            <li key={it.to} className="h-full p-1.5">
              <NavLink
                to={it.to}
                data-onboarding-target={it.to === '/transactions' ? 'nav-transactions' : it.to === '/budget' ? 'nav-budget' : undefined}
                end={it.to === '/'}
                aria-label={it.label}
                onClick={() => setMenuOpen(false)}
                className={({ isActive }) => clsx(
                  TAB_CLS,
                  isActive && !menuOpen ? 'text-amber-300' : 'fg-tertiary',
                )}
              >
                {({ isActive }) => (
                  <TabContent icon={it.icon} label={it.label} active={isActive && !menuOpen} />
                )}
              </NavLink>
            </li>
          ))}
          <li className="relative h-full p-1.5">
            <button
              ref={menuButtonRef}
              type="button"
              data-onboarding-target="nav-accounts"
              aria-label={menuOpen ? 'Close navigation menu' : 'Open navigation menu'}
              aria-expanded={menuOpen}
              aria-controls="mobile-more-pages"
              onClick={() => setMenuOpen((open) => !open)}
              className={clsx(
                TAB_CLS,
                menuOpen || menuRouteActive ? 'text-amber-300' : 'fg-tertiary',
              )}
            >
              <TabContent
                icon={menuOpen ? X : LayoutGrid}
                label="More"
                active={menuOpen || menuRouteActive}
              />
            </button>
          </li>
        </ul>
      </nav>
    </div>
  );
}
