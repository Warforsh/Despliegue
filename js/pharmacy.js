import { sb, $, $$, esc, isRole, toast, fail, tbl, money, fmtD, fmtDT, S, openModal } from './core.js';

export async function render(el) {
  const isPharmacist = isRole('admin', 'pharmacist');
  
  console.log('[pharmacy] Rol actual:', S.profile?.role, '| isPharmacist:', isPharmacist);
  
  // Cargar datos en paralelo (sin el join problemático de profiles en inventory_movements)
  const [rxRes, productsRes, batchesRes, movementsRes, suppliersRes, ordersRes, profilesRes] = await Promise.all([
    sb.from('prescriptions').select(`
      *,
      patient:patients(first_name, last_name, dpi),
      doctor:profiles(full_name),
      prescription_items(*, product:products(name))
    `).order('created_at', { ascending: false }).limit(50),
    sb.from('products').select('*').order('name'),
    isPharmacist ? sb.from('product_batches').select('*, products(name)').order('expiration_date').limit(100) : Promise.resolve({ data: [], error: null }),
    isPharmacist ? sb.from('inventory_movements').select('*, products(name)').order('performed_at', { ascending: false }).limit(50) : Promise.resolve({ data: [], error: null }),
    isPharmacist ? sb.from('suppliers').select('*').eq('is_active', true).order('name') : Promise.resolve({ data: [], error: null }),
    isPharmacist ? sb.from('purchase_orders').select('*, suppliers(name)').order('created_at', { ascending: false }).limit(50) : Promise.resolve({ data: [], error: null }),
    isPharmacist ? sb.from('profiles').select('id, full_name') : Promise.resolve({ data: [], error: null })
  ]);

  if (movementsRes.error) console.error('[pharmacy] Error movimientos:', movementsRes.error);
  if (suppliersRes.error) console.error('[pharmacy] Error proveedores:', suppliersRes.error);

  const rx = rxRes.data;
  const products = productsRes.data;
  const batches = batchesRes.data || [];
  const movements = movementsRes.data || [];
  const suppliers = suppliersRes.data || [];
  const orders = ordersRes.data || [];
  const userNames = Object.fromEntries((profilesRes.data || []).map(u => [u.id, u.full_name]));

  console.log('[pharmacy] Proveedores cargados:', suppliers.length);

  // Alertas de vencimiento próximo (30 días)
  const expiringSoon = batches.filter(b => {
    const daysUntilExpiry = Math.ceil((new Date(b.expiration_date) - new Date()) / (1000 * 60 * 60 * 24));
    return daysUntilExpiry <= 30 && daysUntilExpiry >= 0 && b.remaining_quantity > 0;
  });

  el.innerHTML = `
    <div class="bar">
      <h2>Farmacia e Inventario</h2>
      ${isPharmacist ? `
        <button class="btn" id="btn-new-order">Nueva Orden de Compra</button>
        <button class="btn" id="btn-manage-suppliers">Gestionar Proveedores</button>
      ` : ''}
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
    <!-- Proveedores Activos (NUEVA SECCIÓN VISIBLE) -->
    <div class="card" style="margin-top:1rem">
      <h3>Proveedores Activos</h3>
      <p class="muted">Total: ${suppliers.length} proveedor(es)</p>
      ${suppliers.length > 0 ? tbl(['Nombre', 'Contacto', 'Teléfono', 'Email', 'NIT'], suppliers.map(s => [
        esc(s.name),
        esc(s.contact_name || '-'),
        esc(s.phone || '-'),
        esc(s.email || '-'),
        esc(s.tax_id || '-')
      ])) : '<p class="muted">No hay proveedores activos. Usa "Gestionar Proveedores" para agregar uno.</p>'}
    </div>

    <!-- Órdenes de Compra -->
    <div class="card" style="margin-top:1rem">
      <h3>Órdenes de Compra</h3>
      ${orders.length > 0 ? tbl(['Número', 'Proveedor', 'Fecha', 'Total', 'Estado', 'Acción'], orders.map(o => [
        esc(o.order_number),
        esc(o.suppliers?.name || 'N/A'),
        esc(fmtDT(o.created_at)),
        money(o.total),
        `<span class="badge ${o.status === 'recibida' ? 'atendida' : o.status === 'cancelada' ? 'cancelada' : 'pendiente'}">${esc(o.status)}</span>`,
        o.status === 'pendiente' ? `
          <button class="btn sm" data-receive="${o.id}">Recibir</button>
          <button class="btn sm bad" data-cancel-order="${o.id}">Cancelar</button>
        ` : '<span class="muted">-</span>'
      ])) : '<p class="muted">No hay órdenes de compra registradas.</p>'}
    </div>

    <!-- Gestión de Lotes -->
    <div class="card" style="margin-top:1rem">
      <h3>Lotes de Productos</h3>
      <button class="btn sm" id="btn-new-batch" style="margin-bottom:0.5rem">+ Nuevo Lote Manual</button>
      ${batches.length > 0 ? tbl(['Producto', 'Lote', 'Vencimiento', 'Cantidad Total', 'Restante'], batches.map(b => [
        esc(b.products?.name || 'N/A'),
        esc(b.batch_number),
        fmtD(b.expiration_date),
        esc(b.quantity),
        `<strong>${esc(b.remaining_quantity)}</strong>`
      ])) : '<p class="muted">No hay lotes registrados.</p>'}
    </div>

    <!-- Movimientos de Inventario -->
    <div class="card" style="margin-top:1rem">
      <h3>Movimientos de Inventario (Trazabilidad)</h3>
      ${movements.length > 0 ? tbl(['Fecha', 'Producto', 'Tipo', 'Cantidad', 'Razón', 'Usuario'], movements.map(m => [
        esc(fmtDT(m.performed_at)),
        esc(m.products?.name || 'N/A'),
        `<span class="badge ${m.movement_type === 'entrada' ? 'confirmada' : 'cancelada'}">${esc(m.movement_type)}</span>`,
        esc(m.quantity),
        esc(m.reason),
        esc(userNames[m.performed_by] || 'Sistema')
      ])) : '<p class="muted">No hay movimientos registrados.</p>'}
    </div>
    ` : ''}
  `;

  // Event listeners
  el.addEventListener('click', async (e) => {
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

    if (e.target.id === 'btn-new-batch') {
      openBatchModal(products || [], render.bind(null, el));
      return;
    }

    if (e.target.id === 'btn-new-order') {
      openOrderModal(products || [], suppliers, render.bind(null, el));
      return;
    }

    if (e.target.id === 'btn-manage-suppliers') {
      openSuppliersModal(suppliers, render.bind(null, el));
      return;
    }

    const receiveBtn = e.target.closest('[data-receive]');
    if (receiveBtn) {
      const id = receiveBtn.dataset.receive;
      if (!confirm('¿Confirmar recepción de esta orden? Se actualizará el inventario automáticamente.')) return;
      
      const { error } = await sb.rpc('receive_purchase_order', { p_order_id: id });
      if (error) fail(error);
      else {
        toast('Orden recibida e inventario actualizado');
        render(el);
      }
      return;
    }

    const cancelBtn = e.target.closest('[data-cancel-order]');
    if (cancelBtn) {
      const id = cancelBtn.dataset.cancelOrder;
      if (!confirm('¿Cancelar esta orden de compra?')) return;
      
      const { error } = await sb.from('purchase_orders').update({ status: 'cancelada' }).eq('id', id);
      if (error) fail(error);
      else {
        toast('Orden cancelada');
        render(el);
      }
      return;
    }
  });
}

function openBatchModal(products, onClose) {
  const { el, close } = openModal('Nuevo Lote de Producto (Ingreso Manual)', `
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
      const { data: product } = await sb.from('products').select('stock').eq('id', payload.product_id).single();
      await sb.from('products').update({ stock: (product?.stock || 0) + payload.quantity }).eq('id', payload.product_id);
      
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

