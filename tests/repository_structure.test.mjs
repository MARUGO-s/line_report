import assert from 'node:assert/strict';
import { lstat, readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

const publicSiteFiles = [
  'index.html',
  'analytics.html',
  'foodcourt.html',
  'foodcourt-report.html',
  'foodcourt-weekly-report.html',
  'foodcourt-evolution.html',
  'media.html',
  'message-search.html',
  'petty_cash.html',
  'reservation.html',
  'reviews.html',
  'room_settings.html',
  'ai-usage.html',
  'system-map.html',
  'pages-config.js',
  'auth-session.js',
  'app-theme.js',
  'menu-logout.js',
  'site-cache.js',
  'line-report.webmanifest',
];

const localOnlyRootEntries = [
  'line_report',
  'wine_price.db',
  'wine_price.db-shm',
  'wine_price.db-wal',
  'backups',
  'deno.lock',
];

const ignoredLocalPatterns = [
  '.local/',
  '.DS_Store',
  'line_report',
  'wine_price.db',
  'wine_price.db-shm',
  'wine_price.db-wal',
  'backups/',
  'deno.lock',
];

const forbiddenTrackedEntries = [
  '.DS_Store',
  'line_report',
  'wine_price.db',
  'wine_price.db-shm',
  'wine_price.db-wal',
  'backups/',
  'deno.lock',
];

async function exists(url) {
  try {
    await lstat(url);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

test('GitHub Pages compatibility files stay in the public site root', async () => {
  for (const file of publicSiteFiles) {
    assert.equal(
      await exists(new URL(`public/${file}`, root)),
      true,
      `missing public site file: ${file}`,
    );
  }
});

test('durable local runtime artifacts are kept outside the repository root', async () => {
  for (const entry of localOnlyRootEntries) {
    assert.equal(await exists(new URL(entry, root)), false, `local artifact leaked into root: ${entry}`);
  }
});

test('ephemeral Finder metadata and local state cannot enter Git', async () => {
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync('git', ['ls-files'], {
    cwd: new URL('.', root),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const tracked = result.stdout.split(/\r?\n/);
  for (const entry of forbiddenTrackedEntries) {
    assert.equal(
      tracked.some((path) => path === entry || path.startsWith(entry)),
      false,
      `local artifact is tracked: ${entry}`,
    );
  }
});

test('local runtime artifacts stay ignored after cleanup', async () => {
  const gitignore = await readFile(new URL('.gitignore', root), 'utf8');
  for (const pattern of ignoredLocalPatterns) {
    assert.ok(
      gitignore.split(/\r?\n/).includes(pattern),
      `missing local ignore rule: ${pattern}`,
    );
  }
});

test('repository layout documentation explains root compatibility and local state', async () => {
  const guide = await readFile(new URL('docs/REPOSITORY_STRUCTURE.md', root), 'utf8');
  assert.match(guide, /GitHub Pages/);
  assert.match(guide, /public\//);
  assert.match(guide, /\.local\/backups/);
  assert.match(guide, /\.local\/sqlite/);
});

test('LINE room settings can edit today-reservation alert time like the site Webhook panel', async () => {
  const html = await readFile(new URL('public/room_settings.html', root), 'utf8');
  assert.match(html, /extra:'todayReservationAlert'/);
  assert.match(html, /today-reservation-alert-inp/);
  assert.match(html, /today_reservation_alert_hour/);
  assert.match(html, /today_reservation_alert_minute/);
  assert.match(html, /サイト設定と連動/);
});

test('Pages workflow deploys only the public directory', async () => {
  const workflow = await readFile(new URL('.github/workflows/deploy-pages.yml', root), 'utf8');
  assert.match(workflow, /actions\/configure-pages@v5/);
  assert.match(workflow, /actions\/upload-pages-artifact@v4/);
  assert.match(workflow, /path:\s*public/);
  assert.match(workflow, /actions\/deploy-pages@v4/);
});

test('top-level markdown links from docs still resolve after moving the frontend', async () => {
  const files = (await readdir(new URL('docs/', root))).filter((name) => name.endsWith('.md'));
  for (const name of files) {
    const content = await readFile(new URL(`docs/${name}`, root), 'utf8');
    for (const match of content.matchAll(/\]\(\.\.\/([^)\s#?]+)(?:[?#][^)]*)?\)/g)) {
      const target = decodeURI(match[1]).replace(/:\d+(?::\d+)?$/, '');
      if (target.startsWith('../')) continue;
      const publicCandidate = new URL(`public/${target}`, root);
      const rootCandidate = new URL(target, root);
      assert.ok(
        (await exists(publicCandidate)) || (await exists(rootCandidate)),
        `broken docs link in ${name}: ../${target}`,
      );
    }
  }
});
