import { sb, $, $$, esc, isRole, toast, fail, tbl, money, fmtDT, S, openModal } from './core.js';

export async function render(el) {
  const isCashier = isRole('admin', 'cashier');
  
  // Cargar datos en paralelo
  const [{ data: invoices }, { data: patients }] = await Promise.all([
    sb.from('invoices').select(`
      *,
      patient:patients(first_name, last_name, dpi),
      documents:id,filename,file_type
    `).order('created_at', { ascending: false }).limit(100),
    sb.from('patients').select('id, first_name, last_name, dpi').order('last_name')
  ]);

  el.innerHTML = `
    <div class="bar">
      <h2>Facturación y Caja</h2>
      ${isCashier ? `<button class="btn" id="btn-new-invoice">Nueva Factura</button>` : ''}
    </div>

    <!-- Alerta de Seguridad PCI DSS -->
    <div class="card" style="background:#e7f3ff; border-left:4px solid #2196F3; margin-bottom:1rem">
      <h3 style="color:#0d47a1">🔒 Seguridad de Datos de Pago</h3>
      <p class="muted">Este sistema cumple con PCI DSS. Nunca almacenamos números completos de tarjetas de crédito. Solo se registran los últimos 4 dígitos para referencia.</p>
    </div>

    <!-- Facturas Recientes -->
    <div class="card">
      <h3>Facturas Recientes</h3>
      ${tbl(['Número', 'Paciente', 'Fecha', 'Total', 'Método', 'Estado', 'Documentos', 'Acciones'], (invoices || []).map(inv => [
        esc(inv.number),
        esc(`${inv.patient?.first_name} ${inv.patient?.last_name}`),
        esc(fmtDT(inv.created_at)),
        money(inv.total),
        esc(inv.method || '-'),
        `<span class="badge ${inv.status}">${esc(inv.status)}</span>`,
        inv.documents?.length > 0 ? `<span class="badge">${inv.documents.length} adjuntos</span>` : '-',
        isCashier ? `
          <button class="btn sm" data-view="${inv.id}">Ver</button>
          ${inv.status === 'pagada' ? `<button class="btn sm bad" data-refund="${inv.id}">Reembolso</button>` : ''}
        ` : '<span class="muted">Solo caja</span>'
      ]))}
    </div>

    ${isCashier ? `
    <!-- Resumen de Caja -->
    <div class="card" style="margin-top:1rem">
      <h3>Resumen del Día</h3>
      <div style="display:grid; grid-template-columns: repeat(3, 1fr); gap:1rem; text-align:center;">
        <div>
          <div class="muted">Total Facturado</div>
          <div style="font-size:1.5rem; font-weight:bold;">${money((invoices || []).filter(i => i.status === 'pagada' && i.created_at?.startsWith(new Date().toISOString().split('T')[0])).reduce((sum, i) => sum + Number(i.total), 0))}</div>
        </div>
        <div>
          <div class="muted">Efectivo</div>
          <div style="font-size:1.5rem; font-weight:bold; color:#4caf50;">${money((invoices || []).filter(i => i.status === 'pagada' && i.method === 'efectivo' && i.created_at?.startsWith(new Date().toISOString().split('T')[0])).reduce((sum, i) => sum + Number(i.total), 0))}</div>
        </div>
        <div>
          <div class="muted">Tarjeta</div>
          <div style="font-size:1.5rem; font-weight:bold; color:#2196F3;">${money((invoices || []).filter(i => i.status === 'pagada' && i.method === 'tarjeta' && i.created_at?.startsWith(new Date().toISOString().split('T')[0])).reduce((sum, i) => sum + Number(i.total), 0))}</div>
        </div>
      </div>
    </div>
    ` : ''}
  `;

  // Event listeners
  el.addEventListener('click', async (e) => {
    // Nueva factura
    if (e.target.id === 'btn-new-invoice') {
      openInvoiceModal(patients || [], render.bind(null, el));
      return;
    }

    // Ver factura
    const viewBtn = e.target.closest('[data-view]');
    if (viewBtn) {
      const id = viewBtn.dataset.view;
      const invoice = invoices.find(i => i.id === id);
      if (invoice) openInvoiceDetailModal(invoice);
      return;
    }

    // Reembolso
    const refundBtn = e.target.closest('[data-refund]');
    if (refundBtn) {
      const id = refundBtn.dataset.refund;
      openRefundModal(id, render.bind(null, el));
      return;
    }
  });
}

