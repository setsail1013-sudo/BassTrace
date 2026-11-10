import fs from 'node:fs';
import path from 'node:path';
const roots=[process.env.ProgramFiles,process.env['ProgramFiles(x86)'],process.env.LOCALAPPDATA].filter(Boolean);
const edge=roots.some(root=>fs.existsSync(path.join(root,'Microsoft','Edge','Application','msedge.exe')));
try{await import('playwright');await import('../dist-renderer/score.mjs');console.log(edge?'PDF export ready (Microsoft Edge).':'PDF export needs Microsoft Edge. Browser printing remains available.');}catch{console.log('PDF export components unavailable. Rebuild the interface; browser printing remains available.');}
