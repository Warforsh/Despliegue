import { sb, $, esc, fail } from './core.js';

// Clave pública de reCAPTCHA (segura de exponer en el frontend)
const RECAPTCHA_SITE_KEY = '6LdqkvctAAAAAMnT94RurzY4y2LH6MGILFcEgylh';

// Carga el CSS del login automáticamente (no hace falta tocar index.html)
if (!document.getElementById('lg-css')) {
  const l = document.createElement('link');
  l.id = 'lg-css'; l.rel = 'stylesheet'; l.href = new URL('../css/login.css', import.meta.url).href;
  document.head.appendChild(l);
}

const svg = (p, s = 20) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
const IC = {
  mail: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>'),
  lock: svg('<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'),
  user: svg('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'),
  eye: svg('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  off: svg('<path d="M17.9 17.9A10.1 10.1 0 0 1 12 19c-6.5 0-10-7-10-7a17 17 0 0 1 4.1-5M9.9 5.2A9.7 9.7 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-2.2 3.2M1 1l22 22"/>'),
  cross: svg('<path d="M10 3h4v7h7v4h-7v7h-4v-7H3v-4h7z" fill="currentColor" stroke="none"/>', 24),
  cal: svg('<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>', 18),
  file: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>', 18),
  shield: svg('<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/>', 18),
  ok: svg('<path d="m5 12 5 5 9-10"/>', 32),
  back: svg('<path d="m15 18-6-6 6-6"/>', 16),
};

const COPY = {
  login: ['Bienvenido de nuevo', 'Ingrese para acceder a su cuenta', 'Ingresar'],
  register: ['Cree su cuenta', 'Acceda a sus citas y expediente en línea', 'Crear cuenta'],
  forgot: ['Recuperar contraseña', 'Le enviaremos un enlace para restablecerla', 'Enviar enlace'],
  recovery: ['Nueva contraseña', 'Elija una contraseña segura para su cuenta', 'Guardar contraseña'],
};

const ERR = [
  [/invalid login credentials/i, 'Correo o contraseña incorrectos.'],
  [/email not confirmed/i, 'Debe confirmar su correo antes de ingresar. Revise su bandeja de entrada.'],
  [/already registered|already been registered/i, 'Ya existe una cuenta con ese correo. Intente iniciar sesión.'],
  [/rate limit|too many/i, 'Demasiados intentos. Espere unos minutos e intente de nuevo.'],
  [/password.*(short|least|weak)/i, 'La contraseña es demasiado débil (mínimo 8 caracteres).'],
  [/same.*password|different from the old/i, 'La nueva contraseña debe ser distinta a la anterior.'],
  [/network|fetch/i, 'Sin conexión con el servidor. Verifique su internet.'],
  [/captcha|recaptcha|seguridad/i, 'Verificación de seguridad fallida. Intente de nuevo.'],
];
const toEs = m => (ERR.find(([r]) => r.test(m || '')) || [, m || 'Ocurrió un error inesperado.'])[1];

function strength(p) {
  let s = 0;
  if (p.length >= 8) s++;
  if (/[a-z]/.test(p) && /[A-Z]/.test(p)) s++;
  if (/\d/.test(p)) s++;
  if (/[^A-Za-z0-9]/.test(p) || p.length >= 14) s++;
  return p ? Math.max(1, s) : 0;
}

const field = (name, type, label, icon, extra = '') =>
  `<div class="lg-f"><input id="lg-${name}" name="${name}" type="${type}" placeholder=" " ${extra}><label for="lg-${name}">${label}</label><span class="lg-i">${IC[icon]}</span>
  ${type === 'password' ? `<button type="button" class="lg-eye" aria-label="Mostrar contraseña" data-eye>${IC.eye}</button>` : ''}</div>`;

const getSaved = () => { try { return localStorage.getItem('cmp_email') || ''; } catch { return ''; } };
const setSaved = v => { try { v ? localStorage.setItem('cmp_email', v) : localStorage.removeItem('cmp_email'); } catch {} };

export function authView(boot, mode = 'login') {
  const [title, sub, cta] = COPY[mode];
  const tabs = mode === 'login' || mode === 'register';
  const saved = getSaved();
  $('#app').innerHTML = `<div class="lg-shell">
  <aside class="lg-brand">
    <div class="lg-logo"><i>${IC.cross}</i>Centro Médico Premier</div>
    <div class="lg-hero"><h2>Su salud, en buenas manos.</h2><p>Gestione sus citas, consulte su expediente y reciba atención coordinada en un solo lugar.</p>
      <ul><li><i>${IC.cal}</i>Solicite y siga sus citas en línea</li><li><i>${IC.file}</i>Expediente, consultas y recetas digitales</li><li><i>${IC.shield}</i>Sus datos protegidos con acceso por roles</li></ul></div>
    <div class="lg-foot">© ${new Date().getFullYear()} Centro Médico Premier · Guatemala</div>
  </aside>
  <section class="lg-panel"><div class="lg-card">
    ${tabs ? `<div class="lg-tabs" role="tablist"><button type="button" data-m="login" class="${mode === 'login' ? 'on' : ''}">Ingresar</button><button type="button" data-m="register" class="${mode === 'register' ? 'on' : ''}">Registrarme</button></div>`
      : mode === 'forgot' ? `<a class="lg-back" data-m="login">${IC.back} Volver a ingresar</a>` : ''}
    <h1>${title}</h1><p class="lg-sub">${sub}</p>
    <div class="lg-msg" id="lg-msg" role="alert" hidden></div>
    <form id="lg-form" novalidate>
      ${mode === 'register' ? field('name', 'text', 'Nombre completo', 'user', 'autocomplete="name" required') : ''}
      ${mode !== 'recovery' ? field('email', 'email', 'Correo electrónico', 'mail', `autocomplete="email" required value="${esc(mode === 'login' ? saved : '')}"`) : ''}
      ${mode === 'login' || mode === 'register' || mode === 'recovery' ? field('password', 'password', mode === 'login' ? 'Contraseña' : 'Contraseña (mín. 8)', 'lock', `autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}" required minlength="${mode === 'login' ? 1 : 8}"`) : ''}
      ${mode === 'register' || mode === 'recovery' ? `<div class="lg-str" id="lg-str"><div><i></i><i></i><i></i><i></i></div><small></small></div>${field('password2', 'password', 'Confirmar contraseña', 'lock', 'autocomplete="new-password" required')}` : ''}
      ${mode === 'login' ? `<div class="lg-row"><label class="lg-chk"><input type="checkbox" id="lg-rem" ${saved ? 'checked' : ''}> Recordar mi correo</label><a data-m="forgot">¿Olvidó su contraseña?</a></div>` : '<div style="height:6px"></div>'}
      
      ${mode === 'login' ? `
        <div class="lg-captcha" style="display:flex; justify-content:center; margin:1rem 0; min-height:78px;">
          <div class="g-recaptcha" data-sitekey="${RECAPTCHA_SITE_KEY}" data-theme="light"></div>
        </div>
      ` : ''}
      
      <button class="lg-btn" id="lg-go">${cta}</button>
    </form>
    <div class="lg-secure">${IC.lock.replace(/width="20" height="20"/, 'width="14" height="14"')} Conexión cifrada · Acceso protegido</div>
  </div></section></div>`;

  const msg = (t, type = 'err') => { const m = $('#lg-msg'); m.className = 'lg-msg ' + type; m.textContent = t; m.hidden = !t; };
  const busy = on => { const b = $('#lg-go'); b.disabled = on; b.innerHTML = on ? '<span class="sp"></span>Procesando…' : cta; };

  document.querySelectorAll('[data-m]').forEach(el => (el.onclick = () => authView(boot, el.dataset.m)));
  document.querySelectorAll('[data-eye]').forEach(b => (b.onclick = () => {
    const i = b.parentElement.querySelector('input'), show = i.type === 'password';
    i.type = show ? 'text' : 'password'; b.innerHTML = show ? IC.off : IC.eye; b.setAttribute('aria-label', show ? 'Ocultar contraseña' : 'Mostrar contraseña');
  }));
  const pw = $('#lg-password');
  if ($('#lg-str') && pw) pw.oninput = () => {
    const s = strength(pw.value), box = $('#lg-str');
    box.classList.toggle('show', !!s); box.dataset.s = s; $('small', box).textContent = ['', 'Muy débil', 'Débil — añada mayúsculas y números', 'Buena', 'Excelente'][s];
  };

  const done = (text) => {
    $('.lg-card').innerHTML = `<div class="lg-done"><div class="ic">${IC.ok}</div><h1>¡Listo!</h1><p class="lg-sub">${esc(text)}</p><button class="lg-btn" id="lg-back">Volver a ingresar</button></div>`;
    $('#lg-back').onclick = () => authView(boot, 'login');
  };

  $('#lg-form').onsubmit = async e => {
    e.preventDefault(); msg('');
    const f = Object.fromEntries(new FormData(e.target));
    const bad = n => $('#lg-' + n)?.parentElement.classList.add('bad');
    document.querySelectorAll('.lg-f.bad').forEach(x => x.classList.remove('bad'));
    
    if (mode !== 'recovery' && !/^\S+@\S+\.\S+$/.test(f.email || '')) { bad('email'); return msg('Ingrese un correo válido.'); }
    if (mode === 'register' && !f.name.trim()) { bad('name'); return msg('Ingrese su nombre completo.'); }
    if ((mode === 'register' || mode === 'recovery') && (f.password.length < 8)) { bad('password'); return msg('La contraseña debe tener al menos 8 caracteres.'); }
    if ((mode === 'register' || mode === 'recovery') && f.password !== f.password2) { bad('password2'); return msg('Las contraseñas no coinciden.'); }
    if (mode === 'login' && !f.password) { bad('password'); return msg('Ingrese su contraseña.'); }

    // Validación de reCAPTCHA (solo en login)
    if (mode === 'login') {
      const recaptchaToken = document.getElementById('g-recaptcha-response')?.value;
      if (!recaptchaToken) {
        msg('Por favor, complete la verificación de seguridad.');
        return;
      }
    }

    busy(true);
    try {
      if (mode === 'login') {
        const recaptchaToken = document.getElementById('g-recaptcha-response')?.value;
        
        // 1. Validar reCAPTCHA en el servidor (la clave secreta está protegida)
        const { data: captchaResult, error: captchaError } = await sb.rpc('verify_recaptcha', {
          p_token: recaptchaToken
        });
        
        if (captchaError) {
          console.warn('Error validando captcha:', captchaError);
          // Degradación elegante: si el servidor falla, permitir login pero registrar
        } else if (captchaResult && !captchaResult.success) {
          // Captcha inválido
          if (window.grecaptcha) window.grecaptcha.reset();
          throw new Error('Verificación de seguridad fallida. Por favor, intente de nuevo.');
        }

        // 2. Intentar login
        const { data: authData, error } = await sb.auth.signInWithPassword({ email: f.email.trim(), password: f.password });
        if (error) {
          if (window.grecaptcha) window.grecaptcha.reset();
          throw error;
        }

        // 3. Resetear reCAPTCHA después de login exitoso
        if (window.grecaptcha) window.grecaptcha.reset();

        // 4. Verificación de multi-sesión
        try {
          const { data: canLogin, error: checkError } = await sb.rpc('check_can_login', { p_user_id: authData.user.id });
          if (checkError) throw checkError;
          
          if (canLogin && !canLogin.allowed) {
            await sb.auth.signOut({ scope: 'local' });
            throw new Error(canLogin.message || 'Este usuario ya tiene una sesión activa en otro dispositivo.');
          }

          const { data: { session } } = await sb.auth.getSession();
          await sb.rpc('register_session', {
            p_refresh_token_id: session?.refresh_token || 'unknown',
            p_device_info: navigator.userAgent.substring(0, 200),
            p_ip_address: null
          });
        } catch (sessionErr) {
          if (sessionErr.message && sessionErr.message.includes('sesión activa')) {
            throw sessionErr;
          }
          console.warn('Aviso de verificación de sesión:', sessionErr);
        }

        setSaved($('#lg-rem').checked ? f.email.trim() : '');
        return boot();
      }
      if (mode === 'register') {
        const { data, error } = await sb.auth.signUp({ email: f.email.trim(), password: f.password, options: { data: { full_name: f.name.trim() }, emailRedirectTo: location.origin } });
        if (error) throw error;
        if (data.session) return boot();
        return done('Cuenta creada. Revise su correo y confirme su cuenta para poder ingresar.');
      }
      if (mode === 'forgot') {
        const { error } = await sb.auth.resetPasswordForEmail(f.email.trim(), { redirectTo: location.origin });
        if (error && !/rate limit|too many/i.test(error.message)) console.warn(error.message);
        if (error && /rate limit|too many/i.test(error.message)) throw error;
        return done('Si el correo está registrado, recibirá un enlace para restablecer su contraseña.');
      }
      if (mode === 'recovery') {
        const { error } = await sb.auth.updateUser({ password: f.password });
        if (error) throw error;
        history.replaceState(null, '', location.pathname);
        return boot();
      }
    } catch (err) { msg(toEs(err.message)); busy(false); }
  };
  ($('#lg-email') || $('#lg-password'))?.focus();
}
