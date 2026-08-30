import React, { useState } from 'react';
import { Sparkles, Compass, Lightbulb, Rocket, Send, ChevronUp } from 'lucide-react';

export interface QuickPromptItem {
  id: string;
  text: string;
  category: string;
  icon: React.ReactNode;
}

export const PROMPT_PRESETS: QuickPromptItem[] = [
  {
    id: 'intro',
    text: 'Hey Sera, what can you do?',
    category: 'Capabilities',
    icon: <Sparkles className="h-3.5 w-3.5" />,
  },
  {
    id: 'space',
    text: 'Search latest space discoveries',
    category: 'Research',
    icon: <Rocket className="h-3.5 w-3.5" />,
  },
  {
    id: 'interesting',
    text: 'Tell me something interesting',
    category: 'Discovery',
    icon: <Lightbulb className="h-3.5 w-3.5" />,
  },
  {
    id: 'creative',
    text: 'Help me brainstorm an idea',
    category: 'Creative',
    icon: <Compass className="h-3.5 w-3.5" />,
  },
];

interface FloatingQuickPromptsProps {
  onSelectPrompt: (text: string, sourceRect: DOMRect, itemId: string) => void;
  lampColor: string;
  isAnimating: boolean;
  selectedId: string | null;
}

export const FloatingQuickPrompts: React.FC<FloatingQuickPromptsProps> = ({
  onSelectPrompt,
  lampColor,
  isAnimating,
  selectedId,
}) => {
  const [isHovered, setIsHovered] = useState(false);

  const handleClick = (item: QuickPromptItem, e: React.MouseEvent<HTMLButtonElement>) => {
    if (isAnimating) return;
    const targetEl = e.currentTarget;
    const sourceRect = targetEl.getBoundingClientRect();
    onSelectPrompt(item.text, sourceRect, item.id);
  };

  return (
    <div
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className="group/quick relative flex w-full flex-col justify-end space-y-2 pb-1 select-none transition-all duration-300"
    >
      {/* Pop-up Cards Container (Hidden by default, pops up smoothly on hover) */}
      <div
        className={`flex flex-col space-y-2 transition-all duration-300 ${
          isHovered || isAnimating
            ? 'opacity-100 translate-y-0 scale-100 max-h-[380px] pointer-events-auto'
            : 'opacity-0 translate-y-3 scale-95 max-h-0 pointer-events-none overflow-hidden'
        }`}
      >
        {/* Crisp Header Badge */}
        <div
          className="mb-1 flex items-center justify-between px-1 font-mono text-[10px] font-bold tracking-wider uppercase text-white/70 transition-opacity duration-200"
          style={{ opacity: isAnimating ? 0 : 1 }}
        >
          <span className="inline-flex items-center gap-1.5">
            <Sparkles className="h-3.5 w-3.5" style={{ color: lampColor }} />
            <span className="text-white/80">QUICK PROMPTS</span>
          </span>
          <span className="font-mono text-[9px] text-white/40">Hover to select</span>
        </div>

        {/* Quick Prompt Cards */}
        {PROMPT_PRESETS.map((item) => {
          const isSelected = selectedId === item.id;
          const isOther = isAnimating && !isSelected;

          return (
            <button
              key={item.id}
              data-prompt-id={item.id}
              type="button"
              onClick={(e) => handleClick(item, e)}
              disabled={isAnimating}
              className={`group relative flex w-full items-center justify-between gap-3 rounded-2xl border px-3.5 py-2.5 text-left font-sans text-xs font-medium backdrop-blur-2xl transition-all duration-200 ${
                isOther
                  ? 'opacity-0 scale-95 -translate-y-2 blur-[3px] pointer-events-none'
                  : isSelected
                  ? 'opacity-0 pointer-events-none'
                  : 'hover:border-white/30 hover:bg-white/[0.08] hover:shadow-lg active:scale-[0.98]'
              }`}
              style={{
                background: 'linear-gradient(135deg, rgba(255, 255, 255, 0.06) 0%, rgba(255, 255, 255, 0.02) 100%)',
                borderColor: 'rgba(255, 255, 255, 0.12)',
                boxShadow: `0 4px 16px rgba(0, 0, 0, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.1)`,
                color: '#ffffff',
              }}
            >
              <div className="flex items-center gap-2.5 min-w-0">
                {/* Category Icon Badge */}
                <span
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded-lg transition-transform duration-200 group-hover:scale-105"
                  style={{
                    background: `${lampColor}20`,
                    color: lampColor,
                  }}
                >
                  {item.icon}
                </span>

                {/* Prompt Text */}
                <span className="truncate text-xs font-medium text-white/90 group-hover:text-white">
                  {item.text}
                </span>
              </div>

              {/* Quick Action Send Icon */}
              <Send
                className="h-3.5 w-3.5 shrink-0 opacity-40 transition-all duration-200 group-hover:translate-x-0.5 group-hover:opacity-100"
                style={{ color: lampColor }}
              />
            </button>
          );
        })}
      </div>

      {/* Subtle, Non-Intrusive Trigger Pill when not hovering */}
      {!isAnimating && (
        <div
          className={`flex items-center justify-end px-1 transition-all duration-300 ${
            isHovered ? 'opacity-0 max-h-0 pointer-events-none' : 'opacity-60 hover:opacity-100 max-h-6'
          }`}
        >
          <div className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 font-mono text-[9px] font-semibold text-white/70 backdrop-blur-md transition-all hover:border-white/20 hover:bg-white/[0.08] hover:text-white">
            <Sparkles className="h-2.5 w-2.5" style={{ color: lampColor }} />
            <span>QUICK PROMPTS</span>
            <ChevronUp className="h-2.5 w-2.5 text-white/40" />
          </div>
        </div>
      )}
    </div>
  );
};
