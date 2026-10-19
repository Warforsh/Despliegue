import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';

export const CFG = window.APP_CONFIG || {};
// Sin configuración no se crea el cliente (createClient lanza error con URL vacía)
export const sb = CFG.SUPABASE_URL ? createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY) : null;
export const S = { user: null, profile: null };

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const esc = v => String(v ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
export const isRole = (...r) => r.includes(S.profile?.role);
export const money = v => 'Q' + Number(v || 0).toFixed(2);
export const fmtDT = d => d ? new Date(d).toLocaleString('es-GT', { dateStyle: 'short', timeStyle: 'short' }) : '';
export const fmtD = d => d ? new Date(d.length === 10 ? d + 'T00:00:00' : d).toLocaleDateString('es-GT') : '';
export const today = () => new Date().toLocaleDateString('en-CA');
export const dayBounds = (d = today()) => {
  const s = new Date(d + 'T00:00:00'), e = new Date(s); e.setDate(e.getDate() + 1);
  return [s.toISOString(), e.toISOString()];
};
export const fullName = p => p ? `${p.first_name} ${p.last_name}` : '';
export const STATUSES = ['pendiente', 'programada', 'confirmada', 'en_espera', 'atendida', 'cancelada', 'ausente'];
export const badge = s => `<span class="badge ${esc(s)}">${esc(String(s).replace('_', ' '))}</span>`;
export const tbl = (heads, rows) => rows.length
  ? `<div class="scroll"><table><thead><tr>${heads.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
  : '<p class="muted">Sin resultados.</p>';

export function toast(m, err) {
  const t = $('#toast'); t.textContent = m; t.className = 'show' + (err ? ' bad' : '');
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.className = ''), 4500);
}
export const fail = e => toast(e?.message || String(e), true);

// Registro de accesos (lecturas). Las escrituras se auditan con triggers en la BD.
export async function audit(action, entity, entity_id = null, detail = {}) {
  await sb.from('audit_logs').insert({ user_id: S.user.id, action, entity, entity_id, detail });
}

export function openModal(title, html) {
  const o = document.createElement('div');
  o.className = 'overlay';
  o.innerHTML = `<div class="modal"><div class="bar"><h3>${esc(title)}</h3><button class="x" type="button">✕</button></div>${html}</div>`;
  document.body.appendChild(o);
  const close = () => o.remove();
  $('.x', o).onclick = close;
  return { el: o, close };
}
