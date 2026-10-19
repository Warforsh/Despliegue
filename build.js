// Build estático sin dependencias. Genera dist/ listo para cualquier hosting
// (Cloudflare Pages, Vercel, GitHub Pages, etc.).
//   Producción: lee SUPABASE_URL, SUPABASE_ANON_KEY y CONSULTATION_FEE del entorno.
//   Local:      si no hay variables y existe ./config.js, lo reutiliza.
const fs = require('fs');
const path = require('path');

const OUT = 'dist';
const e = process.env;

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// Archivos de la app
fs.copyFileSync('index.html', path.join(OUT, 'index.html'));
fs.cpSync('css', path.join(OUT, 'css'), { recursive: true });
fs.cpSync('js', path.join(OUT, 'js'), { recursive: true });
if (fs.existsSync('_headers')) fs.copyFileSync('_headers', path.join(OUT, '_headers'));

// config.js
const url = (e.SUPABASE_URL || e.SUPABASE_DATABASE_URL || '')
  .replace(/\/rest\/v1\/?$/, '').replace(/\/$/, '');
const key = e.SUPABASE_ANON_KEY || '';

if (url && key) {
  const cfg = { SUPABASE_URL: url, SUPABASE_ANON_KEY: key, CONSULTATION_FEE: Number(e.CONSULTATION_FEE || 150) };
  fs.writeFileSync(path.join(OUT, 'config.js'), 'window.APP_CONFIG=' + JSON.stringify(cfg) + ';\n');
  console.log('dist/config.js generado desde variables de entorno');
} else if (fs.existsSync('config.js')) {
  fs.copyFileSync('config.js', path.join(OUT, 'config.js'));
  console.log('dist/config.js copiado desde ./config.js (modo local)');
} else {
  // Sin esto el navegador recibiría el index.html como "config.js" y fallaría de forma confusa
  fs.writeFileSync(path.join(OUT, 'config.js'), 'window.APP_CONFIG={};\n');
  console.warn('AVISO: faltan SUPABASE_URL y/o SUPABASE_ANON_KEY; la app mostrará "Falta configuración"');
}
