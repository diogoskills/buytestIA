import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from './config.js';
import { database,verifyInstallation } from './db.js';
import { mercadoPago,emailProvider } from './providers.js';
import { scheduleReconciliation,runBatch } from './jobs.js';
const cfg=loadConfig(),db=database(cfg),providers={mp:mercadoPago(cfg),email:emailProvider(cfg)};
await verifyInstallation(db,cfg);
let running=true;
process.on('SIGTERM',()=>{running=false;});process.on('SIGINT',()=>{running=false;});
try{
 do{
  try{await scheduleReconciliation(db);const n=await runBatch(db,cfg,providers,10);console.log(JSON.stringify({worker:'batch',completed:n}));}
  catch{console.error(JSON.stringify({worker:'retry',error:'batch_unavailable'}));}
  if(!process.argv.includes('--once')&&running)await delay(5000);
 }while(running&&!process.argv.includes('--once'));
}finally{await db.end();}
