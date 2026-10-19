'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../homegate.js'), 'utf8');

function runtime() {
  const button = { disabled: false, textContent: '', isConnected: true };
  const state = { adminLoginPending: false, adminLoginEmail: '' };
  const context = { state, window: {}, t: key => key,
    isAllowedSupabaseAdminEmail: email => email === 'admin@example.test',
    isAllowedSupabaseAdmin: user => user?.email === 'admin@example.test',
    supabaseAdminMode: () => true,
    refresh: async () => {}, };
  vm.createContext(context);
  const functions = source.slice(source.indexOf('function isInvalidSupabaseCredentials('), source.indexOf('function escapeHtml('));
  vm.runInContext(functions, context);
  return { context, state, button, form: { querySelector: () => button } };
}

test('admin errors distinguish timeout/network/credentials and never expose obsolete provider instructions', () => {
  const { context } = runtime();
  for (const message of ['Supabase request timed out.', 'Game server request timed out.']) {
    assert.equal(context.adminAuthErrorMessage({ message, name: 'TimeoutError' }), 'err_admin_timeout');
  }
  assert.equal(context.adminAuthErrorMessage({ message: 'Failed to fetch' }), 'err_admin_network');
  assert.equal(context.adminAuthErrorMessage({ message: 'Invalid login credentials' }), 'err_admin_credentials');
  assert.equal(context.adminAuthErrorMessage({ message: 'Other error', code: 'invalid_credentials' }), 'err_admin_credentials');
  assert.equal(context.adminAuthErrorMessage({ message: 'Email not confirmed' }), 'err_admin_email_confirmation');
  assert.equal(context.adminAuthErrorMessage({ message: 'Rate limit exceeded', status: 429 }), 'err_admin_rate_limit');
  assert.equal(context.adminAuthErrorMessage({ message: 'Supabase SDK unavailable' }), 'err_admin_auth');
  assert.doesNotMatch(source, /отключите Confirm email|Supabase-аккаунт|Supabase Auth\./);
});

test('an incorrect administrator password never creates an account or changes credentials', async () => {
  const { context } = runtime();
  let signups = 0, attempts = 0;
  const client = { auth: {
    signInWithPassword: async () => { attempts++; return { data: null, error: { message: 'Invalid login credentials' } }; },
    signUp: async () => { signups++; throw new Error('Must not sign up'); },
  } };
  await assert.rejects(context.signInTimewebAdmin(client, 'ADMIN@EXAMPLE.TEST', 'not-a-real-password'), /err_admin_credentials/);
  assert.equal(attempts, 1);
  assert.equal(signups, 0);
  await assert.rejects(context.signInTimewebAdmin(client, 'someone@example.test', 'unused'), /err_admin_access/);
  assert.equal(attempts, 1);
});

test('administrator login is single-flight and releases the button after a timeout without retaining a password', async () => {
  const { context, state, form, button } = runtime();
  let attempts = 0, rejectRequest;
  context.window.NarduSupabase = { client: async () => ({ auth: { signInWithPassword: () => {
    attempts++;
    return new Promise((_, reject) => { rejectRequest = reject; });
  } } }) };
  const data = { 'admin-login-email': 'admin@example.test', password: 'synthetic-test-only' };
  const first = context.submitAdminLogin(form, data);
  await new Promise(setImmediate);
  assert.equal(attempts, 1);
  assert.equal(button.disabled, true);
  await context.submitAdminLogin(form, data);
  assert.equal(attempts, 1);
  rejectRequest(Object.assign(new Error('Supabase request timed out.'), { name: 'TimeoutError' }));
  await assert.rejects(first, /Supabase request timed out/);
  assert.equal(state.adminLoginPending, false);
  assert.equal(button.disabled, false);
  assert.equal(state.adminLoginEmail, 'admin@example.test');
  assert.ok(!JSON.stringify(state).includes(data.password));
});

test('a confirmed allowed account opens the existing admin path without a registration call', async () => {
  const { context, state, form } = runtime();
  let refreshes = 0;
  context.refresh = async () => { refreshes++; };
  context.window.NarduSupabase = { client: async () => ({ auth: {
    signInWithPassword: async () => ({ data: { user: { id: 'synthetic-admin', email: 'admin@example.test' } }, error: null }),
  } }) };
  await context.submitAdminLogin(form, { 'admin-login-email': 'admin@example.test', password: 'synthetic-test-only' });
  assert.equal(state.admin.id, 'synthetic-admin');
  assert.equal(refreshes, 1);
  assert.equal(state.adminLoginPending, false);
});
