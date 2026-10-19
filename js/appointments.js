import { sb, S, $, $$, esc, toast, fail, isRole, fmtDT, fullName, openModal, dayBounds, today, badge, STATUSES } from './core.js';

const SLOTS = []; for (let h = 8; h < 18; h++) for (const m of ['00', '30']) SLOTS.push(`${String(h).padStart(2, '0')}:${m}`);

export async function render(el) {
  const pat = isRole('patient'), doc = isRole('doctor'), staff = isRole('admin', 'nurse');
  let mode = 'day';
  el.innerHTML = `<div class="bar"><h2>${doc ? 'Mi agenda' : pat ? 'Mis citas' : 'Agenda de citas'}</h2><div class="row">
    ${pat ? '' : `<input type="date" id="d" value="${today()}" style="width:auto"><button class="btn ghost" id="pend">Solo pendientes</button>`}
    <button class="btn" id="new">${pat ? 'Solicitar cita' : '+ Nueva cita'}</button></div></div><div id="list"></div>`;

  const load = async () => {
    let q = sb.from('appointments').select('id,starts_at,status,reason,patient:patients(id,first_name,last_name,dpi),doctor:profiles!doctor_id(full_name)').order('starts_at', { ascending: !pat });
    if (!pat) {
      if (mode === 'pend') q = q.eq('status', 'pendiente');
      else { const [s, e] = dayBounds($('#d').value); q = q.gte('starts_at', s).lt('starts_at', e); }
    }
    const { data, error } = await q; if (error) return fail(error);
    $('#list').innerHTML = data.length ? data.map(a => {
      const d = new Date(a.starts_at);
      const acts = [];
      if (a.status === 'pendiente' && staff) acts.push(`<button class="btn sm" data-ok="${a.id}">Confirmar</button>`);
      if (isRole('doctor', 'admin') && ['confirmada', 'en_espera'].includes(a.status)) acts.push(`<a class="btn sm" href="#/consultation/${a.id}">Atender</a>`);
      if (a.status === 'atendida') acts.push(`<a href="#/consultation/${a.id}">Ver consulta</a>`);
      const stSel = (staff || doc) ? `<select data-st="${a.id}">${STATUSES.map(s => `<option ${s === a.status ? 'selected' : ''}>${s}</option>`).join('')}</select>` : badge(a.status);
      return `<div class="appt"><div class="t">${d.toLocaleTimeString('es-GT', { hour: '2-digit', minute: '2-digit' })}<div class="muted" style="font-size:11px;font-weight:400">${d.toLocaleDateString('es-GT')}</div></div>
        <div class="i"><b>${pat ? '' : `<a href="#/patients/${a.patient?.id}">${esc(fullName(a.patient))}</a>`}</b> ${pat ? '' : '· '}Dr/a. ${esc(a.doctor?.full_name)}<br><span class="muted">${esc(a.reason || 'Sin motivo')}</span></div>${stSel}${acts.join('')}</div>`;
    }).join('') : '<p class="muted">No hay citas.</p>';
  };
  $('#list').onchange = async e => {
    const id = e.target.dataset.st; if (!id) return;
    const { error } = await sb.from('appointments').update({ status: e.target.value }).eq('id', id);
    error ? fail(error.code === '23505' ? { message: 'Ese horario ya está ocupado para el médico' } : error) : toast('Estado actualizado'); load();
  };
  $('#list').onclick = async e => {
    const id = e.target.dataset.ok; if (!id) return;
    const { error } = await sb.from('appointments').update({ status: 'confirmada' }).eq('id', id);
    error ? fail(error) : toast('Cita confirmada'); load();
  };
  if (!pat) { $('#d').onchange = () => { mode = 'day'; load(); }; $('#pend').onclick = () => { mode = 'pend'; load(); }; }
  $('#new').onclick = () => newAppt(load);
  load();
}

async function newAppt(done) {
  const pat = isRole('patient'), doc = isRole('doctor');
  const { data: ps } = await sb.from('patients').select('id,first_name,last_name,dpi').order('last_name').limit(1000);
  if (!ps?.length) return toast(pat ? 'Primero complete su expediente en "Mi expediente"' : 'No hay pacientes registrados', true);
  let { data: docs } = await sb.from('profiles').select('id,full_name').eq('role', 'doctor').order('full_name');
  if (doc) docs = docs.filter(d => d.id === S.user.id);
  const opt = (a, f) => a.map(x => `<option value="${x.id}">${esc(f(x))}</option>`).join('');
  const m = openModal(pat ? 'Solicitar cita' : 'Nueva cita', `<form><div class="grid">
    ${pat ? `<input type="hidden" name="patient_id" value="${ps[0].id}">` : `<label>Paciente<input id="pf" placeholder="Filtrar por nombre o DPI…"><select name="patient_id" id="ps" required>${opt(ps, p => `${p.last_name}, ${p.first_name} — ${p.dpi}`)}</select></label>`}
    <label>Médico<select name="doctor_id" id="dc" required>${opt(docs, d => d.full_name)}</select></label>
    <label>Fecha<input type="date" name="date" id="dt" min="${today()}" value="${today()}" required></label>
    <label>Hora<select name="time" id="tm" required></select></label></div>
    <label>Motivo<textarea name="reason"></textarea></label><br><button class="btn">${pat ? 'Enviar solicitud' : 'Agendar'}</button>
    ${pat ? '<p class="muted">Su solicitud quedará pendiente hasta ser confirmada por administración.</p>' : ''}</form>`);
  const slots = async () => {
    const dctr = $('#dc', m.el).value, d = $('#dt', m.el).value; if (!dctr || !d) return;
    const [s, e] = dayBounds(d);
    const { data } = await sb.rpc('taken_slots', { p_doctor: dctr, p_from: s, p_to: e });
    const taken = new Set((data || []).map(x => new Date(x).getTime()));
    $('#tm', m.el).innerHTML = SLOTS.map(t => {
      const ms = new Date(`${d}T${t}:00`).getTime(), off = taken.has(ms) || ms < Date.now();
      return `<option value="${t}" ${off ? 'disabled' : ''}>${t}${taken.has(ms) ? ' (ocupado)' : ''}</option>`;
    }).join('');
  };
  $('#dc', m.el).onchange = $('#dt', m.el).onchange = slots; slots();
  if ($('#pf', m.el)) $('#pf', m.el).oninput = ev => { const t = ev.target.value.toLowerCase(); $$('#ps option', m.el).forEach(o => (o.hidden = !o.textContent.toLowerCase().includes(t))); const f = $$('#ps option', m.el).find(o => !o.hidden); if (f) $('#ps', m.el).value = f.value; };
  $('form', m.el).onsubmit = async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    if (!f.time) return toast('No hay horarios disponibles', true);
    const { error } = await sb.from('appointments').insert({ patient_id: f.patient_id, doctor_id: f.doctor_id, starts_at: new Date(`${f.date}T${f.time}:00`).toISOString(), reason: f.reason || null, status: pat ? 'pendiente' : 'programada' });
    if (error) return fail(error.code === '23505' ? { message: 'Horario no disponible para ese médico. Elija otro.' } : error);
    toast(pat ? 'Solicitud enviada' : 'Cita agendada'); m.close(); done();
  };
}
