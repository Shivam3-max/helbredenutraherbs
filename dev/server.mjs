/**
 * Local Shopify emulator for the Helbrede theme.
 *
 * Express + LiquidJS standing in for Shopify's object graph, filters, tags and
 * the /cart/*.js AJAX API, so the theme can be built and reviewed with no store
 * attached and no credentials.
 *
 *   npm run dev   ->  http://localhost:3660
 *
 * Two LiquidJS traps are handled deliberately here, because both fail silently
 * and produce valid-looking HTML with sections missing:
 *   1. custom block tags must use a generator `*render(ctx, emitter)`, never
 *      `async render` — awaiting renderTemplates() resolves the generator
 *      object without ever running it.
 *   2. `{% render %}` isolates scope, so Shopify globals have to be passed as
 *      renderOptions.globals or every snippet loses `settings` and `routes`.
 */
import express from 'express';
import { Liquid } from 'liquidjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const THEME = path.join(ROOT, 'theme');
const PORT = process.env.PORT || 3660;

const shopData = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/shop.json'), 'utf8'));

/* ========================================================================== *
 * 1. Object graph
 * ========================================================================== */
/* Indian grouping (1,00,000 not 100,000) — Intl gets the lakh/crore rule right. */
const INR = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const money = (paise) => `₹${INR.format(Math.round(Number(paise || 0)) / 100)}`;

function toVariant(v, product) {
  return {
    ...v,
    available: v.available !== false,
    inventory_quantity: 99,
    featured_image: null,
    product_handle: product.handle,
    url: `/products/${product.handle}?variant=${v.id}`,
    options: [v.option1],
  };
}

function toProduct(p) {
  const variants = p.variants.map((v) => toVariant(v, p));
  const images = p.images.map((src, i) => ({ src, alt: `${p.title} — view ${i + 1}`, id: i + 1, position: i + 1 }));
  const mf = p.metafields;

  return {
    ...p,
    url: `/products/${p.handle}`,
    variants,
    first_available_variant: variants.find((v) => v.available) || variants[0],
    selected_or_first_available_variant: variants[0],
    images,
    media: images,
    featured_image: images[0] || null,
    featured_media: images[0] || null,
    options_with_values: [{ name: 'Pack', values: variants.map((v) => v.option1) }],
    has_only_default_variant: false,
    /* Shopify exposes metafields as {namespace}.{key} objects with .value.
       `title`, `concern` and `pack_size` live at the top level of shop.json but
       are seeded into the same namespace by scripts/shopify-configure.mjs, so
       mirror the seeded set exactly — otherwise a template reading one of them
       silently falls back here and only diverges on the real store. */
    metafields: {
      helbrede: Object.fromEntries(
        Object.entries({ ...mf, title: p.title, concern: p.concern, pack_size: p.pack_size })
          .filter(([, v]) => v !== undefined && v !== null && v !== '')
          .map(([k, v]) => [k, { value: v, type: typeof v === 'string' ? 'single_line_text_field' : 'json' }]),
      ),
      reviews: { rating: { value: null }, rating_count: { value: null } },
    },
    /* flattened for template convenience */
    hb: mf,
  };
}

const products = shopData.products.map(toProduct);
const productByHandle = new Map(products.map((p) => [p.handle, p]));
const variantById = new Map();
for (const p of products) for (const v of p.variants) variantById.set(v.id, { product: p, variant: v });

const collections = {};
for (const [handle, c] of Object.entries(shopData.collections)) {
  collections[handle] = {
    ...c,
    url: `/collections/${handle}`,
    products: c.products.map((p) => productByHandle.get(p.handle)).filter(Boolean),
    all_products_count: c.products_count,
  };
}

const concerns = shopData.concerns.map((c) => ({ ...c, url: `/collections/${c.slug}`, collection: collections[c.slug] }));
const ingredients = shopData.ingredients.map((i) => ({
  ...i,
  handle: i.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
  products: i.products.map((h) => productByHandle.get(h)).filter(Boolean),
}));

