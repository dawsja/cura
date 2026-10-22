import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import clsx from 'clsx';
import { NotificationBell } from './NotificationBell';
import { ProfileMenu } from './ProfileMenu';

const routeTitles: Record<string, string> = {
  '/': 'Home',
  '/accounts': 'Accounts',
  '/budget': 'Budget',
  '/categories': 'Categories',
  '/transactions': 'Transactions',
  '/paydown': 'Pay down',
  '/saveup': 'Save up',
  '/reports': 'Reports',
  '/rules': 'Rules',
  '/recurring': 'Recurring',
  '/settings': 'Settings',
};

/**
 * The Header maps authenticated routes, including Settings, to mobile page
 * titles and carries the notification bell and profile
 * menu. User identity / sign-out live inside
 * the `ProfileMenu` dropdown — the visible chrome here is intentionally
 * minimal so the user focuses on the page content.
 *
 * On mobile the header behaves like a native app bar: it stays pinned
 * while `#app-main` scrolls underneath, and a hairline divider fades in
 * once content has scrolled so the boundary reads clearly. Desktop
 * (md+) keeps the borderless header unchanged.
 *
 * The bell sits to the LEFT of the profile menu with a 4px gap. It
 * is always visible; the badge only appears when there's at least
 * one SimpleFIN-imported transaction awaiting review.
 */
export function Header() {
  const location = useLocation();
  const title = routeTitles[location.pathname] ?? 'Cura Money';
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const main = document.getElementById('app-main');
    if (!main) return;
    const onScroll = () => setScrolled(main.scrollTop > 4);
    onScroll();
    main.addEventListener('scroll', onScroll, { passive: true });
    return () => main.removeEventListener('scroll', onScroll);
  }, [location.pathname]);

  return (
    // `shrink-0` keeps the Header pinned at the top of the main area
    // while the page content scrolls beneath it. Without this, the
    // header would compress / scroll out of view the moment the main
    // content overflowed.
    <header
      className={clsx(
        'app-header-safe relative z-40 flex min-h-[var(--app-header-height)] shrink-0 items-center justify-between overflow-visible bg-page/95 px-4 py-3 backdrop-blur-xl transition-[border-color,box-shadow] duration-200 md:bg-page md:px-8 md:py-4',
        // Mobile-only scrolled hairline + soft drop; md+ stays borderless.
        'border-b md:border-b-0 md:shadow-none',
        scrolled ? 'border-default shadow-[0_10px_18px_-16px_rgb(0_0_0/0.55)]' : 'border-transparent',
      )}
    >
      <div className="min-w-0 md:hidden">
        <h1 className="truncate text-[1.35rem] font-bold tracking-tight fg-primary">{title}</h1>
      </div>
      {/* On md+ screens the sidebar carries the brand; the right cluster
          holds the bell + profile menu in a single flex row. The bell
          sits to the left of the avatar per spec. */}
      <div className="ml-auto flex items-center gap-2 md:gap-3">
        <NotificationBell />
        <ProfileMenu />
      </div>
    </header>
  );
}
