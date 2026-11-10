import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useCommands } from './commands';
import { accountDetail, adminErrorField, authErrorField, listAccounts, loginAccount, logoutAccount, readSession, registerAccount, updateAccount, type AccountUser, type AdminField, type AuthField } from './accounts';

type Panel = 'login' | 'register' | 'session' | 'admin';
type FieldErrors = Partial<Record<AuthField, string>>;
type RowError = { id: string; field: AdminField; detail: string } | null;

interface AccountActions {
  ready: boolean;
  user: AccountUser | null;
  toggle: (mode: Panel) => void;
  open: (mode: Panel) => void;
  logout: () => Promise<void>;
}

const AccountContext = createContext<AccountActions | null>(null);

export function useAccount(): AccountActions {
  const value = useContext(AccountContext);
  if (!value) throw new Error('AccountEntry must be used within AccountProvider');
  return value;
}

export function AccountProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AccountUser | null>(null);
  const [ready, setReady] = useState(false);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [pending, setPending] = useState(false);
  const [users, setUsers] = useState<AccountUser[] | null>(null);
  const [listError, setListError] = useState('');
  const [rowError, setRowError] = useState<RowError>(null);
  const [pendingId, setPendingId] = useState('');
  const returnFocus = useRef<HTMLElement | null>(null);
  const userRef = useRef<AccountUser | null>(null);
  const pendingRef = useRef(false);
  userRef.current = user;

  useEffect(() => {
    let cancelled = false;
    void readSession().then(result => {
      if (cancelled) return;
      setUser(result.user);
      setNotice(result.notice);
      setReady(true);
      if (result.user) setPanel(current => (current === 'login' || current === 'register' ? null : current));
    });
    return () => { cancelled = true; };
  }, []);

  function rememberFocus() {
    if (panel == null && document.activeElement instanceof HTMLElement) returnFocus.current = document.activeElement;
  }
  function close() {
    setPanel(null);
    setPassword('');
    setErrors({});
    setRowError(null);
    const node = returnFocus.current;
    returnFocus.current = null;
    requestAnimationFrame(() => { if (node?.isConnected) node.focus(); });
  }
  function open(mode: Panel) {
    rememberFocus();
    setPanel(mode);
    setPassword('');
    setRowError(null);
    if ((mode === 'login' || mode === 'register') && notice) {
      setErrors({ [authErrorField(notice)]: notice });
      setNotice(null);
    } else setErrors({});
    if (mode === 'admin') void refreshUsers();
  }
  function toggle(mode: Panel) {
    if (panel === mode) close();
    else open(mode);
  }
  async function logout() {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    try {
      await logoutAccount();
      setUser(null);
      setNotice(null);
      close();
    } catch (error) {
      const detail = accountDetail(error);
      if (detail === '尚未登录') { setUser(null); close(); return; }
      setErrors({ form: detail });
      setPanel(userRef.current ? 'session' : 'login');
    } finally { pendingRef.current = false; setPending(false); }
  }
  async function refreshUsers() {
    setListError('');
    setUsers(null);
    try {
      setUsers(await listAccounts());
    } catch (error) {
      const detail = accountDetail(error);
      if (detail === '尚未登录') {
        setUser(null);
        setPanel('login');
        setErrors({ form: detail });
        return;
      }
      if (detail === '需要管理员权限' || detail === '账号已停用，请联系本机管理员') {
        const session = await readSession();
        setUser(session.user);
        setPanel(session.user ? 'session' : 'login');
        setErrors({ [authErrorField(detail)]: detail });
        return;
      }
      setListError(detail);
    }
  }
  async function submit(mode: 'login' | 'register') {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setErrors({});
    try {
      const next = mode === 'register' ? await registerAccount(username, password) : await loginAccount(username, password);
      setUser(next);
      setNotice(null);
      setUsername('');
      close();
    } catch (error) {
      const detail = accountDetail(error);
      setErrors({ [authErrorField(detail)]: detail });
    } finally { pendingRef.current = false; setPending(false); }
  }
  async function changeUser(id: string, input: { role?: AccountUser['role']; disabled?: boolean }, action: 'role' | 'disabled') {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPendingId(id);
    setRowError(null);
    try {
      const updated = await updateAccount(id, input);
      setUsers(current => current?.map(item => item.id === updated.id ? updated : item) ?? [updated]);
      if (userRef.current?.id === updated.id) {
        setUser(updated);
        if (updated.role !== 'admin') setPanel('session');
      }
    } catch (error) {
      const detail = accountDetail(error);
      if (detail === '尚未登录' || detail === '需要管理员权限' || detail === '账号已停用，请联系本机管理员') {
        const session = await readSession();
        setUser(session.user);
        setPanel(session.user ? 'session' : 'login');
        setErrors({ [authErrorField(detail)]: detail });
        return;
      }
      setRowError({ id, field: adminErrorField(detail, action), detail });
    } finally { pendingRef.current = false; setPendingId(''); }
  }

  useCommands([
    ...(!user ? [
      { id: 'account.login', label: '登录', group: '本机账号', enabled: true, run: () => toggle('login') },
      { id: 'account.register', label: '注册', group: '本机账号', enabled: true, run: () => toggle('register') },
    ] : [
      { id: 'account.logout', label: '退出', group: '本机账号', enabled: !pending, run: () => void logout() },
      ...(user.role === 'admin' ? [{ id: 'account.admin', label: '管理本机账号', group: '本机账号', enabled: true, run: () => open('admin') }] : []),
    ]),
  ]);

  const actions: AccountActions = { ready, user, toggle, open, logout };
  return <AccountContext.Provider value={actions}>
    {children}
    {panel && <AccountSheet panel={panel} user={user} username={username} password={password} errors={errors} pending={pending} users={users} listError={listError} rowError={rowError} pendingId={pendingId} onUsername={value => { setUsername(value); setErrors(current => ({ ...current, username: undefined, form: undefined })); }} onPassword={value => { setPassword(value); setErrors(current => ({ ...current, password: undefined, form: undefined })); }} onSubmit={mode => void submit(mode)} onClose={close} onOpen={open} onLogout={() => void logout()} onChangeUser={(id, input, action) => void changeUser(id, input, action)} />}
  </AccountContext.Provider>;
}

