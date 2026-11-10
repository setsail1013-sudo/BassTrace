/** Local account client.

The session cookie `basstrace_session` is HttpOnly. Callers must not read
`document.cookie`. Same-origin fetch sends the cookie; `credentials: "include"`
covers a cross-origin call to another localhost port.
*/

export type AccountRole = 'admin' | 'user';

export interface AccountUser {
  id: string;
  username: string;
  role: AccountRole;
  disabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export type AuthField = 'username' | 'password' | 'form';
export type AdminField = 'role' | 'disabled' | 'row';

export class AccountApiError extends Error {
  readonly detail: string;
  readonly status: number;
  constructor(detail: string, status: number) {
    super(detail);
    this.name = 'AccountApiError';
    this.detail = detail;
    this.status = status;
  }
}

export function detailMessage(body: unknown, fallback: string): string {
  if (body && typeof body === 'object' && 'detail' in body) {
    const detail = (body as { detail: unknown }).detail;
    if (typeof detail === 'string') return detail.trim() ? detail : fallback;
    if (detail !== undefined && detail !== null) return JSON.stringify(detail);
  }
  return fallback;
}

export function accountDetail(error: unknown): string {
  if (error instanceof AccountApiError) return error.detail;
  if (error instanceof Error && error.message) return error.message;
  return '请求失败';
}

/** Place a Chinese API `detail` under the field it describes. */
export function authErrorField(detail: string): AuthField {
  if (detail === '用户名或密码不正确' || detail === '账号已停用，请联系本机管理员') return 'password';
  const username = detail.includes('用户名');
  const password = detail.includes('密码');
  if (username && !password) return 'username';
  if (password && !username) return 'password';
  return 'form';
}

/** Place an admin API `detail` under the control that was just used. */
export function adminErrorField(detail: string, action: 'role' | 'disabled'): AdminField {
  if (detail === '不能停用当前登录的账号' || detail === '停用状态必须是 true 或 false') return 'disabled';
  if (detail === '角色只能是 admin 或 user') return 'role';
  if (detail === '至少需要保留一名可用的管理员') return action;
  return 'row';
}

export function isAccountUser(value: unknown): value is AccountUser {
  if (!value || typeof value !== 'object') return false;
  const user = value as Record<string, unknown>;
  return typeof user.id === 'string' && user.id.length > 0
    && typeof user.username === 'string'
    && (user.role === 'admin' || user.role === 'user')
    && typeof user.disabled === 'boolean'
    && typeof user.createdAt === 'string'
    && typeof user.updatedAt === 'string';
}

/** 200 `{user}` is a session. 401 `尚未登录` and every other status stay signed out. */
export function userFromMe(status: number, body: unknown): AccountUser | null {
  if (status !== 200 || !body || typeof body !== 'object' || !('user' in body)) return null;
  const user = (body as { user: unknown }).user;
  return isAccountUser(user) ? user : null;
}

/** Register and login accept only these two fields. Role is assigned by the service. */
export function credentialBody(username: string, password: string): { username: string; password: string } {
  return { username, password };
}

export function accountUpdateBody(input: { role?: AccountRole; disabled?: boolean }): { role?: AccountRole; disabled?: boolean } {
  const body: { role?: AccountRole; disabled?: boolean } = {};
  if (input.role) body.role = input.role;
  if (typeof input.disabled === 'boolean') body.disabled = input.disabled;
  return body;
}

async function requestAccount(url: string, method: string, body?: object): Promise<{ status: number; body: unknown }> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      credentials: 'include',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new AccountApiError('暂时无法连接本地服务', 0);
  }
  if (response.status === 204) return { status: 204, body: null };
  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = null; }
  }
  if (!response.ok) throw new AccountApiError(detailMessage(parsed, text.trim() || `请求失败 ${response.status}`), response.status);
  return { status: response.status, body: parsed };
}

function userFromBody(body: unknown): AccountUser {
  const user = body && typeof body === 'object' && 'user' in body ? (body as { user: unknown }).user : null;
  if (!isAccountUser(user)) throw new AccountApiError('请求失败', 200);
  return user;
}

export async function registerAccount(username: string, password: string): Promise<AccountUser> {
  const { body } = await requestAccount('/api/auth/register', 'POST', credentialBody(username, password));
  return userFromBody(body);
}

export async function loginAccount(username: string, password: string): Promise<AccountUser> {
  const { body } = await requestAccount('/api/auth/login', 'POST', credentialBody(username, password));
  return userFromBody(body);
}

export async function logoutAccount(): Promise<void> {
  await requestAccount('/api/auth/logout', 'POST');
}

export async function readSession(): Promise<{ user: AccountUser | null; notice: string | null }> {
  try {
    const { status, body } = await requestAccount('/api/auth/me', 'GET');
    return { user: userFromMe(status, body), notice: null };
  } catch (error) {
    if (error instanceof AccountApiError && error.status === 401 && error.detail === '尚未登录') return { user: null, notice: null };
    if (error instanceof AccountApiError && error.status > 0) return { user: null, notice: error.detail };
    return { user: null, notice: null };
  }
}

export async function listAccounts(): Promise<AccountUser[]> {
  const { body } = await requestAccount('/api/admin/users', 'GET');
  const users = body && typeof body === 'object' && 'users' in body ? (body as { users: unknown }).users : null;
  if (!Array.isArray(users) || users.some(user => !isAccountUser(user))) throw new AccountApiError('请求失败', 200);
  return users;
}

export async function updateAccount(id: string, input: { role?: AccountRole; disabled?: boolean }): Promise<AccountUser> {
  const { body } = await requestAccount(`/api/admin/users/${encodeURIComponent(id)}`, 'PATCH', accountUpdateBody(input));
  return userFromBody(body);
}
