import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { fetchLineQuotaChannels, fetchMonthlyUsage } from '../supabase/functions/_shared/usage_metrics.ts';

test('monthly SQL: >1000 rows, JST boundaries, exclusions, unassigned totals and permissions', async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role;
      create table room_summary_settings(room_id text primary key,room_name text,receipt_report_store_partition_key text);
      create table line_webhook_delivery_logs(target_room_id text,store_partition_key text,method text,context text,line_send_success bool,created_at timestamptz);
      create table summary_delivery_logs(target_room_id text,details jsonb,reason text,line_send_attempted bool,line_send_success bool,run_at timestamptz);
      create table gmail_reservation_alert_logs(line_target_room_id text,line_message_sent_at timestamptz);
      create table reservation_today_alert_logs(room_id text,store_partition_key text,sent_at timestamptz);
      create table calendar_tomorrow_reminder_logs(room_id text,store_partition_key text,sent_at timestamptz);
      create table tokyo_dome_weekly_logs(room_id text,store_partition_key text,sent_at timestamptz,event_count int);
      create table line_receipt_mid_reports(room_id text,report_kind text,sent_at timestamptz);
      create table future_feature(id int);
      create table partition_parent(id int) partition by range(id);
      create table partition_leaf partition of partition_parent for values from (0) to (10);
      insert into room_summary_settings values ('Ctest','架空店舗','Test');
      insert into line_webhook_delivery_logs select 'Ctest','Test','push','test',true,'2026-09-01T00:00:00+09' from generate_series(1,1105);
      insert into line_webhook_delivery_logs values
        ('Ctest',null,'reply','test',true,'2026-09-30T14:59:59Z'),
        ('Ctest',null,'push','test',true,'2026-09-30T15:00:00Z'),
        ('Ctest',null,'push','test',true,'2026-08-31T14:59:59Z'),
        ('Ctest',null,'unknown','test',true,'2026-09-01T00:00:00Z'),
        ('Ctest',null,'push','test',false,'2026-09-01T00:00:00Z');
      insert into gmail_reservation_alert_logs values ('Unassigned','2026-09-01T00:00:00Z');
      insert into line_receipt_mid_reports values ('mtalk-group-12','monthly','2026-09-01T00:00:00Z'),('Ctest','monthly','2026-09-01T00:00:00Z');
      insert into tokyo_dome_weekly_logs values ('Ctest','Test','2026-09-01T00:00:00Z',0),('Ctest','Test','2026-09-01T00:00:00Z',1);`);
    await db.exec(readFileSync(new URL('../supabase/migrations/20260911120000_usage_accuracy.sql',import.meta.url),'utf8'));
    const usage = (await db.query(`select get_usage_monthly('2026-09') as data`)).rows[0].data;
    assert.equal(usage.total_push_rows,1108);
    assert.equal(usage.webhook_reply_rows,1);
    assert.equal(usage.unverified_push_rows,2);
    assert.equal(usage.unassigned_rows,1);
    assert.equal(usage.free_quota_remaining,null);
    assert.equal(usage.by_store.reduce((n,r)=>n+r.total,0),1109);
    assert.equal(usage.by_room.reduce((n,r)=>n+r.total,0),1109);
    assert.equal(usage.by_source_context.reduce((n,r)=>n+r.count,0),1108);
    const empty = (await db.query(`select get_usage_monthly('2026-12') as data`)).rows[0].data;
    assert.equal(empty.total_push_rows,0);
    assert.equal(Date.parse(empty.period_end),Date.parse('2026-12-31T15:00:00Z'));
    await assert.rejects(db.query(`select get_usage_monthly('2026-13')`));
    const sizes = (await db.query(`select get_storage_usage_stats() as data`)).rows[0].data;
    assert.equal(sizes.scope,'public_relations');
    assert(sizes.managed_tables.some(r=>r.table_name==='future_feature'));
    assert(sizes.managed_tables.some(r=>r.table_name==='partition_leaf'));
    assert(!sizes.managed_tables.some(r=>r.table_name==='partition_parent'));
    assert.equal(sizes.managed_tables.reduce((n,r)=>n+r.size_bytes,0),sizes.managed_tables_total_bytes);
    for (const role of ['anon','authenticated']) {
      await db.exec(`set role ${role}`);
      await assert.rejects(db.query(`select get_usage_monthly('2026-09')`));
      await assert.rejects(db.query(`select get_storage_usage_stats()`));
      await db.exec('reset role');
    }
    await db.exec('set role service_role');
    assert.equal((await db.query(`select get_usage_monthly('2026-09') as data`)).rows[0].data.total_push_rows,1108);
  } finally { await db.close(); }
});

test('quota: same token grouped, no global sum, 80%/zero/unlimited/failed/missing preserved', async () => {
  let calls=0;
  const channels=[{label:'A',token:'fake-shared'},{label:'B',token:'fake-shared'},{label:'C',token:'fake-none'},{label:'D',token:'fake-fail'},{label:'E',token:''}];
  const result=await fetchLineQuotaChannels(channels,async (url,init)=>{
    calls++;
    const token=init.headers.Authorization;
    if(token.includes('fail')) return new Response('private upstream error',{status:401});
    assert.equal(init.body,undefined);
    return Response.json(url.endsWith('consumption') ? {totalUsage:160} : token.includes('none') ? {type:'none'} : {type:'limited',value:200});
  });
  assert.equal(calls,6);
  assert.equal(result.channels.length,4);
  const first=result.channels.find(r=>r.labels.includes('A'));
  assert.deepEqual(first.labels,['A','B']); assert.equal(first.remaining,40);
  assert.equal(result.channels.find(r=>r.labels.includes('C')).limit,null);
  assert.equal(result.channels.find(r=>r.labels.includes('D')).used,null);
  assert.equal(result.channels.find(r=>r.labels.includes('E')).status,'not_configured');
  assert(!JSON.stringify(result).includes('fake-')); assert(!JSON.stringify(result).includes('private'));
});

test('quota: malformed/timeout/negative replies are unavailable, genuine zero remains zero', async()=>{
  for (const value of [null,{}, {totalUsage:-1},{totalUsage:'0'}]) {
    const r=await fetchLineQuotaChannels([{label:'A',token:'fake'}],async()=>Response.json(value));
    assert.equal(r.channels[0].used,null);
  }
  const r=await fetchLineQuotaChannels([{label:'A',token:'fake'}],async url=>Response.json(url.endsWith('consumption')?{totalUsage:0}:{type:'limited',value:0}));
  assert.equal(r.channels[0].remaining,0);
  const failure=await fetchLineQuotaChannels([{label:'A',token:'fake'}],async()=>{throw new Error('timeout')});
  assert.equal(failure.channels[0].status,'unavailable');
});

test('RPC failure and invalid counts never become 0', async()=>{
  for (const response of [{data:null,error:{message:'private'}},{data:{status:'ok'},error:null}]) {
    const result=await fetchMonthlyUsage({rpc:async()=>response});
    assert.equal(result.status,'unavailable'); assert.equal(result.total_push_rows,null);
    assert(!JSON.stringify(result).includes('private'));
  }
  const result=await fetchMonthlyUsage({rpc:async()=>{throw new Error('network')}});
  assert.equal(result.status,'unavailable');
});
