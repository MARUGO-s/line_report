import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
test('zero-day repair is idempotent and excludes ambiguous, incomplete, OFF, deleted and existing days', async()=>{
  const db=new PGlite();
  try {
    await db.exec(`create table store_webhook_tables(store_partition_key text primary key);
      insert into store_webhook_tables values ('marugoS'),('sauvage');
      create table store_operation_profiles(store_partition_key text,profile jsonb);
      insert into store_operation_profiles values ('marugos','{"journalSalesSync":true}'),('sauvage','{"journalSalesSync":false}');
      create table pos_journal_files(id bigint generated always as identity,store_partition_key text,business_date date,
        storage_deleted_at timestamptz,parsed_data jsonb,gross_sales bigint,net_sales bigint,tax_yen bigint,
        groups_count bigint,guests_count bigint,receipts_count bigint);
      create table line_sales_manual_day(store_partition_key text,sales_date date,gross_sales_yen bigint,tax_amount_yen bigint,
        guest_count bigint,party_count bigint,source text,journal_values jsonb,manual_values jsonb,
        constraint line_sales_manual_day_store_date_uidx unique(store_partition_key,sales_date));`);
    for(let i=1;i<=8;i++){
      const date=`2026-01-0${i}`;
      const parsed={business_date:date,parsed_complete:i!==2,gross_sales:0,tax:0,guests:0,groups:0,receipts:[]};
      if(i===7)parsed.tax=null;
      await db.query(`insert into pos_journal_files(store_partition_key,business_date,parsed_data,gross_sales,net_sales,
        tax_yen,groups_count,guests_count,receipts_count,storage_deleted_at) values($1,$2,$3, $4,0,0,0,0,0,$5)`,
        [i===3?'sauvage':'marugos',date,JSON.stringify(parsed),i===4?100:0,i===8?'2026-02-01':null]);
    }
    await db.exec(`insert into line_sales_manual_day values('marugoS','2026-01-05',700,0,1,1,'manual',null,'{"gross_sales_yen":700}');
      insert into pos_journal_files(store_partition_key,business_date,gross_sales) values('marugos','2026-01-06',800);`);
    const originals=(await db.query('select * from pos_journal_files order by id')).rows;
    const manual=(await db.query('select * from line_sales_manual_day')).rows[0];
    const migration=readFileSync(new URL('../supabase/migrations/20260911180000_backfill_confirmed_zero_journal_days.sql',import.meta.url),'utf8');
    await db.exec(migration); await db.exec(migration);
    const rows=(await db.query('select * from line_sales_manual_day order by sales_date')).rows;
    assert.equal(rows.length,2); assert.equal(rows[0].store_partition_key,'marugoS');
    assert.equal(rows[0].gross_sales_yen,0); assert.equal(rows[0].source,'journal');
    assert.deepEqual(rows[0].manual_values,{}); assert.deepEqual(rows[1],manual);
    assert.deepEqual((await db.query('select * from pos_journal_files order by id')).rows,originals);
  } finally {await db.close();}
});
