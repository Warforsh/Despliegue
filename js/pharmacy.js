import { sb, $, esc, toast, fail, fmtDT, openModal, fullName, tbl, badge } from './core.js';

export async function render(el) {
  let tab = 'rx';
  const draw = () => {
    el.innerHTML = `<div class="bar"><h2>Farmacia e inventario</h2></div><div class="tabs">
      <button data-t="rx" class="${tab === 'rx' ? 'on' : ''}">Recetas</button><button data-t="inv" class="${tab === 'inv' ? 'on' : ''}">Inventario</button></div><div id="tab"></div>`;
    el.querySelectorAll('.tabs button').forEach(b => (b.onclick = () => { tab = b.dataset.t; draw(); }));
    tab === 'rx' ? rx($('#tab')) : inv($('#tab'));
  };
  draw();
}

async function rx(box) {
  box.innerHTML = `<div class="row" style="margin-bottom:10px"><select id="f" style="width:auto"><option value="pendiente">Pendientes</option><option value="dispensada">Dispensadas</option></select></div><div id="l"></div>`;
  const load = async () => {
    const st = $('#f').value;
    const { data, error } = await sb.from('prescriptions').select('id,status,created_at,dispensed_at,patient:patients(first_name,last_name,dpi),items:prescription_items(name,dose,frequency,duration,quantity,product_id)')
      .eq('status', st).order('created_at', { ascending: false }).limit(100);
    if (error) return fail(error);
    $('#l').innerHTML = tbl(['Fecha', 'Paciente', 'Medicamentos', 'Estado', ''], data.map(r => [fmtDT(r.created_at), `${esc(fullName(r.patient))}<br><span class="muted">${esc(r.patient?.dpi)}</span>`,
      r.items.map(i => `${esc(i.name)} ${esc(i.dose)} · ${esc(i.frequency)} · ${esc(i.duration)} · <b>x${i.quantity}</b>${i.product_id ? '' : ' <i class="muted">(sin inventario)</i>'}`).join('<br>'),
      badge(r.status), r.status === 'pendiente' ? `<button class="btn sm" data-d="${r.id}">Dispensar</button>` : fmtDT(r.dispensed_at)]));
  };
  $('#f').onchange = load;
  $('#l').onclick = async e => {
    const id = e.target.dataset.d; if (!id || !confirm('¿Marcar como dispensada? Se descontará del inventario.')) return;
    const { error } = await sb.rpc('dispense_prescription', { p_id: id });
    error ? fail(error) : toast('Receta dispensada'); load();
  };
  load();
}

async function inv(box) {
  const { data, error } = await sb.from('products').select('*').order('name'); if (error) return fail(error);
  const low = data.filter(p => p.stock < p.min_stock);
  box.innerHTML = `<div class="bar"><span>${low.length ? `<span class="low">⚠️ ${low.length} producto(s) bajo el mínimo</span>` : 'Inventario en orden'}</span><button class="btn" id="np">+ Producto</button></div>
  ${tbl(['Producto', 'Stock', 'Mínimo', 'Precio', ''], data.map(p => [esc(p.name), `<span class="${p.stock < p.min_stock ? 'low' : ''}">${p.stock}${p.stock < p.min_stock ? ' ⚠️' : ''}</span>`, p.min_stock, 'Q' + Number(p.price).toFixed(2), `<button class="btn sm ghost" data-e="${p.id}">Editar</button>`]))}`;
  const edit = p => {
    const m = openModal(p ? 'Editar producto' : 'Nuevo producto', `<form><div class="grid"><label>Nombre<input name="name" required value="${esc(p?.name)}"></label>
      <label>Stock actual<input name="stock" type="number" min="0" required value="${p?.stock ?? 0}"></label><label>Stock mínimo<input name="min_stock" type="number" min="0" required value="${p?.min_stock ?? 0}"></label>
      <label>Precio (Q)<input name="price" type="number" min="0" step="0.01" required value="${p?.price ?? 0}"></label></div><button class="btn">Guardar</button></form>`);
    $('form', m.el).onsubmit = async e => {
      e.preventDefault();
      const o = Object.fromEntries(new FormData(e.target)); ['stock', 'min_stock', 'price'].forEach(k => (o[k] = +o[k]));
      const { error } = p ? await sb.from('products').update(o).eq('id', p.id) : await sb.from('products').insert(o);
      if (error) return fail(error); toast('Producto guardado'); m.close(); inv(box);
    };
  };
  $('#np').onclick = () => edit(null);
  box.onclick = e => { const id = e.target.dataset.e; if (id) edit(data.find(p => p.id === id)); };
}
