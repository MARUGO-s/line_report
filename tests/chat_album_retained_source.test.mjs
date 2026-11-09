import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Provenance only, not production-source copies or a permanent byte-hash gate:
// production main: 3b7bb6d7ecbb21936777be0ac4a6d2efe6ea6efc
// attachments baseline SHA-256: 6ef01c374d0e216b4baa40cb7e4537489e784bbff648efc79fb8433d1a87d562
// reviewed consumer SHA-256: 62d492a9fa1736bd01c993f822d6cd9a9cca1f1b3a2aa48589222f9d5e344c01
// Synthetic metadata below models an RLS-visible row, not RLS enforcement itself.
const root = new URL('../', import.meta.url);
const sources = Object.fromEntries(['attachments', 'messages', 'composer'].map(name =>
  [name, readFileSync(new URL(`public/chat/${name}.js`, root), 'utf8')]));
function extract(file, name) {
  const match = sources[file].match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, 'm'));
  assert.ok(match, `actual ${file}.${name} must exist`);
  return match[0];
}
const path = 'groups/7/synthetic-image.jpg';
const row = { id: 51, group_id: 7, storage_path: path, caption: '保存した画像', created_at: '2026-01-02T03:04:05Z' };
const message = { id: 42, group_id: 7, kind: 'image', payload: { v: 1, kind: 'image', image: { path } } };
const plain = value => JSON.parse(JSON.stringify(value));
function harness({ album = row, original = null, loaded = [], hold, keepError = null, permission = true } = {}) {
  const reads = [], writes = [], storage = [], alerts = [], toasts = [], nodes = new Map();
  const makeNode = () => ({ value: '', innerHTML: '', textContent: '', dataset: {}, handlers: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return true; } },
    addEventListener(type, handler) { this.handlers[type] = handler; }, remove() { this.removed = true; },
    querySelector(selector) { return this.children[selector] ||= makeNode(); }, children: {},
    querySelectorAll() { return ['keep', 'forward'].map(action => { const node = this.querySelector(action); node.dataset.viewerAction = action; return node; }); }
  });
  const context = {
    currentUser: { id: 'synthetic-owner', username: 'Fixture' }, currentGroupId: 7, currentMessages: loaded,
    MESSAGE_COLUMNS: 'id,group_id,kind,payload', forwardMessage: null, registeredUsers: [{ id: 'recipient' }],
    chatAccessAllows: () => permission, renderForwardUsers() {},
    selectGroupSeq: 0, forwardSourceLease: null,
    ownHistoryAuthorized: id => !!context.currentUser && id === context.currentGroupId,
    ownHistoryLease: () => { const owner=context.currentUser, selection=context.currentGroupId, selectionSequence=context.selectGroupSeq;
      return {selection,selectionSequence,valid:()=>owner===context.currentUser && selection===context.currentGroupId}; },
    ownHistoryV1: () => false, currentGroup: () => ({id:7}), shouldHideAdminNotice: () => false,
    $: id => { if (!nodes.has(id)) nodes.set(id, makeNode()); return nodes.get(id); },
    alert: text => alerts.push(text), showChatToast: text => toasts.push(text), console: { error() {}, warn() {} },
    window: { location: { href: 'https://fixture.invalid/chat.html' } }, URL,
    escapeHtml: value => String(value), crypto: { randomUUID: () => 'synthetic-copy' },
    fetch: async url => { assert.equal(url, 'https://fixture.invalid/image'); return { ok: true, blob: async () => ({ type: 'image/jpeg' }) }; },
    document: { createElement: () => makeNode(), body: { appendChild(node) { context.overlay = node; } }, addEventListener() {}, removeEventListener() {} },
    albumItemsById: new Map(), selectedAlbumId: 9, albums: [{ id: 9, name: 'Synthetic album' }],
    canEditAlbum: () => false, albumDate: value => value || '',
    albumSignedUrls: async paths => new Map(paths.map(p => [p, 'https://fixture.invalid/image'])),
    sb: { from(table) {
      const query = { table, filters: [] };
      const chain = {
        select(columns) { query.columns = columns; return chain; },
        eq(key, value) { query.filters.push([key, value]); return chain; },
        limit(value) { query.limit = value; return chain; },
        async order() { reads.push(query); return { data: [{ ...row, album_id: 9, message_id: null }], error: null }; },
        async maybeSingle() { reads.push(query); if (hold) await hold(table); return table === 'chat_album_items' ? album : { data: original, error: null }; },
        insert(value) {
          writes.push({ table, value: plain(value) });
          const result = { data: { id: 77 }, error: table === 'chat_keep_items' ? keepError : null };
          return Object.assign(Promise.resolve(result), { select() { return { async single() { return result; } }; } });
        }
      };
      return chain;
    }, storage: { from(bucket) { assert.equal(bucket, 'chat-images'); return {
      async createSignedUrl(p) { storage.push(['sign', p]); return { data: { signedUrl: 'https://fixture.invalid/image' }, error: null }; },
      async upload(p, blob, options) { storage.push(['upload', p, options]); return { error: null }; }
    }; } } }
  };
  // Responses are wrappers at the boundary; an array/null/scalar data value stays intact.
  const albumResponse = album && Object.hasOwn(album, 'data') ? album : { data: album, error: null };
  album = albumResponse;
  vm.createContext(context);
  for (const [file, names] of Object.entries({ attachments: ['safeParseJson', 'imageFromMessage', 'stickerFromMessage', 'resolveAlbumMessage', 'saveImageToKeep', 'safeHttpUrl', 'openImageViewer'], messages: ['openForward', 'insertForwardedMessage'], composer: ['loadAlbumItems', 'renderAlbums'] })) {
    vm.runInContext(names.map(name => extract(file, name)).join('\n'), context, { filename: `actual-${file}.js` });
  }
  return { context, reads, writes, storage, alerts, toasts, nodes };
}
const event = { stopPropagation() {} };

