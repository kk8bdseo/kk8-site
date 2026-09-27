#!/usr/bin/env node
/**
 * KK8 Bangladesh — static build.
 *
 * Reads site.config.json + pages.json, resolves partials and tokens, emits flat
 * HTML at the repo root (GitHub Pages serves `main` directly), generates
 * sitemap.xml + robots.txt from the manifest, then runs validation gates.
 *
 * No framework, no runtime. Node stdlib only. See docs spec §9.
 * Non-zero exit on any gate failure.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(ROOT, 'site.config.json'), 'utf8'));
const { pages } = JSON.parse(readFileSync(join(ROOT, 'pages.json'), 'utf8'));

const GEO_TOKENS = ['Bangladesh', 'বাংলাদেশ', 'বাংলাদেশে', 'BD'];
const errors = [];
const warns = [];
const fail = (slug, gate, msg) => errors.push(`[${slug}] gate ${gate}: ${msg}`);

/* ---------------------------------------------------------------- helpers */

const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const partial = (name) => read(`partials/${name}.html`);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Resolve a dotted path against the context, e.g. "licence.number". */
const lookup = (ctx, path) =>
  path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), ctx);

/** Expand `<!-- include: name -->` recursively (depth-capped). */
function includes(html, depth = 0) {
  if (depth > 8) throw new Error('include depth exceeded — circular partial?');
  return html.replace(/<!--\s*include:\s*([\w-]+)\s*-->/g, (_, name) =>
    includes(partial(name), depth + 1));
}

/** Substitute `{{token}}` from the context. Unknown tokens are a hard error. */
function tokens(html, ctx, where) {
  return html.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path) => {
    const v = lookup(ctx, path);
    if (v === undefined || v === null) {
      errors.push(`[${where}] unresolved token {{${path}}}`);
      return '';
    }
    return String(v);
  });
}

const moneyUrl = () => cfg.moneySite + (cfg.moneySiteParams || '');

/* ------------------------------------------------------- computed fragments */

/** KK8's own provider cards (name + category label printed on the art). Lazy: every
 *  provider list sits below the fold. width/height reserve space, so nothing shifts. */
const providerCard = (p, g, liClass) => `<li class="${liClass}">
      <img src="${p.img}" alt="${esc(p.name)} — ${esc(g.labelBn)} প্রোভাইডার" width="${p.w}" height="${p.h}"
           loading="lazy" decoding="async" class="block h-auto w-full">
    </li>`;

/** One category's providers as a grid, for the page about that category. */
function providerGroup(id) {
  const g = (cfg.providerGroups || []).find((x) => x.id === id);
  if (!g) return '';
  return `<ul class="not-prose my-6 grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-6">
    ${g.providers.map((p) => providerCard(p, g, '')).join('\n    ')}
  </ul>`;
}

/** Every provider, grouped — the homepage overview. Mobile: one swipeable rail per
 *  category with the next card peeking in. Desktop: wraps into a grid, since sideways
 *  scrolling with a mouse is awkward. */
function providerGrid() {
  return (cfg.providerGroups || []).map((g) => `<div class="min-w-0">
    <p class="text-xs font-bold uppercase tracking-widest text-brand-blue">${esc(g.labelBn)} <span class="text-brand-slate">· ${g.providers.length}</span></p>
    <ul class="carousel-track mt-3 flex snap-x gap-3 overflow-x-auto pb-1 lg:grid lg:grid-cols-9 lg:overflow-visible">
    ${g.providers.map((p) => providerCard(p, g, 'w-[112px] shrink-0 snap-start lg:w-auto')).join('\n    ')}
    </ul>
  </div>`).join('\n');
}

function paymentList() {
  return cfg.paymentRails.map((r) =>
    `<li class="flex items-start gap-3 rounded-base border border-brand-hair bg-brand-tint p-4">
      <span class="mt-0.5 inline-block h-2 w-2 shrink-0 rounded-full bg-brand-blue" aria-hidden="true"></span>
      <span><strong class="font-bold text-brand-navy">${esc(r.nameBn)}</strong>
      <span class="text-brand-slate"> (${esc(r.name)}) — ${esc(r.type)}</span></span>
    </li>`
  ).join('\n');
}

