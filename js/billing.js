import { sb, CFG, $, $$, esc, toast, fail, isRole, fmtDT, openModal, fullName, tbl, badge, money, dayBounds, today } from './core.js';

export async function render(el) {
  let tab = 'inv';
  const draw = () => {
    el.innerHTML = `<div class="bar"><h2>Facturación y caja</h2></div><div class="tabs"><button data-t="inv" class="${tab === 'inv' ? 'on' : ''}">Facturas</button><button data-t="caja" class="${tab === 'caja' ? 'on' : ''}">Caja del día</button></div><div id="tab"></div>`;
    el.querySelectorAll('.tabs button').forEach(b => (b.onclick = () => { tab = b.dataset.t; draw(); }));
    tab === 'inv' ? invoices($('#tab')) : caja($('#tab'));
  };
  draw();
}

async function invoices(box) {
  const { data, error } = await sb.from('invoices').select('id,number,total,method,status,created_at,patient:patients(first_name,last_name)').order('created_at', { ascending: false }).limit(100);
  if (error) return fail(error);
  box.innerHTML = `<div class="bar"><span></span><button class="btn" id="ni">+ Nueva factura</button></div>
  ${tbl(['N.º', 'Fecha', 'Paciente', 'Total', 'Método', 'Estado', ''], data.map(i => [esc(i.number), fmtDT(i.created_at), esc(fullName(i.patient)), money(i.total), esc(i.method || '—'), badge(i.status), i.status === 'pendiente' ? `<button class="btn sm" data-pay="${i.id}">Marcar pagada</button>` : '']))}`;
  $('#ni').onclick = () => newInvoice(() => invoices(box));
  box.onclick = async e => {
    const id = e.target.dataset.pay; if (!id) return;
    const method = (prompt('Método de pago (efectivo / tarjeta):', 'efectivo') || '').toLowerCase().trim();
    if (!['efectivo', 'tarjeta'].includes(method)) return toast('Método inválido', true);
    const { error } = await sb.from('invoices').update({ status: 'pagada', method, paid_at: new Date().toISOString() }).eq('id', id);
    error ? fail(error) : toast('Factura pagada'); invoices(box);
  };
}

async function newInvoice(done) {
  const { data: ps } = await sb.from('patients').select('id,first_name,last_name,dpi').order('last_name').limit(1000);
  const m = openModal('Nueva factura', `<form><label>Paciente<select name="patient" required><option value="">—</option>${ps.map(p => `<option value="${p.id}">${esc(p.last_name + ', ' + p.first_name + ' — ' + p.dpi)}</option>`).join('')}</select></label>
    <div id="lines" class="muted" style="margin:10px 0">Seleccione un paciente para ver conceptos facturables.</div>
    <div class="grid"><label>Concepto adicional<input name="mdesc"></label><label>Monto (Q)<input name="mamt" type="number" step="0.01" min="0"></label>
    <label>Método<select name="method"><option value="efectivo">Efectivo</option><option value="tarjeta">Tarjeta</option></select></label>
    <label>Estado<select name="status"><option value="pagada">Pagada</option><option value="pendiente">Pendiente</option></select></label></div>
    <p><b>Total: <span id="tot">Q0.00</span></b></p><button class="btn">Generar factura</button></form>`);
  const f = $('form', m.el);
  const total = () => {
    let t = $$('[data-amt]:checked', f).reduce((a, i) => a + +i.dataset.amt, 0) + (+f.mamt.value || 0);
    $('#tot', m.el).textContent = money(t); return t;
  };
  f.oninput = f.onchange = total;
  f.patient.onchange = async () => {
    if (!f.patient.value) return;
    const { data, error } = await sb.rpc('billable_items', { p_patient: f.patient.value });
    if (error) return fail(error);
    const fee = CFG.CONSULTATION_FEE || 150;
    $('#lines', m.el).innerHTML = `<div class="line"><label><input type="radio" name="cons" value="" checked> Sin consulta</label></div>` +
      data.consultations.map(c => `<div class="line"><label><input type="radio" name="cons" value="${c.id}" data-amt="${fee}" data-desc="Consulta médica"> Consulta ${fmtDT(c.date)} — ${esc(c.doctor)} (${money(fee)})</label></div>`).join('') +
      data.prescriptions.map(r => {
        const amt = r.items.reduce((a, i) => a + i.qty * i.price, 0), desc = 'Medicamentos: ' + r.items.map(i => `${i.name} x${i.qty}`).join(', ');
        return `<div class="line"><label><input type="checkbox" name="rx" value="${r.id}" data-amt="${amt}" data-desc="${esc(desc)}"> ${esc(desc)} (${money(amt)})</label></div>`;
      }).join('') || '';
    total();
  };
  f.onsubmit = async e => {
    e.preventDefault();
    const sel = $$('[data-amt]:checked', f);
    const items = sel.map(i => ({ desc: i.dataset.desc, amount: +i.dataset.amt }));
    if (+f.mamt.value > 0) items.push({ desc: f.mdesc.value || 'Concepto adicional', amount: +f.mamt.value });
    if (!items.length) return toast('Seleccione al menos un concepto', true);
    const paid = f.status.value === 'pagada';
    const { error } = await sb.from('invoices').insert({
      patient_id: f.patient.value, consultation_id: $('[name=cons]:checked', f)?.value || null,
      prescription_ids: $$('[name=rx]:checked', f).map(i => i.value), items, total: total(),
      status: f.status.value, method: paid ? f.method.value : null, paid_at: paid ? new Date().toISOString() : null });
    if (error) return fail(error); toast('Factura generada'); m.close(); done();
  };
}

async function caja(box) {
  box.innerHTML = `<div class="row" style="margin-bottom:12px"><input type="date" id="cd" value="${today()}" style="width:auto"></div><div id="cx"></div>`;
  const load = async () => {
    const day = $('#cd').value, [s, e] = dayBounds(day);
    const [{ data: inv }, { data: cl }] = await Promise.all([
      sb.from('invoices').select('number,total,method,paid_at,patient:patients(first_name,last_name)').eq('status', 'pagada').gte('paid_at', s).lt('paid_at', e).order('paid_at'),
      sb.from('cash_closures').select('*').eq('closure_date', day).maybeSingle()]);
    const sum = m => inv.filter(i => !m || i.method === m).reduce((a, i) => a + Number(i.total), 0);
    $('#cx').innerHTML = `<div class="cards"><div class="stat">Total recaudado<b>${money(sum())}</b></div><div class="stat">Efectivo<b>${money(sum('efectivo'))}</b></div><div class="stat">Tarjeta<b>${money(sum('tarjeta'))}</b></div></div>
    ${tbl(['Hora', 'Factura', 'Paciente', 'Método', 'Monto'], inv.map(i => [fmtDT(i.paid_at).split(' ').pop(), esc(i.number), esc(fullName(i.patient)), esc(i.method), money(i.total)]))}<br>
    ${cl ? `<div class="card">✅ Caja cerrada el ${fmtDT(cl.created_at)} — Total ${money(cl.total)}</div>` : '<button class="btn danger" id="cc">Cerrar caja de este día</button>'}`;
    if ($('#cc')) $('#cc').onclick = async () => {
      if (!confirm(`Cerrar caja del ${day} con total ${money(sum())}?`)) return;
      const { error } = await sb.from('cash_closures').insert({ closure_date: day, total: sum(), cash_total: sum('efectivo'), card_total: sum('tarjeta') });
      error ? fail(error) : toast('Caja cerrada'); load();
    };
  };
  $('#cd').onchange = load; load();
}
