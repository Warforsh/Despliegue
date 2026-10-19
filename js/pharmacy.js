import { sb, $, $$, esc, isRole, toast, fail, tbl, money, fmtD, fmtDT, S } from './core.js';

export async function render(el) {
  const isPharmacist = isRole('admin', 'pharmacist');
  
  // Cargar datos en paralelo
  const [{ data: rx }, { data: products }, { data: batches }, { data: movements }] = await Promise.all([
    sb.from('prescriptions').select(`
      *,
      patient:patients(first_name, last_name, dpi),
      doctor:profiles(full_name),
      prescription_items(*, product:products(name))
    `).order('created_at', { ascending: false }).limit(50),
    sb.from('products').select('*').order('name'),
    isPharmacist ? sb.from('product_batches').select('*, products(name)').order('expiration_date').limit(100) : { data: [] },
    isPharmacist ? sb.from('inventory_movements').select('*, products(name), profiles(full_name)').order('performed_at', { ascending: false }).limit(50) : { data: [] }
  ]);

  // Alertas de vencimiento próximo (30 días)
  const expiringSoon = (batches?.data || []).filter(b => {
    const daysUntilExpiry = Math.ceil((new Date(b.expiration_date) - new Date()) / (1000 * 60 * 60 * 24));
    return daysUntilExpiry <= 30 && daysUntilExpiry >= 0 && b.remaining_quantity > 0;
  });

  el.innerHTML = `
    <div class="bar">
      <h2>Farmacia e Inventario</h2>
      ${isPharmacist ? `<button class="btn" id="btn-new-receiving">Recibir Orden de Compra</button>` : ''}
    </div>

    ${expiringSoon.length > 0 ? `
    <div class="card" style="background:#fff3cd; border-left:4px solid #ffc107; margin-bottom:1rem">
      <h3 style="color:#856404">⚠️ Alerta: Productos próximos a vencer</h3>
      ${tbl(['Producto', 'Lote', 'Vencimiento', 'Cantidad Restante'], expiringSoon.map(b => [
        esc(b.products?.name || 'N/A'),
        esc(b.batch_number),
        `<strong>${fmtD(b.expiration_date)}</strong>`,
        esc(b.remaining_quantity)
      ]))}
    </div>` : ''}

    <!-- Recetas Pendientes -->
    <div class="card">
      <h3>Recetas Pendientes de Dispensación</h3>
      ${tbl(['Paciente', 'Médico', 'Fecha', 'Items', 'Estado', 'Acción'], (rx || []).filter(r => r.status === 'pendiente').map(r => [
        esc(`${r.patient?.first_name} ${r.patient?.last_name}`),
        esc(r.doctor?.full_name || 'N/A'),
        esc(fmtDT(r.created_at)),
        esc(r.prescription_items?.length || 0),
        `<span class="badge pendiente">${esc(r.status)}</span>`,
        isPharmacist ? `<button class="btn sm" data-dispense="${r.id}">Dispensar</button>` : '<span class="muted">Solo farmacia</span>'
      ]))}
    </div>

    ${isPharmacist ? `
    <!-- Gestión de Lotes -->
    <div class="card" style="margin-top:1rem">
      <h3>Lotes de Productos</h3>
      <button class="btn sm" id="btn-new-batch" style="margin-bottom:0.5rem">+ Nuevo Lote</button>
      ${tbl(['Producto', 'Lote', 'Vencimiento', 'Cantidad Total', 'Restante', 'Proveedor'], (batches?.data || []).map(b => [
        esc(b.products?.name || 'N/A'),
        esc(b.batch_number),
        fmtD(b.expiration_date),
        esc(b.quantity),
        `<strong>${esc(b.remaining_quantity)}</strong>`,
        esc(b.supplier_id ? 'Con proveedor' : '-')
      ]))}
    </div>

    <!-- Movimientos de Inventario -->
    <div class="card" style="margin-top:1rem">
      <h3>Movimientos de Inventario (Trazabilidad)</h3>
      ${tbl(['Fecha', 'Producto', 'Tipo', 'Cantidad', 'Razón', 'Usuario'], (movements?.data || []).map(m => [
        esc(fmtDT(m.performed_at)),
        esc(m.products?.name || 'N/A'),
        `<span class="badge ${m.movement_type === 'entrada' ? 'confirmada' : 'cancelada'}">${esc(m.movement_type)}</span>`,
        esc(m.quantity),
        esc(m.reason),
        esc(m.profiles?.full_name || 'Sistema')
      ]))}
    </div>
    ` : ''}
  `;

  // Event listeners
  el.addEventListener('click', async (e) => {
    // Dispensar receta
    const dispenseBtn = e.target.closest('[data-dispense]');
    if (dispenseBtn) {
      const id = dispenseBtn.dataset.dispense;
      if (!confirm('¿Confirmar dispensación de esta receta?')) return;
      
      const { error } = await sb.rpc('dispense_prescription', { p_id: id });
      if (error) fail(error);
      else {
        toast('Receta dispensada exitosamente');
        render(el);
      }
      return;
    }

    // Nuevo lote
    if (e.target.id === 'btn-new-batch') {
      openBatchModal(products?.data || [], render.bind(null, el));
      return;
    }

    // Recibir orden de compra
    if (e.target.id === 'btn-new-receiving') {
      toast('Funcionalidad de Órdenes de Compra disponible en próximo módulo');
    }
  });
}

function openBatchModal(products, onClose) {
  const { el, close } = openModal('Nuevo Lote de Producto', `
    <form id="batch-form" style="display:grid; gap:0.75rem;">
      <div>
        <label>Producto</label>
        <select name="product_id" required style="width:100%">
          <option value="">Seleccionar...</option>
          ${products.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}
        </select>
      </div>
      <div>
        <label>Número de Lote</label>
        <input type="text" name="batch_number" required placeholder="LOT-2026-001" style="width:100%">
      </div>
      <div>
        <label>Fecha de Vencimiento</label>
        <input type="date" name="expiration_date" required style="width:100%">
      </div>
      <div>
        <label>Cantidad</label>
        <input type="number" name="quantity" required min="1" style="width:100%">
      </div>
      <div>
        <label>Precio de Compra (Q)</label>
        <input type="number" name="purchase_price" step="0.01" min="0" value="0" style="width:100%">
      </div>
      <button type="submit" class="btn">Crear Lote</button>
    </form>
  `);

  $('#batch-form', el).onsubmit = async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const payload = {
      product_id: formData.get('product_id'),
      batch_number: formData.get('batch_number'),
      expiration_date: formData.get('expiration_date'),
      quantity: parseInt(formData.get('quantity')),
      remaining_quantity: parseInt(formData.get('quantity')),
      purchase_price: parseFloat(formData.get('purchase_price') || 0)
    };

    const { error } = await sb.from('product_batches').insert(payload);
    if (error) {
      fail(error);
    } else {
      // Actualizar stock total del producto
      await sb.from('products').update({ 
        stock: sb.rpc('increment_stock', { product_id: payload.product_id, amount: payload.quantity })
      }).eq('id', payload.product_id);
      
      // Registrar movimiento
      await sb.from('inventory_movements').insert({
        product_id: payload.product_id,
        movement_type: 'entrada',
        quantity: payload.quantity,
        reason: 'Creación manual de lote'
      });

      toast('Lote creado exitosamente');
      close();
      onClose();
    }
  };
}
