import {
  sb, CFG, $, $$, esc, isRole, money, fmtDT, today, dayBounds,
  tbl, toast, fail, audit, openModal, S
} from './core.js';

// =====================================================================
// FACTURACIÓN Y CAJA — Centro Médico Premier
// Lectura tolerante a fallos: un módulo opcional no debe romper la vista.
// =====================================================================

const state = {
  invoices: [],
  patients: [],
  summary: [],
  docs: {},
  canManage: false,
  isAdmin: false
};

// ---------- Utilidades ----------
const num = v => Number(v || 0);
const net = inv => Math.max(0, num(inv.total) - num(inv.refund_amount));

// Compatibilidad con facturas antiguas y nuevas del sistema
const itemConcept = it => it?.concept || it?.name || it?.description || 'Concepto';
const itemQty = it => num(it?.qty ?? it?.quantity ?? 1) || 1;
const itemPrice = it => num(it?.price ?? it?.unit_price ?? 0);
const itemSubtotal = it => num(it?.subtotal) || itemQty(it) * itemPrice(it);

const patientName = inv =>
  `${inv.patient?.first_name || ''} ${inv.patient?.last_name || ''}`.trim() || 'Paciente';

const statusBadge = inv => {
  const refund = num(inv.refund_amount);
  if (refund > 0) {
    const full = refund >= num(inv.total);
    return `<span class="badge ${full ? 'cancelada' : 'pendiente'}">${full ? 'reembolsada' : 'reembolso parcial'}</span>`;
  }
  return `<span class="badge ${inv.status === 'pagada' ? 'atendida' : 'pendiente'}">${esc(inv.status || 'pendiente')}</span>`;
};

// CSV seguro: escapa comillas y neutraliza inyección de fórmulas
const csvCell = value => {
  let s = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
};