function categoryGrid() {
  return cfg.productCategories.map((c) =>
    `<li><a href="${c.id === 'slots' ? '/casino-slots.html' : c.id === 'live' ? '/live-casino.html' : c.id === 'sports' ? '/sports-betting.html' : '/casino-slots.html'}"
      class="block rounded-base border border-brand-hair bg-white p-5 transition hover:border-brand-blue hover:shadow-sm">
      <span class="block text-lg font-bold text-brand-navy">${esc(c.nameBn)}</span>
      <span class="mt-1 block text-sm text-brand-slate">${esc(c.name)}</span></a></li>`
  ).join('\n');
}

/** Featured games: KK8's own game-card art, self-hosted (never hotlinked) with client
 *  approval. Lazy-loaded; width/height reserve the slot so the grid never shifts. */
function gameGrid() {
  return cfg.featuredGames.map((g) => `<li>
      <a href="${moneyUrl()}" rel="nofollow noopener" target="_blank" class="group block">
        <img src="${g.img}" alt="${esc(g.name)} — ${esc(g.provider)}-এর স্লট গেম" width="${g.w}" height="${g.h}"
             loading="lazy" decoding="async" class="block h-auto w-full transition duration-200 group-hover:-translate-y-1">
        <p class="mt-1 truncate text-center text-sm font-bold text-brand-navy" title="${esc(g.name)}">${esc(g.name)}</p>
        <p class="text-center text-xs text-brand-slate">${esc(g.provider)}</p>
      </a>
    </li>`).join('\n');
}

/** Today's date on the Bangladesh calendar (Asia/Dhaka, UTC+6). Promo end dates are
 *  local event dates; comparing them against UTC keeps a lapsed promo up to six hours
 *  past its end. en-CA formats as YYYY-MM-DD. */
const todayBD = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(new Date());

/** Hero banners still inside their event window. `expires` is inclusive, so a promo
 *  with a printed end date drops out of the build the day after — a lapsed promotion
 *  can never ship, however long the site sits between deploys. */
function liveHeroBanners() {
  const today = todayBD();
  return (cfg.heroBanners || []).filter((b) => !b.expires || b.expires >= today);
}

/** Homepage promotions section. Sits below the H1 hero, so nothing here is the LCP
 *  element: every slide lazy-loads. Native scroll-snap handles swipe with no JS;
 *  site.js adds arrows and dots. No autoplay — the visitor moves it or it stays put. */
function heroCarousel() {
  const today = todayBD();
  const live = liveHeroBanners();
  const dropped = (cfg.heroBanners || []).length - live.length;
  if (dropped) warns.push(`promo carousel: dropped ${dropped} expired banner(s)`);
  for (const b of live) {
    if (!b.expires) continue;
    const days = Math.round((Date.parse(b.expires) - Date.parse(today)) / 864e5);
    if (days <= 7) warns.push(`promo banner ends in ${days} day(s) (${b.expires}): ${b.src}`);
  }
  if (!live.length) return '';
  const slides = live.map((b, i) => `<li class="w-full shrink-0 snap-start" aria-roledescription="slide" aria-label="${i + 1} / ${live.length}">
        <a href="${moneyUrl()}" rel="nofollow noopener" target="_blank" class="block">
          <img src="${b.src}" alt="${esc(b.alt)}" width="${b.w}" height="${b.h}" loading="lazy" decoding="async"
               class="block aspect-[12/5] w-full object-cover object-[38%_50%] md:aspect-[125/22]">
        </a>
      </li>`).join('\n');
  const many = live.length > 1;
  const arrow = (dir, label, glyph) => `<button type="button" data-dir="${dir}" aria-label="${label}"
        class="promo-arrow absolute top-1/2 hidden h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-white/90 text-xl font-bold text-brand-navy shadow transition hover:bg-white md:flex ${dir < 0 ? 'left-3' : 'right-3'}">${glyph}</button>`;
  return `<section class="section" aria-labelledby="promo-heading">
  <div class="flex items-end justify-between gap-4">
    <div>
      <p class="eyebrow">প্রোমোশন</p>
      <h2 id="promo-heading" class="mt-3 text-2xl font-extrabold text-brand-navy">KK8 অফার ও খবর</h2>
    </div>
    <a href="/promotions.html" class="text-sm font-bold text-brand-blue underline">সব প্রোমোশন</a>
  </div>
  <div class="relative mt-6 overflow-hidden rounded-base bg-brand-navy" aria-roledescription="carousel" aria-label="KK8 অফার ও খবর">
    <ul id="heroTrack" class="carousel-track flex snap-x snap-mandatory overflow-x-auto">
      ${slides}
    </ul>
    ${many ? arrow(-1, 'আগের ব্যানার', '‹') + arrow(1, 'পরের ব্যানার', '›') : ''}
  </div>
  ${many ? `<div id="heroDots" class="mt-3 flex justify-center gap-2">
    ${live.map((_, i) => `<button type="button" class="hero-dot h-2 w-2 rounded-full bg-brand-hair transition" aria-label="ব্যানার ${i + 1}" aria-current="${i === 0}"></button>`).join('')}
  </div>` : ''}
</section>`;
}

