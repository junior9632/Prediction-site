/* GoalPredict — public landing page
   MARKETING ONLY. This page is static: it renders no ticket, no odds, no
   accumulator, no statistics and no account data, and it requests nothing
   from the prediction API. The only network call the homepage can make is the
   shared session check in api.js, which decides whether the header shows
   "Login / Get Started" or the signed-in account chip. */
'use strict';

/* Reveal-on-scroll needs a hook before first paint; if this script never runs
   the page is simply fully visible (no-JS safe). */
document.documentElement.classList.add('reveal-ready');

(function () {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.prototype.slice.call(document.querySelectorAll(sel));

  /* --------------------------- mobile drawer -------------------------- */

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

  /* -------------------------- scroll reveal --------------------------- */

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

    // stagger each element against its neighbours in the same group
    items.forEach((el, index) => {
      el.style.setProperty('--reveal-delay', `${Math.min(index % 4, 3) * 70}ms`);
      observer.observe(el);
    });
  }

  /* ----------------------- header + footer bits ----------------------- */

  function paintYear() {
    const year = $('#year');
    if (year) year.textContent = String(new Date().getFullYear());
  }

  function init() {
    // session awareness for the header only (Login / Get Started / account)
    App.session.bindHeader();
    bindMobileNav();
    bindReveal();
    paintYear();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
