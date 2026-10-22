import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../public/mtalk_schedule.html', import.meta.url), 'utf8');
const start = html.indexOf('    const PERMISSION_DENIED_MESSAGE');
const end = html.indexOf('    async function apiSend(');
const apiErrorFromResponse = new Function(html.slice(start, end) + '\nreturn apiErrorFromResponse;')();

test('403 with server permission message is shown with guidance', () => {
  const e = apiErrorFromResponse({ status: 403 }, { error: 'この店舗の機能を利用する権限がありません。' });
  assert.equal(e.message, 'この店舗の機能を利用する権限がありません。管理者に権限の付与を依頼してください。');
  assert.equal(e.status, 403);
});

test('403 without clear message falls back to permission text', () => {
  const e = apiErrorFromResponse({ status: 403 }, {});
  assert.equal(e.message, 'この店舗の閲覧権限がありません。管理者に権限の付与を依頼してください。');
});

test('other errors keep server message', () => {
  assert.equal(apiErrorFromResponse({ status: 500 }, { error: 'x' }).message, 'x');
  assert.equal(apiErrorFromResponse({ status: 502 }, {}).message, 'HTTP 502');
});

test('all schedule fetches use the helper', () => {
  assert.doesNotMatch(html, /throw new Error\(result\.error \|\| \('HTTP '/);
});
