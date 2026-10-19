import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';

export const CFG = window.APP_CONFIG || {};
// Sin configuración no se crea el cliente (createClient lanza error con URL vacía)
export const sb = CFG.SUPABASE_URL ? createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY) : null;
export const S = { user: null, profile: null };

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const esc = v => String(v ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
export const isRole = (...r) => r.includes(S.profile?.role);
export const money = v => 'Q' + Number(v || 0).toFixed(2);
export const fmtDT = d => d ? new Date(d).toLocaleString('es-GT', { dateStyle: 'short', timeStyle: 'short' }) : '';
export const fmtD = d => d ? new Date(d.length === 10 ? d + 'T00:00:00' : d).toLocaleDateString('es-GT') : '';
export const today = () => new Date().toLocaleDateString('en-CA');
export const dayBounds = (d = today()) => {
  const s = new Date(d + 'T00:00:00'), e = new Date(s); e.setDate(e.getDate() + 1);
  return [s.toISOString(), e.toISOString()];
};
export const fullName = p => p ? `${p.first_name} ${p.last_name}` : '';
export const STATUSES = ['pendiente', 'programada', 'confirmada', 'en_espera', 'atendida', 'cancelada', 'ausente'];
export const badge = s => `<span class="badge ${esc(s)}">${esc(String(s).replace('_', ' '))}</span>`;
export const tbl = (heads, rows) => rows.length
  ? `<div class="scroll"><table><thead><tr>${heads.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
  : '<p class="muted">Sin resultados.</p>';

export function toast(m, err) {
  const t = $('#toast'); t.textContent = m; t.className = 'show' + (err ? ' bad' : '');
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.className = ''), 4500);
}
export const fail = e => toast(e?.message || String(e), true);

// Registro de accesos (lecturas). Las escrituras se auditan con triggers en la BD.
export async function audit(action, entity, entity_id = null, detail = {}) {
  await sb.from('audit_logs').insert({ user_id: S.user.id, action, entity, entity_id, detail });
}

export function openModal(title, html) {
  const o = document.createElement('div');
  o.className = 'overlay';
  o.innerHTML = `<div class="modal"><div class="bar"><h3>${esc(title)}</h3><button class="x" type="button">✕</button></div>${html}</div>`;
  document.body.appendChild(o);
  const close = () => o.remove();
  $('.x', o).onclick = close;
  return { el: o, close };
}

// =====================================================================
// GESTIÓN DE SESIÓN: Timeout de inactividad + Heartbeat
// =====================================================================

const SESSION_CONFIG = {
  INACTIVITY_TIMEOUT: 60 * 1000,      // 1 minuto sin actividad (ajustable)
  WARNING_BEFORE_EXPIRE: 30 * 1000,   // Advertencia 30s antes
  HEARTBEAT_INTERVAL: 20 * 1000,      // Heartbeat cada 20s
  ACTIVITY_EVENTS: ['mousedown', 'mousemove', 'keypress', 'scroll', 'touchstart', 'click']
};

export const SessionManager = {
  lastActivity: Date.now(),
  warningTimer: null,
  expireTimer: null,
  heartbeatTimer: null,
  checkInterval: null,
  warningModal: null,
  isActive: false,

  start() {
    if (this.isActive || !sb) return;
    this.isActive = true;
    this.lastActivity = Date.now();

    this._boundOnActivity = () => this.onActivity();
    SESSION_CONFIG.ACTIVITY_EVENTS.forEach(event => {
      document.addEventListener(event, this._boundOnActivity, { passive: true });
    });

    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), SESSION_CONFIG.HEARTBEAT_INTERVAL);
    this.checkInterval = setInterval(() => this.checkInactivity(), 1000);
  },

  stop() {
    if (!this.isActive) return;
    this.isActive = false;
    clearInterval(this.heartbeatTimer);
    clearInterval(this.checkInterval);
    clearTimeout(this.warningTimer);
    clearTimeout(this.expireTimer);
    if (this.warningModal) {
      this.warningModal.close();
      this.warningModal = null;
    }
    if (this._boundOnActivity) {
      SESSION_CONFIG.ACTIVITY_EVENTS.forEach(event => {
        document.removeEventListener(event, this._boundOnActivity);
      });
    }
  },

  onActivity() {
    this.lastActivity = Date.now();
    if (this.warningModal) {
      this.warningModal.close();
      this.warningModal = null;
      clearTimeout(this.expireTimer);
    }
  },

  checkInactivity() {
    if (!this.isActive || !S.user) return;

    const elapsed = Date.now() - this.lastActivity;
    const timeToWarning = SESSION_CONFIG.INACTIVITY_TIMEOUT - SESSION_CONFIG.WARNING_BEFORE_EXPIRE;
    const timeToExpire = SESSION_CONFIG.INACTIVITY_TIMEOUT;

    if (elapsed >= timeToWarning && elapsed < timeToExpire && !this.warningModal) {
      this.showWarning();
    }

    if (elapsed >= timeToExpire) {
      this.expireSession();
    }
  },

  showWarning() {
    const remaining = Math.ceil((SESSION_CONFIG.INACTIVITY_TIMEOUT - (Date.now() - this.lastActivity)) / 1000);
    
    this.warningModal = openModal('⚠️ Sesión por expirar', `
      <div style="text-align:center; padding:1rem;">
        <p style="font-size:1.1rem; margin-bottom:1rem;">Tu sesión se cerrará automáticamente por inactividad en:</p>
        <div id="countdown" style="font-size:3rem; font-weight:bold; color:#c62828; margin:1rem 0;">${remaining}s</div>
        <p class="muted">Presiona el botón para mantener tu sesión activa.</p>
        <button class="lg-btn" id="btn-stay" style="margin-top:1rem; width:100%;">✓ Seguir conectado</button>
      </div>
    `);

    const countdownEl = $('#countdown', this.warningModal.el);
    const updateCountdown = () => {
      const rem = Math.ceil((SESSION_CONFIG.INACTIVITY_TIMEOUT - (Date.now() - this.lastActivity)) / 1000);
      if (countdownEl && rem > 0) countdownEl.textContent = `${rem}s`;
    };
    const countdownInterval = setInterval(updateCountdown, 1000);

    $('#btn-stay', this.warningModal.el).onclick = () => {
      this.onActivity();
      clearInterval(countdownInterval);
    };

    this.expireTimer = setTimeout(() => clearInterval(countdownInterval), SESSION_CONFIG.WARNING_BEFORE_EXPIRE);
  },

  async expireSession() {
    this.stop();
    try { await sb.auth.signOut({ scope: 'local' }); } catch (err) { console.warn('Expire error:', err); }
    S.user = null; S.profile = null;
    setTimeout(() => { location.hash = ''; location.reload(); }, 2000);
  },

  async sendHeartbeat() {
    if (!S.user) return;
    try { await sb.rpc('heartbeat_session'); } catch (err) { /* Ignorar errores de heartbeat */ }
  }
};