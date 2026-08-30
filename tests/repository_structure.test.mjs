import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  classifyWorkflowRun,
  requiresEdgeDeployGate,
  selectMatchingWorkflowRun,
} from '../scripts/wait-for-edge-deploy.mjs';

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
  'chat.html',
  'chat-admin.html',
  'mtalk-help.html',
  'mtalk_schedule.html',
  'chat.webmanifest',
  'chat-sw.js',
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

test('LINE room settings can edit tomorrow-reminder delivery time', async () => {
  const html = await readFile(new URL('public/room_settings.html', root), 'utf8');
  assert.match(html, /extra:'tomorrowReminder'/);
  assert.match(html, /tomorrow-reminder-inp/);
  assert.match(html, /calendar_tomorrow_reminder_hour/);
  assert.match(html, /calendar_tomorrow_reminder_minute/);
});

test('Pages workflow deploys only the public directory', async () => {
  const workflow = await readFile(new URL('.github/workflows/deploy-pages.yml', root), 'utf8');
  assert.match(workflow, /actions\/configure-pages@v5/);
  assert.match(workflow, /actions\/upload-pages-artifact@v4/);
  assert.match(workflow, /path:\s*public/);
  assert.match(workflow, /actions\/deploy-pages@v4/);
  // validate と deploy を分けず同一ジョブにし、runner 枯渇で二段目だけ落ちるのを防ぐ
  assert.match(workflow, /jobs:\s*\n\s*deploy:/);
  assert.doesNotMatch(workflow, /^\s*validate:\s*$/m);
  assert.match(workflow, /^\s{2}actions:\s*read\s*$/m);
  assert.match(workflow, /fetch-depth:\s*0/);
  assert.match(workflow, /id:\s*edge_gate/);
  assert.match(workflow, /empty_tree="\$\(git hash-object -t tree \/dev\/null\)"/);
  assert.match(workflow, /git diff --name-only -z "\$empty_tree" "\$PUSH_HEAD"/);
  assert.match(workflow, /wait-for-edge-deploy\.mjs detect/);
  assert.match(workflow, /if:\s*steps\.edge_gate\.outputs\.required == 'true'/);
  assert.match(workflow, /wait-for-edge-deploy\.mjs wait/);
  assert.match(workflow, /--head-sha "\$GITHUB_SHA"/);
  assert.match(workflow, /--workflow "deploy-edge-functions\.yml"/);
  assert.match(workflow, /--appearance-timeout-ms 600000/);
  assert.match(workflow, /--completion-timeout-ms 3600000/);
  const waitIndex = workflow.indexOf('- name: Wait for matching Edge Functions deployment');
  assert.ok(waitIndex >= 0);
  assert.ok(waitIndex < workflow.indexOf('- name: Configure Pages'));
  assert.ok(waitIndex < workflow.indexOf('- name: Upload public site'));
  assert.ok(waitIndex < workflow.indexOf('- name: Deploy\n'));
});

test('Pages requires the Edge gate only when one push changes both surfaces', () => {
  assert.deepEqual(requiresEdgeDeployGate(['public/jnm/jnl2txt.html']), {
    publicChanged: true,
    edgeChanged: false,
    required: false,
  });
  assert.deepEqual(requiresEdgeDeployGate(['supabase/functions/admin-api/index.ts']), {
    publicChanged: false,
    edgeChanged: true,
    required: false,
  });
  for (const edgePath of [
    'supabase/functions/admin-api/index.ts',
    'supabase/migrations/20260910080000_example.sql',
    'supabase/config.toml',
    '.github/workflows/deploy-edge-functions.yml',
  ]) {
    assert.equal(
      requiresEdgeDeployGate(['public/jnm/jnl2txt.html', edgePath]).required,
      true,
      edgePath,
    );
  }
  assert.equal(
    requiresEdgeDeployGate(['public/jnm/jnl2txt.html', 'docs/supabase/functions/example.md']).required,
    false,
  );
});

test('Pages selects only the newest push Edge run for the exact commit SHA', () => {
  const sha = 'a'.repeat(40);
  const runs = [
    { id: 1, event: 'push', head_sha: sha, created_at: '2026-08-30T10:00:00Z' },
    { id: 2, event: 'workflow_dispatch', head_sha: sha, created_at: '2026-08-30T10:04:00Z' },
    { id: 3, event: 'push', head_sha: 'b'.repeat(40), created_at: '2026-08-30T10:05:00Z' },
    { id: 4, event: 'push', head_sha: sha.toUpperCase(), created_at: '2026-08-30T10:03:00Z' },
  ];
  assert.equal(selectMatchingWorkflowRun(runs, sha)?.id, 4);
  assert.equal(selectMatchingWorkflowRun(runs, 'c'.repeat(40)), null);
});

