import { sb, $, esc, isRole, toast, fail, tbl, money, fmtD, S, openModal } from './core.js';

export async function render(el) {
  const isAdmin = isRole('admin');
  const isDoctor = isRole('doctor');
  
  // Cargar reportes recientes
  const [{ data: reports }, { data: doctors }] = await Promise.all([
    isAdmin ? sb.from('report_exports').select('*, profiles(full_name)').order('generated_at', { ascending: false }).limit(50) : { data: [] },
    isDoctor ? sb.from('profiles').select('id, full_name').eq('role', 'doctor') : { data: [] }
  ]);

  el.innerHTML = `
    <div class="bar"><h2>Reportes Gerenciales</h2></div>

    <!-- Alerta de Seguridad -->
    <div class="card" style="background:#fff3cd; border-left:4px solid #ffc107; margin-bottom:1rem">
      <h3 style="color:#856404">🔒 Reportes con Auditoría Completa</h3>
      <p class="muted">Todos los reportes generados incluyen marca de agua, metadatos de auditoría y registro de quién los generó. Los datos clínicos están protegidos por RLS.</p>
    </div>

    <!-- Generador de Reportes -->
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
    <!-- Historial de Reportes -->
    <div class="card" style="margin-top:1rem">
      <h3>Historial de Reportes Generados</h3>
      ${tbl(['Fecha', 'Tipo', 'Filas', 'Formato', 'Generado por', 'Acciones'], (reports || []).map(r => [
        esc(fmtD(r.generated_at)),
        `<span class="badge">${esc(r.report_type)}</span>`,
        esc(r.row_count),
        esc(r.file_format.toUpperCase()),
        esc(r.profiles?.full_name || 'Sistema'),
        `<button class="btn sm" data-download="${r.id}">Descargar</button>`
      ]))}
    </div>
    ` : ''}
  `;

  // Event listeners
  el.addEventListener('click', async (e) => {
    const card = e.target.closest('.report-card');
    if (card) {
      const type = card.dataset.type;
      openReportConfigModal(type, doctors?.data || [], render.bind(null, el));
      return;
    }

    const downloadBtn = e.target.closest('[data-download]');
    if (downloadBtn) {
      const id = downloadBtn.dataset.download;
      toast('Descarga de reporte (funcionalidad de storage pendiente)');
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
      <label>Fecha Desde</label>
      <input type="date" name="from" required style="width:100%">
    </div>
    <div>
      <label>Fecha Hasta</label>
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
          <option value="xlsx">Excel (.xlsx)</option>
          <option value="pdf">PDF</option>
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
      let result;
      if (type === 'financial') {
        const { data, error } = await sb.rpc('generate_financial_report', {
          p_from: from,
          p_to: to,
          p_format: format
        });
        if (error) throw error;
        result = data;
      } else if (type === 'clinical') {
        const doctorId = formData.get('doctor_id') || null;
        const { data, error } = await sb.rpc('generate_clinical_report', {
          p_from: from,
          p_to: to,
          p_doctor_id: doctorId
        });
        if (error) throw error;
        result = data;
      } else {
        toast('Reporte en desarrollo');
        close();
        return;
      }

      toast(`Reporte generado exitosamente (${result.data?.totals?.total_invoices || result.data?.totals?.total_consultations || 0} registros)`);
      console.log('Report data:', result);
      close();
      onClose();
    } catch (err) {
      fail(err);
    }
  };
}