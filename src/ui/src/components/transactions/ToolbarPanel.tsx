import type { ReactElement, ReactNode } from 'react';
import { cn } from '../../lib/utils';
import {
  Drawer,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '../ui/drawer';
import { Popover, PopoverContent, PopoverHeader, PopoverTitle, PopoverTrigger } from '../ui/popover';

/**
 * Toolbar panel: a Popover anchored to its button on desktop and a bottom
 * Drawer on phones, so filters stay reachable above the tab bar.
 */
export function ToolbarPanel({
  title,
  open,
  onOpenChange,
  isDesktop,
  trigger,
  className,
  children,
  footer,
}: {
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isDesktop: boolean;
  trigger: ReactElement;
  className?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  if (isDesktop) {
    return (
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>{trigger}</PopoverTrigger>
        <PopoverContent align="end" className={cn('w-80 gap-4 p-4', className)}>
          <PopoverHeader>
            <PopoverTitle>{title}</PopoverTitle>
          </PopoverHeader>
          {children}
          {footer && <div className="flex items-center justify-between gap-2">{footer}</div>}
        </PopoverContent>
      </Popover>
    );
  }
  return (
    <>
      {trigger}
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>{title}</DrawerTitle>
          </DrawerHeader>
          <div className="flex flex-col gap-4 overflow-y-auto px-4 pb-2">{children}</div>
          {footer && <DrawerFooter className="flex-row items-center justify-between">{footer}</DrawerFooter>}
        </DrawerContent>
      </Drawer>
    </>
  );
}
