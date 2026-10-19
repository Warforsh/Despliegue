import { sb, $, $$, esc, isRole, toast, fail, tbl, money, fmtD, fmtDT, S, openModal } from './core.js';

export async function render(el) {
  const isAdmin = isRole('admin');
  const isDoctor = isRole('doctor');
  
  const [{ data: reports }, { data: doctors }] = await Promise.all([
    isAdmin ? sb.from('report_exports').select('*, profiles(full_name)').order('generated_at', { ascending: false }).limit(50) : { data: [] },
    isDoctor || isAdmin ? sb.from('profiles').select('id, full_name').eq('role', 'doctor') : { data: [] }
  ]);

  el.innerHTML = `
    <div class="bar"><h2>Reportes Gerenciales</h2></div>

    <div class="card" style="background:#fff3cd; border-left:4px solid #ffc107; margin-bottom:1rem">
      <h3 style="color:#856404">🔒 Reportes con Auditoría Completa</h3>
      <p class="muted">Todos los reportes generados incluyen marca de agua, metadatos de auditoría y registro de quién los generó. Los datos clínicos están protegidos por RLS.</p>
    </div>

    <div class="card">
      <h3>Generar Nuevo Reporte</h3>
      <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap:1rem;">
        ${isAdmin ? `
        <div class="report-card" data-type="financial" style="padding:1rem; border:2px solid #e0e0e0; border-radius:8px; cursor:pointer; transition:all 0.2s;">
          <h4 style="margin:0 0 0.5rem 0;">💰 Reporte Financiero</h4>
          <p class="muted" style="margin:0;">Facturación, ingresos por método de pago, reembolsos</p>
        </div>
        ` : ''}
        ${isDoctor || isAdmin ? `
        <div class="report-card" data-type="clinical" style="padding:1rem; border:2px solid #e0e0e0; border-radius:8px; cursor:pointer; transition:all 0.2s;">
          <h4 style="margin:0 0 0.5rem 0;">🏥 Reporte Clínico</h4>
          <p class="muted" style="margin:0;">Consultas, diagnósticos, actividad por médico</p>
        </div>
        ` : ''}
        ${isAdmin ? `
        <div class="report-card" data-type="inventory" style="padding:1rem; border:2px solid #e0e0e0; border-radius:8px; cursor:pointer; transition:all 0.2s;">
          <h4 style="margin:0 0 0.5rem 0;">📦 Reporte de Inventario</h4>
          <p class="muted" style="margin:0;">Stock, movimientos, productos por vencer</p>
        </div>
        <div class="report-card" data-type="patients" style="padding:1rem; border:2px solid #e0e0e0; border-radius:8px; cursor:pointer; transition:all 0.2s;">
          <h4 style="margin:0 0 0.5rem 0;">👥 Reporte de Pacientes</h4>
          <p class="muted" style="margin:0;">Pacientes registrados, citas, expedientes</p>
        </div>
        ` : ''}
      </div>
    </div>

    ${isAdmin ? `
    <div class="card" style="margin-top:1rem">
      <h3>Historial de Reportes Generados</h3>
      ${(reports || []).length > 0 ? tbl(['Fecha', 'Tipo', 'Filas', 'Formato', 'Generado por', 'Acciones'], (reports || []).map(r => [
        esc(fmtDT(r.generated_at)),
        `<span class="badge">${esc(r.report_type)}</span>`,
        esc(r.row_count),
        esc(r.file_format.toUpperCase()),
        esc(r.profiles?.full_name || 'Sistema'),
        `<button class="btn sm" data-view="${r.id}">Ver</button>
         <button class="btn sm" data-download="${r.id}">Descargar</button>`
      ])) : '<p class="muted">No hay reportes generados aún.</p>'}
    </div>
    ` : ''}
  `;

  el.addEventListener('click', async (e) => {
    const card = e.target.closest('.report-card');
    if (card) {
      const type = card.dataset.type;
      openReportConfigModal(type, doctors?.data || [], render.bind(null, el));
      return;
    }

    const viewBtn = e.target.closest('[data-view]');
    if (viewBtn) {
      const id = viewBtn.dataset.view;
      const report = reports.find(r => r.id === id);
      if (report) openReportPreview(report);
      return;
    }

    const downloadBtn = e.target.closest('[data-download]');
    if (downloadBtn) {
      const id = downloadBtn.dataset.download;
      const report = reports.find(r => r.id === id);
      if (report) downloadReport(report);
    }
  });
}

