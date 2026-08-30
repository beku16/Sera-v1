import React from 'react';
import { Globe, X, CheckCircle2 } from 'lucide-react';
import { BrowserActionEvent } from '../../types';

interface BrowserActionBannerProps {
  action: BrowserActionEvent | null;
  onDismiss: () => void;
}

export const BrowserActionBanner: React.FC<BrowserActionBannerProps> = ({ action, onDismiss }) => {
  if (!action) return null;

  return (
    <div
      id="sera-browser-action-banner"
      className="fixed left-1/2 top-4 z-50 w-[92%] max-w-md -translate-x-1/2 animate-fade-up"
    >
      <div className="relative flex items-center justify-between gap-3 overflow-hidden rounded-2xl border border-line bg-paper/95 px-4 py-3 shadow-2xl backdrop-blur-md">
        <span className="absolute inset-y-0 left-0 w-1.5 bg-[var(--lamp,var(--color-lamp))]" aria-hidden="true" />
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-line bg-panel text-ink shadow-sm">
            <Globe className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 font-mono text-xs font-bold text-ink">
              <span className="truncate">{action.siteName}</span>
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 font-mono text-[9px] font-bold text-emerald-500 border border-emerald-500/20">
                <CheckCircle2 className="h-2.5 w-2.5" /> {action.openedDirectly ? 'Redirected' : 'Opened'}
              </span>
            </div>
            <span className="block truncate font-mono text-[10px] text-graphite mt-0.5">{action.domain || action.url}</span>
          </div>
        </div>

        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 rounded-lg p-1.5 text-graphite transition hover:bg-panel hover:text-ink active:scale-95"
          title="Dismiss notification"
          aria-label="Dismiss browser notification"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
};