// =====================================================================
// VISTA PRINCIPAL
// =====================================================================
export async function render(el) {
  state.canManage = isRole('admin', 'cashier');
  state.isAdmin = isRole('admin');

  el.innerHTML = '<p class="muted">Cargando facturas…</p>';

  // 1) CONSULTA CRÍTICA: solo relaciones que SÍ existen en el schema.
  //    NO se hace embed de documents (relación polimórfica, sin FK).
  const { data, error } = await sb
    .from('invoices')
    .select('*, patient:patients(first_name, last_name, dpi)')
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) {
    el.innerHTML = `
      <div class="bar"><h2>Facturación y Caja</h2></div>
      <div class="card">
        <p class="bad">No se pudieron cargar las facturas.</p>
        <p class="muted">${esc(error.message)}</p>
        <button class="btn" id="btn-retry">Reintentar</button>
      </div>`;
    $('#btn-retry', el).onclick = () => render(el);
    return fail(error);
  }

  state.invoices = data || [];
  const ids = state.invoices.map(i => i.id);

  // 2) CONSULTAS SECUNDARIAS: ninguna puede dejar la pantalla en blanco.
  const [from, to] = dayBounds(today());

  const [p, d, s] = await Promise.all([
    state.canManage
      ? sb.from('patients').select('id, first_name, last_name, dpi').order('last_name')
      : Promise.resolve({ data: [], error: null }),

    ids.length
      ? sb.from('documents')
          .select('id, entity_id, filename, file_type')
          .eq('entity_type', 'invoice')
          .in('entity_id', ids)
      : Promise.resolve({ data: [], error: null }),

    state.canManage
      ? sb.from('invoices').select('*')
          .eq('status', 'pagada')
          .gte('created_at', from)
          .lt('created_at', to)
      : Promise.resolve({ data: [], error: null })
  ]);

  if (p.error) {
    // Sin catálogo de pacientes no se puede facturar, pero sí se puede leer.
    state.patients = [];
    console.warn('[billing] Pacientes no disponibles:', p.error.message);
  } else {
    state.patients = p.data || [];
  }

  // Documentos es opcional: si la tabla no existe o el rol no tiene permiso,
  // la facturación sigue funcionando normalmente.
  state.docs = {};
  if (d.error) {
    console.warn('[billing] Documentos no disponibles (opcional):', d.error.message);
  } else {
    for (const doc of d.data || []) {
      if (!state.docs[doc.entity_id]) state.docs[doc.entity_id] = [];
      state.docs[doc.entity_id].push(doc);
    }
  }

  state.summary = s.error ? [] : (s.data || []);
  if (s.error) console.warn('[billing] Resumen no disponible:', s.error.message);

  const totalNeto = state.summary.reduce((sum, i) => sum + net(i), 0);
  const totalCash = state.summary.filter(i => i.method === 'efectivo').reduce((sum, i) => sum + net(i), 0);
  const totalCard = state.summary.filter(i => i.method === 'tarjeta').reduce((sum, i) => sum + net(i), 0);

  el.innerHTML = `
    <div class="bar">
      <h2>Facturación y Caja</h2>
      ${state.canManage ? '<button class="btn" id="btn-new-invoice">Nueva Factura</button>' : ''}
    </div>

    <p class="muted">
      Consulta y medicamentos se facturan por separado. Aquí solo se registran
      los conceptos efectivamente prestados o dispensados.
      ${!state.canManage ? '<br><b>Solo lectura:</b> la emisión de facturas es exclusiva de Caja y Administración.' : ''}
    </p>

    ${state.canManage ? `
    <div class="card">
      <h3>Resumen del día · ${esc(fmtDT(from))}</h3>
      <div class="scroll">
        <table>
          <thead><tr><th>Neto cobrado</th><th>Efectivo</th><th>Tarjeta</th></tr></thead>
          <tbody><tr>
            <td><strong>${money(totalNeto)}</strong></td>
            <td>${money(totalCash)}</td>
            <td>${money(totalCard)}</td>
          </tr></tbody>
        </table>
      </div>
      <p class="muted">Importes netos de reembolsos. Solo facturas pagadas de hoy.</p>
    </div>` : ''}

    <div class="card">
      <h3>Facturas</h3>
      <div class="bar" style="gap:.5rem;flex-wrap:wrap">
        <input id="f-search" type="search" placeholder="Buscar por número, nombre o DPI" style="flex:1;min-width:200px">
        <select id="f-status">
          <option value="todas">Todos los estados</option>
          <option value="pagada">Pagadas</option>
          <option value="pendiente">Pendientes</option>
          <option value="reembolsada">Con reembolso</option>
        </select>
      </div>
      <div id="invoice-table"><p class="muted">Sin resultados.</p></div>
      <p class="muted">Se muestran las últimas 200 facturas. Usa el buscador para localizar una.</p>
    </div>
  `;

  // ---------- Pintado de tabla (filtros locales) ----------
  const paint = () => {
    const q = ($('#f-search', el)?.value || '').trim().toLowerCase();
    const filter = $('#f-status', el)?.value || 'todas';

    const rows = state.invoices.filter(i => {
      const hay = `${i.number || ''} ${patientName(i)} ${i.patient?.dpi || ''}`.toLowerCase();
      const matchQ = !q || hay.includes(q);
      const matchS =
        filter === 'todas' ||
        (filter === 'reembolsada' ? num(i.refund_amount) > 0 : i.status === filter);
      return matchQ && matchS;
    }).map(i => {
      const canRefund = state.isAdmin && i.status === 'pagada' && net(i) > 0;
      return [
        esc(i.number || '—'),
        esc(patientName(i)),
        esc(fmtDT(i.created_at)),
        `<strong>${money(i.total)}</strong>`,
        esc(i.method || '—') + (i.card_last_four ? ` ····${esc(i.card_last_four)}` : ''),
        statusBadge(i),
        `${state.docs[i.id]?.length ? `<span class="muted">${state.docs[i.id].length} adj.</span> ` : ''}
         <button class="btn sm" data-view="${i.id}">Ver</button>
         ${canRefund ? `<button class="btn sm bad" data-refund="${i.id}">Reembolso</button>` : ''}`
      ];
    });

    $('#invoice-table', el).innerHTML = tbl(
      ['Número', 'Paciente', 'Fecha', 'Total', 'Método', 'Estado', 'Acciones'],
      rows
    );
  };

  // Asignación (no addEventListener): evita listeners duplicados al re-renderizar.
  el.oninput = e => { if (e.target.id === 'f-search') paint(); };
  el.onchange = e => { if (e.target.id === 'f-status') paint(); };

  el.onclick = e => {
    const b = e.target.closest('button');
    if (!b) return;

    if (b.id === 'btn-new-invoice') {
      openInvoiceModal(() => render(el));
      return;
    }

    if (b.dataset.view) {
      const inv = state.invoices.find(x => x.id === b.dataset.view);
      if (!inv) return toast('Factura no encontrada. Recarga la vista.', true);
      openDetail(inv);
      return;
    }

    if (b.dataset.refund) {
      openRefund(b.dataset.refund, () => render(el));
    }
  };

  paint();
}