test('Pages fails closed for every completed Edge conclusion except success', () => {
  for (const status of ['queued', 'in_progress', 'waiting', 'pending', 'requested']) {
    assert.equal(classifyWorkflowRun({ status }).state, 'pending');
  }
  assert.equal(
    classifyWorkflowRun({ status: 'completed', conclusion: 'success' }).state,
    'success',
  );
  for (const conclusion of [
    'action_required',
    'cancelled',
    'failure',
    'neutral',
    'skipped',
    'stale',
    'startup_failure',
    'timed_out',
    null,
  ]) {
    assert.equal(
      classifyWorkflowRun({ status: 'completed', conclusion }).state,
      'failure',
      String(conclusion),
    );
  }
});

test('Edge Functions workflow deploys from a single job on main push', async () => {
  const workflow = await readFile(
    new URL('.github/workflows/deploy-edge-functions.yml', root),
    'utf8',
  );
  assert.match(workflow, /supabase functions deploy/);
  assert.match(workflow, /--use-api/);
  assert.match(workflow, /SUPABASE_ACCESS_TOKEN/);
  assert.match(workflow, /jobs:\s*\n\s*deploy:/);
  assert.doesNotMatch(workflow, /^\s*validate:\s*$/m);
  assert.match(workflow, /supabase-db-push-reconcile\.sh/);
  const jobHeader = workflow.slice(workflow.indexOf('jobs:'), workflow.indexOf('steps:'));
  assert.doesNotMatch(jobHeader, /SUPABASE_ACCESS_TOKEN|SUPABASE_DB_PASSWORD/);
  assert.match(workflow, /Link project and apply DB migrations[\s\S]*SUPABASE_DB_PASSWORD:\s*\$\{\{ secrets\.SUPABASE_DB_PASSWORD \}\}/);
  assert.match(workflow, /Deploy all functions[\s\S]*SUPABASE_ACCESS_TOKEN:\s*\$\{\{ secrets\.SUPABASE_ACCESS_TOKEN \}\}/);
});

test('db push reconcile repairs remote-only migration history', async () => {
  const scriptUrl = new URL('scripts/supabase-db-push-reconcile.sh', root);
  const script = await readFile(
    scriptUrl,
    'utf8',
  );
  assert.match(script, /migration repair --status reverted/);
  assert.match(script, /20260806185129/);
  assert.match(script, /Remote migration versions not found/);
  assert.match(script, /Retrying supabase db push/);

  const fixture = [
    'Remote migration versions not found in local migrations directory.',
    'supabase migration repair --status reverted 20260827231120 20260828010039',
    '',
  ].join('\n');
  const fixtureDir = await mkdtemp(join(tmpdir(), 'line-report-migration-log-'));
  const fixturePath = join(fixtureDir, 'supabase-cli.log');
  try {
    await writeFile(fixturePath, fixture, 'utf8');
    const parsed = spawnSync(
      'bash',
      [fileURLToPath(scriptUrl), '--extract-orphan-versions', fixturePath],
      { encoding: 'utf8' },
    );
    assert.equal(parsed.status, 0, parsed.stderr);
    assert.deepEqual(parsed.stdout.trim().split('\n'), [
      '20260827231120',
      '20260828010039',
    ]);
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
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

test('public/jnm/index.html stays a redirect stub, not a copy of the app', async () => {
  // アプリ本体は jnl2txt.html の1本だけ。かつては index.html にも同じ825KBを複製し
  // byte一致をテストで強制していたが、片方だけ更新する事故が起きたため転送に切り替えた。
  const indexHtml = await readFile(new URL('public/jnm/index.html', root), 'utf8');
  const appHtml = await readFile(new URL('public/jnm/jnl2txt.html', root), 'utf8');
  assert.ok(
    indexHtml.length < 4000,
    `public/jnm/index.html must stay a small redirect stub (got ${indexHtml.length} bytes). アプリ本体を書き戻さないこと`,
  );
  assert.match(indexHtml, /http-equiv="refresh"[^>]*jnl2txt\.html/);
  assert.match(indexHtml, /location\.replace\('jnl2txt\.html'/);
  assert.ok(
    appHtml.length > 100000,
    'public/jnm/jnl2txt.html must remain the application source',
  );
});
