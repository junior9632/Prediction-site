/* GoalPredict — public landing page
 *
 * DATA RULE (the reason this file is small): the homepage shows only what an
 * anonymous visitor is already allowed to read on the public pages —
 * `/ticket/today`, `/predictions`, `/analytics` — plus the shared session
 * check in api.js. It never calls a dashboard or console endpoint, it never
 * renders account-scoped data, and every personal surface (dashboard activity,
 * account statistics, ticket history, notifications) lives behind the guarded
 * dashboard API, which the server refuses with 401 unless a verified, active
 * session asks for its own data.
 */
'use strict';

/* Reveal-on-scroll needs a hook before first paint; if this script never runs
   the page is simply fully visible (no-JS safe). */
document.documentElement.classList.add('reveal-ready');

(function () {
  const { API, fmt, icons, escapeHtml, verifiedChip, skeletonRows, emptyState } = App;
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.prototype.slice.call(document.querySelectorAll(sel));

  /* Public endpoints only. Anything else would be a private surface. */
  const PUBLIC = {
    ticket: '/ticket/today',
    predictions: '/predictions?limit=6',
    analytics: '/analytics',
  };

  /* ------------------------- public: today's pick ------------------------- */

  function paintPreview(ticket) {
    const pill = $('#pvPill');
    const qualified = ticket.status === 'QUALIFIED';
    const offline = ticket.status === 'DATA_SOURCE_UNAVAILABLE';
    if (pill) pill.className = `pv-pill ${qualified ? 'ok' : offline ? 'bad' : 'warn'}`;
    App.setText('#pvPillText', qualified ? 'Published' : offline ? 'Data offline' : 'Not published');

    App.setText('#pvPicks', qualified ? ticket.selectionCount || 0 : '—');
    App.setText('#pvOdds', qualified && ticket.totalOdds ? fmt.odds(ticket.totalOdds) : '—');
    App.setText(
      '#pvProbability',
      qualified && ticket.estimatedProbability ? fmt.pct(ticket.estimatedProbability * 100) : '—'
    );

    if (qualified) {
      App.setText(
        '#pvNote',
        `${ticket.selectionCount} verified Over 1.5 selection${ticket.selectionCount === 1 ? '' : 's'} inside the ${ticket.oddsWindow ? `${ticket.oddsWindow.min.toFixed(2)}–${ticket.oddsWindow.max.toFixed(2)}` : '2.00–4.00'} range. Open the ticket for the verified prices and the evidence behind each leg.`
      );
    } else if (offline) {
      App.setText('#pvNote', 'The odds feed is unavailable right now, so nothing is published instead of guessing.');
    } else {
      App.setText('#pvNote', (ticket.noTicket && ticket.noTicket.message) || 'No prediction was published for today.');
    }
    App.setText('#pvGenerated', ticket.generatedAt ? `Generated ${fmt.dateTimeLabel(ticket.generatedAt)}` : 'Not generated yet');
  }

  /* ------------------------- public: the record --------------------------- */

  function paintRecord(stats) {
    const t = (stats && stats.tickets) || {};
    const over15 = (stats && stats.over15) || {};
    const flat = (stats && stats.flatStake) || {};

    App.setText('#statSettled', t.settled === undefined ? '—' : t.settled);
    App.setText('#statTicketWinRate', t.winRate === null || t.winRate === undefined ? '—' : fmt.pct(t.winRate));
    App.setText('#statLegWinRate', over15.winRate === null || over15.winRate === undefined ? '—' : fmt.pct(over15.winRate));
    App.setText('#statRoi', flat.roi === null || flat.roi === undefined ? '—' : `${Number(flat.roi) >= 0 ? '+' : ''}${fmt.num(flat.roi, 1)}%`);

    const roiNote = $('#statRoiNote');
    if (roiNote && flat.staked !== undefined) {
      roiNote.textContent = `${flat.staked} unit${flat.staked === 1 ? '' : 's'} staked · ${flat.profit >= 0 ? '+' : ''}${fmt.num(flat.profit, 2)} returned`;
    }
    const settledNote = $('#statSettledNote');
    if (settledNote && t.total !== undefined) {
      settledNote.textContent = `of ${t.total} generated · ${t.pending || 0} still open`;
    }
  }

  /* ------------------------ public: match cards --------------------------- */

  function matchCard(p) {
    const league = (p.league && p.league.name) || 'League';
    const home = p.homeTeam && p.homeTeam.name ? p.homeTeam.name : 'Home';
    const away = p.awayTeam && p.awayTeam.name ? p.awayTeam.name : 'Away';
    const probability = p.modelProbability === null || p.modelProbability === undefined ? null : p.modelProbability * 100;
    const xg = p.expectedGoals && p.expectedGoals.total !== null && p.expectedGoals.total !== undefined ? fmt.num(p.expectedGoals.total) : null;
    const state = p.eligible
      ? `<span class="badge badge-green">${icons.check} Qualified</span>`
      : `<span class="badge badge-slate">${icons.info} ${escapeHtml(p.rejectReason || 'Not qualified')}</span>`;

    return `<article class="pv-match">
      <div class="pv-match-top">
        <span class="league-chip"><span>${escapeHtml(league)}</span></span>
        <span class="tiny muted">${icons.calendar} ${escapeHtml(fmt.kickoffLabel(p.kickoffAt))}</span>
      </div>
      <div class="pv-match-teams">${escapeHtml(home)}<span class="vs">vs</span>${escapeHtml(away)}</div>
      <div class="pv-match-meta">
        <span class="pv-metric"><span class="k">Model</span><span class="v">${probability === null ? '—' : fmt.pct(probability)}</span></span>
        <span class="pv-metric"><span class="k">xG total</span><span class="v">${xg === null ? '—' : xg}</span></span>
        <span class="pv-metric"><span class="k">Over 1.5 form</span><span class="v">${p.over15Rates && p.over15Rates.home !== null && p.over15Rates.home !== undefined ? fmt.pct(p.over15Rates.home) : '—'}</span></span>
      </div>
      <div class="pv-match-foot">
        ${p.odds && p.odds.available ? verifiedChip(p.odds) : `<span class="verified-chip stale">${icons.alert} No verified price</span>`}
        ${state}
      </div>
    </article>`;
  }

  async function paintMatches() {
    const grid = $('#matchCards');
    const empty = $('#matchEmpty');
    if (!grid) return;
    grid.innerHTML = skeletonRows(3);
    try {
      const data = await API.get(PUBLIC.predictions);
      const items = (data && data.items) || [];
      if (!items.length) {
        grid.innerHTML = '';
        if (empty) {
          empty.innerHTML = emptyState('target', 'No fixtures analysed yet', 'Once the next sync runs, today\'s fixtures appear here with their evidence.');
          empty.classList.remove('hidden');
        }
        return;
      }
      grid.innerHTML = items.map(matchCard).join('');
    } catch (err) {
      grid.innerHTML = '';
      if (empty) {
        empty.innerHTML = emptyState('alert', 'Match analysis unavailable', err.message || 'The analysis could not be loaded right now.');
        empty.classList.remove('hidden');
      }
    }
  }

  /* --------------------------- mobile drawer ------------------------------ */

  function bindMobileNav() {
    const toggle = $('#navToggle');
    const menu = $('#mobileMenu');
    if (!toggle || !menu) return;

    const setOpen = (open) => {
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      toggle.setAttribute('aria-label', open ? 'Close navigation menu' : 'Open navigation menu');
      menu.hidden = !open;
      menu.classList.toggle('open', open);
      document.body.classList.toggle('nav-open', open);
    };

    toggle.addEventListener('click', () => setOpen(toggle.getAttribute('aria-expanded') !== 'true'));
    $$('#mobileMenu a').forEach((link) => link.addEventListener('click', () => setOpen(false)));
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') setOpen(false);
    });
    window.addEventListener('resize', () => {
      if (window.innerWidth >= 900) setOpen(false);
    });
  }

  /* -------------------------- scroll reveal ------------------------------- */

  function bindReveal() {
    const items = $$('.reveal');
    if (!items.length) return;

    const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced || typeof window.IntersectionObserver !== 'function') {
      items.forEach((el) => el.classList.add('in'));
      return;
    }

    const observer = new window.IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('in');
          observer.unobserve(entry.target);
        });
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.12 }
    );

    items.forEach((el, index) => {
      el.style.setProperty('--reveal-delay', `${Math.min(index % 4, 3) * 70}ms`);
      observer.observe(el);
    });
  }

  function paintYear() {
    const year = $('#year');
    if (year) year.textContent = String(new Date().getFullYear());
  }

  /* ------------------------------- boot ---------------------------------- */

  async function init() {
    // The header only needs to know WHO is signed in (to swap Login/Create
    // Account for the account chip). It loads no account data.
    App.session.bindHeader();
    bindMobileNav();
    bindReveal();
    paintYear();

    // Three public reads, all of them already served to anonymous visitors on
    // /ticket, /predictions and /analytics. Nothing here is account-scoped.
    const [ticket, stats] = await Promise.all([
      API.get(PUBLIC.ticket).catch(() => null),
      API.get(PUBLIC.analytics).catch(() => null),
    ]);
    if (stats) paintRecord(stats);
    if (ticket) paintPreview(ticket);
    else {
      const pill = $('#pvPill');
      if (pill) pill.className = 'pv-pill bad';
      App.setText('#pvPillText', 'Status unavailable');
      App.setText('#pvNote', 'The published ticket could not be loaded from this browser right now — open the ticket page to try again.');
    }
    await paintMatches();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
