/* GoalPredict — public landing page
 *
 * DATA RULE (the reason this file is small): the homepage is a MARKETING page.
 * It fetches nothing but the shared session check in api.js — no predictions,
 * no ticket, no analytics. Those are member-only surfaces, and the server
 * refuses them with 401 Unauthorized unless a verified, active session asks
 * for them, so the page would only be painting error states anyway.
 *
 * What the visitor sees instead is the shape of the product: the locked
 * preview, the process, the rules and the sign-in door. Every private
 * surface (predictions, today's ticket, ticket history, analytics, dashboard
 * activity, account statistics) lives behind the guarded API.
 */
'use strict';

/* Reveal-on-scroll needs a hook before first paint; if this script never runs
   the page is simply fully visible (no-JS safe). */
document.documentElement.classList.add('reveal-ready');

(function () {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.prototype.slice.call(document.querySelectorAll(sel));

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

  function init() {
    // The header only needs to know WHO is signed in: it swaps Login/Create
    // Account for the account chip and reveals the member-only navigation
    // entries. It loads no prediction data — that stays behind the session.
    App.session.bindHeader();
    bindMobileNav();
    bindReveal();
    paintYear();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