function openInvoiceModal(patients, onClose) {
  const { el, close } = openModal('Nueva Factura', `
    <form id="invoice-form" style="display:grid; gap:0.75rem;">
      <div>
        <label>Paciente</label>
        <select name="patient_id" required style="width:100%">
          <option value="">Seleccionar paciente...</option>
          ${patients.map(p => `<option value="${p.id}">${esc(p.first_name)} ${esc(p.last_name)} - DPI: ${esc(p.dpi)}</option>`).join('')}
        </select>
      </div>

      <!-- Sección de conceptos facturables automáticos -->
      <div id="billable-section" style="display:none;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.5rem;">
          <h4 style="margin:0;">Conceptos pendientes de facturar</h4>
          <button type="button" class="btn sm" id="btn-load-billable">Cargar pendientes</button>
        </div>
        <div id="billable-list" class="muted">Seleccione un paciente y presione "Cargar pendientes"</div>
      </div>

      <!-- Líneas de conceptos dinámicas -->
      <div>
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.5rem;">
          <h4 style="margin:0;">Conceptos de la factura</h4>
          <button type="button" class="btn sm" id="btn-add-line">+ Agregar línea</button>
        </div>
        <div id="lines-container"></div>
        <div style="display:flex; justify-content:flex-end; margin-top:0.5rem; font-size:1.2rem;">
          <strong>Total: <span id="invoice-total">Q0.00</span></strong>
        </div>
      </div>

      <div>
        <label>Método de Pago</label>
        <select name="method" required style="width:100%">
          <option value="efectivo">Efectivo</option>
          <option value="tarjeta">Tarjeta</option>
        </select>
      </div>
      <div id="card-fields" style="display:none;">
        <label>Últimos 4 dígitos de tarjeta (solo referencia)</label>
        <input type="text" name="card_last_four" maxlength="4" pattern="[0-9]{4}" placeholder="1234" style="width:100%">
        <small class="muted">Por seguridad (PCI DSS), solo registramos los últimos 4 dígitos</small>
      </div>
      <button type="submit" class="btn">Crear Factura</button>
    </form>
  `);

  // --- Estado interno ---
  let lines = []; // [{concept, qty, price}]
  let billableData = null; // Respuesta de billable_items()
  let consultationIds = []; // IDs de consultas a facturar
  let prescriptionIds = []; // IDs de recetas a facturar

  const linesContainer = $('#lines-container', el);
  const totalSpan = $('#invoice-total', el);
  const billableSection = $('#billable-section', el);
  const billableList = $('#billable-list', el);

  // --- Renderizar líneas ---
  function renderLines() {
    if (lines.length === 0) {
      linesContainer.innerHTML = '<p class="muted">Sin conceptos. Agregue una línea o cargue pendientes.</p>';
    } else {
      linesContainer.innerHTML = lines.map((line, idx) => `
        <div style="display:grid; grid-template-columns: 3fr 1fr 1fr auto; gap:0.5rem; margin-bottom:0.5rem; align-items:center;">
          <input type="text" value="${esc(line.concept)}" data-idx="${idx}" data-field="concept" placeholder="Concepto" style="width:100%" required>
          <input type="number" value="${line.qty}" data-idx="${idx}" data-field="qty" min="1" step="1" style="width:100%" required>
          <input type="number" value="${line.price}" data-idx="${idx}" data-field="price" min="0" step="0.01" style="width:100%" required>
          <button type="button" class="btn sm bad" data-remove="${idx}">✕</button>
        </div>
      `).join('');
    }
    updateTotal();
  }

  function updateTotal() {
    const total = lines.reduce((sum, l) => sum + (Number(l.qty) * Number(l.price)), 0);
    totalSpan.textContent = 'Q' + total.toFixed(2);
  }

  // --- Eventos ---
  
  // Mostrar sección de facturables al elegir paciente
  $('[name="patient_id"]', el).onchange = (e) => {
    billableSection.style.display = e.target.value ? 'block' : 'none';
    billableList.innerHTML = '<span class="muted">Presione "Cargar pendientes"</span>';
    billableData = null;
  };

  // Cargar conceptos pendientes usando la RPC billable_items
  $('#btn-load-billable', el).onclick = async () => {
    const patientId = $('[name="patient_id"]', el).value;
    if (!patientId) return;

    billableList.innerHTML = '<span class="muted">Cargando...</span>';
    const { data, error } = await sb.rpc('billable_items', { p_patient: patientId });
    if (error) {
      fail(error);
      billableList.innerHTML = '<span class="muted">Error al cargar</span>';
      return;
    }

    billableData = data;
    const consultations = data?.consultations || [];
    const prescriptions = data?.prescriptions || [];

    if (consultations.length === 0 && prescriptions.length === 0) {
      billableList.innerHTML = '<span class="muted">Este paciente no tiene conceptos pendientes de facturar.</span>';
      return;
    }

    const consultationFee = window.APP_CONFIG?.CONSULTATION_FEE || 150;

    let html = '<div style="display:grid; gap:0.5rem;">';
    if (consultations.length > 0) {
      html += `<div><strong>Consultas médicas:</strong></div>`;
      html += consultations.map((c) => `
        <label style="display:flex; gap:0.5rem; align-items:center; padding:0.25rem; background:#f5f5f5; border-radius:4px;">
          <input type="checkbox" data-type="consultation" data-id="${c.id}" data-price="${consultationFee}" data-name="Consulta médica - ${esc(c.doctor)} (${esc(c.date?.split('T')[0] || '')})">
          <span>${esc(c.doctor)} — ${esc(new Date(c.date).toLocaleDateString('es-GT'))} — <strong>Q${Number(consultationFee).toFixed(2)}</strong></span>
        </label>
      `).join('');
    }
    if (prescriptions.length > 0) {
      html += `<div style="margin-top:0.5rem;"><strong>Recetas dispensadas:</strong></div>`;
      html += prescriptions.map((r) => `
        <div style="padding:0.25rem; background:#f5f5f5; border-radius:4px;">
          <label style="display:flex; gap:0.5rem; align-items:center;">
            <input type="checkbox" data-type="prescription" data-id="${r.id}">
            <span>Receta ${esc(new Date(r.date).toLocaleDateString('es-GT'))}</span>
          </label>
          <div style="margin-left:1.5rem; font-size:0.9em;">
            ${(r.items || []).map(it => `${esc(it.name)} x${it.qty} — Q${(Number(it.qty) * Number(it.price)).toFixed(2)}`).join('<br>')}
          </div>
        </div>
      `).join('');
    }
    html += `<button type="button" class="btn sm" id="btn-add-selected" style="margin-top:0.5rem;">Agregar seleccionados a la factura</button>`;
    html += '</div>';
    billableList.innerHTML = html;

    // Evento para agregar seleccionados
    $('#btn-add-selected', el).onclick = () => {
      const selectedConsultations = $$('input[data-type="consultation"]:checked', el);
      const selectedPrescriptions = $$('input[data-type="prescription"]:checked', el);

      selectedConsultations.forEach(cb => {
        lines.push({
          concept: cb.dataset.name,
          qty: 1,
          price: Number(cb.dataset.price)
        });
        consultationIds.push(cb.dataset.id);
      });

      selectedPrescriptions.forEach(cb => {
        const rx = billableData.prescriptions.find(p => p.id === cb.dataset.id);
        if (rx) {
          (rx.items || []).forEach(it => {
            lines.push({
              concept: `${it.name} (${rx.date?.split('T')[0] || ''})`,
              qty: it.qty,
              price: Number(it.price)
            });
          });
          prescriptionIds.push(rx.id);
        }
      });

      renderLines();
      toast(`${selectedConsultations.length + selectedPrescriptions.length} concepto(s) agregado(s)`);
    };
  };

  // Agregar línea manual
  $('#btn-add-line', el).onclick = () => {
    lines.push({ concept: '', qty: 1, price: 0 });
    renderLines();
  };

  // Editar/remover líneas (delegación)
  linesContainer.addEventListener('input', (e) => {
    const idx = e.target.dataset.idx;
    const field = e.target.dataset.field;
    if (idx !== undefined && field) {
      lines[idx][field] = field === 'concept' ? e.target.value : Number(e.target.value);
      updateTotal();
    }
  });
  linesContainer.addEventListener('click', (e) => {
    const idx = e.target.dataset.remove;
    if (idx !== undefined) {
      lines.splice(Number(idx), 1);
      renderLines();
    }
  });

  // Mostrar/ocultar campos de tarjeta
  $('[name="method"]', el).onchange = (e) => {
    $('#card-fields', el).style.display = e.target.value === 'tarjeta' ? 'block' : 'none';
  };

  // Submit
  $('#invoice-form', el).onsubmit = async (e) => {
    e.preventDefault();
    
    if (lines.length === 0) {
      fail('Debe agregar al menos un concepto a la factura');
      return;
    }

    const formData = new FormData(e.target);
    const method = formData.get('method');
    const total = lines.reduce((sum, l) => sum + (Number(l.qty) * Number(l.price)), 0);

    let payload = {
      patient_id: formData.get('patient_id'),
      consultation_id: consultationIds[0] || null, // Solo una consulta por factura (según schema)
      prescription_ids: prescriptionIds,
      items: lines.map(l => ({ concept: l.concept, qty: l.qty, price: l.price, subtotal: l.qty * l.price })),
      total: total,
      method: method,
      status: 'pagada',
      paid_at: new Date().toISOString()
    };

    if (method === 'tarjeta') {
      const cardLastFour = formData.get('card_last_four');
      if (!cardLastFour || !/^[0-9]{4}$/.test(cardLastFour)) {
        fail('Debe ingresar los últimos 4 dígitos de la tarjeta');
        return;
      }
      payload.card_last_four = cardLastFour;
    }

    const { error } = await sb.from('invoices').insert(payload);
    if (error) {
      fail(error);
    } else {
      toast('Factura creada exitosamente');
      close();
      onClose();
    }
  };

  // Render inicial
  renderLines();
}

