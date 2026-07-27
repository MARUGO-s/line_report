import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const root = new URL("../", import.meta.url);

test("knowledge architecture defines runtime, business, and AI knowledge views", async () => {
  const architecture = JSON.parse(
    await readFile(new URL("knowledge/system-architecture.json", root), "utf8"),
  );
  assert.deepEqual(
    architecture.views.map((view) => view.id).sort(),
    ["business", "knowledge", "runtime"],
  );
  const nodeIds = architecture.nodes.map((node) => node.id);
  assert.equal(new Set(nodeIds).size, nodeIds.length);
  const nodeById = new Map(architecture.nodes.map((node) => [node.id, node]));
  const edgeKeys = architecture.edges.map(
    (edge) => `${edge.view}:${edge.from}:${edge.to}:${edge.label}`,
  );
  assert.equal(new Set(edgeKeys).size, edgeKeys.length);
  for (const edge of architecture.edges) {
    assert.ok(nodeById.has(edge.from), `unknown edge source: ${edge.from}`);
    assert.ok(nodeById.has(edge.to), `unknown edge target: ${edge.to}`);
    assert.equal(nodeById.get(edge.from).view, edge.view);
    assert.equal(nodeById.get(edge.to).view, edge.view);
  }
  assert.ok(nodeById.has("line_webhook"));
  assert.ok(nodeById.has("admin_api"));
  assert.ok(nodeById.has("foodcourt_ai"));
  assert.ok(nodeById.has("repo_docs"));
  assert.ok(nodeById.has("graphify_cli"));
});

test("Graphify graph includes every Supabase migration and excludes vendor code", async () => {
  const graph = JSON.parse(
    await readFile(new URL("graphify-out/graph.json", root), "utf8"),
  );
  const graphSourceFiles = new Set(
    graph.nodes.map((node) => String(node.source_file ?? "")),
  );
  const migrations = (
    await readdir(new URL("supabase/migrations/", root))
  ).filter((file) => file.endsWith(".sql"));
  const missing = migrations.filter(
    (file) => !graphSourceFiles.has(`supabase/migrations/${file}`),
  );
  assert.deepEqual(missing, []);
  assert.ok(
    graph.nodes.some(
      (node) =>
        node.source_file ===
        "supabase/migrations/20260612100000_enable_rls_security_tables.sql",
    ),
  );
  assert.equal(
    graph.nodes.some((node) =>
      String(node.source_file ?? "").startsWith("vendor/"),
    ),
    false,
  );
  assert.equal(
    graph.nodes.some((node) =>
      String(node.source_file ?? "").startsWith("node_modules/"),
    ),
    false,
  );
});

