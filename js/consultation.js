import { sb, $, $$, esc, toast, fail, isRole, audit, fmtD, fmtDT, openModal, fullName, badge } from './core.js';

export async function render(el, apptId) {
  const { data: a, error } = await sb.from('appointments')
    .select('id,status,starts_at,patient_id,doctor_id,patient:patients(id,first_name,last_name,dpi,birth_date,blood_type),doctor:profiles!doctor_id(full_name)').eq('id', apptId).single();
  if (error) { el.innerHTML = '<p class="err">Cita no disponible.</p>'; return; }
  const canWrite = isRole('doctor', 'admin');
  let { data: c } = await sb.from('consultations').select('*').eq('appointment_id', apptId).maybeSingle();
  if (!c) {
    if (!(canWrite && ['confirmada', 'en_espera'].includes(a.status))) { el.innerHTML = '<p>Aún no existe una consulta para esta cita.</p>'; return; }
    const r = await sb.from('consultations').insert({ appointment_id: a.id, patient_id: a.patient_id, doctor_id: a.doctor_id }).select().single();
    if (r.error) return fail(r.error); c = r.data;
  }
  audit('view', 'consultation', c.id);
  const locked = c.finalized || !canWrite;
  const [{ data: hist }, { data: rxs }] = await Promise.all([
    sb.from('consultations').select('id,appointment_id,diagnosis,created_at,finalized').eq('patient_id', a.patient_id).neq('id', c.id).order('created_at', { ascending: false }).limit(20),
    sb.from('prescriptions').select('id,status,created_at,items:prescription_items(name,dose,frequency,duration,quantity)').eq('consultation_id', c.id).order('created_at')]);
  const d = ['disabled', ''][+!locked];
  const inp = (k, label, type = 'number', extra = '') => `<label>${label}<input name="${k}" type="${type}" ${extra} value="${esc(c[k] ?? '')}" ${d}></label>`;
  const ta = (k, label) => `<label>${label}<textarea name="${k}" ${d}>${esc(c[k] ?? '')}</textarea></label>`;
  el.innerHTML = `<div class="bar"><h2>Consulta — ${esc(fullName(a.patient))}</h2><div class="row"><a href="#/appointments">← Citas</a> ${c.finalized ? badge('atendida') + ' 🔒 Finalizada' : badge(a.status)}</div></div>
  <p class="muted">DPI ${esc(a.patient.dpi)} · Sangre ${esc(a.patient.blood_type || '—')} · Nac. ${fmtD(a.patient.birth_date)} · Dr/a. ${esc(a.doctor?.full_name)} · ${fmtDT(a.starts_at)}</p>
  <div class="two"><div>
   <form id="cf" class="card"><h3>Signos vitales</h3><div class="grid">
     ${inp('blood_pressure', 'Presión (ej. 120/80)', 'text', 'pattern="\\d{2,3}/\\d{2,3}"')}${inp('temperature', 'Temperatura °C', 'number', 'step="0.1" min="30" max="45"')}
     ${inp('pulse', 'Pulso (lpm)', 'number', 'min="20" max="250"')}${inp('weight_kg', 'Peso (kg)', 'number', 'step="0.01" min="0"')}${inp('height_cm', 'Talla (cm)', 'number', 'step="0.1" min="0"')}</div>
     ${ta('reason', 'Motivo de consulta')}${ta('diagnosis', 'Evaluación / Diagnóstico')}${ta('plan', 'Plan de tratamiento')}
     <div class="row" style="margin-top:12px">${locked ? '' : '<button class="btn" id="sv">Guardar</button><button type="button" class="btn danger" id="fin">Finalizar consulta</button>'}
     ${c.finalized && isRole('admin') ? '<button type="button" class="btn ghost" id="unl">Desbloquear (admin)</button>' : ''}</div></form>
   <div class="card"><div class="bar"><h3>Recetas</h3>${locked ? '' : '<button class="btn sm" id="rx">Agregar Receta</button>'}</div>
     ${rxs?.length ? rxs.map(r => `<div class="hist">${fmtDT(r.created_at)} ${badge(r.status)}<ul>${r.items.map(i => `<li>${esc(i.name)} — ${esc(i.dose)} · ${esc(i.frequency)} · ${esc(i.duration)} · cant. ${i.quantity}</li>`).join('')}</ul></div>`).join('') : '<p class="muted">Sin recetas.</p>'}</div></div>
   <aside class="card"><h3>Historial del paciente</h3>${hist?.length ? hist.map(h => `<div class="hist"><b>${fmtD(h.created_at)}</b><br>${esc((h.diagnosis || 'Sin diagnóstico').slice(0, 80))}<br><a href="#/consultation/${h.appointment_id}">Abrir</a></div>`).join('') : '<p class="muted">Sin consultas previas.</p>'}</aside></div>`;

  const collect = () => {
    const o = Object.fromEntries(new FormData($('#cf')));
    for (const k of Object.keys(o)) if (o[k] === '') o[k] = null;
    return o;
  };
  const save = async extra => {
    const { error } = await sb.from('consultations').update({ ...collect(), ...extra }).eq('id', c.id);
    if (error) { fail(error); return false; } return true;
  };
  if (!locked) {
    $('#cf').onsubmit = async e => { e.preventDefault(); if (await save()) { toast('Consulta guardada'); } };
    $('#fin').onclick = async () => {
      const o = collect();
      if (!o.reason || !o.diagnosis || !o.plan) return toast('Complete motivo, diagnóstico y plan antes de finalizar', true);
      if (!confirm('Al finalizar, la consulta quedará bloqueada y solo un administrador podrá desbloquearla. ¿Continuar?')) return;
      if (!(await save({ finalized: true, finalized_at: new Date().toISOString() }))) return;
      await sb.from('appointments').update({ status: 'atendida' }).eq('id', a.id);
      toast('Consulta finalizada'); render(el, apptId);
    };
    $('#rx').onclick = () => rxModal(c, () => render(el, apptId));
  }
  if ($('#unl')) $('#unl').onclick = async () => {
    if (!confirm('¿Desbloquear esta consulta para edición?')) return;
    if (await save({ finalized: false, finalized_at: null })) { toast('Consulta desbloqueada'); render(el, apptId); }
  };
}

