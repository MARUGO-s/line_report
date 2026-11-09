import assert from "node:assert/strict"
import { readFile, readdir } from "node:fs/promises"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"
import { readChatPageSource } from "./helpers/chat-page-source.mjs"
import { fixture, OWNER } from "./helpers/chat-own-history-fixture.mjs"

const root = new URL("..", import.meta.url)
const read = (relative) => relative === "public/chat.html"
  ? readChatPageSource()
  : readFile(new URL(relative, root), "utf8")
const MIGRATION = "supabase/migrations/20260904010000_chat_user_stores.sql"

function functionDefinition(sql, name) {
  const start = sql.search(new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${name}\\s*\\(`, "i"))
  assert.ok(start >= 0, `migration must define public.${name}`)
  const source = sql.slice(start)
  const marker = /\bas\s+(\$[a-z0-9_]*\$)/i.exec(source)
  assert.ok(marker, `public.${name} must have a dollar-quoted body`)
  const bodyStart = marker.index + marker[0].length
  const end = source.indexOf(`${marker[1]};`, bodyStart)
  assert.ok(end >= 0, `public.${name} body must terminate`)
  return source.slice(0, end + marker[1].length + 1)
}

test("signup requires stores and applies them only after manager approval", async () => {
  const migration = await read(MIGRATION)
  assert.match(migration, /create table if not exists public\.chat_store_catalog/i)
  assert.match(migration, /create table if not exists public\.chat_user_stores/i)
  assert.match(migration, /create table if not exists public\.chat_store_change_requests/i)
  assert.match(migration, /chat_store_change_requests_one_pending/i)
  assert.match(migration, /\('marugo', 'マルゴ'/i)

  const complete = functionDefinition(migration, "chat_complete_signup")
  assert.match(complete, /chat_normalize_store_keys/i)
  assert.match(complete, /kind, requested_store_keys/i)
  assert.match(complete, /'signup-notify'/i)
  assert.doesNotMatch(functionDefinition(migration, "chat_create_default_user_access"), /signup-notify/)

  const review = functionDefinition(migration, "chat_review_signup")
  assert.match(review, /chat_apply_user_stores/i)
  assert.match(review, /kind = 'signup'/i)

  const change = functionDefinition(migration, "chat_request_store_change")
  assert.match(change, /chat_is_registered/i)
  assert.match(change, /'store-change-notify'/i)
  assert.match(change, /所属店舗が変わっていません/)

  const reviewChange = functionDefinition(migration, "chat_review_store_change")
  assert.match(reviewChange, /chat_apply_user_stores/i)
  assert.match(reviewChange, /kind is distinct from 'change'/i)
})

test("new 1:1 chats require overlapping affiliated stores", async () => {
  const openDirect = functionDefinition(await read(MIGRATION), "chat_open_direct")
  assert.match(openDirect, /if v_id is null then/i)
  assert.match(openDirect, /chat_shares_affiliation\(v_me, p_other\)/i)
  assert.match(openDirect, /所属店舗が同じ相手だけ始められます/)
})

test("directory-only direct RPC requires both permissions and does not weaken the ordinary RPC", async () => {
  const files = await readdir(new URL("../supabase/migrations/", import.meta.url))
  const matches = files.filter((name) => /chat_open_direct_for_directory/i.test(name))
  assert.equal(matches.length, 1, "one additive directory RPC migration is required")
  const migration = await read(`supabase/migrations/${matches[0]}`)
  const directory = functionDefinition(migration, "chat_open_direct_for_directory")
  assert.match(directory, /can_browse_users/i)
  assert.match(directory, /chat_open_direct_core\(p_other, false\)/i)
  assert.match(migration, /create or replace function public\.chat_open_direct_core/i)
  const core = functionDefinition(migration, "chat_open_direct_core")
  assert.match(core, /can_start_direct/i)
  assert.match(core, /chat_has_active_access\(p_other\)/i)
  assert.doesNotMatch(directory, /chat_shares_affiliation/i)
  assert.match(migration, /revoke all on function public\.chat_open_direct_for_directory/i)
  const ordinary = functionDefinition(await read(MIGRATION), "chat_open_direct")
  assert.match(ordinary, /chat_shares_affiliation\(v_me, p_other\)/i)
})

test("directory RPC permits active cross-store humans only with both flags; ordinary RPC stays scoped", async () => {
  const files = await readdir(new URL("../supabase/migrations/", import.meta.url))
  const migrationName = files.find((name) => /chat_open_direct_for_directory/i.test(name))
  assert.ok(migrationName)
  const migration = await read(`supabase/migrations/${migrationName}`)
  const db = new PGlite()
  const owner = "11111111-1111-4111-8111-111111111111"
  const crossStore = "22222222-2222-4222-8222-222222222222"
  const sameStore = "33333333-3333-4333-8333-333333333333"
  const otherStore = "44444444-4444-4444-8444-444444444444"
  const noBrowse = "55555555-5555-4555-8555-555555555555"
  const noDirect = "66666666-6666-4666-8666-666666666666"
  const bot = "77777777-7777-4777-8777-777777777777"
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create schema auth;
      create table public.chat_user_access (
        user_id uuid primary key, access_enabled boolean not null,
        can_browse_users boolean not null default false,
        can_start_direct boolean not null default false,
        deleted_at timestamptz, restricted_until timestamptz
      );
      create table public.chat_users (
        id uuid primary key, username text not null,
        is_bot boolean not null default false, bot_deleted_at timestamptz
      );
      create table public.chat_user_stores (user_id uuid not null, store_key text not null);
      create table public.chat_groups (
        id bigint generated always as identity primary key,
        group_name text not null, created_by uuid not null,
        is_direct boolean not null, direct_key text unique
      );
      create table public.chat_group_members (
        group_id bigint not null, user_id uuid not null,
        can_view boolean not null, can_send boolean not null,
        can_invite boolean not null, can_manage boolean not null,
        primary key (group_id, user_id)
      );
      create function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
      $$;
      create function public.chat_has_active_access(p_user_id uuid default null)
      returns boolean language sql stable as $$
        select exists (select 1 from public.chat_user_access a
          where a.user_id = coalesce(p_user_id, auth.uid())
            and a.access_enabled and a.deleted_at is null
            and (a.restricted_until is null or a.restricted_until <= now()))
      $$;
      create function public.chat_is_registered() returns boolean language sql stable as $$
        select exists (select 1 from public.chat_users u where u.id = auth.uid())
          and public.chat_has_active_access()
      $$;
      create function public.chat_can_browse_users() returns boolean language sql stable as $$
        select exists (select 1 from public.chat_user_access a
          where a.user_id = auth.uid() and a.access_enabled and a.can_browse_users
            and a.deleted_at is null
            and (a.restricted_until is null or a.restricted_until <= now()))
      $$;
      create function public.chat_shares_affiliation(p_user_id uuid, p_other uuid)
      returns boolean language sql stable as $$
        select exists (select 1 from public.chat_user_stores a
          join public.chat_user_stores b using (store_key)
          where a.user_id = p_user_id and b.user_id = p_other)
      $$;
      insert into public.chat_users (id, username, is_bot) values
        ('${owner}', 'owner', false), ('${crossStore}', 'cross-store', false),
        ('${sameStore}', 'same-store', false), ('${otherStore}', 'other-store', false),
        ('${noBrowse}', 'no-browse', false), ('${noDirect}', 'no-direct', false),
        ('${bot}', 'bot', true);
      insert into public.chat_user_access
        (user_id, access_enabled, can_browse_users, can_start_direct) values
        ('${owner}', true, true, true), ('${crossStore}', true, false, false),
        ('${sameStore}', true, false, false), ('${otherStore}', true, false, false),
        ('${noBrowse}', true, false, true), ('${noDirect}', true, true, false),
        ('${bot}', true, false, false);
      insert into public.chat_user_stores values
        ('${owner}', 'store-a'), ('${sameStore}', 'store-a'),
        ('${crossStore}', 'store-b'), ('${otherStore}', 'store-b');
    `)
    await db.exec(functionDefinition(migration, "chat_open_direct_core"))
    await db.exec(functionDefinition(migration, "chat_open_direct"))
    await db.exec(functionDefinition(migration, "chat_open_direct_for_directory"))
    await db.exec(`
      revoke all on function public.chat_open_direct_core(uuid, boolean) from public, anon, authenticated, service_role;
      revoke all on function public.chat_open_direct_for_directory(uuid) from public, anon, service_role;
      grant execute on function public.chat_open_direct_for_directory(uuid) to authenticated;
      revoke all on function public.chat_open_direct(uuid) from public, anon;
      grant execute on function public.chat_open_direct(uuid) to authenticated;
    `)
    await db.exec(`select set_config('request.jwt.claim.sub', '${owner}', false); set role authenticated;`)
    const created = (await db.query(`select public.chat_open_direct_for_directory('${crossStore}') as id`)).rows[0].id
    const reused = (await db.query(`select public.chat_open_direct_for_directory('${crossStore}') as id`)).rows[0].id
    assert.equal(String(reused), String(created), "a repeat reuses the same direct room")
    await db.exec('reset role')
    assert.equal((await db.query("select count(*)::int as n from public.chat_group_members")).rows[0].n, 2)
    await db.exec(`select set_config('request.jwt.claim.sub', '${owner}', false); set role authenticated;`)
    const sameStoreId = (await db.query(`select public.chat_open_direct('${sameStore}') as id`)).rows[0].id
    assert.ok(Number(sameStoreId) > 0, "ordinary same-store direct still works")
    await assert.rejects(
      db.query(`select public.chat_open_direct('${otherStore}')`),
      /所属店舗が同じ相手だけ始められます/
    )
    await assert.rejects(
      db.query(`select public.chat_open_direct_for_directory('${bot}')`),
      /同僚ユーザーは現在利用できません/
    )
    await assert.rejects(
      db.query(`select public.chat_open_direct_for_directory('88888888-8888-4888-8888-888888888888')`),
      /現在利用できません/
    )
    await db.exec('reset role')
    await db.exec(`select set_config('request.jwt.claim.sub', '${noBrowse}', false); set role authenticated;`)
    await assert.rejects(
      db.query(`select public.chat_open_direct_for_directory('${crossStore}')`),
      /登録ユーザーを参照する権限がありません/
    )
    await db.exec('reset role')
    await db.exec(`select set_config('request.jwt.claim.sub', '${noDirect}', false); set role authenticated;`)
    await assert.rejects(
      db.query(`select public.chat_open_direct_for_directory('${crossStore}')`),
      /1対1トークを開始する権限がありません/
    )
    await db.exec('reset role')
    await db.exec('set role anon')
    await assert.rejects(
      db.query(`select public.chat_open_direct_for_directory('${crossStore}')`),
      /permission denied/i
    )
  } finally {
    await db.close()
  }
})

