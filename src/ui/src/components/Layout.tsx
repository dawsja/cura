import { useEffect, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { motion, useReducedMotion } from 'motion/react';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { MobileBottomNav } from './MobileBottomNav';

const MOBILE_QUERY = '(max-width: 767px)';

/** Tracks the mobile breakpoint so route transitions only run on mobile. */
function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() => window.matchMedia(MOBILE_QUERY).matches);
  useEffect(() => {
    const media = window.matchMedia(MOBILE_QUERY);
    const onChange = () => setIsMobile(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);
  return isMobile;
}

/**
 * Layout — viewport-locked frame:
 *   - The outer container is `h-full overflow-hidden` (filling
 *     html/body/#root which are also height-locked + overflow-hidden),
 *     so the document itself never scrolls. The only scrollable
 *     surfaces are:
 *       1. The sidebar's nav area (if it overflows) — keeps the
 *          brand + support link pinned to top/bottom.
 *       2. The main <main> — scrolls independently as the user reads
 *          a long transactions list, budget table, etc. The Header
 *          stays visible at the top of the main area. `min-h-0` and
 *          `overscroll-y-contain` keep flex sizing correct and stop
 *          Chromium from chaining wheel scroll past the shell.
 *   - Mobile uses the same outer constraint; the MobileBottomNav is
 *     `fixed` (separate stacking context) so it sits on top of the
 *     scrollable main without taking part in the flex layout.
 *   - On mobile, route changes reset the main scroll position and play
 *     a short fade/slide transition so navigation feels like a native
 *     app's screen change. Desktop (md+) renders routes with no
 *     remount and no animation — identical to before.
 *
 *   Sidebar is icon-only by default; the logo becomes an "open sidebar"
 *   button on hover/focus and the expanded panel has a close button.
 */
export function Layout({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const isMobile = useIsMobile();
  const reducedMotion = useReducedMotion() ?? false;
  const animateRoutes = isMobile && !reducedMotion;

  // Native apps show each screen from the top. Only applied on mobile so
  // desktop scroll behavior stays exactly as it was.
  useEffect(() => {
    if (!isMobile) return;
    document.getElementById('app-main')?.scrollTo({ top: 0 });
  }, [pathname, isMobile]);

  return (
    // Sidebar (`bg-page`) and main area (`bg-page`) share the same
    // background so the rail blends in; only the icon column + support
    // link distinguish it from the content area.
    <div className="app-shell flex bg-page overflow-hidden">
      <Sidebar />
      <div className="flex-1 min-w-0 min-h-0 flex flex-col h-full overflow-hidden">
        <Header />
        <main id="app-main" className="app-main app-mobile-bottom-space flex-1 min-h-0 overflow-y-auto overscroll-y-contain px-4 pt-3 md:p-8 fg-primary">
          {/* Keyed by pathname only while animating: on desktop the key is
              stable so the tree never remounts on navigation. */}
          <motion.div
            key={animateRoutes ? pathname : 'app-routes'}
            initial={animateRoutes ? { opacity: 0, y: 10 } : false}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.22, ease: [0.32, 0.72, 0, 1] }}
          >
            {children}
          </motion.div>
        </main>
        <MobileBottomNav />
      </div>
    </div>
  );
}