export function AccountEntry() {
  const { ready, user, toggle, open, logout } = useAccount();
  if (!ready) return null;
  if (user) return <div className="account-entry">
    <button type="button" className="account-name" title="本机账号" onClick={() => toggle('session')}>{user.username}</button>
    {user.role === 'admin' && <button type="button" onClick={() => open('admin')}>本机账号</button>}
    <button type="button" onClick={() => void logout()}>退出</button>
  </div>;
  return <div className="account-entry">
    <button type="button" onClick={() => toggle('login')}>登录</button>
    <button type="button" onClick={() => toggle('register')}>注册</button>
  </div>;
}

function AccountSheet({ panel, user, username, password, errors, pending, users, listError, rowError, pendingId, onUsername, onPassword, onSubmit, onClose, onOpen, onLogout, onChangeUser }: {
  panel: Panel; user: AccountUser | null; username: string; password: string; errors: FieldErrors; pending: boolean;
  users: AccountUser[] | null; listError: string; rowError: RowError; pendingId: string;
  onUsername: (value: string) => void; onPassword: (value: string) => void; onSubmit: (mode: 'login' | 'register') => void;
  onClose: () => void; onOpen: (mode: Panel) => void; onLogout: () => void;
  onChangeUser: (id: string, input: { role?: AccountUser['role']; disabled?: boolean }, action: 'role' | 'disabled') => void;
}) {
  const sheet = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const title = panel === 'login' ? '登录' : panel === 'register' ? '注册' : '本机账号';
  useEffect(() => {
    const node = sheet.current;
    const field = panel === 'login' || panel === 'register'
      ? node?.querySelector<HTMLElement>('form input')
      : panel === 'admin'
        ? node?.querySelector<HTMLElement>('.account-back')
        : node?.querySelector<HTMLElement>('.account-session button');
    (field ?? node)?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.key === 'Process' || event.keyCode === 229) return;
      if (event.key !== 'Escape' || sheet.current?.contains(event.target as Node)) return;
      event.preventDefault();
      closeRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [panel]);
  return <div className="account-layer no-print" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={sheet} className="account-sheet" role="dialog" aria-modal="false" aria-label={title} tabIndex={-1} onKeyDown={event => {
      if (event.nativeEvent.isComposing || event.key === 'Process') return;
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }}>
      <header><h2>{title}</h2><button type="button" onClick={onClose}>关闭</button></header>
      {panel === 'admin' ? <AdminList user={user} users={users} listError={listError} rowError={rowError} pendingId={pendingId} onBack={() => onOpen('session')} onChangeUser={onChangeUser} /> : panel === 'session' && user ? <div className="account-session">
        <p className="account-note">已登录。曲库仍是这台电脑上的同一份，不会按账号分开。</p>
        <p className="account-signed-in"><strong>{user.username}</strong><span>{user.role === 'admin' ? '管理员' : '普通用户'}</span></p>
        {user.role === 'admin' && <button type="button" className="secondary account-admin-open" onClick={() => onOpen('admin')}>管理本机账号</button>}
        <button type="button" className="secondary account-submit" disabled={pending} onClick={onLogout}>退出</button>
        {errors.form && <p className="field-error" role="alert">{errors.form}</p>}
      </div> : <form noValidate onSubmit={event => { event.preventDefault(); if (panel === 'login' || panel === 'register') onSubmit(panel); }}>
        <p className="account-note">账号只保存在这台电脑。曲谱、曲库和音频按现在的方式使用，不会按账号分开。</p>
        <label>用户名
          <input name="username" autoComplete="username" autoCapitalize="off" spellCheck={false} value={username} onChange={event => onUsername(event.target.value)} aria-invalid={!!errors.username} aria-describedby={errors.username ? 'account-username-error' : undefined} />
          {errors.username && <span id="account-username-error" className="field-error" role="alert">{errors.username}</span>}
        </label>
        <label>密码
          <input name="password" type="password" autoComplete={panel === 'register' ? 'new-password' : 'current-password'} value={password} onChange={event => onPassword(event.target.value)} aria-invalid={!!errors.password} aria-describedby={errors.password ? 'account-password-error' : undefined} />
          {errors.password && <span id="account-password-error" className="field-error" role="alert">{errors.password}</span>}
        </label>
        {errors.form && <p className="field-error" role="alert">{errors.form}</p>}
        <button className="primary account-submit" type="submit" disabled={pending}>{pending ? (panel === 'register' ? '正在注册…' : '正在登录…') : panel === 'register' ? '注册' : '登录'}</button>
        <p className="account-switch">{panel === 'register' ? '已有账号？' : '没有账号？'}<button type="button" onClick={() => onOpen(panel === 'register' ? 'login' : 'register')}>{panel === 'register' ? '登录' : '注册'}</button></p>
      </form>}
    </section>
  </div>;
}