function openOrderModal(products, suppliers, onClose) {
  if (suppliers.length === 0) {
    toast('Primero debes crear al menos un proveedor.', true);
    return;
  }

  const { el, close } = openModal('Nueva Orden de Compra', `
    <form id="order-form" style="display:grid; gap:0.75rem;">
      <div>
        <label>Proveedor</label>
        <select name="supplier_id" required style="width:100%">
          <option value="">Seleccionar proveedor...</option>
          ${suppliers.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}
        </select>
      </div>

      <div>
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.5rem;">
          <h4 style="margin:0;">Productos de la orden</h4>
          <button type="button" class="btn sm" id="btn-add-product">+ Agregar producto</button>
        </div>
        <div id="order-items"></div>
        <div style="display:flex; justify-content:flex-end; margin-top:0.5rem; font-size:1.2rem;">
          <strong>Total: <span id="order-total">Q0.00</span></strong>
        </div>
      </div>

      <div>
        <label>Notas (opcional)</label>
        <textarea name="notes" rows="2" style="width:100%"></textarea>
      </div>

      <button type="submit" class="btn">Crear Orden</button>
    </form>
  `);

  let items = [];
  const itemsEl = $('#order-items', el);
  const totalEl = $('#order-total', el);

  const paintItems = () => {
    itemsEl.innerHTML = items.length
      ? items.map((item, idx) => `
        <div style="display:grid; grid-template-columns: 2fr 1fr 1fr 1fr 1fr auto; gap:0.5rem; margin-bottom:0.5rem; align-items:center;">
          <select data-idx="${idx}" data-field="product_id" required style="width:100%">
            <option value="">Producto...</option>
            ${products.map(p => `<option value="${p.id}" ${p.id === item.product_id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
          </select>
          <input type="number" data-idx="${idx}" data-field="quantity" value="${item.quantity}" min="1" required placeholder="Cant." style="width:100%">
          <input type="number" data-idx="${idx}" data-field="unit_price" value="${item.unit_price}" step="0.01" min="0" required placeholder="Precio" style="width:100%">
          <input type="text" data-idx="${idx}" data-field="batch_number" value="${item.batch_number}" placeholder="Lote" style="width:100%">
          <input type="date" data-idx="${idx}" data-field="expiration_date" value="${item.expiration_date}" style="width:100%">
          <button type="button" class="btn sm bad" data-remove="${idx}">✕</button>
        </div>
      `).join('')
      : '<p class="muted">Sin productos. Agregue al menos uno.</p>';

    const total = items.reduce((sum, i) => sum + (Number(i.quantity) * Number(i.unit_price)), 0);
    totalEl.textContent = money(total);
  };

  $('#btn-add-product', el).onclick = () => {
    items.push({ product_id: '', quantity: 1, unit_price: 0, batch_number: '', expiration_date: '' });
    paintItems();
  };

  itemsEl.oninput = e => {
    const idx = e.target.dataset.idx;
    const field = e.target.dataset.field;
    if (idx !== undefined && field) {
      items[Number(idx)][field] = field === 'product_id' || field === 'batch_number' ? e.target.value : Number(e.target.value);
      const total = items.reduce((sum, i) => sum + (Number(i.quantity) * Number(i.unit_price)), 0);
      totalEl.textContent = money(total);
    }
  };

  itemsEl.onclick = e => {
    const idx = e.target.dataset.remove;
    if (idx !== undefined) {
      items.splice(Number(idx), 1);
      paintItems();
    }
  };

  $('#order-form', el).onsubmit = async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);

    if (items.length === 0) {
      return fail('Agregue al menos un producto a la orden.');
    }

    const cleanItems = items.map(item => {
      const product = products.find(p => p.id === item.product_id);
      return {
        product_id: item.product_id,
        product_name: product?.name || 'N/A',
        quantity: Number(item.quantity),
        unit_price: Number(item.unit_price),
        batch_number: item.batch_number,
        expiration_date: item.expiration_date
      };
    });

    if (cleanItems.some(i => !i.product_id || !i.batch_number || !i.expiration_date)) {
      return fail('Complete todos los campos de cada producto (incluyendo lote y vencimiento).');
    }

    const total = cleanItems.reduce((sum, i) => sum + (i.quantity * i.unit_price), 0);

    const payload = {
      supplier_id: formData.get('supplier_id'),
      items: cleanItems,
      total: total,
      status: 'pendiente',
      notes: formData.get('notes') || null
    };

    const { error } = await sb.from('purchase_orders').insert(payload);
    if (error) {
      fail(error);
    } else {
      toast('Orden de compra creada exitosamente');
      close();
      onClose();
    }
  };

  paintItems();
}

function openSuppliersModal(suppliers, onClose) {
  const { el, close } = openModal('Gestión de Proveedores', `
    <div style="display:grid; gap:1rem;">
      <button class="btn" id="btn-new-supplier">+ Nuevo Proveedor</button>
      <div id="suppliers-list"></div>
    </div>
  `);

  const paintSuppliers = () => {
    $('#suppliers-list', el).innerHTML = suppliers.length
      ? tbl(['Nombre', 'Contacto', 'Teléfono', 'Email', 'Acciones'], suppliers.map(s => [
          esc(s.name),
          esc(s.contact_name || '-'),
          esc(s.phone || '-'),
          esc(s.email || '-'),
          `<button class="btn sm bad" data-delete-supplier="${s.id}">Desactivar</button>`
        ]))
      : '<p class="muted">No hay proveedores registrados.</p>';
  };

  $('#btn-new-supplier', el).onclick = () => {
    const { el: modalEl, close: closeModal } = openModal('Nuevo Proveedor', `
      <form id="supplier-form" style="display:grid; gap:0.75rem;">
        <div>
          <label>Nombre *</label>
          <input type="text" name="name" required style="width:100%">
        </div>
        <div>
          <label>Persona de contacto</label>
          <input type="text" name="contact_name" style="width:100%">
        </div>
        <div>
          <label>Teléfono</label>
          <input type="tel" name="phone" style="width:100%">
        </div>
        <div>
          <label>Email</label>
          <input type="email" name="email" style="width:100%">
        </div>
        <div>
          <label>Dirección</label>
          <textarea name="address" rows="2" style="width:100%"></textarea>
        </div>
        <div>
          <label>NIT / ID Fiscal</label>
          <input type="text" name="tax_id" style="width:100%">
        </div>
        <button type="submit" class="btn">Crear Proveedor</button>
      </form>
    `);

    $('#supplier-form', modalEl).onsubmit = async (e) => {
      e.preventDefault();
      const formData = new FormData(e.target);
      const payload = Object.fromEntries(formData);

      const { data, error } = await sb.from('suppliers').insert(payload).select().single();
      if (error) {
        fail(error);
      } else {
        toast('Proveedor creado exitosamente');
        suppliers.push(data);
        closeModal();
        paintSuppliers();
        onClose();
      }
    };
  };

  el.addEventListener('click', async (e) => {
    const deleteBtn = e.target.closest('[data-delete-supplier]');
    if (deleteBtn) {
      const id = deleteBtn.dataset.deleteSupplier;
      if (!confirm('¿Desactivar este proveedor? No se eliminará, solo dejará de aparecer como opción.')) return;

      const { error } = await sb.from('suppliers').update({ is_active: false }).eq('id', id);
      if (error) {
        fail(error);
      } else {
        toast('Proveedor desactivado');
        const idx = suppliers.findIndex(s => s.id === id);
        if (idx >= 0) suppliers.splice(idx, 1);
        paintSuppliers();
        onClose();
      }
    }
  });

  paintSuppliers();
}