test("generated maps, stats, AI context, and management entry are wired", async () => {
  const [
    systemPage,
    environment,
    statsSource,
    manifest,
    aiContext,
    agentRules,
    indexSource,
    packageSource,
  ] = await Promise.all([
    readFile(new URL("public/system-map.html", root), "utf8"),
    readFile(new URL("public/system-map/environment.html", root), "utf8"),
    readFile(new URL("public/system-map/graph-stats.json", root), "utf8"),
    readFile(
      new URL("public/system-map/knowledge-system-manifest.json", root),
      "utf8",
    ),
    readFile(new URL("docs/AI_CONTEXT.md", root), "utf8"),
    readFile(new URL("AGENTS.md", root), "utf8"),
    readFile(new URL("public/index.html", root), "utf8"),
    readFile(new URL("package.json", root), "utf8"),
  ]);
  const stats = JSON.parse(statsSource);
  assert.ok(stats.nodes > 0);
  assert.ok(stats.edges > 0);
  assert.ok(stats.sqlFiles >= 1);
  assert.ok(stats.sqlNodes >= stats.sqlFiles);
  assert.match(environment, /本番・配信・外部サービス構成/);
  assert.match(environment, /業務データ・AI処理構成/);
  assert.match(environment, /AI・Graphify・Obsidian開発知識循環/);
  assert.match(environment, new RegExp(`${stats.nodes} Graphify nodes`));
  assert.match(systemPage, /\/auth\/verify/);
  assert.match(systemPage, /LINE_REPORT_AUTH\.getToken/);
  assert.match(
    systemPage,
    /authState\.storeScope \|\| authState\.roomScope \|\| authState\.scopeKind/,
  );
  assert.match(systemPage, /全体管理者だけが開けます/);
  assert.match(systemPage, /system-map\/graph\.html/);
  assert.match(systemPage, /system-map\/environment\.html#business/);
  assert.match(systemPage, /from=line/);
  assert.match(indexSource, /href="\.\/system-map\.html"/);
  assert.match(aiContext, /SQL coverage/);
  assert.match(agentRules, /Graphify-first investigation/);
  assert.match(packageSource, /"knowledge:update"/);
  assert.match(packageSource, /"knowledge:check"/);
  assert.match(packageSource, /"knowledge:search"/);
  assert.doesNotMatch(manifest, /\/Users\//);
});

test("system-map inline scripts parse and defer map loading until auth succeeds", async () => {
  const systemPage = await readFile(new URL("public/system-map.html", root), "utf8");
  const scripts = [...systemPage.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map((match) => match[1].trim())
    .filter(Boolean);
  assert.ok(scripts.length >= 2);
  for (const script of scripts) {
    assert.doesNotThrow(() => new Function(script));
  }
  assert.match(systemPage, /id="mapFrame" src="about:blank"/);
  const authCheck = systemPage.indexOf("if (!response.ok)");
  const mapActivation = systemPage.indexOf("activate(tabs[0])");
  assert.ok(authCheck >= 0 && mapActivation > authCheck);
});

async function runSystemMapScenario({
  token = "",
  verify = { ok: false, status: 401, body: {} },
  stats = { ok: true, body: { nodes: 10, edges: 20, communities: 3, sqlFiles: 4 } },
}) {
  const source = await readFile(new URL("public/system-map.html", root), "utf8");
  const script = [...source.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map((match) => match[1])
    .find((body) => body.includes("var gate = document.getElementById('gate')"));
  assert.ok(script);

  function element(attributes = {}) {
    return {
      hidden: Boolean(attributes.hidden),
      src: attributes.src ?? "",
      textContent: "",
      innerHTML: "",
      attributes: { ...attributes },
      classList: { toggle() {} },
      addEventListener() {},
      getAttribute(name) {
        return this.attributes[name] ?? null;
      },
    };
  }

  const elements = {
    gate: element(),
    mapCard: element({ hidden: true }),
    mapFrame: element({ src: "about:blank" }),
    gateTitle: element(),
    gateText: element(),
    loginLink: element({ hidden: true }),
    stats: element(),
  };
  const tabs = [
    element({ "data-src": "system-map/graph.html" }),
    element({ "data-src": "system-map/environment.html#runtime" }),
    element({ "data-src": "system-map/environment.html#business" }),
    element({ "data-src": "system-map/environment.html#knowledge" }),
  ];
  const fetchCalls = [];
  const context = {
    document: {
      getElementById(id) {
        return elements[id];
      },
      querySelectorAll(selector) {
        return selector === ".tab" ? tabs : [];
      },
    },
    LINE_REPORT_AUTH: { getToken: () => token },
    LINE_REPORT_PAGES: {
      ADMIN_SURFACE: "line_report",
      adminApiUrl: (path) => `https://example.test${path}`,
    },
    window: {},
    fetch: async (url, options) => {
      fetchCalls.push({ url, options });
      const response = String(url).includes("/auth/verify") ? verify : stats;
      return {
        ok: response.ok,
        status: response.status ?? (response.ok ? 200 : 500),
        json: async () => response.body,
      };
    },
    console,
    Number,
    Array,
    String,
    Promise,
  };
  context.window = context;
  vm.runInNewContext(script, context);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { elements, fetchCalls };
}

test("system-map auth gate handles no token, scoped session, and global admin", async () => {
  const noToken = await runSystemMapScenario({});
  assert.equal(noToken.elements.mapCard.hidden, true);
  assert.equal(noToken.elements.mapFrame.src, "about:blank");
  assert.equal(noToken.elements.loginLink.hidden, false);
  assert.equal(noToken.fetchCalls.length, 0);

  const scoped = await runSystemMapScenario({
    token: "lrst_scoped",
    verify: {
      ok: true,
      body: { ok: true, storeScope: "marugoS", roomScope: null },
    },
  });
  assert.equal(scoped.elements.mapCard.hidden, true);
  assert.match(scoped.elements.gateText.textContent, /全体管理者/);
  assert.equal(scoped.fetchCalls.length, 1);

  const typedScope = await runSystemMapScenario({
    token: "lrst_typed_scope",
    verify: {
      ok: true,
      body: { ok: true, storeScope: null, roomScope: null, scopeKind: "future_scope" },
    },
  });
  assert.equal(typedScope.elements.mapCard.hidden, true);
  assert.match(typedScope.elements.gateText.textContent, /全体管理者/);

  const globalAdmin = await runSystemMapScenario({
    token: "lrst_global",
    verify: {
      ok: true,
      body: { ok: true, storeScope: null, roomScope: null },
    },
  });
  assert.equal(globalAdmin.elements.gate.hidden, true);
  assert.equal(globalAdmin.elements.mapCard.hidden, false);
  assert.equal(globalAdmin.elements.mapFrame.src, "system-map/graph.html");
  assert.match(globalAdmin.elements.stats.innerHTML, /SQL 4ファイル/);
  assert.equal(globalAdmin.fetchCalls.length, 2);
});

test("system-map keeps maps visible when graph statistics are unavailable", async () => {
  const result = await runSystemMapScenario({
    token: "lrst_global",
    verify: {
      ok: true,
      body: { ok: true, storeScope: null, roomScope: null },
    },
    stats: { ok: false, status: 503, body: {} },
  });
  assert.equal(result.elements.mapCard.hidden, false);
  assert.equal(result.elements.mapFrame.src, "system-map/graph.html");
  assert.match(result.elements.stats.innerHTML, /取得できませんでした/);
});

test("knowledge security boundaries exclude secret and customer data sources", async () => {
  const [ignore, architecture, environment] = await Promise.all([
    readFile(new URL(".graphifyignore", root), "utf8"),
    readFile(new URL("knowledge/system-architecture.json", root), "utf8"),
    readFile(new URL("public/system-map/environment.html", root), "utf8"),
  ]);
  assert.match(ignore, /\.env\*/);
  assert.match(ignore, /vendor\/\*\*/);
  assert.match(ignore, /node_modules\/\*\*/);
  assert.match(ignore, /backups\/\*\*/);
  assert.doesNotMatch(architecture, /sb_secret_[A-Za-z0-9]+/);
  assert.doesNotMatch(environment, /-----BEGIN [A-Z ]*PRIVATE KEY-----/);
});
