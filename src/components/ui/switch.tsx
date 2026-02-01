'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

interface SwitchProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'> {
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
}

const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(
  ({ className, checked, onCheckedChange, disabled, ...props }, ref) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      ref={ref}
      className={cn(
        'peer inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
      style={{
        backgroundColor: checked ? 'var(--color-primary)' : 'var(--color-border)',
      }}
      onClick={() => onCheckedChange?.(!checked)}
      {...props}
    >
      <span
        className="pointer-events-none block h-5 w-5 rounded-full shadow-lg ring-0 transition-transform"
        style={{
          transform: checked ? 'translateX(22px)' : 'translateX(2px)',
          backgroundColor: checked ? 'var(--color-primary-text)' : 'var(--color-surface)',
        }}
      />
    </button>
  )
);
Switch.displayName = 'Switch';

export { Switch };
