import { readFile,readdir } from 'node:fs/promises';
import pg from 'pg';
if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL is required');
const db=new pg.Client({connectionString:process.env.DATABASE_URL});await db.connect();
try{
 await db.query('select pg_advisory_lock(71624001)');
 // Use the same migration history contract as Supabase CLI/GitHub integration.
 // Do not run two migration deployers concurrently.
 const hadHistory=(await db.query("select to_regclass('supabase_migrations.schema_migrations') as name")).rows[0].name;
 await db.query('create schema if not exists supabase_migrations');
 await db.query('create table if not exists supabase_migrations.schema_migrations(version text primary key)');
 await db.query('alter table supabase_migrations.schema_migrations add column if not exists statements text[]');
 await db.query('alter table supabase_migrations.schema_migrations add column if not exists name text');
 if(!hadHistory){
  await db.query('alter table supabase_migrations.schema_migrations enable row level security');
  await db.query('revoke all on supabase_migrations.schema_migrations from public,anon,authenticated');
 }
 for(const file of (await readdir('supabase/migrations')).filter(n=>n.endsWith('.sql')).sort()){
  const [version,...parts]=file.replace(/\.sql$/,'').split('_');
  const previous=await db.query('select version from supabase_migrations.schema_migrations where version=$1',[version]);
  if(previous.rows.length){console.log(`Already applied: ${file}`);continue;}
  const sql=await readFile(`supabase/migrations/${file}`,'utf8');
  await db.query('begin');
  try{
   await db.query(sql);
   await db.query('insert into supabase_migrations.schema_migrations(version,name,statements) values($1,$2,$3)',[version,parts.join('_'),[sql]]);
   await db.query('commit');console.log(`Applied: ${file}`);
  }catch(e){await db.query('rollback');throw e;}
 }
}finally{await db.end();}
