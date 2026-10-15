import { build } from 'esbuild';
await build({entryPoints:['web/premium.js'],bundle:true,minify:true,outfile:'dist/premium.js',target:['es2022']});
