import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountUpdateBody, adminErrorField, authErrorField, credentialBody, detailMessage, userFromMe, type AccountUser } from './accounts';

const user = (role: AccountUser['role'] = 'admin'): AccountUser => ({ id: 'u1', username: 'Bass', role, disabled: false, createdAt: '2026-11-10T00:00:00Z', updatedAt: '2026-11-10T00:00:00Z' });

test('API errors keep the Chinese detail string and do not treat a validation array as text', () => {
  assert.equal(detailMessage({ detail: '该用户名已被使用' }, '请求失败'), '该用户名已被使用');
  assert.equal(detailMessage({ detail: '尚未登录' }, '请求失败'), '尚未登录');
  assert.equal(detailMessage({ detail: '至少需要保留一名可用的管理员' }, '请求失败'), '至少需要保留一名可用的管理员');
  assert.equal(detailMessage({ detail: ['用户名不能为空'] }, '请求失败'), '["用户名不能为空"]');
  assert.equal(detailMessage({ detail: '' }, '请求失败 422'), '请求失败 422');
  assert.equal(detailMessage(null, '请求失败'), '请求失败');
});

test('auth details sit under the field they describe', () => {
  for (const detail of ['用户名不能为空', '用户名不能超过 32 个字符', '用户名不能包含空格或控制字符', '用户名不能包含斜杠或冒号', '该用户名已被使用']) {
    assert.equal(authErrorField(detail), 'username', detail);
  }
  for (const detail of ['密码至少需要 8 个字符', '密码不能超过 128 个字符', '密码包含无法保存的字符']) {
    assert.equal(authErrorField(detail), 'password', detail);
  }
  assert.equal(authErrorField('用户名或密码不正确'), 'password');
  assert.equal(authErrorField('账号已停用，请联系本机管理员'), 'password');
  for (const detail of ['请提供用户名和密码', '尚未登录', '仅允许本机页面提交账号操作', '请求内容过大', '请求体不是有效的 JSON', '请求体必须是 JSON 对象']) {
    assert.equal(authErrorField(detail), 'form', detail);
  }
});

test('admin details sit under the role or disable control that failed', () => {
  assert.equal(adminErrorField('不能停用当前登录的账号', 'disabled'), 'disabled');
  assert.equal(adminErrorField('至少需要保留一名可用的管理员', 'role'), 'role');
  assert.equal(adminErrorField('至少需要保留一名可用的管理员', 'disabled'), 'disabled');
  assert.equal(adminErrorField('角色只能是 admin 或 user', 'role'), 'role');
  assert.equal(adminErrorField('停用状态必须是 true 或 false', 'disabled'), 'disabled');
  assert.equal(adminErrorField('找不到该账号', 'role'), 'row');
  assert.equal(adminErrorField('需要管理员权限', 'disabled'), 'row');
  assert.equal(adminErrorField('请指定要修改的角色或停用状态', 'role'), 'row');
});

test('GET /api/auth/me signs in only on a 200 user and treats 尚未登录 as signed out', () => {
  assert.deepEqual(userFromMe(200, { user: user() }), user());
  assert.equal(userFromMe(401, { detail: '尚未登录' }), null);
  assert.equal(userFromMe(403, { detail: '账号已停用，请联系本机管理员' }), null);
  assert.equal(userFromMe(200, { detail: '尚未登录' }), null);
  assert.equal(userFromMe(200, { user: { ...user(), role: 'owner' } }), null);
  assert.equal(userFromMe(200, { user: { ...user(), disabled: 'false' } }), null);
});

test('account requests never send a role on register or extra admin fields', () => {
  const credentials = credentialBody('  Bass  ', 'secret-pass');
  assert.deepEqual(credentials, { username: '  Bass  ', password: 'secret-pass' });
  assert.deepEqual(Object.keys(credentials), ['username', 'password']);
  assert.deepEqual(accountUpdateBody({ role: 'user' }), { role: 'user' });
  assert.deepEqual(accountUpdateBody({ disabled: false }), { disabled: false });
  assert.deepEqual(accountUpdateBody({ role: 'admin', disabled: true }), { role: 'admin', disabled: true });
});