/*
 * The ingredient library is backed by metaobjects on the real store. Shopify
 * hands Liquid a `system` block plus one wrapper object per field, and reaches
 * entries through `shop.metaobjects.<type>.values` — mirror that exactly, so the
 * templates are written once against the real shape and this harness proves it.
 * The URL matches Shopify's own `/pages/{urlHandle}/{entry}` routing.
 */
const ingredientMetaobjects = ingredients.map((i) => ({
  system: { handle: i.handle, type: 'ingredient', url: `/pages/ingredients/${i.handle}` },
  name: { value: i.name, type: 'single_line_text_field' },
  body: { value: i.body, type: 'multi_line_text_field' },
  products: { value: i.products, type: 'list.product_reference' },
}));
const ingredientMetaobjectByHandle = new Map(ingredientMetaobjects.map((m) => [m.system.handle, m]));

/* ========================================================================== *
 * 2. Cart
 * ========================================================================== */
const cart = { items: [], item_count: 0, total_price: 0, original_total_price: 0, total_discount: 0, currency: 'INR', note: '' };

function recalcCart() {
  cart.item_count = cart.items.reduce((n, i) => n + i.quantity, 0);
  cart.total_price = cart.items.reduce((n, i) => n + i.line_price, 0);
  cart.original_total_price = cart.items.reduce((n, i) => n + (i.original_price || i.price) * i.quantity, 0);
  cart.total_discount = Math.max(0, cart.original_total_price - cart.total_price);
}

function addToCart(id, quantity = 1) {
  const rec = variantById.get(Number(id));
  if (!rec) return null;
  const { product, variant } = rec;
  let line = cart.items.find((i) => i.variant_id === variant.id);
  if (line) {
    line.quantity += quantity;
  } else {
    line = {
      key: `${product.id}:${variant.id}`,
      id: variant.id,
      variant_id: variant.id,
      product_id: product.id,
      product_handle: product.handle,
      product_title: product.title,
      title: `${product.title} — ${variant.title}`,
      variant_title: variant.title,
      quantity,
      price: variant.price,
      original_price: variant.compare_at_price || variant.price,
      image: product.featured_image?.src || null,
      url: `/products/${product.handle}`,
      units: variant.units,
      pack_size: product.pack_size,
      line_price: 0,
    };
    cart.items.push(line);
  }
  cart.items.forEach((i) => { i.line_price = i.price * i.quantity; });
  recalcCart();
  return line;
}

function changeCart(key, quantity) {
  const i = cart.items.findIndex((x) => x.key === key || String(x.variant_id) === String(key));
  if (i < 0) return;
  if (quantity <= 0) cart.items.splice(i, 1);
  else { cart.items[i].quantity = quantity; cart.items[i].line_price = cart.items[i].price * quantity; }
  recalcCart();
}

/* ========================================================================== *
 * 3. Liquid engine
 * ========================================================================== */
const engine = new Liquid({
  root: [
    path.join(THEME, 'sections'),
    path.join(THEME, 'snippets'),
    path.join(THEME, 'templates'),
    path.join(THEME, 'layout'),
  ],
  extname: '.liquid',
  cache: false,
  jsTruthy: true,
  strictFilters: false,
  strictVariables: false,
});