// =====================================================================
// DETALLE DE FACTURA (modal)
// =====================================================================
function openDetail(inv) {
  const items = Array.isArray(inv.items) ? inv.items : [];
  const docs = state.docs[inv.id] || [];
  const refund = num(inv.refund_amount);

  const { el, close } = openModal(`Factura ${inv.number || ''}`, `
    <div style="display:grid;gap:.75rem">
      <div><b>Paciente:</b> ${esc(patientName(inv))}</div>
      ${inv.patient?.dpi ? `<div><b>DPI:</b> ${esc(inv.patient.dpi)}</div>` : ''}
      <div><b>Fecha:</b> ${esc(fmtDT(inv.created_at))}</div>
      <div><b>Estado:</b> ${statusBadge(inv)}</div>
      <div><b>Método:</b> ${esc(inv.method || 'Sin definir')}
        ${inv.card_last_four ? ` · terminada en <b>${esc(inv.card_last_four)}</b>` : ''}
      </div>

      ${refund > 0 ? `
      <div class="card" style="border-left:4px solid #c62828">
        <b>Reembolso registrado:</b> ${money(refund)}
        <p class="muted">${esc(inv.refund_reason || 'Sin motivo registrado')}</p>
        <p class="muted">Fecha: ${esc(fmtDT(inv.refunded_at))}</p>
      </div>` : ''}

      <div>
        <b>Conceptos</b>
        ${items.length ? `
        <div class="scroll">
          <table>
            <thead><tr><th>Concepto</th><th>Cant.</th><th>Precio</th><th>Subtotal</th></tr></thead>
            <tbody>
              ${items.map(it => `
                <tr>
                  <td>${esc(itemConcept(it))}</td>
                  <td>${esc(itemQty(it))}</td>
                  <td>${money(itemPrice(it))}</td>
                  <td>${money(itemSubtotal(it))}</td>
                </tr>`).join('')}
            </tbody>
            <tfoot>
              <tr><td colspan="3" style="text-align:right"><b>TOTAL</b></td>
                  <td><b>${money(inv.total)}</b></td></tr>
              ${refund > 0 ? `<tr><td colspan="3" style="text-align:right">Neto después de reembolso</td>
                  <td><b>${money(net(inv))}</b></td></tr>` : ''}
            </tfoot>
          </table>
        </div>` : '<p class="muted">Sin conceptos detallados.</p>'}
      </div>

      ${docs.length ? `
      <div>
        <b>Documentos asociados</b>
        <p class="muted">${docs.map(d => esc(d.filename)).join(' · ')}</p>
      </div>` : ''}

      <div class="bar" style="justify-content:flex-end;gap:.5rem">
        <button class="btn sm" id="d-csv">Descargar CSV</button>
        <button class="btn sm" id="d-close">Cerrar</button>
      </div>
    </div>
  `);

  // Sin onclick inline: compatible con cabeceras CSP estrictas.
  $('#d-close', el).onclick = close;

  $('#d-csv', el).onclick = async () => {
    const rows = [
      ['Centro Médico Premier'],
      ['Documento confidencial - uso interno'],
      ['Factura', inv.number || ''],
      ['Paciente', patientName(inv)],
      ['Generado por', S.profile?.full_name || S.user?.id || ''],
      ['Generado el', new Date().toISOString()],
      ['Factura ID', inv.id],
      [],
      ['Concepto', 'Cantidad', 'Precio', 'Subtotal'],
      ...items.map(it => [itemConcept(it), itemQty(it), itemPrice(it).toFixed(2), itemSubtotal(it).toFixed(2)]),
      [],
      ['TOTAL', '', '', num(inv.total).toFixed(2)],
      ['Reembolso', '', '', refund.toFixed(2)],
      ['NETO', '', '', net(inv).toFixed(2)]
    ];

    const csv = '\uFEFF' + rows.map(r => r.map(csvCell).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(inv.number || 'factura').replace(/[^a-zA-Z0-9_-]/g, '_')}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);

    // Trazabilidad: la exportación también se audita.
    try {
      await audit('export_invoice', 'invoices', inv.id, {
        format: 'csv', rows: items.length, total: String(inv.total)
      });
    } catch (_) { /* la descarga no debe fallar por auditoría */ }

    toast('CSV descargado con metadatos de auditoría');
  };
}