/** The image a page leads with, so head() can preload it ahead of CSS. */
function lcpImage(page) {
  if (page.banner) return cfg.categoryBanners?.[page.banner]?.src;
  return null;
}

function trustMarks() {
  return cfg.trustMarks.map((t) =>
    `<li class="rounded-pill border border-brand-hair px-3 py-1 text-xs font-semibold text-brand-slate">${esc(t)}</li>`
  ).join('\n');
}

function navLinks(current) {
  const items = [
    ['/', 'হোম'], ['/casino-slots.html', 'ক্যাসিনো ও স্লট'], ['/live-casino.html', 'লাইভ ক্যাসিনো'],
    ['/sports-betting.html', 'স্পোর্টস'], ['/promotions.html', 'প্রোমোশন'],
    ['/app-download.html', 'অ্যাপ'], ['/deposit-withdrawal.html', 'ডিপোজিট'], ['/faq.html', 'FAQ'],
  ];
  return items.map(([href, label]) => {
    const active = (current === 'index' && href === '/') || href === `/${current}.html`;
    return `<li><a href="${href}" class="block px-3 py-2 text-sm font-semibold ${active
      ? 'text-brand-blue' : 'text-brand-navy hover:text-brand-blue'}"${active ? ' aria-current="page"' : ''}>${label}</a></li>`;
  }).join('\n');
}

/** FAQ items read off the rendered page (faq-q button + its faq-a panel). The page is
 *  the single source of truth, so FAQPage schema can never drift from what visitors
 *  see — CLAUDE.md §9's "no schema-only claims". */
function extractFaq(html) {
  const strip = (s) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const out = [];
  for (const [, id, q] of html.matchAll(/<button\b[^>]*class="faq-q"[^>]*aria-controls="([^"]+)"[^>]*>([\s\S]*?)<\/button>/g)) {
    const a = html.match(new RegExp(`<div id="${id}" class="faq-a">([\\s\\S]*?)<\\/div>`));
    if (a) out.push({ q: strip(q.replace(/<span[^>]*aria-hidden="true"[^>]*>[\s\S]*?<\/span>/g, '')), a: strip(a[1]) });
  }
  return out;
}

/* ------------------------------------------------------------------ schema */

function schemaBlocks(page) {
  const url = `${cfg.baseUrl}${page.slug === 'index' ? '/' : `/${page.slug}.html`}`;
  const out = [];

  if (page.schema.includes('Organization')) out.push({
    '@context': 'https://schema.org', '@type': 'Organization',
    name: cfg.brand, alternateName: cfg.siteName, url: cfg.baseUrl,
    logo: `${cfg.baseUrl}/assets/img/logo.png`,
    image: `${cfg.baseUrl}${cfg.ogImage}`,
    description: cfg.tagline,
    sameAs: [cfg.moneySite, cfg.sisterSite, cfg.social.facebook, cfg.social.instagram, cfg.social.telegram],
    areaServed: { '@type': 'Country', name: cfg.geo.country },
    hasCredential: {
      '@type': 'EducationalOccupationalCredential',
      credentialCategory: 'Gaming Licence',
      recognizedBy: { '@type': 'Organization', name: `${cfg.licence.authority} — ${cfg.licence.text}` },
      identifier: cfg.licence.number,
    },
  });

  if (page.schema.includes('WebSite')) out.push({
    '@context': 'https://schema.org', '@type': 'WebSite',
    name: cfg.siteName, alternateName: cfg.siteNameBn, url: cfg.baseUrl,
    inLanguage: cfg.hreflang,
    publisher: { '@type': 'Organization', name: cfg.brand },
    // No SearchAction: neither site has a search, and Google retired the sitelinks
    // search box. Declaring one would be a schema-only claim (CLAUDE.md §9).
  });

  if (page.schema.includes('BreadcrumbList')) out.push({
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'হোম', item: `${cfg.baseUrl}/` },
      { '@type': 'ListItem', position: 2, name: page.h1, item: url },
    ],
  });

  if (page.schema.includes('FAQPage') && page.faq?.length) out.push({
    '@context': 'https://schema.org', '@type': 'FAQPage',
    inLanguage: cfg.hreflang,
    mainEntity: page.faq.map((f) => ({
      '@type': 'Question', name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a },
    })),
  });

  return out.map((o) =>
    `<script type="application/ld+json">\n${JSON.stringify(o, null, 2)}\n</script>`).join('\n');
}

