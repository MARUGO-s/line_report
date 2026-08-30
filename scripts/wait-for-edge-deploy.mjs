#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const EDGE_DEPLOY_PATH_PATTERNS = [
  /^supabase\/functions\//,
  /^supabase\/migrations\//,
  /^supabase\/config\.toml$/,
  /^\.github\/workflows\/deploy-edge-functions\.yml$/,
];

export function requiresEdgeDeployGate(paths) {
  const normalizedPaths = Array.from(paths ?? [], (path) => String(path));
  const publicChanged = normalizedPaths.some((path) => path.startsWith('public/'));
  const edgeChanged = normalizedPaths.some((path) =>
    EDGE_DEPLOY_PATH_PATTERNS.some((pattern) => pattern.test(path))
  );
  return {
    publicChanged,
    edgeChanged,
    required: publicChanged && edgeChanged,
  };
}

export function selectMatchingWorkflowRun(runs, headSha) {
  const expectedSha = String(headSha ?? '').toLowerCase();
  const matching = (Array.isArray(runs) ? runs : [])
    .filter((run) =>
      run?.event === 'push'
      && String(run?.head_sha ?? '').toLowerCase() === expectedSha
    )
    .sort((left, right) => {
      const rightCreatedAt = Date.parse(right?.created_at ?? '') || 0;
      const leftCreatedAt = Date.parse(left?.created_at ?? '') || 0;
      if (rightCreatedAt !== leftCreatedAt) return rightCreatedAt - leftCreatedAt;
      const attemptDelta = Number(right?.run_attempt ?? 0) - Number(left?.run_attempt ?? 0);
      if (attemptDelta !== 0) return attemptDelta;
      return Number(right?.id ?? 0) - Number(left?.id ?? 0);
    });
  return matching[0] ?? null;
}

export function classifyWorkflowRun(run) {
  if (run?.status !== 'completed') {
    return { state: 'pending', conclusion: run?.conclusion ?? null };
  }
  if (run?.conclusion === 'success') {
    return { state: 'success', conclusion: 'success' };
  }
  return {
    state: 'failure',
    conclusion: run?.conclusion ?? 'missing',
  };
}

function parseCommandLine(argv) {
  const [command, ...args] = argv;
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error(`Invalid argument near ${key ?? '(missing)'}`);
    }
    options[key.slice(2)] = value;
  }
  return { command, options };
}

