import { sb, S, $, esc, toast, fail, fmtDT, tbl } from './core.js';

const ROLES = ['admin', 'doctor', 'nurse', 'pharmacist', 'cashier', 'patient'];

export async function render(el) {
  const [{ data: us, error }, { data: logs }] = await Promise.all([
    sb.from('profiles').select('*').order('created_at', { ascending: false }),
    sb.from('audit_logs').select('user_id,action,entity,entity_id,created_at').order('created_at', { ascending: false }).limit(100)]);
  if (error) return fail(error);
  const names = Object.fromEntries(us.map(u => [u.id, u.full_name || u.email]));
  el.innerHTML = `<div class="bar"><h2>Usuarios y roles</h2></div>
  <p class="muted">Los usuarios nuevos se crean como <b>paciente</b>. Asigne aquí el rol de personal (médico, enfermería, farmacéutico, cajero).</p>
  ${tbl(['Nombre', 'Correo', 'Rol', ''], us.map(u => [esc(u.full_name), esc(u.email), `<select data-r="${u.id}" ${u.id === S.user.id ? 'disabled' : ''}>${ROLES.map(r => `<option ${r === u.role ? 'selected' : ''}>${r}</option>`).join('')}</select>`, u.id === S.user.id ? '(usted)' : `<button class="btn sm" data-s="${u.id}">Guardar</button>`]))}
  <h2 style="margin:22px 0 10px">Auditoría (últimos 100 eventos)</h2>
  ${tbl(['Fecha', 'Usuario', 'Acción', 'Entidad', 'ID'], (logs || []).map(l => [fmtDT(l.created_at), esc(names[l.user_id] || 'sistema'), esc(l.action), esc(l.entity), `<span class="muted">${esc((l.entity_id || '').slice(0, 8))}</span>`]))}`;
  el.onclick = async e => {
    const id = e.target.dataset.s; if (!id) return;
    const role = $(`select[data-r="${id}"]`).value;
    const { error } = await sb.from('profiles').update({ role }).eq('id', id);
    error ? fail(error) : toast('Rol actualizado');
  };
}