/* -------------------------------------------------------------------- head */

function head(page) {
  const url = `${cfg.baseUrl}${page.slug === 'index' ? '/' : `/${page.slug}.html`}`;
  return `  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(page.title)}</title>
  <meta name="description" content="${esc(page.meta)}">
  <link rel="canonical" href="${url}">
  <link rel="alternate" hreflang="${cfg.hreflang}" href="${url}">
  <link rel="alternate" hreflang="x-default" href="${url}">
  <meta name="theme-color" content="${cfg.themeColor}">
  <meta name="robots" content="index,follow,max-image-preview:large">
  <meta name="rating" content="adult">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="${esc(cfg.siteName)}">
  <meta property="og:locale" content="${cfg.locale}">
  <meta property="og:title" content="${esc(page.title)}">
  <meta property="og:description" content="${esc(page.meta)}">
  <meta property="og:url" content="${url}">
  <meta property="og:image" content="${cfg.baseUrl}${cfg.ogImage}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:site" content="${cfg.twitterSite}">
  <meta name="twitter:title" content="${esc(page.title)}">
  <meta name="twitter:description" content="${esc(page.meta)}">
  <meta name="twitter:image" content="${cfg.baseUrl}${cfg.ogImage}">
  <link rel="icon" href="/assets/img/favicon-32x32.png" sizes="32x32">
  <link rel="apple-touch-icon" href="/assets/img/apple-touch-icon-180x180.png">
${lcpImage(page) ? `\n  <link rel="preload" as="image" href="${lcpImage(page)}" fetchpriority="high">` : ''}
  <link rel="stylesheet" href="/assets/css/site.css">`;
}

/* ------------------------------------------------------------------- build */

const built = [];

for (const page of pages) {
  const src = `pages/${page.slug}.html`;
  if (!existsSync(join(ROOT, src))) { warns.push(`no source yet: ${src}`); continue; }

  const ctx = {
    ...cfg,
    page,
    head: head(page),
    schema: '',
    content: '',
    nav: navLinks(page.slug),
    providerGrid: providerGrid(),
    providerCount: (cfg.providers || []).length,
    providerGroups: Object.fromEntries((cfg.providerGroups || []).map((g) => [g.id, providerGroup(g.id)])),
    paymentList: paymentList(),
    categoryGrid: categoryGrid(),
    trustMarks: trustMarks(),
    gameGrid: gameGrid(),
    heroCarousel: page.slug === 'index' ? heroCarousel() : '',
    banner: page.banner ? cfg.categoryBanners?.[page.banner] : undefined,
    moneyUrl: moneyUrl(),
    year: new Date().getFullYear(),
    bodyClass: `tpl-${page.template}`,
  };

  let content = tokens(includes(read(src)), ctx, page.slug);
  const onPageFaq = extractFaq(content);
  if (onPageFaq.length) page.faq = onPageFaq;
  ctx.schema = schemaBlocks(page);

  const shell = `partials/shell-${page.template}.html`;
  if (existsSync(join(ROOT, shell))) {
    content = tokens(includes(read(shell)), { ...ctx, content }, page.slug);
  }

  const html = tokens(includes(partial('layout')), { ...ctx, content }, page.slug);
  const out = `${page.slug}.html`;
  writeFileSync(join(ROOT, out), html);
  built.push({ page, html, out });
}

/* ------------------------------------------------------- sitemap + robots */

