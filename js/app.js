import { sb, S, $, esc, toast, fail, isRole } from './core.js';

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

async function boot() {
  if (!window.APP_CONFIG?.SUPABASE_URL) {
    $('#app').innerHTML = '<div class="auth"><h3>Falta configuración</h3><p>No se encontró config.js. Defina SUPABASE_URL y SUPABASE_ANON_KEY (ver README).</p></div>'; return;
  }
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return authView();
  S.user = session.user;
  const { data, error } = await sb.from('profiles').select('*').eq('id', S.user.id).single();
  if (error) { await sb.auth.signOut(); return authView(); }
  S.profile = data;
  shell();
  if (!location.hash) location.hash = isRole('patient') ? '#/me' : '#/dashboard';
  route();
}

function authView(mode = 'login') {
  const reg = mode === 'register';
  $('#app').innerHTML = `<div class="auth"><h2>🏥 Centro Médico Premier</h2><p class="muted">${reg ? 'Crear cuenta de paciente' : 'Iniciar sesión'}</p>
  <form id="f">${reg ? '<input name="name" placeholder="Nombre completo" required>' : ''}
  <input name="email" type="email" placeholder="Correo" required autocomplete="email">
  <input name="password" type="password" placeholder="Contraseña (mín. 8)" minlength="8" required autocomplete="${reg ? 'new-password' : 'current-password'}">
  <button class="btn" style="width:100%">${reg ? 'Registrarme' : 'Entrar'}</button></form>
  <p><a href="#" id="sw">${reg ? 'Ya tengo cuenta' : 'Crear cuenta de paciente'}</a></p></div>`;
  $('#sw').onclick = e => { e.preventDefault(); authView(reg ? 'login' : 'register'); };
  $('#f').onsubmit = async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    if (reg) {
      const { data, error } = await sb.auth.signUp({ email: f.email, password: f.password, options: { data: { full_name: f.name }, emailRedirectTo: location.origin } });
      if (error) return fail(error);
      if (data.session) return boot();
      toast('Cuenta creada. Revise su correo para confirmarla y luego inicie sesión.'); authView();
    } else {
      const { error } = await sb.auth.signInWithPassword({ email: f.email, password: f.password });
      if (error) return fail(error);
      boot();
    }
  };
}

function shell() {
  const nav = Object.entries(ROUTES).filter(([, v]) => !v.hide && v.r.includes(S.profile.role))
    .map(([k, v]) => `<a href="#/${k}" data-r="${k}">${v.t}</a>`).join('');
  $('#app').innerHTML = `<div class="layout"><nav class="side"><h1>🏥 Centro Médico Premier</h1>${nav}
    <div class="me">${esc(S.profile.full_name || S.profile.email)}<br>${LABELS[S.profile.role]}<br><a href="#" id="out">Cerrar sesión</a></div></nav><main id="view"></main></div>`;
  $('#out').onclick = async e => { e.preventDefault(); await sb.auth.signOut(); location.hash = ''; boot(); };
}

async function route() {
  if (!S.profile) return;
  const [name, param] = location.hash.slice(2).split('/');
  const r = ROUTES[name];
  const el = $('#view');
  if (!r || !r.r.includes(S.profile.role)) { el.innerHTML = '<p class="err">Sección no disponible para su rol.</p>'; return; }
  document.querySelectorAll('.side a[data-r]').forEach(a => a.classList.toggle('on', a.dataset.r === name));
  el.innerHTML = '<p class="muted">Cargando…</p>';
  try { (await import(r.m)).render(el, param, name); } catch (e) { console.error(e); el.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}

window.addEventListener('hashchange', route);
sb?.auth.onAuthStateChange(ev => { if (ev === 'SIGNED_OUT') { S.user = S.profile = null; } });
boot();