// =====================================================================
// NUEVA FACTURA (conceptos dinámicos, sin JSON)
// =====================================================================
function openInvoiceModal(onClose) {
  const fee = Number(CFG.CONSULTATION_FEE || 150);

  const { el, close } = openModal('Nueva Factura', `
    <form id="inv-form" style="display:grid;gap:.75rem" novalidate>
      <div>
        <label>Paciente</label>
        <select name="patient_id" required>
          <option value="">Seleccionar paciente…</option>
          ${state.patients.map(p => `
            <option value="${p.id}">${esc(p.first_name)} ${esc(p.last_name)} · DPI ${esc(p.dpi)}</option>
          `).join('')}
        </select>
      </div>

      <div id="pending-box" style="display:none">
        <div class="bar">
          <b>Conceptos pendientes</b>
          <button type="button" class="btn sm" id="btn-load">Cargar pendientes</button>
        </div>
        <div id="pending-list" class="muted">Presiona "Cargar pendientes".</div>
      </div>

      <div>
        <div class="bar">
          <b>Conceptos de la factura</b>
          <button type="button" class="btn sm" id="btn-add-line">+ Agregar línea</button>
        </div>
        <div id="lines"></div>
        <p style="text-align:right"><b>Total: <span id="inv-total">Q0.00</span></b></p>
      </div>

      <div>
        <label>Método de pago</label>
        <select name="method" required>
          <option value="efectivo">Efectivo</option>
          <option value="tarjeta">Tarjeta</option>
        </select>
      </div>

      <div id="card-box" style="display:none">
        <label>Últimos 4 dígitos (referencia)</label>
        <input name="card_last_four" inputmode="numeric" maxlength="4"
               pattern="[0-9]{4}" placeholder="1234" autocomplete="off">
        <p class="muted">Nunca ingreses el número completo de la tarjeta.</p>
      </div>

      <button class="btn" id="inv-submit" type="submit">Crear Factura</button>
    </form>
  `);

  let lines = [];
  let pending = null;
  let consultationIds = new Set();
  let prescriptionIds = new Set();
  let saving = false;

  const linesEl = $('#lines', el);
  const totalEl = $('#inv-total', el);
  const submitBtn = $('#inv-submit', el);

  const paintLines = () => {
    linesEl.innerHTML = lines.length
      ? lines.map((l, i) => `
        <div class="bar" style="gap:.4rem;flex-wrap:wrap">
          <input data-i="${i}" data-f="concept" value="${esc(l.concept)}"
                 placeholder="Concepto" style="flex:2;min-width:160px" required>
          <input data-i="${i}" data-f="qty" type="number" min="1" step="1"
                 value="${esc(l.qty)}" style="flex:.5;min-width:60px" required>
          <input data-i="${i}" data-f="price" type="number" min="0" step="0.01"
                 value="${esc(l.price)}" style="flex:.7;min-width:80px" required>
          <button type="button" class="btn sm bad" data-del="${i}">✕</button>
        </div>`).join('')
      : '<p class="muted">Sin conceptos. Carga pendientes o agrega una línea.</p>';

    totalEl.textContent = money(lines.reduce((s, l) => s + num(l.qty) * num(l.price), 0));
  };

  // Cambiar de paciente limpia todo: evita mezclar conceptos de dos personas.
  $('[name="patient_id"]', el).onchange = e => {
    pending = null;
    consultationIds = new Set();
    prescriptionIds = new Set();
    lines = [];
    $('#pending-box', el).style.display = e.target.value ? 'block' : 'none';
    $('#pending-list', el).innerHTML = 'Presiona "Cargar pendientes".';
    paintLines();
  };

  $('[name="method"]', el).onchange = e => {
    $('#card-box', el).style.display = e.target.value === 'tarjeta' ? 'block' : 'none';
  };

  $('#btn-add-line', el).onclick = () => {
    lines.push({ concept: '', qty: 1, price: 0 });
    paintLines();
  };

  linesEl.oninput = e => {
    const i = e.target.dataset.i, f = e.target.dataset.f;
    if (i === undefined || !f) return;
    lines[Number(i)][f] = f === 'concept' ? e.target.value : num(e.target.value);
    totalEl.textContent = money(lines.reduce((s, l) => s + num(l.qty) * num(l.price), 0));
  };

  linesEl.onclick = e => {
    const i = e.target.dataset.del;
    if (i === undefined) return;
    lines.splice(Number(i), 1);
    paintLines();
  };

  // Aprovecha la RPC existente: NO expone datos clínicos al cajero.
  $('#btn-load', el).onclick = async () => {
    const patientId = $('[name="patient_id"]', el).value;
    if (!patientId) return toast('Selecciona un paciente.', true);

    const list = $('#pending-list', el);
    list.innerHTML = '<p class="muted">Cargando…</p>';

    const { data, error } = await sb.rpc('billable_items', { p_patient: patientId });
    if (error) {
      list.innerHTML = '';
      return fail(error);
    }

    pending = data || { consultations: [], prescriptions: [] };
    const cs = pending.consultations || [];
    const ps = pending.prescriptions || [];

    if (!cs.length && !ps.length) {
      list.innerHTML = '<p class="muted">Este paciente no tiene conceptos pendientes.</p>';
      return;
    }

    list.innerHTML = `
      ${cs.length ? `<p><b>Consultas médicas</b></p>${cs.map(c => `
        <label class="bar" style="gap:.5rem">
          <input type="checkbox" data-kind="c" data-id="${c.id}">
          <span>${esc(c.doctor || 'Médico')} · ${esc(fmtDT(c.date))} · <b>${money(fee)}</b></span>
        </label>`).join('')}` : ''}

      ${ps.length ? `<p><b>Recetas dispensadas</b></p>${ps.map(r => `
        <label class="bar" style="gap:.5rem">
          <input type="checkbox" data-kind="p" data-id="${r.id}">
          <span>Receta · ${esc(fmtDT(r.date))}</span>
        </label>
        <p class="muted">${(r.items || []).map(it =>
          `${esc(it.name)} × ${esc(it.qty)} · ${money(num(it.qty) * num(it.price))}`
        ).join('<br>')}</p>`).join('')}` : ''}

      <button type="button" class="btn sm" id="btn-attach">Agregar seleccionados</button>
    `;

    $('#btn-attach', el).onclick = () => {
      const pickedC = $$('input[data-kind="c"]:checked', el);
      const pickedP = $$('input[data-kind="p"]:checked', el);

      if (!pickedC.length && !pickedP.length) return toast('Selecciona al menos un concepto.', true);

      // El schema actual permite UNA consulta por factura (consultation_id uuid).
      if (pickedC.length > 1) {
        pickedC.slice(1).forEach(cb => { cb.checked = false; });
        toast('Una consulta por factura. Emite facturas separadas para las demás.', true);
      }

      pickedC.forEach(cb => {
        const id = cb.dataset.id;
        if (consultationIds.has(id)) return;
        consultationIds.add(id);
        lines.push({ concept: `Consulta médica · ${fmtDT(cs.find(c => c.id === id)?.date)}`, qty: 1, price: fee });
      });

      pickedP.forEach(cb => {
        const id = cb.dataset.id;
        if (prescriptionIds.has(id)) return;
        const rx = ps.find(r => r.id === id);
        if (!rx) return;
        prescriptionIds.add(id);
        (rx.items || []).forEach(it => {
          lines.push({
            concept: `${it.name} · receta ${fmtDT(rx.date)}`,
            qty: itemQty(it),
            price: itemPrice(it)
          });
        });
      });

      paintLines();
      toast('Conceptos agregados. Revisa el total antes de crear.');
    };
  };

  $('#inv-form', el).onsubmit = async e => {
    e.preventDefault();
    if (saving) return;

    const fd = new FormData(e.target);
    const patientId = fd.get('patient_id');
    const method = fd.get('method');

    if (!patientId) return fail('Selecciona un paciente.');
    if (!lines.length) return fail('Agrega al menos un concepto.');

    const clean = lines.map(l => ({
      concept: String(l.concept || '').trim(),
      qty: Math.trunc(num(l.qty)),
      price: Math.round(num(l.price) * 100) / 100
    }));

    if (clean.some(l => !l.concept)) return fail('Cada concepto necesita un nombre.');
    if (clean.some(l => l.qty < 1 || l.price < 0 || !Number.isFinite(l.price))) {
      return fail('Revisa cantidades y precios de los conceptos.');
    }

    const total = Math.round(clean.reduce((s, l) => s + l.qty * l.price, 0) * 100) / 100;
    if (total <= 0) return fail('El total debe ser mayor que cero.');

    let card = null;
    if (method === 'tarjeta') {
      card = String(fd.get('card_last_four') || '').trim();
      if (!/^[0-9]{4}$/.test(card)) return fail('Ingresa exactamente los últimos 4 dígitos de la tarjeta.');
    }

    // Revalida en servidor que los conceptos siguen sin facturar.
    if (consultationIds.size || prescriptionIds.size) {
      const { data: fresh, error } = await sb.rpc('billable_items', { p_patient: patientId });
      if (error) return fail(error);

      const okC = new Set((fresh?.consultations || []).map(x => x.id));
      const okP = new Set((fresh?.prescriptions || []).map(x => x.id));

      const stale =
        [...consultationIds].some(id => !okC.has(id)) ||
        [...prescriptionIds].some(id => !okP.has(id));

      if (stale) return fail('Algunos conceptos ya fueron facturados. Vuelve a cargar los pendientes.');
    }

    saving = true;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Guardando…';

    try {
      const { error } = await sb.from('invoices').insert({
        patient_id: patientId,
        consultation_id: [...consultationIds][0] || null,
        prescription_ids: [...prescriptionIds],
        items: clean.map(l => ({
          concept: l.concept, qty: l.qty, price: l.price,
          subtotal: Math.round(l.qty * l.price * 100) / 100
        })),
        total,
        method,
        card_last_four: card,
        status: 'pagada',
        paid_at: new Date().toISOString()
        // created_by lo aporta auth.uid() por defecto en la BD.
      });

      if (error) throw error;

      toast('Factura creada correctamente');
      close();
      await onClose();
    } catch (err) {
      fail(err);
    } finally {
      saving = false;
      if (submitBtn.isConnected) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Crear Factura';
      }
    }
  };

  paintLines();
}

