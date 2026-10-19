import { sb, S, $, esc, isRole, SessionManager } from './core.js';
import { authView } from './login.js';
import { ico } from './icons.js';

// Enlace de recuperación de contraseña (Supabase añade #...type=recovery)
let RECOVERY = /type=recovery/.test(location.hash);

const STAFF = ['admin', 'doctor', 'nurse', 'pharmacist', 'cashier'];
const ROUTES = {
  dashboard: { t: 'Dashboard', r: STAFF, m: './dashboard.js' },
  patients: { t: 'Pacientes', r: ['admin', 'doctor', 'nurse', 'cashier'], m: './patients.js' },
  me: { t: 'Mi expediente', r: ['patient'], m: './patients.js' },
  appointments: { t: 'Citas', r: ['admin', 'doctor', 'nurse', 'patient'], m: './appointments.js' },
  pharmacy: { t: 'Farmacia e inventario', r: ['admin', 'pharmacist'], m: './pharmacy.js' },
  billing: { t: 'Facturación y caja', r: ['admin', 'cashier'], m: './billing.js' },
  reports: { t: 'Reportes', r: ['admin', 'doctor', 'pharmacist'], m: './reports.js' },
  users: { t: 'Usuarios y auditoría', r: ['admin'], m: './users.js' },
  consultation: { hide: 1, r: ['admin', 'doctor', 'patient'], m: './consultation.js' },
};
const LABELS = { admin: 'Administrador', doctor: 'Médico', nurse: 'Enfermería', patient: 'Paciente', pharmacist: 'Farmacéutico', cashier: 'Cajero' };
const ICONS = { dashboard: 'grid', patients: 'users', me: 'user', appointments: 'calendar', pharmacy: 'pill', billing: 'receipt', reports: 'chart', users: 'shield' };
const initials = s => (String(s || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('') || '?').toUpperCase();

async function boot() {
  if (!window.APP_CONFIG?.SUPABASE_URL) {
    $('#app').innerHTML = '<div class="auth"><h3>Falta configuración</h3><p>No se encontró config.js. Defina SUPABASE_URL y SUPABASE_ANON_KEY (ver README).</p></div>'; return;
  }
  const { data: { session } } = await sb.auth.getSession();
  if (RECOVERY) { RECOVERY = false; return authView(boot, 'recovery'); }
  if (!session) return authView(boot);
  S.user = session.user;
  const { data, error } = await sb.from('profiles').select('*').eq('id', S.user.id).single();
  if (error) { await sb.auth.signOut(); return authView(boot); }
  S.profile = data;
  
  // Iniciar monitoreo de sesión
  SessionManager.start();
  
  shell();
  if (!location.hash) location.hash = isRole('patient') ? '#/me' : '#/dashboard';
  route();
}

// Menú lateral en móvil (panel deslizable)
function setNav(open) {
  $('#side')?.classList.toggle('open', open);
  $('#scrim')?.classList.toggle('show', open);
  $('#burger')?.setAttribute('aria-expanded', String(open));
}

function shell() {
  const who = S.profile.full_name || S.profile.email;
  const nav = Object.entries(ROUTES).filter(([, v]) => !v.hide && v.r.includes(S.profile.role))
    .map(([k, v]) => `<a href="#/${k}" data-r="${k}">${ico(ICONS[k] || 'file')}<span>${v.t}</span></a>`).join('');
  $('#app').innerHTML = `<div class="layout">
    <header class="topbar"><button class="burger" id="burger" type="button" aria-label="Abrir menú" aria-expanded="false" aria-controls="side">${ico('menu', 22)}</button><span class="tb-title">Centro Médico Premier</span></header>
    <div class="scrim" id="scrim"></div>
    <nav class="side" id="side" aria-label="Principal">
      <div class="brand"><i class="brand-ic">${ico('cross', 22)}</i><span>Centro Médico Premier</span></div>
      <div class="nav">${nav}</div>
      <div class="me">
        <div class="who"><span class="av">${esc(initials(who))}</span><div><b>${esc(who)}</b><small>${esc(LABELS[S.profile.role] || '')}</small></div></div>
        <a href="#" id="out">${ico('logout', 18)}<span>Cerrar sesión</span></a>
      </div>
    </nav>
    <main id="view"></main></div>`;
  $('#burger').onclick = () => setNav(!$('#side').classList.contains('open'));
  $('#scrim').onclick = () => setNav(false);
  
  // Cierre de sesión robusto con detención del monitoreo
  $('#out').onclick = async e => { 
    e.preventDefault(); 
    SessionManager.stop();
    try {
      await sb.rpc('close_session').catch(() => {});
      await sb.auth.signOut({ scope: 'local' });
    } catch (err) {
      console.warn('Logout error:', err);
    }
    location.hash = ''; 
    boot(); 
  };
}

async function route() {
  if (!S.profile) return;
  const [name, param] = location.hash.slice(2).split('/');
  const r = ROUTES[name];
  const el = $('#view');
  if (!r || !r.r.includes(S.profile.role)) { el.innerHTML = '<p class="err">Sección no disponible para su rol.</p>'; return; }
  document.querySelectorAll('.side a[data-r]').forEach(a => a.classList.toggle('on', a.dataset.r === name));
  setNav(false);
  el.innerHTML = '<p class="muted">Cargando…</p>';
  try { (await import(r.m)).render(el, param, name); } catch (e) { console.error(e); el.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}

window.addEventListener('hashchange', route);
document.addEventListener('keydown', e => { if (e.key === 'Escape') setNav(false); });
sb.auth.onAuthStateChange(ev => {
  if (ev === 'SIGNED_OUT') { 
    S.user = S.profile = null; 
    SessionManager.stop();
  }
  if (ev === 'PASSWORD_RECOVERY') authView(boot, 'recovery');
});
boot();
