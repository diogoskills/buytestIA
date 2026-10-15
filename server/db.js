import pg from 'pg';
// SSL verification is controlled by the connection string / trusted PGSSLROOTCERT.
// Never use rejectUnauthorized:false or sslmode=no-verify.
export function database(cfg){return new pg.Pool({connectionString:cfg.databaseUrl,max:5,connectionTimeoutMillis:10000,statement_timeout:30000});}

export async function verifyInstallation(db,cfg){
  const expected={product_id:cfg.productId,supabase_url:new URL(cfg.supabaseUrl).origin,
    mp_mode:cfg.mpMode,collector_id:cfg.mpCollectorId};
  await db.query('insert into billing.installation(id,context) values(true,$1) on conflict(id) do nothing',[JSON.stringify(expected)]);
  const actual=(await db.query('select context from billing.installation where id=true')).rows[0]?.context;
  if(!actual||Object.keys(expected).some(key=>actual[key]!==expected[key])){
    throw new Error('Database installation context mismatch. Keep product, Supabase project, Mercado Pago mode and receiver consistent; use a separate database/project for production and tests.');
  }
}