function openReportConfigModal(type, doctors, onClose) {
  const titles = {
    financial: 'Reporte Financiero',
    clinical: 'Reporte Clínico',
    inventory: 'Reporte de Inventario',
    patients: 'Reporte de Pacientes'
  };

  let fieldsHtml = `
    <div>
      <label>Fecha Desde *</label>
      <input type="date" name="from" required style="width:100%">
    </div>
    <div>
      <label>Fecha Hasta *</label>
      <input type="date" name="to" required style="width:100%">
    </div>
  `;

  if (type === 'clinical') {
    fieldsHtml += `
      <div>
        <label>Médico (opcional)</label>
        <select name="doctor_id" style="width:100%">
          <option value="">Todos los médicos</option>
          ${doctors.map(d => `<option value="${d.id}">${esc(d.full_name)}</option>`).join('')}
        </select>
      </div>
    `;
  }

  const { el, close } = openModal(`Configurar ${titles[type]}`, `
    <form id="report-form" style="display:grid; gap:0.75rem;">
      ${fieldsHtml}
      <div>
        <label>Formato de Exportación</label>
        <select name="format" required style="width:100%">
          <option value="csv">CSV (Excel)</option>
        </select>
      </div>
      <button type="submit" class="btn">Generar Reporte</button>
    </form>
  `);

  $('#report-form', el).onsubmit = async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const from = formData.get('from');
    const to = formData.get('to');
    const format = formData.get('format');

    try {
      let reportData;
      let reportType;

      if (type === 'financial') {
        const { data, error } = await sb.rpc('generate_financial_report', {
          p_from: from, p_to: to, p_format: format
        });
        if (error) throw error;
        reportData = data.data;
        reportType = 'financial';
      } else if (type === 'clinical') {
        const doctorId = formData.get('doctor_id') || null;
        const { data, error } = await sb.rpc('generate_clinical_report', {
          p_from: from, p_to: to, p_doctor_id: doctorId
        });
        if (error) throw error;
        reportData = data.data;
        reportType = 'clinical';
      } else if (type === 'inventory') {
        const [{ data: products }, { data: batches }, { data: movements }] = await Promise.all([
          sb.from('products').select('*').order('name'),
          sb.from('product_batches').select('*, products(name)').order('expiration_date'),
          sb.from('inventory_movements').select('*, products(name)').gte('performed_at', from + 'T00:00:00').lte('performed_at', to + 'T23:59:59')
        ]);
        
        reportData = {
          period: { from, to },
          products: products || [],
          batches: batches || [],
          movements: movements || [],
          totals: {
            total_products: (products || []).length,
            low_stock: (products || []).filter(p => p.stock <= p.min_stock).length,
            expiring_soon: (batches || []).filter(b => {
              const days = Math.ceil((new Date(b.expiration_date) - new Date()) / (1000 * 60 * 60 * 24));
              return days <= 30 && days >= 0 && b.remaining_quantity > 0;
            }).length
          }
        };
        reportType = 'inventory';
      } else if (type === 'patients') {
        const [{ data: patients }, { data: appointments }] = await Promise.all([
          sb.from('patients').select('*').gte('created_at', from + 'T00:00:00').lte('created_at', to + 'T23:59:59'),
          sb.from('appointments').select('*').gte('starts_at', from + 'T00:00:00').lte('starts_at', to + 'T23:59:59')
        ]);
        
        reportData = {
          period: { from, to },
          patients: patients || [],
          appointments: appointments || [],
          totals: {
            total_patients: (patients || []).length,
            total_appointments: (appointments || []).length,
            attended: (appointments || []).filter(a => a.status === 'atendida').length,
            cancelled: (appointments || []).filter(a => a.status === 'cancelada').length
          }
        };
        reportType = 'patients';
      }

      const rowCount = reportData.totals?.total_invoices || reportData.totals?.total_consultations || 
                       reportData.totals?.total_products || reportData.totals?.total_patients || 0;

      const { data: report, error: insertError } = await sb.from('report_exports').insert({
        report_type: reportType,
        filters: { from, to },
        row_count: rowCount,
        file_format: format,
        metadata: {
          generated_by: S.user.id,
          generated_at: new Date().toISOString(),
          watermark: 'Centro Médico Premier - Documento Confidencial',
          filters: { from, to },
          data: reportData
        }
      }).select().single();

      if (insertError) throw insertError;

      toast(`Reporte generado: ${report.row_count} registros`);
      close();
      openReportPreview(report);
      onClose();
    } catch (err) {
      fail(err);
    }
  };
}