test('existing loaded and fetched same-room image paths work before the SQL change', async () => {
  for (const options of [{ loaded: [message] }, { original: message }]) {
    const h = harness(options); assert.equal((await h.context.resolveAlbumMessage(42, path)).id, 42);
    assert.equal(h.reads.filter(q => q.table === 'chat_album_items').length, 0); assert.deepEqual(h.writes, []);
    for (const q of h.reads) assert.ok(q.filters.some(([k,v]) => k === 'group_id' && v === 7));
  }
});

test('orphan id zero resolves only through a fresh same-room stored album snapshot without writes', async () => {
  const h = harness(); const result = await h.context.resolveAlbumMessage(0, path);
  assert.ok(result, 'retained image must resolve after source deletion');
  assert.equal(result.id, null); assert.equal(result.content, row.caption); assert.equal(result.created_at, row.created_at);
  assert.equal(h.context.imageFromMessage(result).path, path);
  assert.deepEqual(h.reads.map(q => [q.table, q.columns, q.filters, q.limit]), [['chat_album_items', 'id,group_id,storage_path,caption,created_at', [['group_id',7],['storage_path',path]], 1]]);
  assert.deepEqual(h.writes, []); assert.deepEqual(h.storage, []);
});

test('missing original id falls back to saved album; an empty caption has existing image guidance', async () => {
  const h = harness({ album: { ...row, caption: '' } }); const result = await h.context.resolveAlbumMessage(42, path);
  assert.ok(result); assert.equal(result.content, '[画像]'); assert.equal(result.id, null);
  assert.deepEqual(h.reads.map(q => q.table), ['chat_messages', 'chat_album_items']); assert.deepEqual(h.writes, []);
});

for (const [name, album] of Object.entries({ 'wrong group': { ...row, group_id: 8 }, 'wrong path': { ...row, storage_path: 'groups/7/other.jpg' }, array: [row], 'zero rows': null, error: { data: row, error: { message: 'synthetic-denied' } } })) {
  test(`refuses ${name} album response without writes`, async () => {
    const h = harness({ album }); assert.equal(await h.context.resolveAlbumMessage(0, path), null); assert.deepEqual(h.writes, []);
  });
}

test('a cached mismatched message is not authority for a different path or room', async () => {
  for (const wrong of [{ ...message, group_id: 8 }, { ...message, payload: { image: { path: 'groups/7/other.jpg' } } }]) {
    const h = harness({ loaded: [wrong], album: null }); assert.equal(await h.context.resolveAlbumMessage(42, path), null); assert.deepEqual(h.writes, []);
  }
});

test('rejects signed-out, roomless and foreign-room caller paths before reads', async () => {
  for (const change of [c => { c.currentUser = null; }, c => { c.currentGroupId = null; }, c => { c.currentGroupId = 8; }]) {
    const h = harness(); change(h.context); assert.equal(await h.context.resolveAlbumMessage(0, path), null); assert.deepEqual(h.reads, []); assert.deepEqual(h.writes, []);
  }
});