test("friend finder renders every human under store sections and uses the scoped cross-store RPC", async () => {
  const f = await fixture()
  try {
    f.query(async (table) => {
      if (table === "chat_users") {
        return {data:[
          {id:OWNER,username:"自分",is_bot:false},
          {id:"local",username:"店舗Aの人",is_bot:false},
          {id:"cross",username:"店舗Bの人",is_bot:false},
          {id:"multi",username:"複数店舗の人",is_bot:false},
          {id:"unassigned",username:"未所属の人",is_bot:false},
          {id:"bot",username:"店舗Bot",is_bot:true},
        ],error:null}
      }
      if (table === "chat_user_stores") {
        return {data:[
          {user_id:"local",store_key:"store-a"},
          {user_id:"cross",store_key:"store-b"},
          {user_id:"multi",store_key:"store-a"},
          {user_id:"multi",store_key:"store-b"},
        ],error:null}
      }
      if (table === "chat_store_catalog") {
        return {data:[
          {store_key:"store-b",display_name:"店舗B",sort_order:10},
          {store_key:"store-a",display_name:"店舗A",sort_order:20},
        ],error:null}
      }
      return {data:[],error:null}
    })
    f.run(`currentUser = {id:'${OWNER}', username:'自分'};
      currentChatAccess = {access_enabled:true, signup_status:'approved', can_browse_users:true, can_start_direct:true};
      myGroups = []; talkTab = 'friends';
      loadGroups = async () => {}; selectGroup = () => {};`)
    await f.run("loadRegisteredUsers()")
    assert.equal(f.calls.filter((call) => call.table === "chat_store_catalog").length, 1)
    const list = f.w.document.getElementById("myGroupsList")
    assert.ok(list.textContent.includes("店舗B"), "store heading is rendered")
    assert.ok(list.textContent.includes("店舗A"), "store heading is rendered")
    assert.ok(list.textContent.includes("店舗Bの人"), "cross-store user is visible")
    assert.ok(list.textContent.includes("複数店舗の人"), "multi-store user is visible")
    assert.ok(list.textContent.includes("所属店舗未設定"), "unassigned user is retained")
    assert.ok(!list.textContent.includes("店舗Bot"), "Bots are not colleague candidates")
    assert.ok(!list.textContent.includes("自分"), "the current user is not a candidate")
    const headings = [...list.querySelectorAll(".friend-store-heading")].map((e) => e.textContent)
    assert.deepEqual(headings, ["店舗B", "店舗A", "所属店舗未設定"])
    const multiRows = [...list.querySelectorAll(".user-row")]
      .filter((row) => row.textContent.includes("複数店舗の人"))
    assert.equal(multiRows.length, 2, "multi-store users appear in each store group")
    f.rpc(async (name, body) => {
      assert.equal(name, "chat_open_direct_for_directory")
      assert.deepEqual(body, {p_other:"cross"})
      return {data:11}
    })
    const crossRow = [...list.querySelectorAll(".user-row")]
      .find((row) => row.textContent.includes("店舗Bの人"))
    crossRow.querySelector("button.join-btn").click()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(f.calls.filter((call) => call.name === "chat_open_direct_for_directory").length, 1)
  } finally {
    await f.close()
  }
})

