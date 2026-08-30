import React, { useEffect, useState } from 'react';
import { Brain, Edit2, Plus, Search, Trash2 } from 'lucide-react';
import { defaultMemoryManager } from '../../memory/MemoryManager';
import { MemoryCategory, MemoryItem } from '../../memory/memoryTypes';

const categories: MemoryCategory[] = ['identity', 'preference', 'project', 'routine', 'relationship', 'skill', 'other'];

export const MemorySettingsTab: React.FC = () => {
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState('');
  const [category, setCategory] = useState<MemoryCategory>('other');
  const [editing, setEditing] = useState<MemoryItem | null>(null);
  const [isOpen, setIsOpen] = useState(false);

  const refresh = async () => setItems(await defaultMemoryManager.list(query));
  useEffect(() => {
    void refresh();
  }, [query]);

  const close = () => {
    setIsOpen(false);
    setEditing(null);
    setDraft('');
    setCategory('other');
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!draft.trim()) return;
    if (editing) await defaultMemoryManager.update(editing.id, draft, category);
    else await defaultMemoryManager.remember(draft, category);
    close();
    await refresh();
  };

  return (
    <div className="space-y-4 text-xs">
      <div className="rounded-xl border border-line bg-paper p-4">
        <div className="flex items-center gap-2 font-mono text-xs font-semibold tracking-[0.14em] text-ink">
          <Brain className="h-4 w-4 text-graphite" /> PERSISTENT MEMORY
          <span className="ml-auto rounded-full border border-ink bg-ink px-1.5 py-0.5 font-mono text-[10px] tracking-[0.12em] text-paper">ACTIVE</span>
        </div>
        <p className="mt-2 font-mono text-[11px] leading-relaxed text-graphite">
          SERA keeps durable facts here across sessions. Memories are plain text — no secrets.
        </p>
      </div>

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-2.5 h-3.5 w-3.5 text-faint" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search saved memories…"
          className="w-full rounded-xl border border-line bg-paper py-2 pl-8 pr-3 font-mono text-xs text-ink placeholder:text-faint focus:border-ink-soft focus:outline-none"
        />
      </div>

      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setIsOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-ink px-3 py-1.5 font-mono text-xs font-semibold tracking-[0.1em] text-paper hover:bg-ink-soft"
        >
          <Plus className="h-3.5 w-3.5" /> ADD MEMORY
        </button>
      </div>

      <div className="sera-scroll max-h-[300px] space-y-2 overflow-y-auto pr-1">
        {items.length === 0 ? (
          <p className="py-6 text-center font-mono text-xs text-faint">No memories for this query.</p>
        ) : (
          items.map((item) => (
            <div key={item.id} className="flex items-start justify-between gap-3 rounded-xl border border-line bg-paper p-3">
              <div className="min-w-0">
                <p className="font-mono text-xs leading-relaxed text-ink">{item.fact}</p>
                <span className="font-mono text-[10px] capitalize tracking-[0.12em] text-graphite">{item.category}</span>
              </div>
              <span className="flex shrink-0 gap-1">
                <button
                  type="button"
                  title="Edit memory"
                  onClick={() => {
                    setEditing(item);
                    setDraft(item.fact);
                    setCategory(item.category);
                    setIsOpen(true);
                  }}
                  className="rounded-md p-1.5 text-graphite hover:bg-ink/5 hover:text-ink"
                >
                  <Edit2 className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  title="Delete memory"
                  onClick={async () => {
                    await defaultMemoryManager.forget(item.id);
                    await refresh();
                  }}
                  className="rounded-md p-1.5 text-graphite hover:bg-ink/5 hover:text-ink"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </span>
            </div>
          ))
        )}
      </div>

      {items.length > 0 && (
        <button
          type="button"
          onClick={async () => {
            defaultMemoryManager.clear();
            await refresh();
          }}
          className="font-mono text-[11px] tracking-[0.12em] text-graphite hover:text-ink"
        >
          CLEAR ALL
        </button>
      )}

      {isOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-ink/20 p-4 backdrop-blur-[2px]">
          <form onSubmit={save} className="w-full max-w-md space-y-4 rounded-2xl border-2 border-ink bg-panel p-5 shadow-hard">
            <h3 className="font-mono text-xs font-semibold tracking-[0.14em] text-ink">{editing ? 'EDIT MEMORY' : 'ADD MEMORY'}</h3>
            <textarea
              autoFocus
              required
              rows={4}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="What should SERA remember?"
              className="w-full resize-none rounded-xl border border-line bg-paper p-3 font-mono text-xs text-ink placeholder:text-faint focus:border-ink-soft focus:outline-none"
            />
            <label className="block space-y-1">
              <span className="font-mono text-[11px] tracking-[0.12em] text-graphite">CATEGORY</span>
              <select
                value={category}
                onChange={(event) => setCategory(event.target.value as MemoryCategory)}
                className="w-full rounded-xl border border-line bg-paper p-2 font-mono text-xs text-ink focus:border-ink-soft focus:outline-none"
              >
                {categories.map((option) => (
                  <option key={option} value={option}>
                    {option[0].toUpperCase() + option.slice(1)}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={close} className="rounded-lg border border-line bg-paper px-3 py-1.5 font-mono text-xs text-ink hover:border-ink-soft">
                Cancel
              </button>
              <button type="submit" className="rounded-lg bg-ink px-4 py-1.5 font-mono text-xs font-semibold tracking-[0.1em] text-paper hover:bg-ink-soft">
                Save
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