function parseDuration(options, name, fallback, { allowZero = false } = {}) {
  const value = Number(options[name] ?? fallback);
  const valid = Number.isFinite(value) && (allowZero ? value >= 0 : value > 0);
  if (!valid) throw new Error(`--${name} must be ${allowZero ? 'non-negative' : 'positive'}`);
  return value;
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function githubJson(url, token) {
  const response = await fetch(url, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': 'line-report-pages-edge-gate',
      'x-github-api-version': '2022-11-28',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const requestId = response.headers.get('x-github-request-id');
    const error = new Error(
      `GitHub Actions API returned HTTP ${response.status}${requestId ? ` (request ${requestId})` : ''}`,
    );
    error.status = response.status;
    throw error;
  }
  return response.json();
}

function shouldRetryApiError(error) {
  return error?.status === undefined || error.status === 408 || error.status === 429 || error.status >= 500;
}

function assertMatchingRun(run, headSha) {
  if (run?.event !== 'push' || String(run?.head_sha ?? '').toLowerCase() !== headSha.toLowerCase()) {
    throw new Error('GitHub Actions API returned a workflow run that does not match this push SHA');
  }
}

async function findMatchingRun({
  apiUrl,
  repository,
  workflow,
  headSha,
  token,
  initialDelayMs,
  appearanceTimeoutMs,
  pollMs,
}) {
  const deadline = Date.now() + appearanceTimeoutMs;
  if (initialDelayMs > 0) {
    console.log(`Waiting ${initialDelayMs}ms for the Edge workflow run to appear...`);
    await sleep(initialDelayMs);
  }

  const [owner, repo] = repository.split('/');
  const listUrl = new URL(
    `${apiUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
      + `/actions/workflows/${encodeURIComponent(workflow)}/runs`,
  );
  listUrl.searchParams.set('event', 'push');
  listUrl.searchParams.set('head_sha', headSha);
  listUrl.searchParams.set('per_page', '20');

  let lastRetryableError = null;
  while (Date.now() <= deadline) {
    try {
      const payload = await githubJson(listUrl, token);
      const run = selectMatchingWorkflowRun(payload?.workflow_runs, headSha);
      if (run) {
        assertMatchingRun(run, headSha);
        console.log(`Found matching Edge workflow run ${run.id}: ${run.html_url ?? '(URL unavailable)'}`);
        return run;
      }
      lastRetryableError = null;
      console.log(`No matching Edge workflow run is visible yet for ${headSha}.`);
    } catch (error) {
      if (!shouldRetryApiError(error)) throw error;
      lastRetryableError = error;
      console.warn(`Retryable GitHub Actions API error while locating the run: ${error.message}`);
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(pollMs, remaining));
  }

  const suffix = lastRetryableError ? ` Last API error: ${lastRetryableError.message}` : '';
  throw new Error(
    `Matching Deploy Edge Functions run did not appear within ${appearanceTimeoutMs}ms.${suffix}`,
  );
}

async function waitForCompletion({
  apiUrl,
  repository,
  run,
  headSha,
  token,
  completionTimeoutMs,
  pollMs,
}) {
  const deadline = Date.now() + completionTimeoutMs;
  const [owner, repo] = repository.split('/');
  const runUrl = new URL(
    `${apiUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
      + `/actions/runs/${encodeURIComponent(run.id)}`,
  );
  let currentRun = run;

  while (Date.now() <= deadline) {
    assertMatchingRun(currentRun, headSha);
    const classification = classifyWorkflowRun(currentRun);
    if (classification.state === 'success') {
      console.log(`Edge workflow run ${currentRun.id} completed successfully.`);
      return;
    }
    if (classification.state === 'failure') {
      throw new Error(
        `Edge workflow run ${currentRun.id} completed with conclusion: ${classification.conclusion}`,
      );
    }

    console.log(`Edge workflow run ${currentRun.id} is ${currentRun.status ?? 'unknown'}; waiting...`);
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(pollMs, remaining));

    try {
      currentRun = await githubJson(runUrl, token);
    } catch (error) {
      if (!shouldRetryApiError(error)) throw error;
      console.warn(`Retryable GitHub Actions API error while polling run ${run.id}: ${error.message}`);
    }
  }

  throw new Error(
    `Edge workflow run ${run.id} did not complete successfully within ${completionTimeoutMs}ms`,
  );
}

async function detectCommand(options) {
  if (!options['paths-file']) throw new Error('--paths-file is required for detect');
  const buffer = await readFile(options['paths-file']);
  const paths = buffer.toString('utf8').split('\0').filter(Boolean);
  const result = requiresEdgeDeployGate(paths);
  console.log(`public_changed=${result.publicChanged}`);
  console.log(`edge_changed=${result.edgeChanged}`);
  console.log(`required=${result.required}`);
}

async function waitCommand(options) {
  const repository = options.repository ?? process.env.GITHUB_REPOSITORY;
  const headSha = options['head-sha'] ?? process.env.GITHUB_SHA;
  const workflow = options.workflow ?? 'deploy-edge-functions.yml';
  const apiUrl = (options['api-url'] ?? process.env.GITHUB_API_URL ?? 'https://api.github.com')
    .replace(/\/+$/, '');
  const token = process.env.GITHUB_TOKEN;

  if (!/^[^/\s]+\/[^/\s]+$/.test(repository ?? '')) {
    throw new Error('--repository must be in owner/repository form');
  }
  if (!/^[a-f0-9]{40}$/i.test(headSha ?? '')) {
    throw new Error('--head-sha must be a full 40-character Git commit SHA');
  }
  if (!/^[a-z0-9_.-]+$/i.test(workflow)) {
    throw new Error('--workflow must be a workflow file name');
  }
  if (!token) throw new Error('GITHUB_TOKEN is required');

  const pollMs = parseDuration(options, 'poll-ms', 10_000);
  const initialDelayMs = parseDuration(options, 'initial-delay-ms', 5_000, { allowZero: true });
  const appearanceTimeoutMs = parseDuration(options, 'appearance-timeout-ms', 600_000);
  const completionTimeoutMs = parseDuration(options, 'completion-timeout-ms', 3_600_000);

  const run = await findMatchingRun({
    apiUrl,
    repository,
    workflow,
    headSha,
    token,
    initialDelayMs,
    appearanceTimeoutMs,
    pollMs,
  });
  await waitForCompletion({
    apiUrl,
    repository,
    run,
    headSha,
    token,
    completionTimeoutMs,
    pollMs,
  });
}

async function main() {
  const { command, options } = parseCommandLine(process.argv.slice(2));
  if (command === 'detect') return detectCommand(options);
  if (command === 'wait') return waitCommand(options);
  throw new Error('Usage: wait-for-edge-deploy.mjs <detect|wait> [options]');
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  main().catch((error) => {
    const message = String(error?.message ?? error).replace(/[\r\n]+/g, ' ');
    console.error(`::error::${message}`);
    process.exitCode = 1;
  });
}