function openReportPreview(report) {
  const data = report.metadata?.data;
  if (!data) {
    toast('Este reporte no tiene datos disponibles para visualizar', true);
    return;
  }

  let contentHtml = '';

  if (report.report_type === 'financial') {
    const invoices = data.invoices || [];
    contentHtml = `
      <h4>Facturas (${invoices.length})</h4>
      ${invoices.length > 0 ? tbl(['Número', 'Paciente', 'Fecha', 'Total', 'Método', 'Estado'], invoices.map(inv => [
        esc(inv.number),
        esc(inv.patient),
        esc(fmtDT(inv.date)),
        money(inv.total),
        esc(inv.method || '-'),
        `<span class="badge">${esc(inv.status)}</span>`
      ])) : '<p class="muted">Sin facturas en el período.</p>'}
      <div style="margin-top:1rem; padding:1rem; background:#f5f5f5; border-radius:4px;">
        <strong>Totales:</strong><br>
        Total facturas: ${data.totals?.total_invoices || 0}<br>
        Monto total: ${money(data.totals?.total_amount || 0)}<br>
        Efectivo: ${money(data.totals?.cash_total || 0)}<br>
        Tarjeta: ${money(data.totals?.card_total || 0)}
      </div>
    `;
  } else if (report.report_type === 'clinical') {
    const consultations = data.consultations || [];
    contentHtml = `
      <h4>Consultas (${consultations.length})</h4>
      ${consultations.length > 0 ? tbl(['Fecha', 'Paciente', 'Médico', 'Diagnóstico', 'Estado'], consultations.map(c => [
        esc(fmtDT(c.date)),
        esc(c.patient),
        esc(c.doctor),
        esc(c.diagnosis || '-'),
        c.finalized ? '<span class="badge confirmada">Finalizada</span>' : '<span class="badge pendiente">En curso</span>'
      ])) : '<p class="muted">Sin consultas en el período.</p>'}
      <div style="margin-top:1rem; padding:1rem; background:#f5f5f5; border-radius:4px;">
        <strong>Total consultas:</strong> ${data.totals?.total_consultations || 0}
      </div>
    `;
  } else if (report.report_type === 'inventory') {
    const products = data.products || [];
    const batches = data.batches || [];
    contentHtml = `
      <h4>Productos (${products.length})</h4>
      ${products.length > 0 ? tbl(['Nombre', 'Stock Actual', 'Stock Mínimo', 'Precio'], products.map(p => [
        esc(p.name),
        `<strong style="color:${p.stock <= p.min_stock ? '#c62828' : 'inherit'}">${esc(p.stock)}</strong>`,
        esc(p.min_stock),
        money(p.price)
      ])) : '<p class="muted">Sin productos.</p>'}
      
      <h4 style="margin-top:1rem;">Lotes (${batches.length})</h4>
      ${batches.length > 0 ? tbl(['Producto', 'Lote', 'Vencimiento', 'Restante'], batches.map(b => [
        esc(b.products?.name || 'N/A'),
        esc(b.batch_number),
        fmtD(b.expiration_date),
        esc(b.remaining_quantity)
      ])) : '<p class="muted">Sin lotes.</p>'}
      
      <div style="margin-top:1rem; padding:1rem; background:#f5f5f5; border-radius:4px;">
        <strong>Totales:</strong><br>
        Total productos: ${data.totals?.total_products || 0}<br>
        Stock bajo: ${data.totals?.low_stock || 0}<br>
        Próximos a vencer: ${data.totals?.expiring_soon || 0}
      </div>
    `;
  } else if (report.report_type === 'patients') {
    const patients = data.patients || [];
    const appointments = data.appointments || [];
    contentHtml = `
      <h4>Pacientes (${patients.length})</h4>
      ${patients.length > 0 ? tbl(['Nombre', 'DPI', 'Fecha Nacimiento', 'Teléfono'], patients.map(p => [
        esc(`${p.first_name} ${p.last_name}`),
        esc(p.dpi),
        fmtD(p.birth_date),
        esc(p.phone || '-')
      ])) : '<p class="muted">Sin pacientes en el período.</p>'}
      
      <h4 style="margin-top:1rem;">Citas (${appointments.length})</h4>
      ${appointments.length > 0 ? tbl(['Fecha', 'Estado'], appointments.map(a => [
        esc(fmtDT(a.starts_at)),
        `<span class="badge">${esc(a.status)}</span>`
      ])) : '<p class="muted">Sin citas en el período.</p>'}
      
      <div style="margin-top:1rem; padding:1rem; background:#f5f5f5; border-radius:4px;">
        <strong>Totales:</strong><br>
        Total pacientes: ${data.totals?.total_patients || 0}<br>
        Total citas: ${data.totals?.total_appointments || 0}<br>
        Atendidas: ${data.totals?.attended || 0}<br>
        Canceladas: ${data.totals?.cancelled || 0}
      </div>
    `;
  }

  const { el, close } = openModal(`Vista Previa: ${report.report_type.toUpperCase()}`, `
    <div style="display:grid; gap:1rem;">
      <div style="background:#e3f2fd; padding:0.75rem; border-radius:4px; border-left:4px solid #2196F3;">
        <strong>Período:</strong> ${fmtD(report.metadata?.filters?.from)} al ${fmtD(report.metadata?.filters?.to)}<br>
        <strong>Generado:</strong> ${fmtDT(report.generated_at)}<br>
        <strong>Filas:</strong> ${report.row_count}
      </div>
      ${contentHtml}
      <div class="bar" style="justify-content:flex-end; gap:0.5rem;">
        <button class="btn sm" id="preview-download">Descargar CSV</button>
        <button class="btn sm" id="preview-close">Cerrar</button>
      </div>
    </div>
  `);

  $('#preview-close', el).onclick = close;
  $('#preview-download', el).onclick = () => downloadReport(report);
}

