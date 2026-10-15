import pg from 'pg';
if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL is required');
const [product,plan,amount]=process.argv.slice(2);
if(!/^[a-z0-9-]{1,64}$/.test(product??'')||!['annual','lifetime'].includes(plan)||!/^\d+$/.test(amount??'')||Number(amount)<1||Number(amount)>2147483647)throw new Error('Usage: npm run price -- forma-premium annual 4000 (integer cents)');
const db=new pg.Client({connectionString:process.env.DATABASE_URL});await db.connect();
try{
 await db.query('begin');await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[`price:${product}:${plan}`]);
 await db.query('update billing.prices set active=false where product_id=$1 and plan=$2 and active',[product,plan]);
 await db.query(`insert into billing.prices(product_id,plan,version,currency,amount_cents,active)
  select $1,$2,coalesce(max(version),0)+1,'BRL',$3,true from billing.prices where product_id=$1 and plan=$2`,[product,plan,Number(amount)]);
 await db.query('commit');console.log('New price version activated. Existing orders are unchanged.');
}catch(e){await db.query('rollback');throw e;}finally{await db.end();}