for (const table of ['chat_messages', 'chat_album_items']) {
  test(`held ${table} read cannot survive a new auth object or changed room`, async () => {
    for (const change of [c => { c.currentUser = { ...c.currentUser }; }, c => { c.currentGroupId = 8; }]) {
      let release, entered;
      const blocked = new Promise(resolve => { release = resolve; }); const started = new Promise(resolve => { entered = resolve; });
      const h = harness({ original: message, hold: async current => { if (current === table) { entered(); await blocked; } } });
      const pending = h.context.resolveAlbumMessage(table === 'chat_messages' ? 42 : 0, path);
      const reachedRead = await Promise.race([started.then(() => true), pending.then(() => false)]);
      release(); assert.equal(reachedRead, true, `must attempt the held ${table} read`);
      change(h.context); assert.equal(await pending, null); assert.deepEqual(h.writes, []);
    }
  });
}

test('actual viewer Keep action uses id-zero image payload only on explicit click', async () => {
  const h = harness(); h.context.openImageViewer('https://fixture.invalid/image', { messageId: 0, storagePath: path });
  assert.deepEqual(h.writes, []); await h.context.overlay.querySelector('keep').handlers.click(event);
  assert.deepEqual(h.writes, [{ table: 'chat_keep_items', value: { user_id: 'synthetic-owner', kind: 'image', payload: { v: 1, image: { path } } } }]);
  assert.deepEqual(h.alerts, []); assert.deepEqual(h.toasts, ['Keepメモに転送しました']);
});

test('actual viewer forward opens permissions-checked chooser without automatic writes, then image copy remains an image', async () => {
  const h = harness(); h.context.openImageViewer('https://fixture.invalid/image', { messageId: 0, storagePath: path });
  await h.context.overlay.querySelector('forward').handlers.click(event);
  assert.ok(h.context.forwardMessage); assert.equal(h.context.forwardMessage.id, null); assert.deepEqual(h.writes, []); assert.deepEqual(h.storage, []);
  // Explicit destination send boundary; no real RPC, Storage or HTTP is contacted.
  await h.context.insertForwardedMessage(h.context.forwardMessage, 11, h.context.forwardSourceLease);
  assert.deepEqual(h.storage.map(x => x.slice(0,2)), [['sign', path], ['upload','groups/11/synthetic-copy.jpg']]);
  assert.deepEqual(h.writes, [{ table: 'chat_messages', value: { group_id: 11, user_id: 'synthetic-owner', username: 'Fixture', content: '[画像]', kind: 'image', payload: { v: 1, kind: 'image', image: { path: 'groups/11/synthetic-copy.jpg' } } } }]);
});

test('missing snapshots retain Keep and forward failure guidance and make no writes', async () => {
  const h = harness({ album: null }); await h.context.saveImageToKeep(path, 0);
  h.context.openImageViewer('https://fixture.invalid/image', { messageId: 0, storagePath: path }); await h.context.overlay.querySelector('forward').handlers.click(event);
  assert.deepEqual(h.alerts, ['画像の確認に失敗しました', 'この画像を転送できるメッセージ情報がありません']); assert.deepEqual(h.writes, []);
});

test('Keep insert errors and existing forward permission refusal remain visible', async () => {
  const h = harness({ keepError: { message: 'synthetic-denied' }, permission: false }); await h.context.saveImageToKeep(path, 0);
  h.context.openImageViewer('https://fixture.invalid/image', { messageId: 0, storagePath: path }); await h.context.overlay.querySelector('forward').handlers.click(event);
  assert.deepEqual(h.alerts, ['Keepメモへの転送に失敗しました: synthetic-denied', '転送先のユーザーを選ぶ権限がありません']); assert.equal(h.context.forwardMessage, null); assert.equal(h.writes.length, 1);
});

test('actual album loader and renderer preserve nullable source and pass message id zero to viewer', async () => {
  const h = harness(); await h.context.loadAlbumItems(9); h.context.renderAlbums();
  const saved = h.context.albumItemsById.get(9)[0]; assert.equal(saved.message_id, null); assert.equal(saved.storage_path, path);
  assert.match(h.nodes.get('albumList').innerHTML, /messageId:0,storagePath:this.dataset.storagePath/);
  assert.match(h.nodes.get('albumList').innerHTML, /https:\/\/fixture.invalid\/image/); assert.deepEqual(h.writes, []);
});

