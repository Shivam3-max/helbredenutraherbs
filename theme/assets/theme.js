/* ==========================================================================
   Helbrede — behaviour layer
   Vanilla ES modules, no framework. Every module is defensive: if its markup
   is not on the page it returns quietly, so sections can be reordered or
   removed in the theme editor without breaking anything else.
   ========================================================================== */
(() => {
  'use strict';

  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const money = (paise) => {
    const n = Math.round(Number(paise || 0)) / 100;
    return '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: n % 1 ? 2 : 0 });
  };
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------------------------------------------------------------- panels */
  const Panels = (() => {
    const scrim = $('[data-scrim]');
    let open = null;
    let lastFocus = null;

    function show(name) {
      const el = $(`[data-panel="${name}"]`);
      if (!el) return;
      if (open) hide();
      lastFocus = document.activeElement;
      open = el;
      el.classList.add('is-on');
      el.setAttribute('aria-hidden', 'false');
      if (scrim && name !== 'search') { scrim.hidden = false; requestAnimationFrame(() => scrim.classList.add('is-on')); }
      document.body.style.overflow = 'hidden';
      const focusable = el.querySelector('input,button,a[href]');
      setTimeout(() => focusable?.focus({ preventScroll: true }), 120);
      document.querySelectorAll(`[data-open="${name}"]`).forEach((b) => b.setAttribute('aria-expanded', 'true'));
    }

    function hide() {
      if (!open) return;
      const name = open.dataset.panel;
      open.classList.remove('is-on');
      open.setAttribute('aria-hidden', 'true');
      scrim?.classList.remove('is-on');
      setTimeout(() => { if (scrim && !open) scrim.hidden = true; }, 380);
      document.body.style.overflow = '';
      document.querySelectorAll(`[data-open="${name}"]`).forEach((b) => b.setAttribute('aria-expanded', 'false'));
      open = null;
      lastFocus?.focus?.({ preventScroll: true });
    }

    document.addEventListener('click', (e) => {
      const opener = e.target.closest('[data-open]');
      if (opener) { e.preventDefault(); show(opener.dataset.open); return; }
      if (e.target.closest('[data-close]')) { e.preventDefault(); hide(); }
    });
    scrim?.addEventListener('click', hide);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });

    return { show, hide };
  })();

  /* ------------------------------------------------------------ cart state */
  const Cart = (() => {
    const lines   = $('[data-cart-lines]');
    const empty   = $('[data-cart-empty]');
    const foot    = $('[data-cart-foot]');
    const totalEl = $('[data-cart-total]');
    const bar     = $('[data-ship-bar]');
    const barTxt  = $('[data-ship-text]');
    const barFill = $('[data-ship-fill]');

    function paint(cart) {
      $$('[data-cart-count]').forEach((el) => { el.textContent = cart.item_count; el.hidden = cart.item_count === 0; });
      $$('[data-cart-count-text]').forEach((el) => { el.textContent = `(${cart.item_count})`; });
      if (!lines) return;

      lines.innerHTML = cart.items.map((i) => `
        <li class="cl" data-key="${i.key}" data-quantity="${i.quantity}">
          ${i.image ? `<img class="cl__img" src="${i.image}" alt="" width="76" height="76">` : '<div class="cl__img"></div>'}
          <div>
            <a class="cl__t" href="${i.url}">${i.product_title}</a>
            <div class="cl__v">${i.variant_title}${i.pack_size ? ` · ${i.pack_size}` : ''}</div>
            <div class="cl__row">
              <span class="qty">
                <button type="button" data-qty="-1" aria-label="Decrease quantity">−</button>
                <span>${i.quantity}</span>
                <button type="button" data-qty="1" aria-label="Increase quantity">+</button>
              </span>
              <span class="cl__price">${money(i.line_price)}</span>
            </div>
          </div>
        </li>`).join('');

      const has = cart.item_count > 0;
      if (empty) empty.hidden = has;
      if (foot) foot.hidden = !has;
      if (totalEl) totalEl.textContent = money(cart.total_price);

      if (bar && barTxt && barFill) {
        const t = Number(bar.dataset.threshold || 0);
        const left = Math.max(0, t - cart.total_price);
        barTxt.textContent = !has ? `Free delivery on orders over ${money(t)}`
          : left > 0 ? `${money(left)} away from free delivery`
          : 'Free delivery unlocked';
        barFill.style.width = `${Math.min(100, t ? (cart.total_price / t) * 100 : 0)}%`;
      }
    }

    async function refresh() {
      try { paint(await (await fetch('/cart.js')).json()); } catch (_) {}
    }

    /* fetch resolves on a 4xx, so a sold-out 422 used to fall straight through
       to the drawer — which then opened empty with nothing explaining why.
       Check the status, surface Shopify's own message, and only open the drawer
       on a real add. Returns false so callers can abandon (buy-now must not
       redirect to a checkout the line never reached). */
    function showError(message) {
      const box = $('[data-cart-error]');
      if (!box) return;
      box.textContent = message;
      box.hidden = false;
    }

    function clearError() {
      const box = $('[data-cart-error]');
      if (box) { box.textContent = ''; box.hidden = true; }
    }

    async function add(id, quantity = 1) {
      clearError();
      try {
        const res = await fetch('/cart/add.js', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: [{ id: Number(id), quantity: Number(quantity) }] }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          showError(body.description || body.message || 'Sorry — that could not be added to your cart.');
          return false;
        }
        await refresh();
        Panels.show('cart');
        return true;
      } catch (_) {
        showError('Sorry — something went wrong. Please try again.');
        return false;
      }
    }

    async function change(key, quantity) {
      try {
        await fetch('/cart/change.js', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: key, quantity }),
        });
        /* The cart page is server-rendered, so repainting the drawer is not
           enough — its own rows and subtotal would keep the old values. */
        if (document.body.classList.contains('template-cart')) { window.location.reload(); return; }
        await refresh();
      } catch (_) {}
    }

    /* Delegated on the document rather than the drawer list, so the same
       controls work on the cart page, whose rows Liquid renders server-side.
       Quantity is read off the row instead of its text, so both markups agree. */
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-qty],[data-remove]');
      if (!btn) return;
      const row = btn.closest('[data-key]');
      if (!row) return;
      e.preventDefault();
      const cur = Number(row.dataset.quantity || 0);
      const next = btn.hasAttribute('data-remove') ? 0 : Math.max(0, cur + Number(btn.dataset.qty));
      change(row.dataset.key, next);
    });

    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-add-to-cart]');
      if (!btn) return;
      e.preventDefault();
      const form = btn.closest('form');
      const id = btn.dataset.variantId || form?.querySelector('[name="id"]')?.value;
      const qty = form?.querySelector('[name="quantity"]')?.value || 1;
      if (!id) return;
      btn.classList.add('is-busy');
      add(id, qty).finally(() => btn.classList.remove('is-busy'));
    });

    refresh();
    return { add, refresh };
  })();

  /* ---------------------------------------------------- header mega menu */
  (() => {
    const root = $('[data-drop]');
    if (!root) return;
    const btn = $('[data-drop-btn]', root);
    const panel = $('[data-drop-panel]', root);
    if (!btn || !panel) return;
    let closeTimer;

    function open() {
      clearTimeout(closeTimer);
      panel.hidden = false;
      requestAnimationFrame(() => panel.classList.add('is-on'));
      btn.setAttribute('aria-expanded', 'true');
    }
    function close() {
      panel.classList.remove('is-on');
      btn.setAttribute('aria-expanded', 'false');
      closeTimer = setTimeout(() => { panel.hidden = true; }, 240);
    }
    const toggle = () => (btn.getAttribute('aria-expanded') === 'true' ? close() : open());

    btn.addEventListener('click', (e) => { e.preventDefault(); toggle(); });

    /* hover is a convenience on pointer devices; click and keyboard still work */
    if (window.matchMedia('(hover: hover)').matches) {
      root.addEventListener('mouseenter', open);
      root.addEventListener('mouseleave', close);
      panel.addEventListener('mouseenter', open);
      panel.addEventListener('mouseleave', close);
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && btn.getAttribute('aria-expanded') === 'true') { close(); btn.focus(); }
    });
    document.addEventListener('click', (e) => {
      if (!root.contains(e.target) && !panel.contains(e.target)) close();
    });
    panel.addEventListener('focusout', (e) => {
      if (!panel.contains(e.relatedTarget) && !root.contains(e.relatedTarget)) close();
    });
  })();

  /* ------------------------------------------------------- hero banner --- */
  (() => {
    const root = $('[data-hero]');
    if (!root) return;
    const slides = $$('[data-hero-slide]', root);
    const dots   = $$('[data-hero-dot]', root);
    if (slides.length < 2) return;
    const autoplay = root.dataset.autoplay !== 'false';
    const interval = Math.max(3000, Number(root.dataset.interval) || 5000);
    let i = 0, timer;

    function go(n) {
      i = (n + slides.length) % slides.length;
      slides.forEach((s, k) => {
        const on = k === i;
        s.classList.toggle('is-on', on);
        s.setAttribute('aria-hidden', String(!on));
        /* a hidden slide is still a link — keep it out of the tab order */
        if (on) s.removeAttribute('tabindex');
        else s.setAttribute('tabindex', '-1');
      });
      dots.forEach((d, k) => {
        d.classList.toggle('is-on', k === i);
        d.setAttribute('aria-selected', String(k === i));
      });
    }

    const start = () => {
      if (reduceMotion || !autoplay) return;
      clearInterval(timer);
      timer = setInterval(() => go(i + 1), interval);
    };
    const stop = () => clearInterval(timer);

    dots.forEach((d, k) => d.addEventListener('click', () => { stop(); go(k); start(); }));
    $('[data-hero-next]', root)?.addEventListener('click', () => { stop(); go(i + 1); start(); });
    $('[data-hero-prev]', root)?.addEventListener('click', () => { stop(); go(i - 1); start(); });

    root.addEventListener('mouseenter', stop);
    root.addEventListener('mouseleave', start);
    root.addEventListener('focusin', stop);

    /* swipe on touch */
    let x0 = null;
    root.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; stop(); }, { passive: true });
    root.addEventListener('touchend', (e) => {
      if (x0 === null) return;
      const dx = e.changedTouches[0].clientX - x0;
      if (Math.abs(dx) > 40) go(dx < 0 ? i + 1 : i - 1);
      x0 = null;
      start();
    }, { passive: true });

    go(0);
    start();
  })();

  /* ------------------------------------------------------- announcement bar */
  (() => {
    const root = $('[data-anno]');
    if (!root) return;
    const items = $$('[data-anno-item]', root);
    if (items.length < 2) return;
    let i = 0, timer;

    const go = (n) => {
      items[i].classList.remove('is-on');
      i = (n + items.length) % items.length;
      items[i].classList.add('is-on');
    };
    const start = () => { if (!reduceMotion) timer = setInterval(() => go(i + 1), 6000); };
    const stop = () => clearInterval(timer);

    $('[data-anno-next]', root)?.addEventListener('click', () => { stop(); go(i + 1); start(); });
    $('[data-anno-prev]', root)?.addEventListener('click', () => { stop(); go(i - 1); start(); });
    root.addEventListener('mouseenter', stop);
    root.addEventListener('mouseleave', start);
    start();
  })();

  /* -------------------------------------------------- rotating placeholder */
  (() => {
    const input = $('[data-rotating-placeholder]');
    if (!input || reduceMotion) return;
    let list;
    try { list = JSON.parse(input.dataset.rotatingPlaceholder); } catch { return; }
    if (!Array.isArray(list) || !list.length) return;
    let i = 0;
    setInterval(() => {
      if (document.activeElement === input || input.value) return;
      i = (i + 1) % list.length;
      input.placeholder = `Search for “${list[i]}”`;
    }, 2800);
  })();

  /* ------------------------------------------------------ predictive search */
  (() => {
    const forms = $$('[data-search-form]');
    if (!forms.length) return;

    forms.forEach((form) => {
      const input = form.querySelector('input[type="search"]');
      const box = form.querySelector('[data-suggest]') || form.parentElement.querySelector('[data-suggest]');
      if (!input || !box) return;
      let t;

      input.addEventListener('input', () => {
        clearTimeout(t);
        const q = input.value.trim();
        if (q.length < 2) { box.hidden = true; box.innerHTML = ''; return; }
        t = setTimeout(async () => {
          try {
            const r = await (await fetch(`/search/suggest?q=${encodeURIComponent(q)}`)).json();
            if (!r.products.length && !r.concerns.length) {
              box.innerHTML = `<p class="sg__empty">Nothing matched “${q}”. Try a concern or an ingredient.</p>`;
            } else {
              box.innerHTML = [
                ...r.concerns.map((c) => `<a class="sg" href="${'/collections/' + c.slug}">
                    <div><div class="sg__t">${c.label}</div><div class="sg__s">Concern · ${c.count} products</div></div></a>`),
                ...r.products.map((p) => `<a class="sg" href="${p.url}">
                    ${p.image ? `<img src="${p.image}" alt="" width="42" height="42">` : '<div class="sg__img"></div>'}
                    <div><div class="sg__t">${p.title}</div><div class="sg__s">${p.subtitle || ''}</div></div>
                    <span class="sg__p">${p.price}</span></a>`),
              ].join('');
            }
            box.hidden = false;
          } catch (_) { box.hidden = true; }
        }, 180);
      });

      document.addEventListener('click', (e) => {
        if (!form.contains(e.target)) box.hidden = true;
      });
    });
  })();

  /* ------------------------------------------------------------- accordions */
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.acc__btn');
    if (!btn) return;
    const panel = btn.nextElementSibling;
    if (!panel) return;
    const openNow = btn.getAttribute('aria-expanded') === 'true';

    if (btn.closest('[data-acc-single]') && !openNow) {
      $$('.acc__btn[aria-expanded="true"]', btn.closest('[data-acc-single]')).forEach((b) => {
        b.setAttribute('aria-expanded', 'false');
        b.nextElementSibling.style.height = '0px';
      });
    }
    btn.setAttribute('aria-expanded', String(!openNow));
    panel.style.height = openNow ? '0px' : `${panel.firstElementChild.offsetHeight}px`;
  });

  /* ------------------------------------------------------------ reveal ---- */
  (() => {
    const targets = $$('[data-reveal],[data-reveal-stagger]');
    if (!targets.length) return;
    if (reduceMotion || !('IntersectionObserver' in window)) {
      targets.forEach((t) => t.classList.add('is-in'));
      return;
    }
    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        if (!en.isIntersecting) return;
        en.target.classList.add('is-in');
        io.unobserve(en.target);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.06 });
    targets.forEach((t) => io.observe(t));

    /* Nothing may stay invisible because an observer never fired — a page
       loaded in a background tab, a prerender, a browser quirk. Content
       always wins over the animation. */
    setTimeout(() => targets.forEach((t) => t.classList.add('is-shown')), 4000);
  })();

  /* --------------------------------------------------------- rail controls */
  $$('[data-rail]').forEach((rail) => {
    const wrap = rail.closest('[data-rail-wrap]') || rail.parentElement;
    const prev = wrap?.querySelector('[data-rail-prev]');
    const next = wrap?.querySelector('[data-rail-next]');
    if (!prev || !next) return;

    const step = () => rail.firstElementChild?.offsetWidth + 16 || 280;
    const sync = () => {
      const max = rail.scrollWidth - rail.clientWidth - 4;
      prev.disabled = rail.scrollLeft <= 4;
      next.disabled = rail.scrollLeft >= max;
      const idle = max <= 4;
      prev.hidden = next.hidden = idle;
    };
    prev.addEventListener('click', () => rail.scrollBy({ left: -step(), behavior: reduceMotion ? 'auto' : 'smooth' }));
    next.addEventListener('click', () => rail.scrollBy({ left: step(), behavior: reduceMotion ? 'auto' : 'smooth' }));
    rail.addEventListener('scroll', sync, { passive: true });
    window.addEventListener('resize', sync);
    sync();
  });

  /* ------------------------------------------------------------ tab groups */
  $$('[data-tabs]').forEach((group) => {
    const btns = $$('[data-tab]', group);
    const panes = $$('[data-tab-pane]', group);
    btns.forEach((btn) => btn.addEventListener('click', () => {
      const key = btn.dataset.tab;
      btns.forEach((b) => { b.classList.toggle('is-on', b === btn); b.setAttribute('aria-pressed', String(b === btn)); });
      panes.forEach((p) => { p.hidden = p.dataset.tabPane !== key; });
      group.dispatchEvent(new CustomEvent('tabchange', { detail: { key } }));
    }));
  });

  /* ------------------------------------------------------ collection grid */
  (() => {
    const root = $('[data-collection]');
    const grid = $('[data-grid]');
    if (!root || !grid) return;
    const items = $$('[data-item]', grid);
    const countEl = $('[data-count]');
    const noneEl = $('[data-none]');
    let filter = '*';

    function apply() {
      let shown = 0;
      items.forEach((it) => {
        const tags = (it.dataset.filters || '').split('|');
        const on = filter === '*' || tags.includes(filter);
        it.hidden = !on;
        if (on) shown++;
      });
      if (countEl) {
        countEl.hidden = filter === '*';
        countEl.textContent = `${shown} product${shown === 1 ? '' : 's'} in ${filter}`;
      }
      if (noneEl) noneEl.hidden = shown > 0;
    }

    $$('[data-filter]', root).forEach((btn) => btn.addEventListener('click', () => {
      filter = btn.dataset.filter;
      $$('[data-filter]', root).forEach((b) => {
        b.classList.toggle('is-on', b === btn);
        b.setAttribute('aria-pressed', String(b === btn));
      });
      apply();
    }));

    $('[data-sort]', root)?.addEventListener('change', (e) => {
      const how = e.target.value;
      const sorted = [...items].sort((a, b) => {
        if (how === 'price-asc')  return Number(a.dataset.price) - Number(b.dataset.price);
        if (how === 'price-desc') return Number(b.dataset.price) - Number(a.dataset.price);
        if (how === 'name')       return a.dataset.name.localeCompare(b.dataset.name);
        return 0;
      });
      sorted.forEach((el) => grid.appendChild(el));
    });
  })();

  /* =========================================================== product page */

  /* --- gallery --- */
  (() => {
    const stage = $('.pdp__stage');
    if (!stage) return;
    const shots = $$('.pdp__shot', stage);
    $$('.pdp__thumb').forEach((thumb) => thumb.addEventListener('click', () => {
      const i = thumb.dataset.thumb;
      shots.forEach((s) => s.classList.toggle('is-on', s.dataset.shot === i));
      $$('.pdp__thumb').forEach((t) => {
        t.classList.toggle('is-on', t === thumb);
        t.setAttribute('aria-selected', String(t === thumb));
      });
    }));
  })();

  /* --- read more --- */
  (() => {
    const btn = $('[data-clamp-toggle]');
    const box = $('[data-clamp]');
    if (!btn || !box) return;
    btn.addEventListener('click', () => {
      const open = box.classList.toggle('is-open');
      btn.textContent = open ? 'Read less' : 'Read more';
      btn.setAttribute('aria-expanded', String(open));
    });
  })();

  /* --- quantity ---
     The pack ladder that used to live here went with its markup: every product
     is a single stocked bottle, so there is no variant to switch between. If
     real pre-packed SKUs ever exist, the selector has to set both the add-to-
     cart dataset and the form's hidden id input — the wallet buttons submit the
     form directly and would otherwise check out the first-rendered variant. */
  (() => {
    const qtyVal = $('[data-qty-value]');
    const qtyInput = $('[data-qty-input]');

    $$('[data-qty-step]').forEach((btn) => btn.addEventListener('click', () => {
      if (!qtyVal || !qtyInput) return;
      const next = Math.max(1, Number(qtyVal.textContent) + Number(btn.dataset.qtyStep));
      qtyVal.textContent = next;
      qtyInput.value = next;
    }));

    /* The custom "Buy now" was replaced by Shopify's own accelerated checkout
       buttons, which submit the product form directly — no handler needed. */
  })();

  /* --- delivery estimate ---
     There is no courier serviceability feed, so this is an honest estimate
     from the pincode's postal region rather than a promise. */
  (() => {
    const root = $('[data-pincode]');
    if (!root) return;
    const input = $('[data-pin-input]', root);
    const out = $('[data-pin-out]', root);
    const btn = $('[data-pin-check]', root);

    const METRO = /^(11|12|16|14|40|41|56|60|50|70|38|39|30|20|22|26|48)/;

    function check() {
      const pin = (input.value || '').trim();
      out.hidden = false;
      if (!/^[1-9][0-9]{5}$/.test(pin)) {
        out.classList.add('is-bad');
        out.textContent = 'Enter a valid 6-digit pincode.';
        return;
      }
      out.classList.remove('is-bad');
      const days = METRO.test(pin) ? 3 : 5;
      const d = new Date();
      d.setDate(d.getDate() + days);
      const when = d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
      out.textContent = `Estimated delivery by ${when} · Cash on delivery available`;
    }

    btn?.addEventListener('click', check);
    input?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); check(); } });
  })();

  /* --- safety & interaction check ---
     Matches the buyer's declared situation against THIS product's own safety
     copy. Nothing is generated; a non-match says so rather than reassuring. */
  (() => {
    const root = $('[data-safety]');
    if (!root) return;
    let lines = [];
    try { lines = JSON.parse(root.dataset.lines) || []; } catch { return; }
    const out = $('[data-safety-out]', root);

    /* `not` excludes lines that merely contain the keyword in an unrelated
       sense — "keep out of reach of children" is a storage instruction, not an
       age contraindication, and surfacing it as one would be misleading. */
    const RULES = {
      'Pregnant or breastfeeding': { re: /pregnan|breastfeed|lactat|nursing/i },
      'Thyroid condition':         { re: /thyroid/i },
      'Diabetes medication':       { re: /diabet|blood sugar|glyc|insulin/i },
      'Blood pressure medication': { re: /blood pressure|hypertens|hypotens/i },
      'Sedatives or sleep aids':   { re: /sedat|drowsi|anticonvuls|tranquil/i },
      'Under 18':                  { re: /child|under 18|18 year|minor|paediatr|pediatr/i,
                                     not: /keep out of reach|store in a cool/i },
      'Surgery scheduled':         { re: /surgery|surgical|an(a)?esthe|bleeding|blood thin/i },
    };

    const active = new Set();

    function paint() {
      if (!active.size) { out.hidden = true; out.innerHTML = ''; return; }
      const blocks = [...active].map((cond) => {
        const rule = RULES[cond];
        const hits = lines.filter((l) => rule && rule.re.test(l) && !(rule.not && rule.not.test(l)));
        if (hits.length) {
          return hits.map((h) => `<div class="safety-hit">
              <div class="safety-hit__c">${cond}</div>
              <p class="safety-hit__t">${h}</p></div>`).join('');
        }
        return `<div class="safety-hit" style="border-left-color:var(--gold);background:var(--gold-wash)">
            <div class="safety-hit__c" style="color:var(--gold-deep)">${cond}</div>
            <p class="safety-hit__t">This product’s safety information does not mention
            ${cond.toLowerCase()} specifically. That is not the same as “safe for you” —
            please confirm with a qualified healthcare professional before use.</p></div>`;
      });
      out.innerHTML = blocks.join('');
      out.hidden = false;
    }

    $$('[data-cond]', root).forEach((chip) => chip.addEventListener('click', () => {
      const c = chip.dataset.cond;
      const on = active.has(c);
      on ? active.delete(c) : active.add(c);
      chip.classList.toggle('is-on', !on);
      chip.setAttribute('aria-pressed', String(!on));
      paint();
    }));
  })();

  /* --- routine builder --- */
  (() => {
    const root = $('[data-ritual]');
    if (!root) return;
    const totalEl = $('[data-ritual-total]');
    const addBtn = $('[data-ritual-add]');
    const items = () => $$('[data-ritual-item]', root);

    function total() {
      const sum = items().filter((i) => i.checked).reduce((n, i) => n + Number(i.dataset.price), 0);
      if (totalEl) totalEl.textContent = money(sum);
      if (addBtn) addBtn.disabled = sum === 0;
    }

    root.addEventListener('change', total);

    addBtn?.addEventListener('click', async () => {
      const chosen = items().filter((i) => i.checked).map((i) => ({ id: Number(i.value), quantity: 1 }));
      if (!chosen.length) return;
      addBtn.disabled = true;
      try {
        await fetch('/cart/add.js', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: chosen }),
        });
        await Cart.refresh();
        Panels.show('cart');
      } finally { addBtn.disabled = false; }
    });

    total();
  })();

  /* ============================================================ tool pages */

  const CATALOG = (() => {
    const el = document.getElementById('hb-catalog');
    if (!el) return null;
    try { return JSON.parse(el.textContent); } catch { return null; }
  })();

  /* Topical vs ingestible — the split that makes a cross-category routine work. */
  const isTopical = (p) => /serum|oil|cream|gel|lotion/i.test(p.t);

  /* --- ritual builder --- */
  (() => {
    const root = $('[data-rb]');
    if (!root || !CATALOG) return;

    const list   = $('[data-rb-list]', root);
    const totEl  = $('[data-rb-total]', root);
    const descEl = $('[data-rb-desc]', root);
    const noteEl = $('[data-rb-note]', root);
    const addBtn = $('[data-rb-add]', root);

    let concern = $('[data-rb-concern]', root)?.dataset.rbConcern;
    let depth = 3;
    let picks = [];

    function build() {
      const inConcern = CATALOG.filter((p) => p.c === concern);
      const primary = inConcern[0];
      if (!primary) { picks = []; return; }

      const chosen = [primary];
      /* prefer the opposite form for the second slot — a serum next to a tablet */
      const opposite = inConcern.find((p) => p !== primary && isTopical(p) !== isTopical(primary));
      const second = opposite || inConcern[1];
      if (second) chosen.push(second);

      const daily = CATALOG.find((p) => p.c === 'daily-essentials' && !chosen.includes(p));
      if (daily) chosen.push(daily);

      const night = CATALOG.find((p) => (p.c === 'sleep-stress' || p.c === 'liver-detox') && !chosen.includes(p));
      if (night) chosen.push(night);

      const SLOTS = ['Morning', 'Evening', 'Daily', 'Night'];
      picks = chosen.slice(0, depth).map((p, i) => ({
        p,
        slot: SLOTS[i] || 'Daily',
        note: i === 0 ? 'The formula for the concern you picked'
            : i === 1 ? (isTopical(p) ? 'The topical half of the same routine' : 'Works alongside it on the same concern')
            : i === 2 ? 'The daily base everything sits on'
            : 'Recovery while you sleep',
        on: true,
      }));
    }

    function paint() {
      list.innerHTML = picks.map((r, i) => `
        <label class="rit">
          <input class="sr" type="checkbox" ${r.on ? 'checked' : ''} data-rb-item="${i}">
          <span class="rit__slot">${r.slot}</span>
          ${r.p.img ? `<img class="rit__img" src="${r.p.img}" alt="" width="64" height="64" loading="lazy">` : '<span class="rit__img"></span>'}
          <span>
            <span class="rit__t">${r.p.t}</span>
            <span class="rit__n">${r.note}</span>
          </span>
          <span class="rit__p">${money(r.p.price)}</span>
        </label>`).join('');

      const on = picks.filter((r) => r.on);
      const sum = on.reduce((n, r) => n + r.p.price, 0);
      totEl.textContent = on.length ? money(sum) : '—';
      addBtn.disabled = !on.length;

      const label = $(`[data-rb-concern="${concern}"]`, root)?.textContent.trim() || concern;
      descEl.textContent = on.length
        ? `${on.length} formulas for ${label}: ${on.map((r) => r.p.t).join(', ')}.`
        : 'Tick at least one product to build a routine.';

      const topicals = on.filter((r) => isTopical(r.p)).length;
      noteEl.textContent = topicals && topicals < on.length
        ? 'This routine works from both directions — something you take and something you apply.'
        : 'Every formula here is taken orally. Add a serum or oil for a topical layer.';
    }

    root.addEventListener('click', (e) => {
      const c = e.target.closest('[data-rb-concern]');
      if (c) {
        concern = c.dataset.rbConcern;
        $$('[data-rb-concern]', root).forEach((b) => {
          b.classList.toggle('is-on', b === c);
          b.setAttribute('aria-pressed', String(b === c));
        });
        build(); paint(); return;
      }
      const d = e.target.closest('[data-rb-depth]');
      if (d) {
        depth = Number(d.dataset.rbDepth);
        $$('[data-rb-depth]', root).forEach((b) => {
          b.classList.toggle('is-on', b === d);
          b.setAttribute('aria-pressed', String(b === d));
        });
        build(); paint();
      }
    });

    list.addEventListener('change', (e) => {
      const cb = e.target.closest('[data-rb-item]');
      if (!cb) return;
      picks[Number(cb.dataset.rbItem)].on = cb.checked;
      paint();
    });

    addBtn.addEventListener('click', async () => {
      const items = picks.filter((r) => r.on).map((r) => ({ id: r.p.vid, quantity: 1 }));
      if (!items.length) return;
      addBtn.disabled = true;
      try {
        await fetch('/cart/add.js', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items }),
        });
        await Cart.refresh();
        Panels.show('cart');
      } finally { addBtn.disabled = false; }
    });

    build(); paint();
  })();

  /* --- label compare --- */
  (() => {
    const root = $('[data-compare]');
    if (!root || !CATALOG) return;
    const selA = $('[data-cmp="a"]', root);
    const selB = $('[data-cmp="b"]', root);
    const out = $('[data-cmp-out]', root);

    const options = CATALOG.map((p, i) => `<option value="${i}">${p.t}</option>`).join('');
    selA.innerHTML = options;
    selB.innerHTML = options;
    selA.selectedIndex = 0;
    selB.selectedIndex = Math.min(1, CATALOG.length - 1);

    function panel(p) {
      const dosed = p.ing.filter((i) => i.d).length;
      return `<div class="cmp__card">
        <div class="cmp__hd">
          ${p.img ? `<img src="${p.img}" alt="" width="56" height="56">` : ''}
          <div>
            <div class="cmp__t">${p.t}</div>
            <div class="cmp__p">${money(p.price)} · ${p.pack || ''}</div>
          </div>
        </div>
        <div class="cmp__stat">
          <span><b>${p.ing.length}</b>actives listed</span>
          <span><b>${dosed}</b>with a declared dose</span>
        </div>
        <div class="label-panel">
          <div class="label-panel__hd">
            <span class="label-panel__t">Supplement facts</span>
            <span class="label-panel__s">${p.pack || ''}</span>
          </div>
          <div class="label-panel__rule"></div>
          ${p.ing.length ? p.ing.map((i) => `<div class="label-row">
              <span class="label-row__n">${i.n}</span>
              <span class="label-row__d">${i.d ? i.d : '<em class="t-dim-3">not declared</em>'}</span>
            </div>`).join('')
            : '<div class="label-row"><span class="label-row__n">No ingredient list published for this product.</span></div>'}
        </div>
        <a class="btn btn--ghost btn--sm" href="/products/${p.h}">View ${p.t}</a>
      </div>`;
    }

    function paint() {
      out.innerHTML = panel(CATALOG[selA.value]) + panel(CATALOG[selB.value]);
    }
    selA.addEventListener('change', paint);
    selB.addEventListener('change', paint);
    paint();
  })();

  window.Helbrede = { Cart, Panels, money };
})();
