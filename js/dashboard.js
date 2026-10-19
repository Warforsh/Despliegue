import { sb, $, esc, isRole, money, dayBounds, fmtDT, fullName, badge } from './core.js';

export async function render(el) {
  const [s, e] = dayBounds();
  const count = async (t, f) => { const { count } = await f(sb.from(t).select('id', { count: 'exact', head: true })); return count ?? 0; };
  const cards = [];
  const clinical = isRole('admin', 'doctor', 'nurse');
  let agenda = [];
  if (clinical) {
    const [pat, apt, att, pend] = await Promise.all([
      count('patients', q => q.gte('created_at', s).lt('created_at', e)),
      count('appointments', q => q.gte('starts_at', s).lt('starts_at', e)),
      count('consultations', q => q.eq('finalized', true).gte('finalized_at', s).lt('finalized_at', e)),
      count('appointments', q => q.eq('status', 'pendiente'))]);
    cards.push(['Pacientes registrados hoy', pat], ['Citas del día', apt], ['Consultas atendidas', att]);
    if (isRole('admin', 'nurse')) cards.push(['Solicitudes de cita pendientes', pend]);
    ({ data: agenda } = await sb.from('appointments').select('id,starts_at,status,patient:patients(first_name,last_name),doctor:profiles!doctor_id(full_name)')
      .gte('starts_at', s).lt('starts_at', e).order('starts_at'));
  }
  if (isRole('admin', 'cashier')) {
    const { data } = await sb.from('invoices').select('total').eq('status', 'pagada').gte('paid_at', s).lt('paid_at', e);
    cards.push(['Ingresos del día', money((data || []).reduce((a, r) => a + Number(r.total), 0))]);
  }
  let low = [];
  if (isRole('admin', 'pharmacist')) {
    const { data } = await sb.from('products').select('name,stock,min_stock');
    low = (data || []).filter(p => p.stock < p.min_stock);
    const { count: rx } = await sb.from('prescriptions').select('id', { count: 'exact', head: true }).eq('status', 'pendiente');
    cards.push(['Recetas pendientes', rx ?? 0]);
  }
  el.innerHTML = `<div class="bar"><h2>Dashboard</h2><span class="muted">${new Date().toLocaleDateString('es-GT', { dateStyle: 'full' })}</span></div>
  <div class="cards">${cards.map(([l, v]) => `<div class="stat">${esc(l)}<b>${esc(v)}</b></div>`).join('')}</div>
  ${low.length ? `<div class="alert">⚠️ <b>Stock bajo:</b> ${low.map(p => `${esc(p.name)} (${p.stock}/${p.min_stock})`).join(', ')}</div>` : ''}
  ${clinical ? `<div class="card"><h3>Citas de hoy</h3>${agenda.length ? agenda.map(a => `<div class="hist">${fmtDT(a.starts_at).split(' ').pop()} — ${esc(fullName(a.patient))} · Dr/a. ${esc(a.doctor?.full_name)} ${badge(a.status)}</div>`).join('') : '<p class="muted">Sin citas hoy.</p>'}</div>` : ''}`;
}
