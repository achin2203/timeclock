/* TimeClock — mobile web client. No build step; plain modern JS. */
(() => {
  'use strict';

  // ---------- tiny helpers ----------
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
  const app = $('#app');
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  };

  const state = { me: null, config: null, orgId: null, org: null, member: null, isAdmin: false, timers: [] };

  async function api(method, path, body) {
    const res = await fetch('/api' + path, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
    if (!res.ok) {
      const err = new Error(data?.error || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function money(cents, currency = state.org?.currency || 'USD') {
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format((cents || 0) / 100);
    } catch {
      return ((cents || 0) / 100).toFixed(2);
    }
  }
  const hm = (min) => `${Math.floor(min / 60)}h ${String(Math.round(min % 60)).padStart(2, '0')}m`;
  const tz = () => state.org?.timezone;
  const fmtTime = (ms) => new Intl.DateTimeFormat(undefined, { timeZone: tz(), hour: 'numeric', minute: '2-digit' }).format(ms);
  const fmtDate = (ms) =>
    new Intl.DateTimeFormat(undefined, { timeZone: tz(), weekday: 'short', month: 'short', day: 'numeric' }).format(ms);
  const fmtDay = (ymd) => {
    const [y, m, d] = ymd.split('-').map(Number);
    return new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(
      Date.UTC(y, m - 1, d, 12)
    );
  };
  const clockStr = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };
  // <input type="datetime-local"> uses the phone's local time.
  const toLocalInput = (ms) => {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const fromLocalInput = (v) => (v ? new Date(v).getTime() : null);
  const initials = (n) => (n || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  const methodLabel = { cash: 'Cash', bank: 'Bank transfer', check: 'Check', other: 'Other' };

  let toastT;
  function toast(msg, isErr) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast' + (isErr ? ' err' : '');
    t.hidden = false;
    clearTimeout(toastT);
    toastT = setTimeout(() => (t.hidden = true), 2600);
  }
  const vibrate = (p) => { try { navigator.vibrate?.(p); } catch { /* ignore */ } };

  function clearTimers() {
    state.timers.forEach(clearInterval);
    state.timers = [];
  }
  // Ticks every element with data-since=<ms> (elapsed timer) and data-rate=<cents/h> (running wage).
  function startTicking() {
    const tick = () => {
      const now = Date.now();
      $$('[data-since]').forEach((el) => {
        const since = Number(el.dataset.since);
        if (el.dataset.rate) el.textContent = money(Math.round((Number(el.dataset.rate) * (now - since)) / 3600000));
        else el.textContent = clockStr(now - since);
      });
    };
    tick();
    state.timers.push(setInterval(tick, 1000));
  }

  // Busy-state wrapper for buttons.
  async function busy(btn, fn) {
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      await fn();
    } catch (e) {
      toast(e.message, true);
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- bottom sheet ----------
  function sheet(html, onMount) {
    const root = $('#sheet-root');
    root.innerHTML = `<div class="backdrop"></div><div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div>${html}</div>`;
    const close = () => (root.innerHTML = '');
    $('.backdrop', root).onclick = close;
    $$('[data-close]', root).forEach((b) => (b.onclick = close));
    onMount?.($('.sheet', root), close);
    $('input:not([type=hidden])', root)?.focus({ preventScroll: true });
    return close;
  }

  // ---------- navigation ----------
  const ICONS = {
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    team: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.7-3.5 3.3-5.5 6.5-5.5s5.8 2 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.8c2 .7 3.2 2.5 3.5 5.2"/></svg>',
    history: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
    settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  };
  function renderTabs(active) {
    const nav = $('#tabs');
    if (!state.orgId) return (nav.hidden = true);
    const tabs = [['clock', 'Clock', '#/'], ['history', 'History', '#/history']];
    if (state.isAdmin) tabs.push(['team', 'Team', '#/team']);
    tabs.push(['settings', 'Settings', '#/settings']);
    nav.innerHTML = tabs
      .map(([k, label, href]) => `<a href="${href}" class="${active === k ? 'on' : ''}">${ICONS[k]}<span>${label}</span></a>`)
      .join('');
    nav.hidden = false;
  }

  async function route() {
    clearTimers();
    $('#sheet-root').innerHTML = '';
    const hash = location.hash.replace(/^#/, '') || '/';
    try {
      state.config ||= await api('GET', '/auth/config').catch(() => ({}));
      if (!state.me) await loadMe();
      if (!state.me) return renderLogin();
      if (!state.orgId) return renderSetup();
      if (!state.org) await loadOrg();

      const m = hash.match(/^\/team\/([\w-]+)$/);
      if (hash === '/team' && state.isAdmin) return await renderTeam();
      if (m && state.isAdmin) return await renderMember(m[1]);
      if (hash === '/history') return await renderHistory();
      if (hash === '/settings') return renderSettings();
      if (hash === '/new-org') return renderSetup(true);
      return await renderClock();
    } catch (e) {
      if (e.status === 401) {
        state.me = null;
        return renderLogin();
      }
      if (e.status === 404 && state.orgId) {
        state.orgId = null;
        state.org = null;
        store.set('orgId', '');
        return route();
      }
      app.innerHTML = `<div class="card center"><p>${esc(e.message)}</p><button class="btn" id="retry">Try again</button></div>`;
      $('#retry').onclick = route;
    }
  }
  window.addEventListener('hashchange', route);
  const go = (h) => (location.hash === h ? route() : (location.hash = h));

  async function loadMe() {
    try {
      state.me = await api('GET', '/me');
    } catch (e) {
      if (e.status === 401) state.me = null;
      else throw e;
    }
    if (!state.me) return;
    const saved = store.get('orgId');
    const orgs = state.me.orgs;
    state.orgId = orgs.find((o) => o.id === saved)?.id || orgs[0]?.id || null;
  }
  async function loadOrg() {
    const r = await api('GET', `/orgs/${state.orgId}`);
    state.org = r.org;
    state.member = r.me;
    state.isAdmin = r.isAdmin;
    store.set('orgId', String(state.orgId));
  }
  function switchOrg(id) {
    state.orgId = id;
    state.org = null;
    store.set('orgId', String(id));
    go('#/');
  }

  // ---------- login ----------
  async function renderLogin() {
    $('#tabs').hidden = true;
    app.innerHTML = `
      <img class="login-logo" src="/icon.svg" alt="" />
      <h1 class="center">TimeClock</h1>
      <p class="center muted">Clock in, clock out, get paid right.</p>
      <div class="card" id="login-card">
        <form id="f-target" novalidate>
          <label class="field"><span>${state.config.sms ? 'Phone number or email' : 'Email address'}</span>
            <input id="target" autocomplete="username" inputmode="email" placeholder="${state.config.sms ? '(919) 555-0101 or you@email.com' : 'you@email.com'}" required />
          </label>
          <div class="error" id="err"></div>
          <button class="btn" type="submit">Send me a code</button>
        </form>
        ${state.config.googleClientId || state.config.facebookAppId ? '<div class="divider">or</div><div class="social" id="social"></div>' : ''}
      </div>`;
    $('#f-target').onsubmit = async (ev) => {
      ev.preventDefault();
      const btn = $('button', ev.target);
      const target = $('#target').value.trim();
      $('#err').textContent = '';
      await busy(btn, async () => {
        try {
          const r = await api('POST', '/auth/otp/request', { target });
          renderCode(r);
        } catch (e) {
          $('#err').textContent = e.message;
        }
      });
    };
    mountSocial();
  }

  function renderCode(r) {
    const card = $('#login-card');
    card.innerHTML = `
      <p class="center">We sent a 6-digit code to<br /><b>${esc(r.target)}</b>${r.kind === 'email' ? '<br /><span class="muted small">Check your spam folder if it isn\'t there in a minute.</span>' : ''}</p>
      <form id="f-code" novalidate>
        <input id="code" class="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]*" placeholder="••••••" />
        ${r.devCode ? `<div class="hint">Dev mode — no email/SMS configured. Your code is <b>${esc(r.devCode)}</b></div>` : ''}
        <div class="error" id="err"></div>
        <button class="btn" type="submit">Sign in</button>
        <button class="btn ghost" type="button" id="back">Use a different number or email</button>
      </form>`;
    const code = $('#code');
    code.focus();
    const submit = async () => {
      const btn = $('#f-code button[type=submit]');
      await busy(btn, async () => {
        try {
          await api('POST', '/auth/otp/verify', { target: r.target, code: code.value });
          await afterLogin();
        } catch (e) {
          $('#err').textContent = e.message;
          code.select();
        }
      });
    };
    code.oninput = () => {
      code.value = code.value.replace(/\D/g, '').slice(0, 6);
      if (code.value.length === 6) submit();
    };
    $('#f-code').onsubmit = (ev) => {
      ev.preventDefault();
      submit();
    };
    $('#back').onclick = renderLogin;
  }

  async function afterLogin() {
    state.me = null;
    state.org = null;
    await loadMe();
    go('#/');
  }

  function loadScript(src) {
    return new Promise((ok, fail) => {
      if ($(`script[src="${src}"]`)) return ok();
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = ok;
      s.onerror = fail;
      document.head.appendChild(s);
    });
  }

  async function mountSocial() {
    const box = $('#social');
    if (!box) return;
    const { googleClientId, facebookAppId } = state.config;
    if (googleClientId) {
      const g = document.createElement('div');
      box.appendChild(g);
      try {
        await loadScript('https://accounts.google.com/gsi/client');
        google.accounts.id.initialize({
          client_id: googleClientId,
          callback: async ({ credential }) => {
            try {
              await api('POST', '/auth/google', { credential });
              await afterLogin();
            } catch (e) {
              toast(e.message, true);
            }
          },
        });
        google.accounts.id.renderButton(g, { theme: 'outline', size: 'large', shape: 'pill', text: 'continue_with', width: 300 });
      } catch {
        g.textContent = 'Google sign-in unavailable';
      }
    }
    if (facebookAppId) {
      const b = document.createElement('button');
      b.className = 'btn fb';
      b.style.maxWidth = '300px';
      b.textContent = 'Continue with Facebook';
      box.appendChild(b);
      b.onclick = async () => {
        try {
          await loadScript('https://connect.facebook.net/en_US/sdk.js');
          FB.init({ appId: facebookAppId, version: 'v19.0', cookie: false, xfbml: false });
          FB.login(
            async (resp) => {
              if (!resp.authResponse) return;
              try {
                await api('POST', '/auth/facebook', { accessToken: resp.authResponse.accessToken });
                await afterLogin();
              } catch (e) {
                toast(e.message, true);
              }
            },
            { scope: 'public_profile,email' }
          );
        } catch {
          toast('Facebook sign-in unavailable', true);
        }
      };
    }
  }

  const tzList = () => {
    let zones = [];
    try { zones = Intl.supportedValuesOf('timeZone'); } catch { /* older browsers */ }
    return `<datalist id="tzlist">${zones.map((z) => `<option value="${z}">`).join('')}</datalist>`;
  };

  // ---------- organisation setup ----------
  function renderSetup(isExtra) {
    $('#tabs').hidden = !isExtra;
    const guessTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York';
    const currencies = ['USD', 'INR', 'CAD', 'GBP', 'EUR', 'AUD', 'AED', 'SGD'];
    app.innerHTML = `
      ${isExtra ? '<a class="back" href="#/settings">‹ Back</a>' : ''}
      <h1>${isExtra ? 'New organization' : 'Welcome!'}</h1>
      ${isExtra ? '' : `<p class="muted">You're signed in as <b>${esc(state.me.user.email || state.me.user.phone)}</b>.</p>
      <div class="card"><b>Here to clock in?</b><p class="muted small" style="margin:6px 0 0">Ask your manager to add you using this phone number or email, then tap refresh.</p>
      <button class="btn secondary" style="margin-top:12px" id="refresh">Refresh</button></div>
      <h2>Or set up your business</h2>`}
      <form class="card" id="f-org">
        <label class="field"><span>Business name</span><input name="name" required placeholder="e.g. Sunrise Cafe" /></label>
        ${state.me.user.name ? '' : '<label class="field"><span>Your name</span><input name="yourName" required autocomplete="name" /></label>'}
        <label class="field"><span>Time zone</span><input name="timezone" list="tzlist" value="${esc(guessTz)}" /></label>${tzList()}
        <label class="field"><span>Currency</span><select name="currency">${currencies.map((c) => `<option>${c}</option>`).join('')}</select></label>
        <div class="error" id="err"></div>
        <button class="btn" type="submit">Create organization</button>
      </form>
      ${isExtra ? '' : '<button class="btn ghost" id="logout">Sign out</button>'}`;
    $('#refresh')?.addEventListener('click', afterLogin);
    $('#logout')?.addEventListener('click', logout);
    $('#f-org').onsubmit = async (ev) => {
      ev.preventDefault();
      const f = Object.fromEntries(new FormData(ev.target));
      await busy($('button[type=submit]', ev.target), async () => {
        try {
          const r = await api('POST', '/orgs', f);
          store.set('orgId', String(r.id));
          state.me = null;
          state.org = null;
          await loadMe();
          toast('Organization created — add your team next');
          go('#/team');
        } catch (e) {
          $('#err').textContent = e.message;
        }
      });
    };
  }

  // ---------- clock screen ----------
  function topbar() {
    const many = state.me.orgs.length > 1;
    return `<div class="topbar"><div class="org">${esc(state.org.name)}</div>${
      many ? '<button class="btn sm secondary" id="switch">Switch</button>' : ''
    }</div>`;
  }
  function wireTopbar() {
    $('#switch')?.addEventListener('click', () =>
      sheet(
        `<h3>Switch organization</h3><div class="list" style="margin-top:12px">${state.me.orgs
          .map(
            (o) => `<button class="item" data-org="${o.id}"><div class="grow"><div class="title">${esc(o.name)}</div>
            <div class="meta">${esc(o.role)}</div></div>${o.id === state.orgId ? '✓' : ''}</button>`
          )
          .join('')}</div>`,
        (el, close) =>
          $$('[data-org]', el).forEach((b) => (b.onclick = () => (close(), switchOrg(b.dataset.org))))
      )
    );
  }

  function balanceTile(bal, label = 'Balance owed to you') {
    const credit = bal.balanceCents < 0;
    return `<div class="stat owed ${credit ? 'credit' : ''}"><div class="label">${credit ? 'Paid in advance' : label}</div>
      <div class="value">${money(Math.abs(bal.balanceCents))}</div></div>`;
  }

  async function renderClock() {
    renderTabs('clock');
    const s = await api('GET', `/orgs/${state.orgId}/members/me/summary?from=${Date.now() - 8 * 86400000}`);
    const open = s.openShift;
    const today = s.days.find((d) => d.date === s.today) || { minutes: 0, wageCents: 0 };
    const name = state.me.user.name || s.member.name;
    app.innerHTML = `
      ${topbar()}
      <p class="muted" style="margin:0">Hi ${esc(name.split(' ')[0])} 👋</p>
      <div class="clock-wrap">
        <button id="clock" class="clock-btn ${open ? 'out' : ''}" aria-label="${open ? 'Clock out' : 'Clock in'}">
          ${open
            ? `<span class="sub">On the clock</span><span class="timer" data-since="${open.clockIn}">0:00:00</span><span>CLOCK OUT</span>`
            : `<span>CLOCK IN</span><span class="sub">${s.member.hourlyRateCents ? money(s.member.hourlyRateCents) + '/hr' : 'Tap to start'}</span>`}
        </button>
      </div>
      <div class="status-line">${open ? `Started at ${fmtTime(open.clockIn)} · earning <b data-since="${open.clockIn}" data-rate="${open.rateCents}"></b>` : 'You are clocked out'}</div>
      <div class="stats">
        <div class="stat"><div class="label">Today</div><div class="value">${hm(today.minutes)}</div><div class="small muted">${money(today.wageCents)}</div></div>
        ${balanceTile(s.balance)}
      </div>
      <h2>This week</h2>
      ${daysList(s.days.slice(0, 7))}
      <a class="btn ghost" href="#/history">See full history</a>`;
    wireTopbar();
    startTicking();
    $('#clock').onclick = (ev) =>
      busy(ev.currentTarget, async () => {
        if (open) {
          const r = await api('POST', `/orgs/${state.orgId}/clock/out`, {});
          vibrate([30, 60, 30]);
          toast(`Clocked out · ${hm(r.shift.minutes)} · ${money(r.shift.wageCents)}`);
        } else {
          await api('POST', `/orgs/${state.orgId}/clock/in`, {});
          vibrate(40);
          toast('Clocked in — have a great shift!');
        }
        await renderClock();
      });
  }

  function daysList(days) {
    if (!days.length) return '<div class="list"><div class="empty">No hours yet</div></div>';
    return `<div class="list">${days
      .map(
        (d) => `<div class="item"><div class="grow"><div class="title">${fmtDay(d.date)} ${d.inProgress ? '<span class="badge live">in progress</span>' : ''}</div>
        <div class="meta">${hm(d.minutes)} · ${d.shifts} shift${d.shifts > 1 ? 's' : ''}</div></div><div class="amt">${money(d.wageCents)}</div></div>`
      )
      .join('')}</div>`;
  }

  function shiftsList(shifts, editable) {
    if (!shifts.length) return '<div class="list"><div class="empty">No shifts in this period</div></div>';
    return `<div class="list">${shifts
      .map((x) => {
        const inner = `<div class="grow"><div class="title">${fmtDate(x.clockIn)}</div>
          <div class="meta">${fmtTime(x.clockIn)} – ${x.open ? '<span class="badge live">now</span>' : fmtTime(x.clockOut)} · ${hm(x.minutes)} @ ${money(x.rateCents)}/h${x.note ? ' · ' + esc(x.note) : ''}</div></div>
          <div class="amt">${money(x.wageCents)}</div>`;
        return editable ? `<button class="item" data-shift="${x.id}">${inner}</button>` : `<div class="item">${inner}</div>`;
      })
      .join('')}</div>`;
  }

  function paymentsList(pays, editable) {
    if (!pays.length) return '<div class="list"><div class="empty">No payments in this period</div></div>';
    return `<div class="list">${pays
      .map((p) => {
        const inner = `<div class="grow"><div class="title">${methodLabel[p.method] || p.method}</div>
          <div class="meta">${fmtDate(p.paidAt)} ${fmtTime(p.paidAt)}${p.note ? ' · ' + esc(p.note) : ''}</div></div>
          <div class="amt neg">−${money(p.amountCents)}</div>`;
        return editable ? `<button class="item" data-pay="${p.id}">${inner}</button>` : `<div class="item">${inner}</div>`;
      })
      .join('')}</div>`;
  }

  const PERIODS = [['7', '7 days'], ['30', '30 days'], ['90', '90 days'], ['3650', 'All']];
  const periodSeg = (cur) =>
    `<div class="seg" id="period">${PERIODS.map(([v, l]) => `<button data-p="${v}" class="${cur === v ? 'on' : ''}">${l}</button>`).join('')}</div>`;

  // ---------- my history ----------
  async function renderHistory(period = store.get('period') || '30', tab = 'days') {
    renderTabs('history');
    const s = await api('GET', `/orgs/${state.orgId}/members/me/summary?from=${Date.now() - Number(period) * 86400000}`);
    app.innerHTML = `
      ${topbar()}
      <h1>My history</h1>
      <div class="stats">
        <div class="stat"><div class="label">Earned (period)</div><div class="value">${money(s.period.earnedCents)}</div></div>
        <div class="stat"><div class="label">Paid (period)</div><div class="value">${money(s.period.paidCents)}</div></div>
      </div>
      <div class="stats">${balanceTile(s.balance)}<div class="stat"><div class="label">Hourly rate</div><div class="value">${money(s.member.hourlyRateCents)}</div></div></div>
      ${periodSeg(period)}
      <div class="seg" id="tab" style="margin-top:0">
        ${['days', 'shifts', 'payments'].map((t) => `<button data-t="${t}" class="${tab === t ? 'on' : ''}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}
      </div>
      ${tab === 'days' ? daysList(s.days) : tab === 'shifts' ? shiftsList(s.shifts, false) : paymentsList(s.payments, false)}`;
    wireTopbar();
    $$('#period button').forEach((b) => (b.onclick = () => (store.set('period', b.dataset.p), renderHistory(b.dataset.p, tab))));
    $$('#tab button').forEach((b) => (b.onclick = () => renderHistory(period, b.dataset.t)));
  }

  // ---------- team (admin) ----------
  async function renderTeam() {
    renderTabs('team');
    const { members } = await api('GET', `/orgs/${state.orgId}/members`);
    const active = members.filter((m) => m.active);
    const inactive = members.filter((m) => !m.active);
    const onClock = active.filter((m) => m.openShift).length;
    const owed = active.reduce((a, m) => a + Math.max(0, m.balanceCents), 0);
    const row = (m) => `
      <button class="item" data-m="${m.id}">
        <div class="avatar">${esc(initials(m.name))}${m.openShift ? '<span class="dot"></span>' : ''}</div>
        <div class="grow"><div class="title">${esc(m.name)} ${m.role !== 'employee' ? `<span class="badge">${m.role}</span>` : ''} ${m.linked ? '' : '<span class="badge warn">not signed in yet</span>'}</div>
          <div class="meta">${m.openShift ? `On shift · <span data-since="${m.openShift.clockIn}"></span>` : `${money(m.hourlyRateCents)}/hr`}</div></div>
        <div class="amt">${money(m.balanceCents)}<div class="meta">owed</div></div>
      </button>`;
    app.innerHTML = `
      ${topbar()}
      <h1>Team</h1>
      <div class="stats">
        <div class="stat"><div class="label">On the clock</div><div class="value">${onClock} / ${active.length}</div></div>
        <div class="stat owed"><div class="label">Total owed</div><div class="value">${money(owed)}</div></div>
      </div>
      <h2>Employees</h2>
      <div class="list">${active.map(row).join('') || '<div class="empty">No employees yet — tap + to add one</div>'}</div>
      ${inactive.length ? `<h2>Inactive</h2><div class="list">${inactive.map(row).join('')}</div>` : ''}
      <button class="fab" id="add" aria-label="Add employee">+</button>`;
    wireTopbar();
    startTicking();
    $$('[data-m]').forEach((b) => (b.onclick = () => go(`#/team/${b.dataset.m}`)));
    $('#add').onclick = () => memberSheet(null, renderTeam);
  }

  function memberSheet(m, after) {
    const isOwner = m?.role === 'owner';
    sheet(
      `<h3>${m ? 'Edit employee' : 'Add employee'}</h3>
      ${m ? '' : `<p class="muted small" style="margin:0">${state.config?.sms ? 'They sign in with this phone number or email (or a Google account with the same email).' : 'They sign in with this email address, or a Google account with the same email.'}</p>`}
      <form id="f-m">
        <label class="field"><span>Name</span><input name="name" required value="${esc(m?.name || '')}" autocomplete="off" /></label>
        <label class="field"><span>Email</span><input name="email" type="email" inputmode="email" value="${esc(m?.email || '')}" ${state.config?.sms ? 'placeholder="optional"' : 'required placeholder="name@email.com"'} /></label>
        <label class="field"><span>Mobile number</span><input name="phone" type="tel" inputmode="tel" value="${esc(m?.phone || '')}" placeholder="${state.config?.sms ? '(919) 555-0101' : 'optional, for your records'}" /></label>
        <label class="field"><span>Hourly rate (${esc(state.org.currency)})</span><input name="hourlyRate" inputmode="decimal" value="${m ? (m.hourlyRateCents / 100).toFixed(2) : ''}" placeholder="15.00" required /></label>
        ${m?.openShift ? '<label class="row small" style="margin-top:10px"><input type="checkbox" name="applyToOpenShift" style="width:22px;min-height:22px" /> Apply new rate to the shift in progress</label>' : ''}
        ${isOwner ? '' : `<label class="field"><span>Role</span><select name="role"><option value="employee">Employee</option><option value="admin" ${m?.role === 'admin' ? 'selected' : ''}>Admin (can manage team &amp; pay)</option></select></label>`}
        <div class="error" id="err"></div>
        <button class="btn" type="submit">${m ? 'Save' : 'Add employee'}</button>
        ${m && !isOwner ? `<button class="btn ${m.active ? 'danger' : 'secondary'}" type="button" id="toggle" style="margin-top:10px">${m.active ? 'Deactivate' : 'Reactivate'}</button>` : ''}
        <button class="btn ghost" type="button" data-close>Cancel</button>
      </form>`,
      (el, close) => {
        $('#f-m', el).onsubmit = async (ev) => {
          ev.preventDefault();
          const f = Object.fromEntries(new FormData(ev.target));
          f.applyToOpenShift = !!f.applyToOpenShift;
          await busy($('button[type=submit]', el), async () => {
            try {
              if (m) await api('PATCH', `/orgs/${state.orgId}/members/${m.id}`, f);
              else await api('POST', `/orgs/${state.orgId}/members`, f);
              close();
              toast(m ? 'Saved' : `${f.name} added`);
              after();
            } catch (e) {
              $('#err', el).textContent = e.message;
            }
          });
        };
        $('#toggle', el)?.addEventListener('click', async () => {
          await api('PATCH', `/orgs/${state.orgId}/members/${m.id}`, { active: !m.active }).catch((e) => toast(e.message, true));
          close();
          after();
        });
      }
    );
  }

  async function renderMember(id, period = store.get('period') || '30', tab = 'days') {
    renderTabs('team');
    const s = await api('GET', `/orgs/${state.orgId}/members/${id}/summary?from=${Date.now() - Number(period) * 86400000}`);
    const m = { ...s.member, openShift: s.openShift };
    const open = s.openShift;
    const rerender = (p = period, t = tab) => renderMember(id, p, t);
    const credit = s.balance.balanceCents < 0;
    app.innerHTML = `
      <div class="topbar"><a class="back" href="#/team">‹ Team</a><button class="btn sm secondary" id="edit">Edit</button></div>
      <div class="row"><div class="avatar">${esc(initials(m.name))}${open ? '<span class="dot"></span>' : ''}</div>
        <div class="grow"><h1 style="margin:0">${esc(m.name)}</h1><div class="muted small">${money(m.hourlyRateCents)}/hr · ${esc(m.phone || m.email || '')}</div></div></div>
      <div class="card hero-bal" style="margin-top:16px;background:${credit ? 'var(--primary-soft)' : 'var(--rose-soft)'}">
        <div class="muted small">${credit ? 'Paid in advance' : 'Balance owed'}</div>
        <div class="big">${money(Math.abs(s.balance.balanceCents))}</div>
        <div class="muted small">Earned ${money(s.balance.earnedCents)} · Paid ${money(s.balance.paidCents)}${open ? ' · + current shift' : ''}</div>
      </div>
      <button class="btn" id="pay" style="margin-top:12px">💵 Record cash payment</button>
      <div class="btn-row">
        <button class="btn ${open ? 'danger' : 'secondary'}" id="clk" style="flex-direction:column;gap:0">${open ? `<span>Clock out</span><span class="small mono" data-since="${open.clockIn}"></span>` : 'Clock them in'}</button>
        <button class="btn secondary" id="addshift">+ Add shift</button>
      </div>
      ${periodSeg(period)}
      <div class="stats" style="margin-top:0">
        <div class="stat"><div class="label">Earned (period)</div><div class="value">${money(s.period.earnedCents)}</div></div>
        <div class="stat"><div class="label">Paid (period)</div><div class="value">${money(s.period.paidCents)}</div></div>
      </div>
      <div class="seg" id="tab">
        ${['days', 'shifts', 'payments'].map((t) => `<button data-t="${t}" class="${tab === t ? 'on' : ''}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}
      </div>
      ${tab === 'days' ? daysList(s.days) : tab === 'shifts' ? shiftsList(s.shifts, true) : paymentsList(s.payments, true)}
      ${tab !== 'payments' ? '<p class="muted small center">Tap a shift to fix its times.</p>' : '<p class="muted small center">Tap a payment to delete it.</p>'}`;
    startTicking();
    $$('#period button').forEach((b) => (b.onclick = () => (store.set('period', b.dataset.p), rerender(b.dataset.p))));
    $$('#tab button').forEach((b) => (b.onclick = () => rerender(period, b.dataset.t)));
    $('#edit').onclick = () => memberSheet(m, () => rerender());
    $('#pay').onclick = () => paymentSheet(m, s.balance, () => rerender(period, 'payments'));
    $('#addshift').onclick = () => shiftSheet(m, null, () => rerender(period, 'shifts'));
    $('#clk').onclick = (ev) =>
      busy(ev.currentTarget, async () => {
        await api('POST', `/orgs/${state.orgId}/clock/${open ? 'out' : 'in'}`, { memberId: m.id });
        toast(open ? `${m.name} clocked out` : `${m.name} clocked in`);
        await rerender();
      });
    $$('[data-shift]').forEach(
      (b) => (b.onclick = () => shiftSheet(m, s.shifts.find((x) => x.id === b.dataset.shift), () => rerender(period, 'shifts')))
    );
    $$('[data-pay]').forEach((b) => {
      const p = s.payments.find((x) => x.id === b.dataset.pay);
      b.onclick = () =>
        sheet(
          `<h3>${money(p.amountCents)} ${methodLabel[p.method]}</h3><p class="muted">${fmtDate(p.paidAt)} ${fmtTime(p.paidAt)}${p.note ? '<br>' + esc(p.note) : ''}</p>
           <button class="btn danger" id="del">Delete this payment</button><button class="btn ghost" data-close>Cancel</button>`,
          (el, close) =>
            ($('#del', el).onclick = (ev) =>
              busy(ev.currentTarget, async () => {
                await api('DELETE', `/orgs/${state.orgId}/members/${m.id}/payments/${p.id}`);
                close();
                toast('Payment deleted');
                rerender(period, 'payments');
              }))
        );
    });
  }

  function paymentSheet(m, bal, after) {
    const owed = Math.max(0, bal.balanceCents);
    let method = 'cash';
    sheet(
      `<h3>Pay ${esc(m.name)}</h3>
      <p class="muted small" style="margin:0">Currently owed: <b>${money(bal.balanceCents)}</b></p>
      <form id="f-pay">
        <label class="field"><span>Amount (${esc(state.org.currency)})</span><input name="amount" class="money" inputmode="decimal" placeholder="0.00" required /></label>
        ${owed ? `<div class="chips" style="margin-top:10px"><button type="button" class="chip" data-amt="${(owed / 100).toFixed(2)}">Full balance ${money(owed)}</button>
          <button type="button" class="chip" data-amt="${(Math.round(owed / 2) / 100).toFixed(2)}">Half</button></div>` : ''}
        <label class="field"><span>Paid with</span></label>
        <div class="chips" id="methods">${Object.entries(methodLabel).map(([k, l]) => `<button type="button" class="chip ${k === 'cash' ? 'on' : ''}" data-method="${k}">${l}</button>`).join('')}</div>
        <label class="field"><span>Date &amp; time</span><input name="paidAt" type="datetime-local" value="${toLocalInput(Date.now())}" /></label>
        <label class="field"><span>Note</span><input name="note" placeholder="optional, e.g. weekly pay" /></label>
        <div id="after" class="hint" hidden></div>
        <div class="error" id="err"></div>
        <button class="btn" type="submit">Save payment</button>
        <button class="btn ghost" type="button" data-close>Cancel</button>
      </form>`,
      (el, close) => {
        const amt = $('[name=amount]', el);
        const preview = () => {
          const v = Math.round(Number(amt.value || 0) * 100);
          const box = $('#after', el);
          box.hidden = !v;
          box.innerHTML = `Balance after this payment: <b>${money(bal.balanceCents - v)}</b>`;
        };
        amt.oninput = preview;
        $$('[data-amt]', el).forEach((c) => (c.onclick = () => ((amt.value = c.dataset.amt), preview())));
        $$('[data-method]', el).forEach(
          (c) => (c.onclick = () => {
            method = c.dataset.method;
            $$('[data-method]', el).forEach((x) => x.classList.toggle('on', x === c));
          })
        );
        $('#f-pay', el).onsubmit = async (ev) => {
          ev.preventDefault();
          const f = Object.fromEntries(new FormData(ev.target));
          await busy($('button[type=submit]', el), async () => {
            try {
              const r = await api('POST', `/orgs/${state.orgId}/members/${m.id}/payments`, {
                amount: f.amount,
                method,
                note: f.note,
                paidAt: fromLocalInput(f.paidAt) || Date.now(),
              });
              close();
              vibrate(40);
              toast(`Paid ${money(r.payment.amountCents)} · balance ${money(r.balance.balanceCents)}`);
              after();
            } catch (e) {
              $('#err', el).textContent = e.message;
            }
          });
        };
      }
    );
  }

  function shiftSheet(m, x, after) {
    const now = Date.now();
    const defIn = x?.clockIn ?? now - 8 * 3600000;
    const defOut = x ? x.clockOut : now;
    sheet(
      `<h3>${x ? 'Edit shift' : 'Add shift'} · ${esc(m.name)}</h3>
      <form id="f-s">
        <label class="field"><span>Clock in</span><input name="clockIn" type="datetime-local" required value="${toLocalInput(defIn)}" /></label>
        <label class="field"><span>Clock out ${x?.open ? '(leave empty while still working)' : ''}</span><input name="clockOut" type="datetime-local" ${x?.open ? '' : 'required'} value="${defOut ? toLocalInput(defOut) : ''}" /></label>
        <label class="field"><span>Hourly rate for this shift</span><input name="hourlyRate" inputmode="decimal" value="${((x?.rateCents ?? m.hourlyRateCents) / 100).toFixed(2)}" /></label>
        <label class="field"><span>Note</span><input name="note" value="${esc(x?.note || '')}" placeholder="optional, e.g. forgot to clock out" /></label>
        <div id="calc" class="hint"></div>
        <div class="error" id="err"></div>
        <button class="btn" type="submit">Save shift</button>
        ${x ? '<button class="btn danger" type="button" id="del" style="margin-top:10px">Delete shift</button>' : ''}
        <button class="btn ghost" type="button" data-close>Cancel</button>
      </form>`,
      (el, close) => {
        const form = $('#f-s', el);
        const calc = () => {
          const a = fromLocalInput(form.clockIn.value);
          const b = fromLocalInput(form.clockOut.value) || (x?.open ? Date.now() : null);
          const rate = Math.round(Number(form.hourlyRate.value || 0) * 100);
          $('#calc', el).innerHTML =
            a && b && b > a ? `${hm((b - a) / 60000)} × ${money(rate)}/h = <b>${money(Math.round((rate * (b - a)) / 3600000))}</b>` : 'Check the times';
        };
        form.oninput = calc;
        calc();
        form.onsubmit = async (ev) => {
          ev.preventDefault();
          const body = {
            clockIn: fromLocalInput(form.clockIn.value),
            clockOut: fromLocalInput(form.clockOut.value),
            hourlyRate: form.hourlyRate.value,
            note: form.note.value,
          };
          await busy($('button[type=submit]', el), async () => {
            try {
              if (x) await api('PATCH', `/orgs/${state.orgId}/members/${m.id}/shifts/${x.id}`, body);
              else await api('POST', `/orgs/${state.orgId}/members/${m.id}/shifts`, body);
              close();
              toast('Shift saved');
              after();
            } catch (e) {
              $('#err', el).textContent = e.message;
            }
          });
        };
        $('#del', el)?.addEventListener('click', (ev) =>
          busy(ev.currentTarget, async () => {
            await api('DELETE', `/orgs/${state.orgId}/members/${m.id}/shifts/${x.id}`);
            close();
            toast('Shift deleted');
            after();
          })
        );
      }
    );
  }

  // ---------- settings ----------
  function renderSettings() {
    renderTabs('settings');
    const u = state.me.user;
    app.innerHTML = `
      ${topbar()}
      <h1>Settings</h1>
      <h2>You</h2>
      <form class="card" id="f-me">
        <label class="field" style="margin-top:0"><span>Your name</span><input name="name" value="${esc(u.name || state.member.name || '')}" autocomplete="name" /></label>
        <p class="muted small">Signed in as ${esc(u.email || u.phone)}</p>
        <button class="btn secondary" type="submit">Save name</button>
      </form>
      ${state.isAdmin ? `
      <h2>Organization</h2>
      <form class="card" id="f-org">
        <label class="field" style="margin-top:0"><span>Business name</span><input name="name" value="${esc(state.org.name)}" /></label>
        <label class="field"><span>Time zone</span><input name="timezone" list="tzlist" value="${esc(state.org.timezone)}" /></label>${tzList()}
        <label class="field"><span>Currency</span><input name="currency" value="${esc(state.org.currency)}" maxlength="3" /></label>
        <button class="btn secondary" type="submit" style="margin-top:14px">Save organization</button>
      </form>
      <h2>Payroll export</h2>
      <div class="card">
        <p class="muted small" style="margin-top:0">Download every shift (hours, rate, wage) as a spreadsheet.</p>
        <div class="chips">${[['7', 'Last 7 days'], ['14', 'Last 14 days'], ['31', 'Last 31 days']].map(([d, l]) => `<a class="chip" style="display:inline-flex;align-items:center;text-decoration:none;color:inherit" href="/api/orgs/${state.orgId}/export.csv?from=${Date.now() - d * 86400000}">${l}</a>`).join('')}</div>
      </div>` : ''}
      <h2>Account</h2>
      <div class="list">
        ${state.me.orgs.length > 1 ? '<button class="item" id="sw2"><div class="grow title">Switch organization</div>›</button>' : ''}
        <button class="item" id="neworg"><div class="grow title">Create another organization</div>›</button>
        <button class="item" id="logout"><div class="grow title" style="color:var(--rose)">Sign out</div></button>
      </div>`;
    wireTopbar();
    $('#sw2')?.addEventListener('click', () => $('#switch')?.click());
    $('#neworg').onclick = () => go('#/new-org');
    $('#logout').onclick = logout;
    $('#f-me').onsubmit = (ev) => {
      ev.preventDefault();
      busy($('button', ev.target), async () => {
        await api('PATCH', '/me', { name: ev.target.name.value });
        state.me.user.name = ev.target.name.value;
        toast('Saved');
      });
    };
    $('#f-org')?.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const f = Object.fromEntries(new FormData(ev.target));
      busy($('button', ev.target), async () => {
        await api('PATCH', `/orgs/${state.orgId}`, f);
        state.org = null;
        state.me = null;
        await loadMe();
        await loadOrg();
        toast('Saved');
        renderSettings();
      });
    });
  }

  async function logout() {
    await api('POST', '/auth/logout', {}).catch(() => {});
    Object.assign(state, { me: null, orgId: null, org: null, member: null, isAdmin: false });
    location.hash = '#/';
    renderLogin();
  }

  // Refresh when the app comes back to the foreground (e.g. phone unlocked).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.orgId && !$('#sheet-root').innerHTML) route();
  });

  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('/sw.js').catch(() => {});
  route();
})();
