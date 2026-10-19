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
      <div>
        <label>Conceptos (JSON)</label>
        <textarea name="items" rows="4" placeholder='[{"concept":"Consulta médica","qty":1,"price":150}]' required style="width:100%"></textarea>
      </div>
      <div>
        <label>Total (Q)</label>
        <input type="number" name="total" step="0.01" min="0" required style="width:100%">
      </div>
      <div>
        <label>Método de Pago</label>
        <select name="method" required style="width:100%">
          <option value="efectivo">Efectivo</option>
          <option value="tarjeta">Tarjeta</option>
        </select>
      </div>
      <div id="card-fields" style="display:none;">
        <label>Últimos 4 dígitos de tarjeta (solo para referencia)</label>
        <input type="text" name="card_last_four" maxlength="4" pattern="[0-9]{4}" placeholder="1234" style="width:100%">
        <small class="muted">Por seguridad, solo registramos los últimos 4 dígitos</small>
      </div>
      <button type="submit" class="btn">Crear Factura</button>
    </form>
  `);

  // Mostrar/ocultar campos de tarjeta
  const methodSelect = $('[name="method"]', el);
  const cardFields = $('#card-fields', el);
  methodSelect.onchange = () => {
    cardFields.style.display = methodSelect.value === 'tarjeta' ? 'block' : 'none';
  };

  $('#invoice-form', el).onsubmit = async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const method = formData.get('method');
    
    let payload = {
      patient_id: formData.get('patient_id'),
      items: JSON.parse(formData.get('items')),
      total: parseFloat(formData.get('total')),
      method: method,
      status: 'pagada',
      paid_at: new Date().toISOString()
    };

    // Solo agregar datos de tarjeta si el método es tarjeta
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
      <div>
        <strong>Conceptos:</strong>
        <pre style="background:#f5f5f5; padding:0.5rem; border-radius:4px; overflow-x:auto;">${esc(JSON.stringify(invoice.items, null, 2))}</pre>
      </div>
      <button class="btn" onclick="this.closest('.overlay').remove()">Cerrar</button>
    </div>
  `);
}

function openRefundModal(invoiceId, onClose) {
  const { el, close } = openModal('Procesar Reembolso', `
    <form id="refund-form" style="display:grid; gap:0.75rem;">
      <div>
        <label>Monto del Reembolso (Q)</label>
        <input type="number" name="refund_amount" step="0.01" min="0" required style="width:100%">
      </div>
      <div>
        <label>Razón del Reembolso</label>
        <textarea name="refund_reason" rows="3" required style="width:100%"></textarea>
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