test("new users join only affiliated store rooms as viewers", async () => {
  const migration = await read("supabase/migrations/20260905010000_chat_store_room_affiliation.sql")
  const join = functionDefinition(migration, "chat_join_store_rooms")
  assert.match(join, /人間は所属店舗の承認後に/i)
  assert.doesNotMatch(join, /where g\.is_store_room\s+on conflict/i)
  assert.match(functionDefinition(migration, "chat_sync_user_store_rooms"), /default_can_send = false/i)
  assert.match(functionDefinition(migration, "chat_apply_user_stores"), /chat_sync_user_store_rooms/i)
  assert.match(functionDefinition(migration, "chat_add_members"), /chat_user_can_join_group_by_store/i)
})

test("chat.html requires store pick, later change, and filters 1:1 candidates", async () => {
  const chat = await read("public/chat.html")
  const knowledge = await read("supabase/functions/chat-knowledge/index.ts")

  assert.match(chat, /id="profileStorePick"/)
  assert.match(chat, /id="profileSettingsOverlay"/)
  assert.match(chat, /rpc\('chat_complete_signup'/)
  assert.match(chat, /rpc\('chat_request_store_change'/)
  assert.match(chat, /rpc\('chat_review_store_change'/)
  assert.match(chat, /function sharesAffiliationWith/)
  assert.match(chat, /function openProfileSettings/)
  assert.match(chat, /所属店舗を1つ以上選んでください/)
  assert.match(chat, /sharesAffiliationWith\(u\)/)
  assert.match(chat, /mtalk-stores:\(approve\|deny\)/)
  assert.match(chat, /id="chatAdminMenuLink" href="\.\/chat-admin\.html" class="hidden"[^>]*aria-hidden="true" tabindex="-1"/)
  assert.doesNotMatch(chat, /\.from\('chat_users'\)[\s\S]{0,120}?\.insert\(/)

  assert.match(knowledge, /action === "store-change-notify"/)
  assert.match(knowledge, /mtalk-stores:approve:/)
  assert.match(knowledge, /所属店舗の変更/)
})

test("privilege boundaries: no self insert, viewer defaults, store-room join, no silent admin", async () => {
  const boundary = await read("supabase/migrations/20260906010000_chat_privilege_boundaries.sql")
  const chat = await read("public/chat.html")
  const admin = await read("public/chat-admin.html")

  assert.match(boundary, /alter column can_send set default false/i)
  assert.match(boundary, /alter column can_invite set default false/i)
  assert.match(boundary, /drop policy if exists chat_users_insert_self/i)
  assert.match(boundary, /revoke insert on table public\.chat_users/i)
  assert.match(functionDefinition(boundary, "chat_join_by_invite"), /chat_user_can_join_group_by_store/i)
  assert.match(functionDefinition(boundary, "chat_create_group"), /chat_shares_affiliation/i)
  assert.match(boundary, /signup_status = 'pending'/i)

  assert.match(chat, /function syncAccountAdminLink\(\)[\s\S]{0,500}?is_full_admin === true/)
  assert.match(admin, /referrerIsHqDashboard/)
  assert.match(admin, /resumeAdminBtn/)
  assert.match(admin, /ここは M-talk の利用者画面ではありません/)
})
