import { sb, esc, isRole, money, dayBounds, fullName, badge } from './core.js';
import { ico } from './icons.js';

const hhmm = d => new Date(d).toLocaleTimeString('es-GT', { hour: '2-digit', minute: '2-digit' });

export async function render(el) {
  const [s, e] = dayBounds();
  const count = async (t, f) => { const { count } = await f(sb.from(t).select('id', { count: 'exact', head: true })); return count ?? 0; };
  const cards = []; // [etiqueta, valor, icono, tono]
  const clinical = isRole('admin', 'doctor', 'nurse');
  let agenda = [];
  if (clinical) {
    const [pat, apt, att, pend] = await Promise.all([
      count('patients', q => q.gte('created_at', s).lt('created_at', e)),
      count('appointments', q => q.gte('starts_at', s).lt('starts_at', e)),
      count('consultations', q => q.eq('finalized', true).gte('finalized_at', s).lt('finalized_at', e)),
      count('appointments', q => q.eq('status', 'pendiente'))]);
    cards.push(['Pacientes registrados hoy', pat, 'users', ''], ['Citas del día', apt, 'calendar', 't-blue'], ['Consultas atendidas', att, 'check', 't-green']);
    if (isRole('admin', 'nurse')) cards.push(['Solicitudes de cita pendientes', pend, 'clock', 't-amber']);
    ({ data: agenda } = await sb.from('appointments').select('id,starts_at,status,patient:patients(first_name,last_name),doctor:profiles!doctor_id(full_name)')
      .gte('starts_at', s).lt('starts_at', e).order('starts_at'));
  }
  if (isRole('admin', 'cashier')) {
    const { data } = await sb.from('invoices').select('total').eq('status', 'pagada').gte('paid_at', s).lt('paid_at', e);
    cards.push(['Ingresos del día', money((data || []).reduce((a, r) => a + Number(r.total), 0)), 'coin', 't-green']);
  }
  let low = [];
  if (isRole('admin', 'pharmacist')) {
    const { data } = await sb.from('products').select('name,stock,min_stock');
    low = (data || []).filter(p => p.stock < p.min_stock);
    const { count: rx } = await sb.from('prescriptions').select('id', { count: 'exact', head: true }).eq('status', 'pendiente');
    cards.push(['Recetas pendientes', rx ?? 0, 'pill', 't-amber']);
  }

  const statCard = ([l, v, icon, tone]) =>
    `<div class="stat ${tone}"><i class="st-ic">${ico(icon, 22)}</i>${esc(l)}<b>${esc(v)}</b></div>`;
  const agendaItem = a =>
    `<li class="tl-item"><span class="tl-t">${esc(hhmm(a.starts_at))}</span><span class="tl-dot"></span>
      <div class="tl-body"><b>${esc(fullName(a.patient))}</b><small>Dr/a. ${esc(a.doctor?.full_name)}</small> ${badge(a.status)}</div></li>`;

  el.innerHTML = `<div class="bar"><h2>Dashboard</h2><span class="muted">${new Date().toLocaleDateString('es-GT', { dateStyle: 'full' })}</span></div>
  <div class="cards">${cards.map(statCard).join('')}</div>
  ${low.length ? `<div class="alert warn">${ico('alert', 20)}<div><b>Stock bajo</b>
    <div class="chips">${low.map(p => `<span class="chip">${esc(p.name)} · ${esc(p.stock)}/${esc(p.min_stock)}</span>`).join('')}</div></div></div>` : ''}
  ${clinical ? `<div class="card"><h3>Citas de hoy</h3>${agenda.length
    ? `<ul class="tl">${agenda.map(agendaItem).join('')}</ul>`
    : `<div class="empty">${ico('inbox', 30)}<span>Sin citas hoy.</span></div>`}</div>` : ''}`;
}