function downloadReport(report) {
  const data = report.metadata?.data;
  if (!data) {
    toast('Este reporte no tiene datos disponibles', true);
    return;
  }

  let rows = [];
  
  rows.push(['Centro Médico Premier']);
  rows.push([`Reporte de ${report.report_type.toUpperCase()}`]);
  rows.push(['Documento confidencial - uso interno']);
  rows.push([]);
  rows.push(['Generado por', S.profile?.full_name || '']);
  rows.push(['Generado el', report.generated_at]);
  rows.push(['Período', `${report.metadata?.filters?.from} al ${report.metadata?.filters?.to}`]);
  rows.push([]);

  if (report.report_type === 'financial') {
    rows.push(['Número', 'Paciente', 'Fecha', 'Total', 'Método', 'Estado']);
    (data.invoices || []).forEach(inv => {
      rows.push([inv.number, inv.patient, inv.date, inv.total, inv.method || '', inv.status]);
    });
    rows.push([]);
    rows.push(['TOTALES']);
    rows.push(['Total facturas', data.totals?.total_invoices || 0]);
    rows.push(['Monto total', data.totals?.total_amount || 0]);
    rows.push(['Efectivo', data.totals?.cash_total || 0]);
    rows.push(['Tarjeta', data.totals?.card_total || 0]);
  } else if (report.report_type === 'clinical') {
    rows.push(['Fecha', 'Paciente', 'Médico', 'Diagnóstico', 'Estado']);
    (data.consultations || []).forEach(c => {
      rows.push([c.date, c.patient, c.doctor, c.diagnosis || '', c.finalized ? 'Finalizada' : 'En curso']);
    });
    rows.push([]);
    rows.push(['Total consultas', data.totals?.total_consultations || 0]);
  } else if (report.report_type === 'inventory') {
    rows.push(['PRODUCTOS']);
    rows.push(['Nombre', 'Stock Actual', 'Stock Mínimo', 'Precio']);
    (data.products || []).forEach(p => {
      rows.push([p.name, p.stock, p.min_stock, p.price]);
    });
    rows.push([]);
    rows.push(['LOTES']);
    rows.push(['Producto', 'Lote', 'Vencimiento', 'Restante']);
    (data.batches || []).forEach(b => {
      rows.push([b.products?.name || '', b.batch_number, b.expiration_date, b.remaining_quantity]);
    });
    rows.push([]);
    rows.push(['TOTALES']);
    rows.push(['Total productos', data.totals?.total_products || 0]);
    rows.push(['Stock bajo', data.totals?.low_stock || 0]);
    rows.push(['Próximos a vencer', data.totals?.expiring_soon || 0]);
  } else if (report.report_type === 'patients') {
    rows.push(['PACIENTES']);
    rows.push(['Nombre', 'DPI', 'Fecha Nacimiento', 'Teléfono']);
    (data.patients || []).forEach(p => {
      rows.push([`${p.first_name} ${p.last_name}`, p.dpi, p.birth_date, p.phone || '']);
    });
    rows.push([]);
    rows.push(['CITAS']);
    rows.push(['Fecha', 'Estado']);
    (data.appointments || []).forEach(a => {
      rows.push([a.starts_at, a.status]);
    });
    rows.push([]);
    rows.push(['TOTALES']);
    rows.push(['Total pacientes', data.totals?.total_patients || 0]);
    rows.push(['Total citas', data.totals?.total_appointments || 0]);
    rows.push(['Atendidas', data.totals?.attended || 0]);
    rows.push(['Canceladas', data.totals?.cancelled || 0]);
  }

  const csv = '\uFEFF' + rows.map(row => 
    row.map(cell => {
      let s = String(cell ?? '');
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return `"${s.replace(/"/g, '""')}"`;
    }).join(',')
  ).join('\r\n');

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `reporte_${report.report_type}_${report.metadata?.filters?.from}_a_${report.metadata?.filters?.to}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);

  toast('Reporte descargado con marca de agua y metadatos de auditoría');
}