function openInvoiceDetailModal(invoice) {
  const { el, close } = openModal(`Factura ${invoice.number}`, `
    <div style="display:grid; gap:0.75rem;">
      <div><strong>Paciente:</strong> ${esc(invoice.patient?.first_name)} ${esc(invoice.patient?.last_name)}</div>
      <div><strong>DPI:</strong> ${esc(invoice.patient?.dpi)}</div>
      <div><strong>Fecha:</strong> ${esc(fmtDT(invoice.created_at))}</div>
      <div><strong>Total:</strong> ${money(invoice.total)}</div>
      <div><strong>Método:</strong> ${esc(invoice.method || '-')}</div>
      ${invoice.card_last_four ? `<div><strong>Tarjeta:</strong> ****-****-****-${esc(invoice.card_last_four)}</div>` : ''}
      <div><strong>Estado:</strong> <span class="badge ${invoice.status}">${esc(invoice.status)}</span></div>
      ${invoice.refund_amount > 0 ? `
        <div style="background:#ffebee; padding:0.5rem; border-radius:4px; border-left:4px solid #f44336;">
          <strong>Reembolso:</strong> ${money(invoice.refund_amount)}<br>
          <strong>Razón:</strong> ${esc(invoice.refund_reason || '-')}<br>
          <strong>Fecha:</strong> ${esc(fmtDT(invoice.refunded_at))}
        </div>
      ` : ''}
      <div>
        <strong>Conceptos:</strong>
        <table style="width:100%; border-collapse:collapse; margin-top:0.5rem;">
          <thead>
            <tr style="background:#f5f5f5;">
              <th style="text-align:left; padding:0.5rem;">Concepto</th>
              <th style="text-align:right; padding:0.5rem;">Cant.</th>
              <th style="text-align:right; padding:0.5rem;">Precio</th>
              <th style="text-align:right; padding:0.5rem;">Subtotal</th>
            </tr>
          </thead>
          <tbody>
            ${(invoice.items || []).map(it => `
              <tr>
                <td style="padding:0.5rem; border-top:1px solid #e0e0e0;">${esc(it.concept || it.name || '-')}</td>
                <td style="padding:0.5rem; border-top:1px solid #e0e0e0; text-align:right;">${esc(it.qty || 1)}</td>
                <td style="padding:0.5rem; border-top:1px solid #e0e0e0; text-align:right;">${money(it.price)}</td>
                <td style="padding:0.5rem; border-top:1px solid #e0e0e0; text-align:right;">${money(it.subtotal || (it.qty || 1) * (it.price || 0))}</td>
              </tr>
            `).join('')}
          </tbody>
          <tfoot>
            <tr style="background:#f5f5f5; font-weight:bold;">
              <td colspan="3" style="padding:0.5rem; text-align:right;">TOTAL:</td>
              <td style="padding:0.5rem; text-align:right;">${money(invoice.total)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <button class="btn" onclick="this.closest('.overlay').remove()">Cerrar</button>
    </div>
  `);
}

