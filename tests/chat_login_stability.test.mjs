import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const root = new URL('../public/', import.meta.url);

// Exercise the real registration block without loading unrelated chat controls.
test('service worker takeover does not reload an active login form', async () => {
  const source = await readFile(new URL('chat/composer.js', root), 'utf8');
  const begin = source.indexOf("if ('serviceWorker' in navigator) {");
  const end = source.indexOf('if (window.visualViewport)', begin);
  assert.ok(begin >= 0 && end > begin);
  const listeners = new Map();
  let reloads = 0;
  vm.runInNewContext(source.slice(begin, end), {
    navigator: { serviceWorker: {
      addEventListener(name, callback) { listeners.set(name, callback); },
      getRegistration: async () => null,
    } },
    document: { addEventListener() {} },
    sessionStorage: { getItem: () => null, setItem() {} },
    location: { reload() { reloads += 1; } },
    window: {},
    currentUser: null,
    flushPushDiagnostics() {},
  });
  listeners.get('controllerchange')?.();
  assert.equal(reloads, 0, 'updating the app must not discard typed login data');
});

test('service worker activation does not navigate an open M-talk page', async () => {
  const source = await readFile(new URL('chat-sw.js', root), 'utf8');
  const begin = source.indexOf("self.addEventListener('activate',");
  const end = source.indexOf("self.addEventListener('fetch',", begin);
  assert.ok(begin >= 0 && end > begin);
  let activate;
  let navigations = 0;
  let claims = 0;
  const context = {
    CHAT_CACHE: 'line-report-chat-v68',
    CHAT_PUSH_DIAGNOSTIC_QUEUE: 'line-report-chat-push-diagnostics',
    caches: { keys: async () => ['line-report-chat-v67', 'line-report-chat-v68'], delete: async () => true },
    self: {
      addEventListener(name, callback) { if (name === 'activate') activate = callback; },
      clients: {
        claim: async () => { claims += 1; },
        matchAll: async () => [{
          url: 'https://marugo-s.github.io/line_report/chat.html',
          navigate: async () => { navigations += 1; },
        }],
      },
    },
    URL,
  };
  vm.runInNewContext(source.slice(begin, end), context);
  let completion;
  activate({ waitUntil(value) { completion = value; } });
  await completion;
  assert.equal(claims, 0, 'new worker must not force takeover of the open page');
  assert.equal(navigations, 0, 'activation must not discard an in-progress login');
});

test('pending authentication gives feedback and ignores duplicate login attempts', async () => {
  const source = await readFile(new URL('chat/auth.js', root), 'utf8');
  const elements = {
    emailInput: { value: 'probe@example.invalid' },
    passwordInput: { value: 'fake-password' },
    rememberInput: { checked: false },
    loginBtn: { disabled: false, textContent: 'ログイン' },
    loginProgress: { textContent: '', classList: {
      hidden: true,
      add() { this.hidden = true; },
      remove() { this.hidden = false; },
    } },
  };
  let attempts = 0;
  let delayed;
  const context = {
    $: (id) => elements[id],
    sb: { auth: { signInWithPassword: () => { attempts += 1; return new Promise(() => {}); } } },
    setTimeout(callback) { delayed = callback; return 1; },
    clearTimeout() {},
    showLoginError() {},
    console,
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  void context.login();
  void context.login();
  assert.equal(attempts, 1, 'Enter while disabled must not send a second sign-in request');
  assert.equal(elements.loginBtn.textContent, '認証中…');
  assert.equal(elements.loginProgress.classList.hidden, false);
  assert.match(elements.loginProgress.textContent, /認証/);
  delayed();
  assert.match(elements.loginProgress.textContent, /時間/);
});

test('successful authentication restores the button and clears the pending state', async () => {
  const source = await readFile(new URL('chat/auth.js', root), 'utf8');
  const progress = { textContent: '', classList: {
    hidden: true, add() { this.hidden = true; }, remove() { this.hidden = false; },
  } };
  const elements = {
    emailInput: { value: 'probe@example.invalid' }, passwordInput: { value: 'synthetic-fixture' },
    rememberInput: { checked: false }, loginBtn: { disabled: false, textContent: 'ログイン' },
    loginProgress: progress,
  };
  let finish;
  let cleared = false;
  let signedIn = 0;
  const context = {
    $: (id) => elements[id],
    sb: { auth: { signInWithPassword: () => new Promise((resolve) => { finish = resolve; }) } },
    localStorage: { removeItem() {} }, CREDENTIAL_KEY: 'fixture',
    setTimeout: () => 9, clearTimeout: (id) => { cleared = id === 9; },
    afterSignIn: async () => { signedIn += 1; }, console,
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  const attempt = context.login();
  finish({ error: null });
  await attempt;
  assert.equal(signedIn, 1);
  assert.equal(elements.passwordInput.value, '');
  assert.equal(elements.loginBtn.disabled, false);
  assert.equal(elements.loginBtn.textContent, 'ログイン');
  assert.equal(progress.classList.hidden, true);
  assert.equal(cleared, true);
});

test('authentication error restores the button without clearing the typed password', async () => {
  const source = await readFile(new URL('chat/auth.js', root), 'utf8');
  const progress = { textContent: '', classList: {
    hidden: true, add() { this.hidden = true; }, remove() { this.hidden = false; },
  } };
  const elements = {
    emailInput: { value: 'probe@example.invalid' }, passwordInput: { value: 'synthetic-fixture' },
    rememberInput: { checked: false }, loginBtn: { disabled: false, textContent: 'ログイン' },
    loginProgress: progress,
  };
  const errors = [];
  let cleared = false;
  const context = {
    $: (id) => elements[id],
    sb: { auth: { signInWithPassword: async () => ({ error: { message: 'Invalid login credentials' } }) } },
    setTimeout: () => 9, clearTimeout: (id) => { cleared = id === 9; },
    showLoginError: (message) => errors.push(message), console,
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  await context.login();
  assert.deepEqual(errors, ['メールアドレスまたはパスワードが違います']);
  assert.equal(elements.passwordInput.value, 'synthetic-fixture');
  assert.equal(elements.loginBtn.disabled, false);
  assert.equal(elements.loginBtn.textContent, 'ログイン');
  assert.equal(progress.classList.hidden, true);
  assert.equal(cleared, true);
});

test('login scripts referenced by the page match the service worker shell URLs', async () => {
  const [html, worker] = await Promise.all([
    readFile(new URL('chat.html', root), 'utf8'),
    readFile(new URL('chat-sw.js', root), 'utf8'),
  ]);
  for (const name of ['auth', 'composer']) {
    const match = html.match(new RegExp(`<script src="(chat/${name}\\.js\\?v=[^"]+)"`));
    assert.ok(match, `${name} needs a versioned page URL`);
    assert.ok(worker.includes(`'./${match[1]}'`), `${name} in CHAT_SHELL must use the same version`);
  }
});
