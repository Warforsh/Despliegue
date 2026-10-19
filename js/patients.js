import { sb, S, $, esc, toast, fail, isRole, audit, fmtD, fmtDT, openModal, fullName, tbl, badge } from './core.js';

const BT = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
const canEdit = () => isRole('admin', 'doctor', 'nurse');

export async function render(el, param, route) {
  if (route === 'me') return mine(el);
  return param ? detail(el, param) : list(el);
}

async function list(el) {
  el.innerHTML = `<div class="bar"><h2>Pacientes</h2>${canEdit() ? '<button id="new" class="btn">+ Nuevo paciente</button>' : ''}</div>
  <input id="q" class="search" placeholder="Buscar por nombre o DPI…"><div id="res"></div>`;
  const run = async () => {
    let q = sb.from('patients').select('id,dpi,first_name,last_name,birth_date,phone').order('last_name').limit(50);
    for (const t of $('#q').value.trim().split(/\s+/).filter(Boolean)) {
      const x = t.replace(/[,()%*]/g, '');
      if (x) q = q.or(`first_name.ilike.%${x}%,last_name.ilike.%${x}%,dpi.ilike.%${x}%`);
    }
    const { data, error } = await q; if (error) return fail(error);
    $('#res').innerHTML = tbl(['DPI', 'Paciente', 'Nacimiento', 'Teléfono', ''],
      data.map(p => [esc(p.dpi), esc(fullName(p)), fmtD(p.birth_date), esc(p.phone), `<a href="#/patients/${p.id}">Ver expediente</a>`]));
  };
  let tm; $('#q').oninput = () => { clearTimeout(tm); tm = setTimeout(run, 300); };
  if ($('#new')) $('#new').onclick = () => form(null, run);
  run();
}

function form(p, done, selfUser) {
  const v = k => esc(p?.[k] ?? '');
  const m = openModal(p ? 'Editar paciente' : 'Registrar paciente', `<form><div class="grid">
    <label>DPI (13 dígitos)<input name="dpi" required pattern="\\d{13}" maxlength="13" inputmode="numeric" value="${v('dpi')}" ${p ? 'readonly' : ''}></label>
    <label>Nombres<input name="first_name" required value="${v('first_name')}"></label>
    <label>Apellidos<input name="last_name" required value="${v('last_name')}"></label>
    <label>Fecha de nacimiento<input name="birth_date" type="date" required max="${new Date().toLocaleDateString('en-CA')}" value="${v('birth_date')}"></label>
    <label>Tipo de sangre<select name="blood_type"><option value="">—</option>${BT.map(b => `<option ${p?.blood_type === b ? 'selected' : ''}>${b}</option>`).join('')}</select></label>
    <label>Teléfono<input name="phone" required value="${v('phone')}"></label>
    <label>Correo<input name="email" type="email" value="${v('email')}"></label>
    <label>Contacto de emergencia<input name="emergency_name" required value="${v('emergency_name')}"></label>
    <label>Teléfono de emergencia<input name="emergency_phone" required value="${v('emergency_phone')}"></label></div>
    <button class="btn">Guardar</button></form>`);
  $('form', m.el).onsubmit = async e => {
    e.preventDefault();
    const o = Object.fromEntries(new FormData(e.target));
    for (const k of ['blood_type', 'email']) if (!o[k]) o[k] = null;
    if (!/^\d{13}$/.test(o.dpi)) return toast('El DPI debe tener 13 dígitos', true);
    if (!p) {
      const { data: dup } = await sb.from('patients').select('id').eq('dpi', o.dpi).maybeSingle();
      if (dup) return toast('Ya existe un paciente con ese DPI', true);
      const { data: sim } = await sb.from('patients').select('id').ilike('first_name', o.first_name).ilike('last_name', o.last_name).eq('birth_date', o.birth_date).limit(1);
      if (sim?.length && !confirm('Existe un paciente con el mismo nombre y fecha de nacimiento. ¿Registrar de todos modos?')) return;
      if (selfUser) o.user_id = selfUser;
    }
    const { error } = p ? await sb.from('patients').update(o).eq('id', p.id) : await sb.from('patients').insert(o);
    if (error) return fail(error.code === '23505' ? { message: 'Ese DPI ya está registrado. Contacte a recepción.' } : error);
    toast('Paciente guardado'); m.close(); done();
  };
}

async function mine(el) {
  const { data: p } = await sb.from('patients').select('id').eq('user_id', S.user.id).maybeSingle();
  if (p) return detail(el, p.id);
  el.innerHTML = `<div class="card"><h2>Complete su expediente</h2><p>Para solicitar citas necesitamos sus datos.</p><button class="btn" id="go">Completar registro</button></div>`;
  $('#go').onclick = () => form(null, () => mine(el), S.user.id);
}

async function detail(el, id) {
  const { data: p, error } = await sb.from('patients').select('*').eq('id', id).single();
  if (error) { el.innerHTML = '<p class="err">Paciente no disponible.</p>'; return; }
  audit('view', 'patient', id);
  const [{ data: ap }, { data: cs }] = await Promise.all([
    sb.from('appointments').select('id,starts_at,status,reason,doctor:profiles!doctor_id(full_name)').eq('patient_id', id).order('starts_at', { ascending: false }),
    sb.from('consultations').select('id,appointment_id,diagnosis,finalized,created_at').eq('patient_id', id).order('created_at', { ascending: false })]);
  const cnt = {}; (ap || []).forEach(a => (cnt[a.status] = (cnt[a.status] || 0) + 1));
  const age = Math.floor((Date.now() - new Date(p.birth_date + 'T00:00:00')) / 31557600000);
  el.innerHTML = `<div class="bar"><h2>${esc(fullName(p))}</h2><div class="row">${!isRole('patient') ? '<a href="#/patients">← Volver</a>' : ''}${canEdit() ? '<button class="btn ghost" id="ed">Editar</button>' : ''}</div></div>
  <div class="card"><div class="grid">
    <div><span class="muted">DPI</span><br>${esc(p.dpi)}</div><div><span class="muted">Nacimiento</span><br>${fmtD(p.birth_date)} (${age} años)</div>
    <div><span class="muted">Sangre</span><br>${esc(p.blood_type || '—')}</div><div><span class="muted">Teléfono</span><br>${esc(p.phone)}</div>
    <div><span class="muted">Correo</span><br>${esc(p.email || '—')}</div><div><span class="muted">Emergencia</span><br>${esc(p.emergency_name)} · ${esc(p.emergency_phone)}</div></div></div>
  <div class="card"><h3>Resumen de citas</h3><p>${Object.entries(cnt).map(([k, n]) => `${badge(k)} ${n}`).join(' &nbsp; ') || '<span class="muted">Sin citas</span>'}</p>
  ${tbl(['Fecha', 'Médico', 'Motivo', 'Estado'], (ap || []).slice(0, 15).map(a => [fmtDT(a.starts_at), esc(a.doctor?.full_name), esc(a.reason), badge(a.status)]))}</div>
  <div class="card"><h3>Consultas</h3>${tbl(['Fecha', 'Diagnóstico', ''], (cs || []).map(c => [fmtDT(c.created_at), esc((c.diagnosis || '—').slice(0, 90)), `<a href="#/consultation/${c.appointment_id}">${c.finalized ? 'Ver' : 'Abrir'}</a>`]))}</div>`;
  if ($('#ed')) $('#ed').onclick = () => form(p, () => detail(el, id));
}