function openRefundModal(invoiceId, onClose) {
  const { el, close } = openModal('Procesar Reembolso', `
    <form id="refund-form" style="display:grid; gap:0.75rem;">
      <div style="background:#fff3cd; padding:0.75rem; border-radius:4px; border-left:4px solid #ffc107;">
        <strong>⚠️ Atención:</strong> Esta acción registrará un reembolso en el sistema. Asegúrese de devolver el dinero al paciente antes de confirmar.
      </div>
      <div>
        <label>Monto del Reembolso (Q)</label>
        <input type="number" name="refund_amount" step="0.01" min="0" required style="width:100%">
      </div>
      <div>
        <label>Razón del Reembolso</label>
        <textarea name="refund_reason" rows="3" required placeholder="Ej: Error en diagnóstico, servicio no prestado, etc." style="width:100%"></textarea>
      </div>
      <button type="submit" class="btn bad">Confirmar Reembolso</button>
    </form>
  `);

  $('#refund-form', el).onsubmit = async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    
    const { error } = await sb.from('invoices').update({
      refund_amount: parseFloat(formData.get('refund_amount')),
      refund_reason: formData.get('refund_reason'),
      refunded_at: new Date().toISOString(),
      refunded_by: S.user.id
    }).eq('id', invoiceId);

    if (error) {
      fail(error);
    } else {
      toast('Reembolso procesado exitosamente');
      close();
      onClose();
    }
  };
}