// Cache delivery is tested against the actual shipped v72 worker, not a rewritten
// copy of its fetch algorithm. Every network/cache boundary below is synthetic.
{
  const html = readFileSync(new URL('public/chat.html', root), 'utf8');
  const source = readFileSync(new URL('public/chat-sw.js', root), 'utf8');
  const legacy = readFileSync(new URL('tests/fixtures/chat-sw-v72.fixture.js', root), 'utf8');
  const origin = 'https://fixture.invalid/line_report/';
  const oldURL = `${origin}chat/attachments.js?v=20260911-calendar-links-1`;
  const entry = html.match(/src="(chat\/attachments.js\?[^" ]+)"/)[1];
  const assetURL = new URL(entry, origin).href;
  function worker(workerSource) {
    const stores = new Map([['line-report-chat-v72', new Map([[oldURL, 'OLD CONSUMER FIXTURE']])]]);
    const handlers = {}, effects = [], fetched = [];
    const draft = { text: '未送信の下書き', requestIdentity: 'same-pending-fixture' };
    const response = body => ({ ok: true, body, clone() { return response(body); } });
    const absolute = key => new URL(typeof key === 'string' ? key : key.url, origin).href;
    const fetch = async key => {
      const url = absolute(key); fetched.push(url);
      return response(url.includes('/attachments.js?') ? 'NEW CONSUMER FIXTURE' : 'SHELL FIXTURE');
    };
    const caches = {
      async open(name) {
        if (!stores.has(name)) stores.set(name, new Map());
        const map = stores.get(name);
        const put = async (key, value) => { map.set(absolute(key), value.body); };
        const add = async key => put(key, await fetch(key));
        return { put, add, addAll: async keys => { for (const key of keys) await add(key); },
          async match(key) { const body = map.get(absolute(key)); return body && response(body); } };
      },
      async keys() { return [...stores.keys()]; },
      async delete(name) { return stores.delete(name); },
      async match(key) {
        for (const store of stores.values()) {
          const body = store.get(absolute(key)); if (body) return response(body);
        }
      }
    };
    vm.runInNewContext(workerSource, { URL, Set, Request, Response, console, caches, fetch, self: {
      location: new URL(`${origin}chat-sw.js`), navigator: {},
      addEventListener(type, handler) { handlers[type] = handler; },
      skipWaiting() { effects.push('skipWaiting'); },
      clients: {
        claim() { effects.push('claim'); },
        async matchAll() {
          effects.push('matchAll');
          return [{ navigate() { effects.push('navigate'); }, postMessage() { effects.push('postMessage'); } }];
        }
      }
    } }, { filename: 'actual-chat-service-worker.js' });
    return { stores, effects, fetched, draft,
      async asset(url) {
        let result;
        handlers.fetch({ request: { method: 'GET', mode: 'cors', url }, respondWith(value) { result = value; } });
        return result ? await result : fetch(url);
      },
      async lifecycle(type) {
        let promise; handlers[type]({ waitUntil(value) { promise = value; } }); await promise;
      }
    };
  }
  test('shipped v72 worker fetches the new entry key instead of returning its old cache-first consumer', async () => {
    const w = worker(legacy);
    assert.equal((await w.asset(assetURL)).body, 'NEW CONSUMER FIXTURE');
    assert.deepEqual(w.fetched, [assetURL]);
  });
  test('HTML entry and actual SW shell use the same new key and a fresh cache revision', () => {
    const shell = source.match(/['"]\.\/(chat\/attachments.js\?[^'" ]+)['"]/)[1];
    const cache = source.match(/const CHAT_CACHE = '([^']+)'/)[1];
    assert.equal(shell, entry);
    assert.notEqual(assetURL, oldURL);
    assert.notEqual(cache, 'line-report-chat-v72');
  });
  test('actual new SW install/activate does not claim, navigate or message open drafts', async () => {
    const w = worker(source), before = JSON.stringify(w.draft);
    await w.lifecycle('install'); await w.lifecycle('activate');
    assert.equal(JSON.stringify(w.draft), before);
    assert.deepEqual(w.effects, ['skipWaiting']);
    assert.equal((await w.asset(assetURL)).body, 'NEW CONSUMER FIXTURE');
  });
}
