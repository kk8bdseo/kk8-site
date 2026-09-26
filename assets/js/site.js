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

  /* Hero carousel. Scroll-snap already handles swipe with no JS; this adds dots and a
     5s autoplay that stops for good the moment anyone touches, hovers or focuses it
     (WCAG 2.2.2), and never starts for users who prefer reduced motion. */
  var track = document.getElementById('heroTrack');
  if (track && track.children.length > 1) {
    var slides = track.children;
    var dots = document.querySelectorAll('#heroDots .hero-dot');
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var idx = 0, timer = null;

    var go = function (i) {
      idx = (i + slides.length) % slides.length;
      track.scrollTo({ left: slides[idx].offsetLeft, behavior: reduce ? 'auto' : 'smooth' });
    };
    var mark = function () {
      var i = Math.round(track.scrollLeft / track.clientWidth);
      idx = i;
      Array.prototype.forEach.call(dots, function (d, j) {
        d.setAttribute('aria-current', j === i ? 'true' : 'false');
      });
    };
    var stop = function () { if (timer) { clearInterval(timer); timer = null; } };

    track.addEventListener('scroll', function () { window.requestAnimationFrame(mark); }, { passive: true });
    Array.prototype.forEach.call(dots, function (d, j) {
      d.addEventListener('click', function () { stop(); go(j); });
    });
    ['pointerdown', 'mouseenter', 'focusin', 'touchstart'].forEach(function (ev) {
      track.parentNode.addEventListener(ev, stop, { passive: true });
    });
    if (!reduce) timer = setInterval(function () { go(idx + 1); }, 5000);
  }
})();
