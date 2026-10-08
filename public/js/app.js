/* GoalPredict — public landing page
 *
 * DATA RULE (the reason this file is small): the homepage is MARKETING. It
 * renders no prediction data of any kind — no fixture, no team, no odds, no
 * pick, no confidence figure, no ticket total, no win rate. It therefore makes
 * exactly one request, the shared session check in api.js, which only answers
 * WHO is signed in so the header can swap Login / Create Account for the
 * member navigation.
 *
 * Everything a member reads lives behind the guarded APIs (predictions,
 * tickets, analytics, fixtures, odds, dashboard activity). Each of those
 * answers an anonymous caller with 401 and no payload, and the pages that
 * render them redirect a visitor to the sign-in door. Calling them from here
 * would be both pointless and a leak, so this script does not — and it does
 * not even name their URLs, which the access tests check for.
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
    // The header only needs to know WHO is signed in: a visitor keeps the
    // public navigation plus Login / Create Account, a member gets the member
    // navigation (Dashboard, Predictions, Today's Ticket, Ticket History,
    // Analytics) revealed and Logout. No prediction data is loaded.
    App.session.bindHeader();
    bindMobileNav();
    bindReveal();
    paintYear();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