// =====================================================================
// REEMBOLSO DOCUMENTADO (solo admin)
// =====================================================================
function openRefund(id, onClose) {
  const inv = state.invoices.find(i => i.id === id);
  if (!inv) return toast('Factura no encontrada.', true);

  const remaining = net(inv);

  const { el, close } = openModal(`Reembolso · ${inv.number || ''}`, `
    <form id="refund-form" style="display:grid;gap:.75rem">
      <p class="muted">Total: <b>${money(inv.total)}</b> · Disponible a reembolsar: <b>${money(remaining)}</b></p>
      <p class="muted">Confirma que el dinero ya fue devuelto al paciente. Esta acción queda auditada.</p>

      <div>
        <label>Monto a reembolsar (acumulado)</label>
        <input name="amount" type="number" step="0.01" min="0.01" max="${remaining}"
               value="${remaining}" required>
      </div>
      <div>
        <label>Motivo del reembolso</label>
        <textarea name="reason" rows="3" required minlength="5"
                  placeholder="Describe el motivo de forma documentada"></textarea>
      </div>
      <button class="btn bad" type="submit">Confirmar reembolso</button>
    </form>
  `);

  $('#refund-form', el).onsubmit = async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const amount = Math.round(num(fd.get('amount')) * 100) / 100;
    const reason = String(fd.get('reason') || '').trim();

    if (!(amount > 0) || amount > remaining) {
      return fail(`El monto debe estar entre 0.01 y ${money(remaining)}.`);
    }
    if (reason.length < 5) return fail('Registra un motivo legible del reembolso.');

    const btn = $('button[type="submit"]', el);
    btn.disabled = true;

    try {
      const { error } = await sb.from('invoices').update({
        refund_amount: num(inv.refund_amount) + amount,
        refund_reason: reason,
        refunded_at: new Date().toISOString()
        // refunded_by lo firma el trigger stamp_refund con auth.uid().
      }).eq('id', id);

      if (error) throw error;

      toast('Reembolso registrado y auditado');
      close();
      await onClose();
    } catch (err) {
      fail(err);
      btn.disabled = false;
    }
  };
}