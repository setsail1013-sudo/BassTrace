import { build } from 'esbuild';
await build({entryPoints:['src/three-track-export.ts'],outfile:'dist-renderer/score.mjs',bundle:true,platform:'browser',format:'esm',minify:true,keepNames:false});