/* --- filters --- */
const F = engine.registerFilter.bind(engine);
F('asset_url', (v) => `/assets/${v}`);
F('asset_img_url', (v) => `/assets/${v}`);
F('file_url', (v) => `/assets/${v}`);
F('file_img_url', (v) => `/assets/${v}`);
F('shopify_asset_url', (v) => `/assets/${v}`);
F('stylesheet_tag', (v) => `<link rel="stylesheet" href="${v}">`);
F('script_tag', (v) => `<script src="${v}" defer></script>`);
F('image_url', (img) => (typeof img === 'string' ? img : img?.src || ''));
F('img_url', (img) => (typeof img === 'string' ? img : img?.src || ''));
F('image_tag', (url, ...a) => `<img src="${url}" alt="" loading="lazy">`);
F('money', money);
F('money_with_currency', (v) => `${money(v)} INR`);
F('money_without_currency', (v) => (Number(v || 0) / 100).toFixed(2));
F('money_without_trailing_zeros', money);
F('handle', (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
F('handleize', (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
F('t', (v) => String(v));
F('json', (v) => JSON.stringify(v));
F('within', (url) => url);
F('link_to', (label, url) => `<a href="${url}">${label}</a>`);
F('pluralize', (n, one, many) => (n === 1 ? one : many));
F('strip_html', (s) => String(s || '').replace(/<[^>]*>/g, ''));
F('placeholder_svg_tag', () => '');
F('metafield_text', (m) => (m && m.value != null ? m.value : ''));
F('metafield_tag', (m) => (m && m.value != null ? m.value : ''));
F('default_errors', () => '');
F('payment_type_svg_tag', () => '');
F('weight_with_unit', (w) => `${w} g`);
F('format_address', () => '');
F('highlight', (s) => s);
F('camelize', (s) => String(s || ''));
F('sort_natural', (arr) => [...(arr || [])].sort());
F('date', (v) => String(v || ''));

/* --- tags --- */
engine.registerTag('schema', {
  parse(token, remain) { while (remain.length) { const t = remain.shift(); if (t.name === 'endschema') return; } },
  render() { return ''; },
});

for (const name of ['javascript', 'stylesheet']) {
  engine.registerTag(name, {
    parse(token, remain) { while (remain.length) { const t = remain.shift(); if (t.name === `end${name}`) return; } },
    render() { return ''; },
  });
}

engine.registerTag('style', {
  parse(token, remain) {
    this.tpls = [];
    const stream = this.liquid.parser.parseStream(remain);
    stream.on('tag:endstyle', function () { this.stop(); })
      .on('template', (tpl) => this.tpls.push(tpl))
      .on('end', () => { throw new Error('{% style %} not closed'); });
    stream.start();
  },
  *render(ctx, emitter) {
    emitter.write('<style>');
    yield this.liquid.renderer.renderTemplates(this.tpls, ctx, emitter);
    emitter.write('</style>');
  },
});

engine.registerTag('form', {
  parse(token, remain) {
    this.args = token.args;
    this.tpls = [];
    const stream = this.liquid.parser.parseStream(remain);
    stream.on('tag:endform', function () { this.stop(); })
      .on('template', (tpl) => this.tpls.push(tpl))
      .on('end', () => { throw new Error('{% form %} not closed'); });
    stream.start();
  },
  *render(ctx, emitter) {
    const kind = (this.args.split(',')[0] || '').trim().replace(/^['"]|['"]$/g, '');
    const action = kind === 'product' ? '/cart/add' : kind === 'cart' ? '/cart' : '/';
    emitter.write(`<form method="post" action="${action}" accept-charset="UTF-8" class="form form--${kind}" data-form="${kind}">`);
    yield this.liquid.renderer.renderTemplates(this.tpls, ctx, emitter);
    emitter.write('</form>');
  },
});

engine.registerTag('paginate', {
  parse(token, remain) {
    this.args = token.args;
    this.tpls = [];
    const stream = this.liquid.parser.parseStream(remain);
    stream.on('tag:endpaginate', function () { this.stop(); })
      .on('template', (tpl) => this.tpls.push(tpl))
      .on('end', () => { throw new Error('{% paginate %} not closed'); });
    stream.start();
  },
  *render(ctx, emitter) {
    const m = this.args.match(/^(.+?)\s+by\s+(\d+)/);
    const per = m ? parseInt(m[2], 10) : 24;
    const coll = m ? yield this.liquid.evalValue(m[1].trim(), ctx) : [];
    const arr = Array.isArray(coll) ? coll : [];
    ctx.push({ paginate: { items: arr.length, current_page: 1, pages: Math.ceil(arr.length / per) || 1, parts: [], next: null, previous: null, page_size: per } });
    yield this.liquid.renderer.renderTemplates(this.tpls, ctx, emitter);
    ctx.pop();
  },
});

/** Section defaults read straight out of the {% schema %} block. */
function buildSection(name, src) {
  const m = src.match(/\{%-?\s*schema\s*-?%\}([\s\S]*?)\{%-?\s*endschema\s*-?%\}/);
  const section = { id: name, settings: {}, blocks: [] };
  if (!m) return section;
  let schema;
  try { schema = JSON.parse(m[1]); } catch (e) {
    console.warn(`  ! ${name}: schema is not valid JSON — ${e.message}`);
    return section;
  }
  for (const s of schema.settings || []) {
    if (!s.id) continue;
    section.settings[s.id] = s.default !== undefined ? s.default : (s.type === 'checkbox' ? false : '');
  }
  const preset = (schema.presets || [])[0];
  if (preset) {
    Object.assign(section.settings, preset.settings || {});
    (preset.blocks || []).forEach((b, i) => {
      const def = (schema.blocks || []).find((x) => x.type === b.type);
      const settings = {};
      for (const s of def?.settings || []) {
        if (!s.id) continue;
        settings[s.id] = s.default !== undefined ? s.default : (s.type === 'checkbox' ? false : '');
      }
      Object.assign(settings, b.settings || {});
      section.blocks.push({ id: `${name}-${i}`, type: b.type, settings, shopify_attributes: '' });
    });
  }
  return section;
}

engine.registerTag('section', {
  parse(token) { this.name = token.args.trim().replace(/^['"]|['"]$/g, ''); },
  *render(ctx, emitter) {
    const file = path.join(THEME, 'sections', `${this.name}.liquid`);
    if (!fs.existsSync(file)) { emitter.write(`<!-- section ${this.name} missing -->`); return; }
    const src = fs.readFileSync(file, 'utf8');
    const section = buildSection(this.name, src);
    const globals = ctx.globals || {};
    const override = globals.__section_data?.[this.name];
    if (override) {
      if (override.settings) Object.assign(section.settings, override.settings);
      if (override.blocks) {
        section.blocks = override.blocks.map((b, i) => ({ id: `${this.name}-${i}`, type: b.type, settings: b.settings || {}, shopify_attributes: '' }));
      }
    }
    const html = yield engine.parseAndRender(src, { section }, { globals });
    emitter.write(`<div id="shopify-section-${this.name}" class="shopify-section">${html}</div>`);
  },
});

/* ========================================================================== *
 * 4. Globals
 * ========================================================================== */
/*
 * Theme settings come from the theme's own config, exactly as they do on
 * Shopify: schema defaults first, then whatever settings_data.json overrides.
 *
 * This used to be a hardcoded object, which quietly invented settings the theme
 * did not declare — `announcements` among them. Locally the announcement bar
 * rotated three offers; on the real store `settings.announcements` was nil and
 * the bar rendered empty, which also collapsed its height and shifted every
 * section below it. Reading the real files means a setting the theme has not
 * declared is missing here too, and the smoke run sees it.
 */
const settings = (() => {
  const out = { logo: null };
  const schemaPath = path.join(THEME, 'config/settings_schema.json');
  if (fs.existsSync(schemaPath)) {
    for (const group of JSON.parse(fs.readFileSync(schemaPath, 'utf8'))) {
      for (const f of group.settings || []) {
        if (f.id && f.default !== undefined) out[f.id] = f.default;
      }
    }
  }
  const dataPath = path.join(THEME, 'config/settings_data.json');
  if (fs.existsSync(dataPath)) {
    const raw = fs.readFileSync(dataPath, 'utf8').replace(/^﻿?\s*\/\*[\s\S]*?\*\//, '');
    Object.assign(out, JSON.parse(raw).current || {});
  }
  return out;
})();

const routes = {
  root_url: '/', cart_url: '/cart', cart_add_url: '/cart/add', cart_change_url: '/cart/change',
  cart_update_url: '/cart/update', search_url: '/search', all_products_collection_url: '/collections/all',
  account_url: '/account', account_login_url: '/account/login', predictive_search_url: '/search/suggest',
};

const shop = {
  name: 'Helbrede Nutraherbs', email: settings.email, domain: 'helbredenutraherbs.com',
  url: 'https://helbredenutraherbs.com', currency: 'INR', money_format: '₹{{amount}}',
  metaobjects: { ingredient: { values: ingredientMetaobjects, count: ingredientMetaobjects.length } },
};

const linklists = {
  'main-menu': {
    links: [
      { title: 'Shop All', url: '/collections/all', links: [] },
      ...shopData.menu.map((m) => ({ title: m.title, url: m.url, links: [], count: m.count })),
      { title: 'Ingredients', url: '/pages/ingredients', links: [] },
      { title: 'Free Consultancy', url: '/pages/consultancy', links: [] },
    ],
  },
  footer: {
    links: [
      { title: 'Shop All', url: '/collections/all' },
      { title: 'Build a Ritual', url: '/pages/ritual-builder' },
      { title: 'Read the Label', url: '/pages/label-check' },
      { title: 'Ingredient Library', url: '/pages/ingredients' },
      { title: 'About Us', url: '/pages/about' },
      { title: 'Free Consultancy', url: '/pages/consultancy' },
      { title: 'Contact', url: '/pages/contact' },
      { title: 'FAQs', url: '/pages/faq' },
    ],
  },
};

function baseGlobals(extra = {}) {
  return {
    settings, routes, shop, cart, linklists,
    collections, all_products: products, concerns, ingredients,
    /* Global `metaobjects` is the current spelling; shop.metaobjects is the
       deprecated alias Shopify still honours. Expose both, as the store does. */
    metaobjects: shop.metaobjects,
    canonical_url: 'https://helbredenutraherbs.com',
    current_tags: [], powered_by_link: '',
    request: { design_mode: false, page_type: extra.template || 'index', path: extra.path || '/' },
    ...extra,
  };
}

async function renderPage(res, { template, page_title, page_description, path: p = '/', data = {}, sectionData = null, only = null }) {
  const templateFile = path.join(THEME, 'templates', `${template}.liquid`);
  const jsonFile = path.join(THEME, 'templates', `${template}.json`);

  const globals = baseGlobals({ template, path: p, page_title, page_description, ...data });
  if (sectionData) globals.__section_data = sectionData;

  try {
    let content = '';
    if (fs.existsSync(jsonFile)) {
      const cfg = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
      let order = cfg.order || Object.keys(cfg.sections || {});
      /* ?only=<section-key|type> renders one section alone, at the top of the
         page — the fastest way to review or screenshot a single module. */
      if (only) {
        order = order.filter((k) => k === only || cfg.sections[k]?.type === only);
      }
      const parts = [];
      for (const key of order) {
        const def = cfg.sections[key];
        if (!def) continue;
        const file = path.join(THEME, 'sections', `${def.type}.liquid`);
        if (!fs.existsSync(file)) { parts.push(`<!-- section ${def.type} missing -->`); continue; }
        const src = fs.readFileSync(file, 'utf8');
        const section = buildSection(def.type, src);
        if (def.settings) Object.assign(section.settings, def.settings);
        if (def.blocks) {
          const order2 = def.block_order || Object.keys(def.blocks);
          section.blocks = order2.map((bk, i) => ({
            id: `${key}-${i}`, type: def.blocks[bk].type,
            settings: def.blocks[bk].settings || {}, shopify_attributes: '',
          }));
        }
        section.id = key;
        const html = await engine.parseAndRender(src, { section }, { globals });
        parts.push(`<div id="shopify-section-${key}" class="shopify-section">${html}</div>`);
      }
      content = parts.join('\n');
    } else if (fs.existsSync(templateFile)) {
      content = await engine.parseAndRender(fs.readFileSync(templateFile, 'utf8'), {}, { globals });
    } else {
      content = `<!-- template ${template} missing -->`;
    }

    const layout = fs.readFileSync(path.join(THEME, 'layout', 'theme.liquid'), 'utf8');
    const html = await engine.parseAndRender(layout, { content_for_layout: content }, { globals });
    res.set('content-type', 'text/html; charset=utf-8').send(html);
  } catch (err) {
    console.error(`\n[render ${template}]`, err.message);
    res.status(500).send(`<pre style="padding:2rem;font:13px/1.6 ui-monospace,monospace;white-space:pre-wrap">
<b>Render error — ${template}</b>

${String(err.stack || err.message).replace(/[<>]/g, (c) => ({ '<': '&lt;', '>': '&gt;' }[c]))}</pre>`);
  }
}

/* ========================================================================== *
 * 5. Routes
 * ========================================================================== */
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/assets', express.static(path.join(THEME, 'assets'), { maxAge: 0 }));
app.use('/media', express.static(path.join(ROOT, 'catalog/images'), { maxAge: '1h' }));

app.get('/', (req, res) => renderPage(res, {
  template: 'index', page_title: 'Helbrede Nutraherbs — Ayurvedic & Nutraceutical Wellness', path: '/',
  only: req.query.only || null,
}));

app.get('/collections/all', (req, res) => renderPage(res, {
  template: 'collection', page_title: 'Shop All', path: '/collections/all',
  data: {
    collection: {
      handle: 'all', title: 'Shop All', kind: 'category', url: '/collections/all',
      tagline: 'Every formula, one shelf',
      description: `All ${products.length} Helbrede formulas — supplements, serums and oils across eight concerns.`,
      filters: [], products, products_count: products.length,
    },
  },
}));

app.get('/collections/:handle', (req, res) => {
  const collection = collections[req.params.handle];
  if (!collection) return res.status(404).send(notFound(req.path));
  renderPage(res, {
    template: 'collection', page_title: collection.title, path: req.path,
    page_description: collection.description, data: { collection },
  });
});

app.get('/products/:handle', (req, res) => {
  let product = productByHandle.get(req.params.handle);
  if (!product) return res.status(404).send(notFound(req.path));

  /*
   * `?stock=out` forces the sold-out buy box, the way `?only=` forces a single
   * section. The seeded catalogue is uniformly in stock while a third of the
   * real one is not, so without this the harness could never render that path —
   * which is how an enabled "Add to cart" on a sold-out product reached the live
   * store, where it answered 422 and opened an empty cart drawer.
   */
  if (req.query.stock === 'out') {
    product = {
      ...product,
      available: false,
      variants: product.variants.map((v) => ({ ...v, available: false })),
    };
    product.selected_or_first_available_variant = product.variants[0];
    product.first_available_variant = product.variants[0];
  }

  const related = products
    .filter((p) => p.concern === product.concern && p.handle !== product.handle)
    .slice(0, 8);
  const routine = buildRoutine(product);
  renderPage(res, {
    template: 'product', page_title: product.title, path: req.path,
    page_description: product.subtitle,
    data: { product, collection: collections[product.concern], related, routine },
  });
});

/** A cross-concern routine: the topical + ingestible pairing Kapiva cannot make. */
function buildRoutine(product) {
  const sameConcern = products.filter((p) => p.concern === product.concern && p.handle !== product.handle);
  const daily = products.find((p) => p.concern === 'daily-essentials' && p.handle !== product.handle);
  const support = products.find((p) => ['sleep-stress', 'digestion-gut', 'liver-detox'].includes(p.concern) && p.handle !== product.handle);
  return [
    { slot: 'Morning', product, note: 'Start the routine with the formula you came for' },
    sameConcern[0] && { slot: 'Morning', product: sameConcern[0], note: 'Pairs with it on the same concern' },
    daily && { slot: 'Daily', product: daily, note: 'The base layer everything sits on' },
    support && { slot: 'Night', product: support, note: 'Recovery while you sleep' },
  ].filter(Boolean);
}

const PAGES = {
  'ritual-builder': { title: 'Build Your Ritual', template: 'page.ritual' },
  'label-check': { title: 'Read the Label', template: 'page.label' },
  ingredients: { title: 'Ingredient Library', template: 'page.ingredients' },
  about: { title: 'About Helbrede', template: 'page.about' },
  consultancy: { title: 'Free Ayurvedic Consultancy', template: 'page.consultancy' },
  contact: { title: 'Contact Us', template: 'page.contact' },
  faq: { title: 'Frequently Asked Questions', template: 'page.faq' },
};

app.get('/pages/:handle', (req, res) => {
  const def = PAGES[req.params.handle];
  if (!def) return res.status(404).send(notFound(req.path));
  const tpl = fs.existsSync(path.join(THEME, 'templates', `${def.template}.liquid`)) ? def.template : 'page';
  renderPage(res, {
    template: tpl, page_title: def.title, path: req.path,
    data: { page: { title: def.title, handle: req.params.handle, content: '' } },
  });
});

/* Shopify renders these through templates/metaobject/<type>.liquid, with the
   entry exposed as `metaobject` — not as a page. */
app.get('/pages/ingredients/:handle', (req, res) => {
  const entry = ingredientMetaobjectByHandle.get(req.params.handle);
  if (!entry) return res.status(404).send(notFound(req.path));
  renderPage(res, {
    template: 'metaobject/ingredient', page_title: entry.name.value, path: req.path,
    data: { metaobject: entry },
  });
});

app.get('/cart', (req, res) => renderPage(res, { template: 'cart', page_title: 'Your Cart', path: '/cart' }));

app.get('/search', (req, res) => {
  const q = String(req.query.q || '').trim();
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const results = !terms.length ? [] : products.filter((p) => {
    const hay = `${p.title} ${p.subtitle} ${p.concern_label} ${p.tags.join(' ')} ${p.hb.ingredients.map((i) => i.name).join(' ')}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
  renderPage(res, {
    template: 'search', page_title: q ? `Search: ${q}` : 'Search', path: '/search',
    data: { search: { terms: q, results, results_count: results.length, performed: !!q } },
  });
});

/* --- cart AJAX API --- */
app.get('/cart.js', (req, res) => res.json(cart));
app.post('/cart/add.js', (req, res) => {
  const items = req.body.items || [{ id: req.body.id, quantity: req.body.quantity || 1 }];
  const added = items.map((i) => addToCart(i.id, Number(i.quantity) || 1)).filter(Boolean);
  res.json({ items: added });
});
app.post('/cart/change.js', (req, res) => { changeCart(req.body.id ?? req.body.line, Number(req.body.quantity)); res.json(cart); });
app.post('/cart/update.js', (req, res) => {
  for (const [k, q] of Object.entries(req.body.updates || {})) changeCart(k, Number(q));
  res.json(cart);
});
app.post('/cart/clear.js', (req, res) => { cart.items = []; recalcCart(); res.json(cart); });
app.post('/cart/add', (req, res) => { addToCart(req.body.id, Number(req.body.quantity) || 1); res.redirect('/cart'); });

/* --- predictive search --- */
app.get('/search/suggest', (req, res) => {
  const q = String(req.query.q || '').toLowerCase().trim();
  if (!q) return res.json({ products: [], concerns: [] });
  res.json({
    products: products.filter((p) => `${p.title} ${p.subtitle}`.toLowerCase().includes(q)).slice(0, 6)
      .map((p) => ({ title: p.title, subtitle: p.subtitle, url: p.url, image: p.featured_image?.src, price: money(p.price_min) })),
    concerns: concerns.filter((c) => c.label.toLowerCase().includes(q)).slice(0, 3),
  });
});

function notFound(p) {
  return `<!doctype html><meta charset=utf-8><title>404</title>
<body style="font:16px/1.6 system-ui;padding:4rem;max-width:40rem;margin:auto">
<h1 style="font-size:1.4rem">404 — no route for <code>${p}</code></h1>
<p><a href="/">Back to the homepage</a></p></body>`;
}
app.use((req, res) => res.status(404).send(notFound(req.path)));

app.listen(PORT, () => {
  console.log(`\n  Helbrede theme  →  http://localhost:${PORT}`);
  console.log(`  ${products.length} products · ${Object.keys(collections).length} collections · ${concerns.length} concerns · ${ingredients.length} ingredients\n`);
});
