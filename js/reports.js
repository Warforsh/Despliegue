import { sb, $, esc, fail, isRole, audit, fmtD, fmtDT, fullName, today, dayBounds, money, tbl } from './core.js';

const ymd = d => new Date(d).toLocaleDateString('en-CA');
const weekStart = d => { const x = new Date(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return ymd(x); };

const REPORTS = {
  patients: { t: 'Pacientes registrados en un período', r: ['admin', 'doctor'], async run(s, e) {
    let q = sb.from('patients').select('dpi,first_name,last_name,birth_date,phone,created_at').gte('created_at', s).lt('created_at', e).order('created_at');
    if (isRole('doctor')) { // el médico solo ve pacientes con los que tiene citas
      const { data: ap } = await sb.from('appointments').select('patient_id');
      const ids = [...new Set((ap || []).map(a => a.patient_id))];
      if (!ids.length) return { head: ['DPI', 'Paciente', 'Nacimiento', 'Teléfono', 'Registrado'], rows: [] };
      q = q.in('id', ids);
    }
    const { data, error } = await q; if (error) throw error;
    return { head: ['DPI', 'Paciente', 'Nacimiento', 'Teléfono', 'Registrado'], rows: data.map(p => [p.dpi, fullName(p), fmtD(p.birth_date), p.phone || '', fmtD(p.created_at)]) };
  } },
  appts: { t: 'Citas: programadas vs atendidas vs canceladas', r: ['admin', 'doctor'], async run(s, e) {
    const { data, error } = await sb.from('appointments').select('starts_at,status,patient:patients(first_name,last_name),doctor:profiles!doctor_id(full_name)').gte('starts_at', s).lt('starts_at', e).order('starts_at');
    if (error) throw error;
    const c = {}; data.forEach(a => (c[a.status] = (c[a.status] || 0) + 1));
    const summary = ['programada', 'confirmada', 'atendida', 'cancelada', 'ausente', 'pendiente'].map(k => `${k}: ${c[k] || 0}`).join('  |  ');
    return { summary, head: ['Fecha', 'Paciente', 'Médico', 'Estado'], rows: data.map(a => [fmtDT(a.starts_at), fullName(a.patient), a.doctor?.full_name || '', a.status]) };
  } },
  income: { t: 'Ingresos por día / semana / mes', r: ['admin'], group: true, async run(s, e, g) {
    const { data, error } = await sb.from('invoices').select('total,method,paid_at').eq('status', 'pagada').gte('paid_at', s).lt('paid_at', e);
    if (error) throw error;
    const key = d => g === 'month' ? ymd(d).slice(0, 7) : g === 'week' ? 'Semana de ' + weekStart(d) : ymd(d);
    const m = {}; data.forEach(i => { const k = key(i.paid_at); m[k] ??= { n: 0, ef: 0, ta: 0 }; m[k].n++; m[k][i.method === 'efectivo' ? 'ef' : 'ta'] += +i.total; });
    const rows = Object.entries(m).sort().map(([k, v]) => [k, v.n, money(v.ef), money(v.ta), money(v.ef + v.ta)]);
    const tot = Object.values(m).reduce((a, v) => a + v.ef + v.ta, 0);
    return { summary: 'Total del período: ' + money(tot), head: ['Período', 'Facturas', 'Efectivo', 'Tarjeta', 'Total'], rows };
  } },
  products: { t: 'Productos más dispensados', r: ['admin', 'pharmacist'], async run(s, e) {
    const { data, error } = await sb.from('prescription_items').select('name,quantity,prescriptions!inner(status,dispensed_at)').eq('prescriptions.status', 'dispensada').gte('prescriptions.dispensed_at', s).lt('prescriptions.dispensed_at', e);
    if (error) throw error;
    const m = {}; data.forEach(i => (m[i.name] = (m[i.name] || 0) + i.quantity));
    return { head: ['Producto', 'Unidades dispensadas'], rows: Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, v]) };
  } },
};

export async function render(el) {
  const avail = Object.entries(REPORTS).filter(([, r]) => isRole(...r.r));
  const first = new Date(); first.setDate(1);
  let last = null;
  el.innerHTML = `<div class="bar"><h2>Reportes</h2></div><div class="card"><div class="grid">
    <label>Reporte<select id="rp">${avail.map(([k, r]) => `<option value="${k}">${esc(r.t)}</option>`).join('')}</select></label>
    <label>Desde<input type="date" id="fr" value="${ymd(first)}"></label><label>Hasta<input type="date" id="to" value="${today()}"></label>
    <label id="gl" style="display:none">Agrupar por<select id="gr"><option value="day">Día</option><option value="week">Semana</option><option value="month">Mes</option></select></label></div>
    <div class="row"><button class="btn" id="go">Generar</button><button class="btn ghost" id="xl" disabled>Excel</button><button class="btn ghost" id="pf" disabled>PDF</button></div></div><div id="out"></div>`;
  const sync = () => ($('#gl').style.display = REPORTS[$('#rp').value].group ? '' : 'none');
  $('#rp').onchange = sync; sync();
  $('#go').onclick = async () => {
    const key = $('#rp').value, [s] = dayBounds($('#fr').value), [, e] = dayBounds($('#to').value);
    try {
      const r = await REPORTS[key].run(s, e, $('#gr').value);
      last = { title: REPORTS[key].t, key, ...r };
      $('#out').innerHTML = (r.summary ? `<p><b>${esc(r.summary)}</b></p>` : '') + tbl(r.head, r.rows.map(row => row.map(c => esc(c))));
      $('#xl').disabled = $('#pf').disabled = false;
      audit('view', 'report:' + key);
    } catch (err) { fail(err); }
  };
  $('#xl').onclick = () => {
    const ws = XLSX.utils.aoa_to_sheet([[last.title], [last.summary || ''], last.head, ...last.rows]);
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Reporte');
    XLSX.writeFile(wb, `reporte_${last.key}_${today()}.xlsx`); audit('export_xlsx', 'report:' + last.key);
  };
  $('#pf').onclick = () => {
    const doc = new window.jspdf.jsPDF();
    doc.setFontSize(14); doc.text('Centro Médico Premier', 14, 15); doc.setFontSize(11); doc.text(last.title, 14, 22);
    doc.setFontSize(9); doc.text(`${$('#fr').value} a ${$('#to').value}${last.summary ? '  —  ' + last.summary : ''}`, 14, 28);
    doc.autoTable({ head: [last.head], body: last.rows, startY: 33, styles: { fontSize: 8 }, headStyles: { fillColor: [14, 116, 144] } });
    doc.save(`reporte_${last.key}_${today()}.pdf`); audit('export_pdf', 'report:' + last.key);
  };
}