const today = new Date().toISOString().slice(0, 10);
writeFileSync(join(ROOT, 'sitemap.xml'),
`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.w3.org/1999/sitemap/0.9"
        xmlns:xhtml="http://www.w3.org/1999/xhtml">
${built.map(({ page }) => {
  const url = `${cfg.baseUrl}${page.slug === 'index' ? '/' : `/${page.slug}.html`}`;
  return `  <url>
    <loc>${url}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>${page.changefreq}</changefreq>
    <priority>${page.priority}</priority>
    <xhtml:link rel="alternate" hreflang="${cfg.hreflang}" href="${url}"/>
  </url>`;
}).join('\n')}
</urlset>
`.replace('http://www.w3.org/1999/sitemap/0.9', 'http://www.sitemaps.org/schemas/sitemap/0.9'));

writeFileSync(join(ROOT, 'robots.txt'),
`User-agent: *
Allow: /

Sitemap: ${cfg.baseUrl}/sitemap.xml
`);

/* ------------------------------------------------------------------- gates */

const seenTitles = new Map();
const seenMetas = new Map();

for (const { page, html, out } of built) {
  const text = html.replace(/<script[\s\S]*?<\/script>/g, ' ')
                   .replace(/<style[\s\S]*?<\/style>/g, ' ')
                   .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  // 1 — exactly one h1, carrying the brand
  const h1s = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/g) || [];
  if (h1s.length !== 1) fail(out, 1, `expected 1 <h1>, found ${h1s.length}`);
  else if (!/KK8/i.test(h1s[0])) fail(out, 1, 'h1 does not contain the brand token "KK8"');

  // 1b — the Latin primary keyword must appear in the page (BD players type Latin)
  if (!text.toLowerCase().includes(page.primaryKeyword.toLowerCase()))
    fail(out, 1, `Latin primary keyword "${page.primaryKeyword}" absent from page text`);

  // 2 — title + meta present, unique, geo-signalled
  const title = (html.match(/<title>([\s\S]*?)<\/title>/) || [])[1];
  const desc = (html.match(/<meta name="description" content="([^"]*)"/) || [])[1];
  if (!title) fail(out, 2, 'missing <title>');
  if (!desc) fail(out, 2, 'missing meta description');
  if (title) {
    if (seenTitles.has(title)) fail(out, 2, `duplicate title (also ${seenTitles.get(title)})`);
    seenTitles.set(title, out);
    if (!GEO_TOKENS.some((t) => title.includes(t))) fail(out, 2, 'no geo token in title');
  }
  if (desc) {
    if (seenMetas.has(desc)) fail(out, 2, `duplicate meta description (also ${seenMetas.get(desc)})`);
    seenMetas.set(desc, out);
  }

  // 3 — canonical present and on the configured domain
  const canon = (html.match(/<link rel="canonical" href="([^"]*)"/) || [])[1];
  if (!canon) fail(out, 3, 'missing canonical');
  else if (!canon.startsWith(cfg.baseUrl)) fail(out, 3, `canonical off-domain: ${canon}`);

  // 4 — every JSON-LD block parses; required types present
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  for (const [, body] of blocks) {
    try { JSON.parse(body); } catch (e) { fail(out, 4, `invalid JSON-LD: ${e.message}`); }
  }
  const types = blocks.flatMap(([, b]) => { try { return [JSON.parse(b)['@type']]; } catch { return []; } });
  for (const need of page.schema) {
    if (need === 'FAQPage' && !page.faq?.length) continue; // no questions authored yet
    if (!types.includes(need)) fail(out, 4, `declared schema ${need} not emitted`);
  }

  // 5 — every img has non-empty alt
  for (const [tag] of html.matchAll(/<img\b[^>]*>/g)) {
    const alt = (tag.match(/\balt="([^"]*)"/) || [])[1];
    if (alt === undefined) fail(out, 5, `img without alt: ${tag.slice(0, 80)}`);
    else if (!alt.trim()) fail(out, 5, `img with empty alt: ${tag.slice(0, 80)}`);
  }

  // 6 — internal links resolve against the manifest
  const slugs = new Set(pages.map((p) => p.slug));
  for (const [, href] of html.matchAll(/href="(\/[^"#?]*)"/g)) {
    if (href.startsWith('/assets/')) continue;
    if (href === '/') continue;
    const m = href.match(/^\/([\w-]+)\.html$/);
    if (!m) { fail(out, 6, `unrecognised internal link: ${href}`); continue; }
    if (!slugs.has(m[1])) fail(out, 6, `internal link to unknown page: ${href}`);
  }

  // 7 — lang + hreflang hygiene. hreflang must never point at the sister domain.
  if (!/<html lang="bn">/.test(html)) fail(out, 7, 'missing <html lang="bn">');
  for (const [, hl, href] of html.matchAll(/<link rel="alternate" hreflang="([^"]*)" href="([^"]*)"/g)) {
    if (!href.startsWith(cfg.baseUrl))
      fail(out, 7, `hreflang "${hl}" points off-domain (${href}) — declares the two properties duplicates`);
  }

  // 11 — structural tags balance. An unclosed <button> or <div> silently swallows the
  //      rest of an FAQ block, and the FAQ schema extracted from it goes wrong with it.
  for (const tag of ['div', 'section', 'button', 'ul', 'ol', 'li', 'table', 'tr', 'a', 'h1', 'h2', 'h3', 'p', 'nav', 'aside']) {
    const open = (html.match(new RegExp(`<${tag}(?=[\\s>])`, 'g')) || []).length;
    const close = (html.match(new RegExp(`</${tag}>`, 'g')) || []).length;
    if (open !== close) fail(out, 11, `<${tag}> opened ${open}× but closed ${close}×`);
  }

  // 9 — no Malaysia leakage, no Bangladesh legality claim
  if (/\bRM\s?\d/.test(text) || /\bMYR\b/.test(text)) fail(out, 9, 'MYR/RM figure in copy');
  for (const rail of ['FPX', 'Touch \'n Go', 'DuitNow', 'Boost']) {
    if (text.includes(rail)) fail(out, 9, `Malaysian payment rail "${rail}" in copy`);
  }
  if (/(বাংলাদেশে\s+(?:এটি\s+)?বৈধ|আইনত\s+বৈধ|legal\s+in\s+Bangladesh)/i.test(text))
    fail(out, 9, 'appears to claim gambling is legal in Bangladesh');
}