function AdminList({ user, users, listError, rowError, pendingId, onBack, onChangeUser }: {
  user: AccountUser | null; users: AccountUser[] | null; listError: string; rowError: RowError; pendingId: string;
  onBack: () => void; onChangeUser: (id: string, input: { role?: AccountUser['role']; disabled?: boolean }, action: 'role' | 'disabled') => void;
}) {
  return <div className="account-admin">
    <p className="account-note">调整角色或停用账号。停用后不能登录。歌曲不会被隐藏或分开。</p>
    <button type="button" className="account-back" onClick={onBack}>返回</button>
    {listError && <p className="field-error" role="alert">{listError}</p>}
    {users == null && !listError && <p className="account-note">正在读取账号…</p>}
    {users?.length === 0 && <p className="account-note">还没有本机账号。</p>}
    {!!users?.length && <ul className="account-users">{users.map(item => {
      const error = rowError?.id === item.id ? rowError : null;
      const busy = pendingId === item.id;
      return <li key={item.id}>
        <div className="account-user-line">
          <span className="account-user-id"><span className="account-user-name">{item.username}</span>{(item.disabled || item.id === user?.id) && <span className="account-user-status">{item.disabled && <em>已停用</em>}{item.id === user?.id && <em>当前登录</em>}</span>}</span>
          <select aria-label={`${item.username} 的角色`} value={item.role} disabled={!!pendingId} onChange={event => onChangeUser(item.id, { role: event.target.value as AccountUser['role'] }, 'role')}>
            <option value="admin">管理员</option>
            <option value="user">普通用户</option>
          </select>
          <button type="button" disabled={!!pendingId} onClick={() => onChangeUser(item.id, { disabled: !item.disabled }, 'disabled')}>{busy ? '正在保存…' : item.disabled ? '启用' : '停用'}</button>
        </div>
        {error && <p className="field-error" role="alert">{error.detail}</p>}
      </li>;
    })}</ul>}
  </div>;
}