async function rxModal(c, done) {
  const { data: prods } = await sb.from('products').select('id,name,stock').order('name');
  const row = () => `<div class="rx-row"><select data-p><option value="">Otro (no inventariado)</option>${(prods || []).map(p => `<option value="${p.id}">${esc(p.name)} (stock ${p.stock})</option>`).join('')}</select>
    <input data-n placeholder="Medicamento" required><input data-d placeholder="Dosis" required><input data-f placeholder="Frecuencia" required><input data-u placeholder="Duración" required><input data-q type="number" min="1" placeholder="Cant." required></div>`;
  const m = openModal('Nueva receta', `<form><div id="rows">${row()}</div><button type="button" class="btn ghost sm" id="add">+ Medicamento</button> <button class="btn">Guardar receta</button>
    <p class="muted">Guardar la receta no descuenta inventario; la farmacia lo hace al dispensar.</p></form>`);
  $('#add', m.el).onclick = () => $('#rows', m.el).insertAdjacentHTML('beforeend', row());
  $('#rows', m.el).onchange = e => { if (e.target.matches('[data-p]')) { const r = e.target.closest('.rx-row'); const p = (prods || []).find(x => x.id === e.target.value); if (p) $('[data-n]', r).value = p.name; } };
  $('form', m.el).onsubmit = async e => {
    e.preventDefault();
    const { data: rx, error } = await sb.from('prescriptions').insert({ consultation_id: c.id, patient_id: c.patient_id, doctor_id: c.doctor_id }).select('id').single();
    if (error) return fail(error);
    const items = $$('.rx-row', m.el).map(r => ({ prescription_id: rx.id, product_id: $('[data-p]', r).value || null, name: $('[data-n]', r).value.trim(), dose: $('[data-d]', r).value.trim(), frequency: $('[data-f]', r).value.trim(), duration: $('[data-u]', r).value.trim(), quantity: +$('[data-q]', r).value }));
    const r2 = await sb.from('prescription_items').insert(items);
    if (r2.error) return fail(r2.error);
    audit('create', 'prescription', rx.id); toast('Receta agregada'); m.close(); done();
  };
}