// 10 — a primary keyword may be targeted by exactly one page across BOTH properties.
//      Two pages on one query compete for one slot; that is the collapse the two-site
//      architecture exists to prevent (spec §5.1).
{
  const mine = new Map();
  for (const p of pages) {
    const k = p.primaryKeyword.toLowerCase().trim();
    if (mine.has(k)) fail(`${p.slug}.html`, 10, `primary keyword "${k}" also targeted by ${mine.get(k)}.html on this site`);
    mine.set(k, p.slug);
  }
  const theirsFile = join(ROOT, '..', cfg.siteKey === 'seo' ? 'kk8-news' : 'kk8-site', 'pages.json');
  if (existsSync(theirsFile)) {
    for (const p of JSON.parse(readFileSync(theirsFile, 'utf8')).pages) {
      const k = p.primaryKeyword.toLowerCase().trim();
      if (mine.has(k)) fail(`${mine.get(k)}.html`, 10, `primary keyword "${k}" also targeted by the sister property (${p.slug})`);
    }
  }
}

// 8 — cross-property duplicate body copy
const sibling = join(ROOT, '..', cfg.siteKey === 'seo' ? 'kk8-news' : 'kk8-site');
if (existsSync(sibling)) {
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  const mine = new Map();
  for (const { html, out } of built)
    for (const [, p] of html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)) {
      const t = norm(p.replace(/<[^>]+>/g, ''));
      if (t.length > 80) mine.set(t, out);
    }
  let dup = 0;
  for (const f of readdirSync(sibling).filter((f) => f.endsWith('.html'))) {
    const other = readFileSync(join(sibling, f), 'utf8');
    for (const [, p] of other.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)) {
      const t = norm(p.replace(/<[^>]+>/g, ''));
      if (t.length > 80 && mine.has(t)) {
        fail(mine.get(t), 8, `body paragraph duplicated in sibling property (${f}) — cannibalisation risk`);
        if (++dup > 5) break;
      }
    }
    if (dup > 5) break;
  }
} else {
  warns.push('gate 8 skipped — sibling property not built yet');
}

/* ------------------------------------------------------------------ report */

console.log(`\n  ${cfg.siteName}  (${cfg.domain})`);
console.log(`  built ${built.length}/${pages.length} pages · sitemap ${built.length} urls\n`);
for (const w of warns) console.log(`  ~ ${w}`);
if (errors.length) {
  console.error(`\n  ✗ ${errors.length} gate failure(s):\n`);
  for (const e of errors) console.error(`    ${e}`);
  console.error('');
  process.exit(1);
}
console.log(`  ✓ all gates passed\n`);
