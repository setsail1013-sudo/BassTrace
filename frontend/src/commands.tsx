import { Presence } from './motion';
import { createContext, useContext, useEffect, useId, useLayoutEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import './commands.css';

export interface Command {
  id: string; label: string; keys?: string[]; group?: string; enabled?: boolean;
  inInput?: boolean; inDialog?: boolean; priority?: number; keepEditor?: boolean; scope?: 'score'; run: () => void;
}
export function matchesShortcut(event: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>, shortcut: string): boolean {
  const parts = shortcut.toLowerCase().split('+'), key = parts.pop()!;
  const ctrl = parts.includes('ctrl'), shift = parts.includes('shift'), alt = parts.includes('alt');
  if (!!(event.ctrlKey || event.metaKey) !== ctrl || event.altKey !== alt) return false;
  // '+' is represented by Plus so the delimiter remains unambiguous.
  if (key === 'plus') return !ctrl && !alt && ['+', '='].includes(event.key);
  if (event.shiftKey !== shift) return false;
  return key === 'space' ? event.code === 'Space' : event.key.toLowerCase() === key;
}
class Registry {
  scopes = new Map<string, Command[]>(); listeners = new Set<() => void>(); snapshot: Command[] = []; fingerprint = '';
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  getSnapshot = () => this.snapshot;
  all = () => [...this.scopes.values()].flat().sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  update(scope: string, commands?: Command[]) {
    if (commands) this.scopes.set(scope, commands); else this.scopes.delete(scope);
    const next = this.all(), signature = JSON.stringify(next.map(({ run, ...c }) => c));
    if (signature !== this.fingerprint) { this.fingerprint = signature; this.snapshot = next; this.listeners.forEach(fn => fn()); }
  }
  invoke = (id: string) => {
    let command = this.all().find(c => c.id === id && c.enabled !== false);
    if (!command) return;
    if (!command.keepEditor) flushSync(() => window.dispatchEvent(new Event('basschart:commit-lyric')));
    command = this.all().find(c => c.id === id && c.enabled !== false);
    command?.run();
  };
}
const Context = createContext<Registry | null>(null);
export function useCommands(commands: Command[]) {
  const registry = useContext(Context), scope = useId();
  useLayoutEffect(() => { registry?.update(scope, commands); });
  useEffect(() => () => registry?.update(scope), [registry, scope]);
}
export function useCommandActions() {
  const registry = useContext(Context);
  return { invoke: (id: string) => registry?.invoke(id) };
}
export function CommandProvider({ children }: { children: ReactNode }) {
  const [registry] = useState(() => new Registry());
  return <Context.Provider value={registry}>{children}<CommandSurface registry={registry}/></Context.Provider>;
}
function CommandSurface({ registry }: { registry: Registry }) {
  const commands = useSyncExternalStore(registry.subscribe, registry.getSnapshot);
  const [open, setOpen] = useState<'search' | 'help' | null>(null), [query, setQuery] = useState(''), [active, setActive] = useState(0);
  const [returnFocus, setReturnFocus] = useState<HTMLElement | null>(null);
  useEffect(() => { if (open) document.querySelector('.command-list>button.active')?.scrollIntoView({ block: 'nearest' }); }, [active, query, open]);
  function show(mode: 'search' | 'help') { setReturnFocus(document.activeElement as HTMLElement); setQuery(''); setActive(0); setOpen(mode); }
  function close() { setOpen(null); returnFocus?.focus(); }
  useCommands([
    { id: 'commands.search', label: '搜索全部命令', keys: ['Ctrl+K'], inInput: true, inDialog: true, keepEditor: true, run: () => show('search') },
    { id: 'commands.help', label: '快捷键帮助', keys: ['F1'], inInput: true, inDialog: true, keepEditor: true, run: () => show('help') },
  ]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      if (open) return;
      const target = event.target as HTMLElement;
      const input = !!target.closest('input:not([type="range"]),textarea,select,[contenteditable="true"]'), dialog = !!target.closest('[role="dialog"]');
      const command = registry.all().find(c => c.enabled !== false && (!input || c.inInput) && (!dialog || c.inDialog) && (!c.scope || !!target.closest('.three-track-score')) && c.keys?.some(key => matchesShortcut(event, key)));
      if (command) { event.preventDefault(); event.stopPropagation(); if (!event.repeat) registry.invoke(command.id); }
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [open, registry]);

  const unique = commands.filter((c, i) => commands.findIndex(n => n.id === c.id) === i);
  const filtered = unique.filter(c => (open !== 'help' || c.keys?.length) && `${c.label} ${c.group ?? ''} ${c.keys?.join(' ') ?? ''}`.toLowerCase().includes(query.toLowerCase()));
  const current = Math.min(active, Math.max(0, filtered.length - 1));
  function execute(command: Command) { if (command.enabled === false) return; setOpen(null); registry.invoke(command.id); }
  return <Presence>{open?<div className="command-backdrop no-print" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}>
    <section className="command-panel" role="dialog" aria-modal="true" aria-label={open === 'help' ? '快捷键帮助' : '搜索命令'} onKeyDown={e => {
      if (e.nativeEvent.isComposing) return;
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive(Math.min(filtered.length - 1, current + 1)); }
      if (e.key === 'ArrowUp') { e.preventDefault(); setActive(Math.max(0, current - 1)); }
      if (e.key === 'Enter' && e.target instanceof HTMLInputElement) { e.preventDefault(); if (filtered[current]) execute(filtered[current]); }
      if (e.key === 'Tab') { const focusable = [...e.currentTarget.querySelectorAll<HTMLElement>('input,button:not(:disabled)')]; const at = focusable.indexOf(document.activeElement as HTMLElement); if (e.shiftKey && at === 0) { e.preventDefault(); focusable.at(-1)?.focus(); } else if (!e.shiftKey && at === focusable.length - 1) { e.preventDefault(); focusable[0]?.focus(); } }
      e.stopPropagation();
    }}>
      <header><strong>{open === 'help' ? '快捷键帮助' : '搜索命令'}</strong><button aria-label="关闭命令面板" onClick={close}>Esc</button></header>
      <input autoFocus aria-label="搜索操作或快捷键" placeholder="搜索操作，例如：歌词、加花、复制和弦…" value={query} onChange={e => { setQuery(e.target.value); setActive(0); }}/>
      <div className="command-list">{filtered.map((c, i) => <button key={c.id} className={i === current ? 'active' : ''} disabled={c.enabled === false} onClick={() => execute(c)} title={c.keys?.join(' / ')}><span>{c.label}<small>{c.group ?? '工作台'}{c.enabled === false ? ' · 当前不可用' : ''}</small></span><kbd>{c.keys?.join(' / ').replace('Plus', '+')}</kbd></button>)}{!filtered.length && <p>没有找到对应操作</p>}</div>
      <footer>Space 播放／暂停，文字输入时保留编辑按键。加花支持 Ctrl／Shift+点击和空白处框选，Delete 批量删除，[／] 批量改下划线。歌词句首空格／退格调 ¼ 拍，双空格拆分，空白耗尽后双退格合并。</footer>
    </section>
  </div>:null}</Presence>;
}
