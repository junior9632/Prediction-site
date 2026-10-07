/* ==========================================================================
   GoalPredict — shared frontend helpers (vanilla JS, no frameworks)
   All data comes from our own Node.js API. No third party calls, no keys.
   ========================================================================== */
'use strict';

const App = (() => {
  /* ------------------------------ cookies ----------------------------- */
  function readCookie(name) {
    const match = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/([.$?*|{}()[\]\\/+^])/g, '\\$1') + '=([^;]*)'));
    return match ? decodeURIComponent(match[1]) : null;
  }

  /* ------------------------------- api -------------------------------- */
  const API = {
    base: '/api',
    csrf() {
      return readCookie('fp_csrf');
    },
    async request(path, options = {}) {
      const headers = Object.assign({ Accept: 'application/json' }, options.headers || {});
      if (options.body !== undefined) headers['Content-Type'] = 'application/json';
      const csrf = API.csrf();
      if (csrf && options.method && options.method !== 'GET') headers['X-CSRF-Token'] = csrf;

      const res = await fetch(API.base + path, {
        method: options.method || 'GET',
        headers,
        credentials: 'same-origin',
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        cache: options.cache || 'no-store',
      });

      let payload = null;
      try {
        payload = await res.json();
      } catch (_) {
        payload = null;
      }

      if (!res.ok) {
        const err = new Error((payload && payload.error && payload.error.message) || `Request failed (${res.status})`);
        err.status = res.status;
        err.code = payload && payload.error ? payload.error.code : 'HTTP_' + res.status;
        err.details = payload && payload.error ? payload.error.details : null;
        throw err;
      }
      return payload ? payload.data : null;
    },
    get(path) {
      return API.request(path);
    },
    post(path, body) {
      return API.request(path, { method: 'POST', body });
    },
    put(path, body) {
      return API.request(path, { method: 'PUT', body });
    },
    del(path) {
      return API.request(path, { method: 'DELETE' });
    },
  };

  /* ------------------------------ format ------------------------------ */
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function toDate(value) {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const fmt = {
    dayLabel(value) {
      const d = toDate(value);
      if (!d) return '—';
      return `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
    },
    timeLabel(value) {
      const d = toDate(value);
      if (!d) return '—';
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    },
    dateTimeLabel(value) {
      const d = toDate(value);
      if (!d) return '—';
      return `${fmt.dayLabel(d)} · ${fmt.timeLabel(d)}`;
    },
    kickoffLabel(value) {
      const d = toDate(value);
      if (!d) return '—';
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      const diff = Math.round((day - today) / 86400000);
      const time = fmt.timeLabel(d);
      if (diff === 0) return `Today ${time}`;
      if (diff === 1) return `Tomorrow ${time}`;
      if (diff === -1) return `Yesterday ${time}`;
      return `${fmt.dayLabel(d)} ${time}`;
    },
    ago(value) {
      const d = toDate(value);
      if (!d) return '—';
      const mins = Math.floor((Date.now() - d.getTime()) / 60000);
      if (mins < 1) return 'just now';
      if (mins < 60) return `${mins}m ago`;
      const hours = Math.floor(mins / 60);
      if (hours < 24) return `${hours}h ago`;
      const days = Math.floor(hours / 24);
      return `${days}d ago`;
    },
    odds(value) {
      if (value === null || value === undefined || value === '') return '—';
      const n = Number(value);
      if (!Number.isFinite(n)) return String(value);
      return n.toFixed(2);
    },
    pct(value) {
      if (value === null || value === undefined) return '—';
      return `${Math.round(Number(value))}%`;
    },
    num(value, dp = 2) {
      if (value === null || value === undefined) return '—';
      const n = Number(value);
      return Number.isFinite(n) ? n.toFixed(dp) : '—';
    },
  };

  /* -------------------------------- dom ------------------------------- */
  function el(tag, className, html) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (html !== undefined) node.innerHTML = html;
    return node;
  }

  function clear(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  function setText(selector, text) {
    const node = typeof selector === 'string' ? document.querySelector(selector) : selector;
    if (node) node.textContent = text === null || text === undefined ? '—' : String(text);
    return node;
  }

  function show(node, visible) {
    const n = typeof node === 'string' ? document.querySelector(node) : node;
    if (n) n.classList.toggle('hidden', !visible);
    return n;
  }

  function escapeHtml(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* ------------------------------- icons ------------------------------ */
  const svg = (path, extra = '') =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${extra}>${path}</svg>`;

  const icons = {
    ball: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7l3.5 2.6-1.3 4.1h-4.4L8.5 9.6 12 7z"/><path d="M12 3v4M4.5 9.5l4 .1M19.5 9.5l-4 .1M7 19l2.8-3.3M17 19l-2.8-3.3"/>'),
    ticket: svg('<path d="M3 9a2 2 0 0 0 2-2V5h14v2a2 2 0 0 0 0 4v2a2 2 0 0 0 0 4v2H5v-2a2 2 0 0 0-2-2z" transform="translate(0 1)"/><path d="M13 6v2M13 11v2M13 16v2"/>'),
    bolt: svg('<path d="M13 2L4 14h6l-1 8 9-12h-6l1-8z"/>'),
    shield: svg('<path d="M12 3l8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V6l8-3z"/><path d="M9 12l2 2 4-4"/>'),
    check: svg('<path d="M4 12.5l5 5L20 6.5"/>'),
    checkCircle: svg('<circle cx="12" cy="12" r="9"/><path d="M8.5 12.5l2.5 2.5 5-5.5"/>'),
    clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>'),
    chart: svg('<path d="M4 20V10M10 20V4M16 20v-8M22 20H2"/>'),
    target: svg('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.4"/>'),
    users: svg('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"/><circle cx="17.5" cy="9" r="2.8"/><path d="M16 14.4c3.1.3 5.5 2.4 5.5 5.6"/>'),
    settings: svg('<circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.01a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55h.01a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.01a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z"/>'),
    logout: svg('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/>'),
    alert: svg('<path d="M12 3l10 18H2L12 3z"/><path d="M12 10v5M12 18.5v.5"/>'),
    info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>'),
    x: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
    refresh: svg('<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>'),
    lock: svg('<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>'),
    calendar: svg('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/>'),
    database: svg('<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>'),
    activity: svg('<path d="M22 12h-4l-3 8-6-16-3 8H2"/>'),
    history: svg('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 8v4l3 2"/>'),
    home: svg('<path d="M3 10.5L12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>'),
    sparkles: svg('<path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8L12 3z"/><path d="M19 15l.9 2.3 2.1.9-2.1.9L19 21.5l-.9-2.4-2.1-.9 2.1-.9L19 15z"/>'),
    eye: svg('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>'),
    arrowLeft: svg('<path d="M19 12H5M11 6l-6 6 6 6"/>'),
    chevronDown: svg('<path d="M6 9l6 6 6-6"/>'),
    layers: svg('<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/>'),
    whistle: svg('<circle cx="8" cy="14" r="5"/><path d="M13 12l8-3v4l-8 1"/><path d="M8 9V6M5 10L3 8"/>'),
  };

  /* ----------------------------- fragments ---------------------------- */
  function statusBadge(ticket) {
    if (!ticket) return `<span class="badge badge-slate">—</span>`;
    if (ticket.status === 'QUALIFIED') {
      const result = ticket.result;
      if (result === 'WON') return `<span class="badge badge-green">${icons.check} Won</span>`;
      if (result === 'LOST') return `<span class="badge badge-red">${icons.x} Lost</span>`;
      if (result === 'VOID' || result === 'PARTIAL_VOID') return `<span class="badge badge-amber">${icons.info} Void</span>`;
      return `<span class="badge badge-green">${icons.checkCircle} Qualified</span>`;
    }
    if (ticket.status === 'NO_QUALIFYING_TICKET') return `<span class="badge badge-slate">${icons.info} No qualifying ticket</span>`;
    if (ticket.status === 'DATA_SOURCE_UNAVAILABLE') return `<span class="badge badge-amber">${icons.alert} Data unavailable</span>`;
    return `<span class="badge badge-slate">${icons.clock} Pending</span>`;
  }

  function verifiedChip(odds) {
    if (!odds || !odds.verifiedAt) return `<span class="verified-chip stale">${icons.alert} Not verified</span>`;
    const label = odds.verifiedAgo || fmt.ago(odds.verifiedAt);
    return `<span class="verified-chip" title="Bookmaker price verified on our server">${icons.checkCircle} Verified ${escapeHtml(label)}</span>`;
  }

  /** One accumulator selection row (homepage + ticket page + admin). */
  function pickRow(pick, options = {}) {
    const leagueLogo = pick.league && pick.league.logo ? `<img src="${escapeHtml(pick.league.logo)}" alt="" loading="lazy">` : '';
    const score = pick.score
      ? `<span class="score-pill" title="Final score (90 minutes)">${pick.score.home}-${pick.score.away}</span>`
      : '';
    const resultBadge =
      pick.result && pick.result !== 'PENDING'
        ? pick.result === 'WON'
          ? `<span class="badge badge-green">${icons.check} Won</span>`
          : pick.result === 'LOST'
            ? `<span class="badge badge-red">${icons.x} Lost</span>`
            : `<span class="badge badge-amber">${icons.info} ${escapeHtml(pick.result)}</span>`
        : '';

    return `
      <article class="pick-row">
        <span class="pick-index" aria-hidden="true"></span>
        <div class="pick-main">
          <div class="pick-top">
            <span class="league-chip">${leagueLogo}<span>${escapeHtml((pick.league && pick.league.name) || 'League')}</span></span>
            ${resultBadge}${score}
          </div>
          <div class="pick-teams">${escapeHtml(pick.homeTeam && pick.homeTeam.name ? pick.homeTeam.name : 'Home')}<span class="vs">vs</span>${escapeHtml(pick.awayTeam && pick.awayTeam.name ? pick.awayTeam.name : 'Away')}</div>
          <div class="pick-meta">
            <span>${icons.calendar} ${escapeHtml(fmt.kickoffLabel(pick.kickoffAt))}</span>
            ${options.showVerified === false ? '' : verifiedChip(pick.odds)}
          </div>
        </div>
        <div class="pick-side">
          <div>
            <div class="market-label">Over 1.5 Goals</div>
            <div class="market-book">${escapeHtml((pick.odds && pick.odds.bookmaker) || 'Bookmaker')}</div>
          </div>
          <div class="row">
            <span class="odds-badge">${escapeHtml(fmt.odds(pick.odds && pick.odds.display !== undefined ? pick.odds.display : pick.odds && pick.odds.value))}</span>
            <div class="conf-pill">
              <div class="n">${fmt.pct(pick.confidence)}</div>
              <div class="l">Confidence</div>
              <div class="conf-bar"><i style="width:${Math.max(4, Math.min(100, Math.round(Number(pick.confidence) || 0)))}%"></i></div>
            </div>
          </div>
        </div>
      </article>`;
  }

  /** The "why this match" evidence bullets from the stored analysis. */
  function pickEvidence(pick) {
    const snap = pick.snapshot || {};
    const lines = [];
    if (snap.expectedTotalGoals !== null && snap.expectedTotalGoals !== undefined) {
      lines.push(`Modelled goal expectancy: <b>${fmt.num(snap.expectedTotalGoals)}</b> total goals`);
    }
    if (snap.impliedProbability) lines.push(`Bookmaker implied chance: <b>${fmt.pct(snap.impliedProbability * 100)}</b>`);
    if (snap.bookmakersOffering) lines.push(`<b>${snap.bookmakersOffering}</b> bookmaker(s) quote this exact Over 1.5 price`);
    if (!lines.length) lines.push('Verified Over 1.5 price from a real bookmaker.');
    lines.push('Odds frozen at generation time — the snapshot never changes.');
    return `<ul class="small muted" style="margin:6px 0 0; padding-left:18px;">${lines.map((l) => `<li>${l}</li>`).join('')}</ul>`;
  }

  function emptyState(icon, title, message) {
    return `<div class="empty-state">
      <div class="icon">${icons[icon] || icons.info}</div>
      <h3>${escapeHtml(title)}</h3>
      <p>${escapeHtml(message)}</p>
    </div>`;
  }

  function skeletonRows(count = 3) {
    return Array.from({ length: count })
      .map(() => `<div class="skeleton block" style="margin:10px 16px;"></div>`)
      .join('');
  }

  /* ------------------------- session helpers -------------------------- */
  const session = {
    cache: null,
    async me() {
      try {
        const data = await API.get('/auth/me');
        session.cache = data;
        return data;
      } catch (_) {
        session.cache = null;
        return null;
      }
    },
    reset() {
      session.cache = null;
    },
    /** Wire the shared header login controls on every page. */
    bindHeader() {
      const loginBtn = document.querySelector('[data-auth-login]');
      const signed = document.querySelector('[data-auth-signed]');
      const nameNode = document.querySelector('[data-auth-name]');
      const logoutBtn = document.querySelector('[data-auth-logout]');
      // Public marketing CTAs: shown to visitors, replaced by the dashboard
      // shortcut once a session exists. This is presentation only — every
      // account scoped value still comes from the server-side guarded API.
      const guestNodes = document.querySelectorAll('[data-auth-guest]');
      const memberCtaNodes = document.querySelectorAll('[data-auth-signed-cta]');
      const dashboardNodes = document.querySelectorAll('[data-auth-dashboard]');

      const paint = () => {
        const me = session.cache;
        const isAuthed = Boolean(me);
        const isAdmin = isAuthed && me.type === 'admin';
        if (loginBtn) loginBtn.classList.toggle('hidden', isAuthed);
        if (signed) signed.classList.toggle('hidden', !isAuthed);
        guestNodes.forEach((node) => node.classList.toggle('hidden', isAuthed));
        memberCtaNodes.forEach((node) => node.classList.toggle('hidden', !isAuthed));
        // administrators get their console from its own unlisted address; the
        // member shortcut is not offered to them
        dashboardNodes.forEach((node) => node.classList.toggle('hidden', isAdmin));
        if (nameNode && me) {
          nameNode.textContent = me.account ? me.account.username : 'Account';
          nameNode.href = me.type === 'admin' ? '/account.html' : '/dashboard';
          nameNode.setAttribute('aria-label', 'Open my account');
        }
      };

      session.me().then(paint).catch(paint);

      if (logoutBtn) {
        logoutBtn.addEventListener('click', async () => {
          try {
            await API.post('/auth/logout', {});
          } catch (_) {
            /* ignore */
          }
          session.reset();
          window.location.href = '/';
        });
      }
      return session;
    },
  };

  return { API, fmt, el, clear, setText, show, escapeHtml, icons, statusBadge, verifiedChip, pickRow, pickEvidence, emptyState, skeletonRows, session, readCookie };
})();

window.App = App;

/* ----------------------- PWA service worker ------------------------- */
// Registered from an external file because CSP forbids inline scripts.
// The worker never caches /api/ — live tickets and odds only.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* a failed registration must never break the page */
    });
  });
}
