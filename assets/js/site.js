/* KK8 Bangladesh — minimal vanilla JS. Mobile nav + FAQ accordion only (CLAUDE.md §2). */
(function () {
  'use strict';

  var toggle = document.getElementById('navToggle');
  var nav = document.getElementById('mobileNav');
  if (toggle && nav) {
    toggle.addEventListener('click', function () {
      var open = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!open));
      nav.hidden = open;
    });
  }

  /* Language switcher is a <details>; close it on a click anywhere else. */
  var switches = document.querySelectorAll('details.lang-switch');
  document.addEventListener('click', function (e) {
    Array.prototype.forEach.call(switches, function (d) {
      if (d.open && !d.contains(e.target)) d.open = false;
    });
  });

  /* Accordions are progressive: markup renders open and readable without JS,
     so the FAQ content is always crawlable and never hidden from indexing. */
  var qs = document.querySelectorAll('.faq-q');
  Array.prototype.forEach.call(qs, function (btn) {
    var panel = document.getElementById(btn.getAttribute('aria-controls'));
    if (!panel) return;
    btn.setAttribute('aria-expanded', 'false');
    panel.hidden = true;
    btn.addEventListener('click', function () {
      var open = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', String(!open));
      panel.hidden = open;
    });
  });

  /* Promotions carousel. Scroll-snap already handles swipe with no JS; this adds
     arrows and dots. Deliberately no autoplay — it moves only when the visitor moves it. */
  var track = document.getElementById('heroTrack');
  if (track && track.children.length > 1) {
    var slides = track.children;
    var dots = document.querySelectorAll('#heroDots .hero-dot');
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var idx = 0;

    var go = function (i) {
      idx = (i + slides.length) % slides.length;
      track.scrollTo({ left: slides[idx].offsetLeft, behavior: reduce ? 'auto' : 'smooth' });
    };
    var mark = function () {
      idx = Math.round(track.scrollLeft / track.clientWidth);
      Array.prototype.forEach.call(dots, function (d, j) {
        d.setAttribute('aria-current', j === idx ? 'true' : 'false');
      });
    };

    track.addEventListener('scroll', function () { window.requestAnimationFrame(mark); }, { passive: true });
    Array.prototype.forEach.call(dots, function (d, j) {
      d.addEventListener('click', function () { go(j); });
    });
    Array.prototype.forEach.call(document.querySelectorAll('.promo-arrow'), function (btn) {
      btn.addEventListener('click', function () { go(idx + Number(btn.getAttribute('data-dir'))); });
    });
  }
})();
