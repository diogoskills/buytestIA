import { loadConfig } from './config.js';
import { database,verifyInstallation } from './db.js';
import { mercadoPago, emailProvider } from './providers.js';
import { createApp } from './app.js';
const cfg=loadConfig(),db=database(cfg);
await verifyInstallation(db,cfg);
const app=createApp({db,cfg,providers:{mp:mercadoPago(cfg),email:emailProvider(cfg)}});
const server=app.listen(cfg.port,'0.0.0.0',()=>console.log(`API listening on port ${cfg.port}`));
async function close(){server.close();await db.end();}
process.on('SIGTERM',close);process.on('SIGINT',close);
