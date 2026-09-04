/**
 * DOM smoke tests against the running harness.
 *
 *   node dev/server.mjs &   ->   npm run smoke
 *
 * These assert on *rendered markup*, not status codes, on purpose: the two
 * LiquidJS traps this theme has to avoid both produce a valid HTTP 200 page
 * with whole sections silently missing. A status check would pass while the
 * page was half empty.
 */
const BASE = process.env.BASE || 'http://localhost:3660';

let pass = 0;
const fails = [];

const count = (html, re) => (html.match(re) || []).length;

function check(label, got, want) {
  const ok = typeof want === 'function' ? want(got) : got === want;
  if (ok) { pass++; return; }
  fails.push(`${label}: got ${got}${typeof want === 'function' ? '' : `, want ${want}`}`);
}

const gt = (n) => (got) => got > n;
const gte = (n) => (got) => got >= n;

async function get(path) {
  const res = await fetch(BASE + path);
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.text();
}

/* Every page must satisfy these, whatever the template. */
function assertChrome(html, where) {
  check(`${where} · no missing sections`, count(html, /<!-- section .+? missing/g), 0);
  check(`${where} · no unrendered liquid`, count(html, /\{\{|\{%/g), 0);
  check(`${where} · header`, count(html, /class="hdr"/g), 1);
  check(`${where} · footer`, count(html, /class="ftr"/g), 1);
  check(`${where} · cart drawer`, count(html, /data-panel="cart"/g), 1);
  check(`${where} · search overlay`, count(html, /data-panel="search"/g), 1);
  /* desktop primary nav — was missing entirely until the mega menu landed */
  check(`${where} · desktop nav links`, count(html, /class="hdr__navlink/g), 7);
  check(`${where} · concern mega items`, count(html, /class="megaitem"/g), 8);
  check(`${where} · mega tools`, count(html, /class="megatool"/g), 3);
  check(`${where} · mega toggle`, count(html, /data-drop-btn/g), 1);
  /* phone search bar is always on screen, never behind an icon */
  check(`${where} · phone search bar`, count(html, /class="hdr__msearch"/g), 1);
  check(`${where} · stylesheets`, count(html, /<link rel="stylesheet"/g), gte(3));
  check(`${where} · no raw entity leak`, count(html, /&amp;amp;|&lt;p&gt;/g), 0);
  /* real contact details, on every page, with no placeholder left behind */
  check(`${where} · phone`, count(html, /\+91 70090 40553/g), gte(1));
  check(`${where} · email`, count(html, /info@helbredenutraherbs\.com/g), gte(1));
  check(`${where} · whatsapp`, count(html, /wa\.me\/917009040553/g), gte(1));
  /* The WhatsApp Button app embed renders the floating launcher. A second one
     from the theme put a green bubble in each bottom corner of every page. */
  check(`${where} · no theme whatsapp fab`, count(html, /class="wa-fab"/g), 0);
  check(`${where} · no stale contact`, count(html, /62838|care@helbrede/g), 0);
}

const run = async () => {
  /* ---------------------------------------------------------- homepage --- */
  {
    const html = await get('/');
    assertChrome(html, 'home');
    check('home · hero banners', count(html, /data-hero-slide/g), 3);
    check('home · hero dots', count(html, /data-hero-dot/g), 3);
    check('home · hero arrows', count(html, /data-hero-(prev|next)/g), 2);
    /* one desktop + one mobile artwork per banner — a 3.49:1 strip cannot crop
       to a portrait phone screen, so they are separate slots */
    check('home · desktop banner slots', count(html, /class="hb__desk"/g), 3);
    check('home · mobile banner slots', count(html, /class="hb__mob"/g), 3);
    check('home · desktop banner assets',
      count(html, /assets\/banner-(hair-care|face-serum|mahabali)-desktop\.jpg/g), 3);
    check('home · mobile banner assets',
      count(html, /assets\/banner-(hair-care|face-serum|mahabali)-mobile\.jpg/g), 3);
    check('home · carousel settings',
      count(html, /data-autoplay="true"\s+data-interval="5000"/g), 1);
    check('home · no empty slot labels', count(html, /class="slot__label"><\/div>/g), 0);
    /* the banner leads the page, the concern shelf follows it */
    check('home · hero leads the page',
      html.indexOf('shopify-section-hero') < html.indexOf('shopify-section-concern'), true);
    check('home · concern chips', count(html, /class="chip cs__chip/g), 3);
    check('home · concern panes', count(html, /data-tab-pane="/g), 3);
    /* Native Shopify collections: health, hair and skin, plus best sellers. */
    check('home · product cards', count(html, /<article class="card"/g), 29);
    check('home · best-seller rail', count(html, /data-rail-wrap/g), gte(1));
    check('home · label teaser', count(html, /class="label-panel"/g), 1);
    check('home · ritual teaser', count(html, /class="rit"/g), 3);
    check('home · discount badges', count(html, /badge--save/g), gt(20));
    check('home · announcement items', count(html, /data-anno-item/g), 3);
    check('home · section headings', count(html, /sec-head__main/g), gte(1));
  }

  /* --------------------------------------------- why / certs / marketplaces */
  {
    const html = await get('/');
    check('why · four reasons', count(html, /class="whycard"/g), 4);
    check('why · numerals 01-04', count(html, /class="whycard__num"[^>]*>0[1-4]</g), 4);
    check('why · proof lines', count(html, /class="whycard__proof"/g), 4);

    check('certs · five badges', count(html, /class="cert"/g), 5);
    check('certs · badge assets', count(html, /assets\/cert-(fssai|ayush|iso|gmp|lab)\.png/g), 5);
    check('certs · captions', count(html, /class="cert__cap"/g), 5);

    check('marketplaces · two cards', count(html, /class="mktcard"/g), 2);
    check('marketplaces · amazon link', count(html, /amazon\.in/g), 1);
    check('marketplaces · flipkart link', count(html, /flipkart\.com/g), 1);
    check('marketplaces · outbound links safe', count(html, /rel="noopener noreferrer"/g), gte(2));
    /* Was asserting the marked slot rendered — which pinned a working note as
       correct storefront output. The logo is the merchant's uploaded asset or
       the marketplace name as type; never the box. */
    check('marketplaces · logo falls back to type', count(html, /mktcard__wordmark/g), 2);
  }

  /* ------------------------------------------------------- product page --- */
  {
    const handle = 'helbrede-berberine-capsules-400mg-berberis-aristata-with-cinnamon-black-pepper-metabolic-wellness-support-60-capsules';
    const html = await get(`/products/${handle}`);
    assertChrome(html, 'pdp');
    check('pdp · breadcrumb', count(html, /class="wrap crumbs"/g), 1);
    check('pdp · gallery shots', count(html, /class="pdp__shot/g), gte(5));
    check('pdp · gallery thumbs', count(html, /class="pdp__thumb/g), gte(5));
    check('pdp · title', count(html, /class="pdp__title"/g), 1);
    check('pdp · pack ladder rows', count(html, /class="pack /g), 3);
    check('pdp · pack badges', count(html, /pack__badge/g), 3);
    check('pdp · per-unit price', count(html, /pack__each/g), 2);
    check('pdp · add to cart', count(html, /data-add-to-cart/g), 1);
    check('pdp · buy now', count(html, /data-buy-now/g), 1);
    check('pdp · pincode check', count(html, /data-pincode/g), 1);
    check('pdp · call to order', count(html, /class="pdp__call"/g), 1);
    check('pdp · benefit cards', count(html, /class="ben"/g), gte(4));
    check('pdp · LABEL PANEL', count(html, /class="label-panel"/g), 1);
    check('pdp · label rows', count(html, /class="label-row"/g), gte(3));
    check('pdp · declared doses', count(html, /class="label-row__d"/g), gte(3));
    check('pdp · ingredient cards', count(html, /class="ing"/g), gte(3));
    check('pdp · how-to steps', count(html, /class="step"/g), gte(1));
    check('pdp · SAFETY CHECK', count(html, /data-safety/g), gte(1));
    check('pdp · safety conditions', count(html, /data-cond="/g), 7);
    check('pdp · safety lines', count(html, /<li>/g), gte(5));
    check('pdp · FAQ items', count(html, /class="acc__item"/g), gte(3));
    /* This product's spec table was entirely torn fragments, so cleanSpecs drops
       it and the section hides — assert that rather than the rows. The rendered
       table is covered against a product that kept its specs, below. */
    check('pdp · specs hidden when unusable', count(html, /class="specs__row"/g), 0);
    check('pdp · ROUTINE', count(html, /data-ritual-item/g), gte(3));
    check('pdp · related rail', count(html, /data-rail/g), gte(1));
    check('pdp · why helbrede', count(html, /class="whycard"/g), 4);
  }

  /* The spec table, on a product whose rows survived cleanSpecs. Also asserts
     the orientation: the nutrient is the label, the amount is the value —
     the raw parse had them the wrong way round. */
  {
    const handle = 'helbrede-nutraherbs-digestive-enzyme-tablets-fungal-diastase-papain';
    const html = await get(`/products/${handle}`);
    check('specs · rows rendered', count(html, /class="specs__row"/g), gte(3));
    check('specs · no torn fragments', count(html, /<dd>[^<]*\s[.,]/g), 0);
    /* Orientation: a bare quantity must never end up in the label column. */
    check('specs · label is not a quantity', count(html, /<dt>[\d.,]+\s*(mg|mcg|g|ml|IU)\b/gi), 0);
  }

  /* The product whose rows the raw parse had reversed — "2,000 mg / L-Arginine".
     cleanSpecs turns them round, so the nutrient must lead. */
  {
    const handle = 'helbrede-l-arginine-1000-mg-tablets-amino-acid-for-endurance-amp-workout-support-60-tablets';
    const html = await get(`/products/${handle}`);
    check('specs · reversed pair corrected', count(html, /<dt>L-Arginine<\/dt>\s*<dd>2,000 mg<\/dd>/g), 1);
    check('specs · no quantity in label', count(html, /<dt>[\d.,]+\s*(mg|mcg|g|ml|IU)\b/gi), 0);
  }

  /* Every product must render its buy box and at least the parsed content. */
  {
    const shop = await (await fetch(`${BASE}/cart.js`)).json().catch(() => null);
    if (!shop) fails.push('cart.js did not respond');
  }

  /* ------------------------------------------------------------ cart API -- */
  {
    await fetch(`${BASE}/cart/clear.js`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const pdp = await get('/products/virgin-hair-oil');
    const id = (pdp.match(/data-variant-id="(\d+)"/) || [])[1];
    check('cart · variant id present', Boolean(id), true);

    const added = await (await fetch(`${BASE}/cart/add.js`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ id: Number(id), quantity: 2 }] }),
    })).json();
    check('cart · add returns a line', added.items?.length, 1);

    const cart = await (await fetch(`${BASE}/cart.js`)).json();
    check('cart · item count', cart.item_count, 2);
    check('cart · total > 0', cart.total_price, gt(0));

    /* With a line in the cart, the page must be editable. It shipped read-only
       — quantity as bare text, no remove — so anyone arriving at /cart from a
       bookmark or a refresh was stuck with whatever the drawer had left. */
    {
      const html = await get('/cart');
      check('cart page · line rows', count(html, /class="cartpage__row"/g), 1);
      check('cart page · line key', count(html, /data-key="/g), 1);
      check('cart page · quantity on row', count(html, /data-quantity="2"/g), 1);
      check('cart page · qty buttons', count(html, /data-qty="/g), 2);
      check('cart page · remove button', count(html, /data-remove/g), 1);
      check('cart page · checkout button', count(html, /name="checkout"/g), 1);
    }

    await fetch(`${BASE}/cart/clear.js`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  }

  /* ------------------------------------------------------------- search --- */
  {
    const r = await (await fetch(`${BASE}/search/suggest?q=ashwagandha`)).json();
    check('search · suggests products', r.products.length, gt(0));
  }

  /* --------------------------------------------------------- every route -- */
  {
    const shop = JSON.parse(
      await (await import('node:fs')).promises.readFile(new URL('../data/shop.json', import.meta.url), 'utf8'),
    );
    let broken = 0;
    for (const p of shop.products) {
      const res = await fetch(`${BASE}/products/${p.handle}`);
      if (!res.ok) { broken++; continue; }
      const html = await res.text();
      if (count(html, /<!-- section .+? missing/g) || count(html, /\{\{|\{%/g)) broken++;
      if (!count(html, /class="pdp__title"/g)) broken++;
    }
    check('all 35 product pages render clean', broken, 0);

    for (const h of Object.keys(shop.collections)) {
      const res = await fetch(`${BASE}/collections/${h}`);
      if (!res.ok) fails.push(`collection ${h} -> HTTP ${res.status}`);
      else pass++;
    }
  }

  /* ------------------------------------------------ contact + local SEO -- */
  {
    const html = await get('/pages/contact');
    check('contact · postal address', count(html, /Sushant Complex SCO 2/g), gte(1));
    check('contact · address element', count(html, /<address/g), gte(1));
    check('contact · manufacturing line', count(html, /Kenko Healthcare/g), gte(1));
  }
  {
    const html = await get('/');
    const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    check('seo · JSON-LD present', Boolean(m), true);
    if (m) {
      let d = null;
      try { d = JSON.parse(m[1]); } catch (_) {}
      check('seo · JSON-LD parses', Boolean(d), true);
      check('seo · postal code', d?.address?.postalCode, '134109');
      check('seo · locality', d?.address?.addressLocality, 'Panchkula');
      check('seo · telephone', d?.telephone, '+917009040553');
    }
  }

  /* -------------------------------------------------- collection page --- */
  {
    const html = await get('/collections/skin-care');
    assertChrome(html, 'collection');
    check('collection · heading', count(html, /sec-head__main/g), gte(1));
    check('collection · filter chips', count(html, /data-filter="/g), gte(2));
    check('collection · sort control', count(html, /data-sort/g), 1);
    check('collection · grid items', count(html, /data-item /g), 7);
    check('collection · cards', count(html, /<article class="card"/g), 7);
  }
  {
    const html = await get('/collections/all');
    check('collection all · 35 cards', count(html, /<article class="card"/g), 35);
  }

  /* -------------------------------------------------------- tool pages --- */
  {
    const html = await get('/pages/ritual-builder');
    assertChrome(html, 'ritual');
    check('ritual · concern chips', count(html, /data-rb-concern="/g), 8);
    check('ritual · depth chips', count(html, /data-rb-depth="/g), 3);
    check('ritual · catalog payload', count(html, /id="hb-catalog"/g), 1);
    check('ritual · add button', count(html, /data-rb-add/g), 1);
  }
  {
    const html = await get('/pages/label-check');
    assertChrome(html, 'label');
    check('label · two pickers', count(html, /data-cmp="/g), 2);
    check('label · catalog payload', count(html, /id="hb-catalog"/g), 1);
  }
  {
    const html = await get('/pages/ingredients');
    assertChrome(html, 'ingredients');
    check('ingredients · cards', count(html, /class="ing"/g), gte(50));
  }
  {
    const html = await get('/pages/ingredients/ashwagandha');
    check('ingredient detail · cards', count(html, /<article class="card"/g), gte(1));
  }

  /* ------------------------------------------------------ content pages -- */
  for (const [path, label, needle] of [
    ['/pages/about', 'about', /class="val"/g],
    ['/pages/contact', 'contact', /class="pdp__call"/g],
    ['/pages/faq', 'faq', /class="acc__item"/g],
    ['/pages/consultancy', 'consultancy', /class="fld"/g],
  ]) {
    const html = await get(path);
    assertChrome(html, label);
    check(`${label} · body content`, count(html, needle), gte(3));
  }

  /* -------------------------------------------------------- cart/search -- */
  {
    const html = await get('/cart');
    assertChrome(html, 'cart page');
    check('cart page · heading', count(html, /sec-head__main/g), gte(1));
  }
  {
    const html = await get('/search?q=ashwagandha');
    assertChrome(html, 'search page');
    check('search page · results', count(html, /<article class="card"/g), gte(1));
  }

  /* ------------------------------------------------------ short titles ---- */
  /* Shopify's product.title is the full merchandising string — brand, pipes,
     specs, ~100 characters against the ~26 the card was designed for. Cards on
     the live store ran four lines deep and pushed every rail out of shape. The
     short name rides in helbrede.title; assert the card and PDP use it. */
  {
    const html = await get('/');
    const titles = [...html.matchAll(/<h3 class="card__title"><a[^>]*>([^<]+)<\/a>/g)].map((m) => m[1].trim());
    check('cards · titles rendered', titles.length, gte(4));
    const longest = titles.reduce((n, t) => Math.max(n, t.length), 0);
    check(`cards · short name used (longest ${longest})`, longest <= 60, true);

    const pdp = await get('/products/helbrede-berberine-capsules-400mg-berberis-aristata-with-cinnamon-black-pepper-metabolic-wellness-support-60-capsules');
    const h1 = (pdp.match(/<h1 class="pdp__title">([^<]*)</) || [])[1] || '';
    check(`pdp · short name in heading (${h1.length} chars)`, h1.length > 0 && h1.length <= 60, true);

    /* The label panel and the ritual rail render product names too, and were
       missed on the first pass — the panel is narrow and a 100-character title
       overflowed it on the live homepage. */
    const panelName = (html.match(/<span class="label-row__d">([^<]*)</) || [])[1] || '';
    check(`label panel · short name (${panelName.length} chars)`, panelName.length > 0 && panelName.length <= 60, true);


    /* The benefits heading interpolates the name into a sentence, so the full
       title turned it into a two-line shout on every PDP. */
    const benefitsH2 = (pdp.match(/<h2 class="sec-head__main">Benefits of ([^<]*)</) || [])[1] || "";
    check(`pdp · benefits heading short (${benefitsH2.length} chars)`, benefitsH2.length > 0 && benefitsH2.length <= 60, true);
    const ritualNames = [...html.matchAll(/<span class="rit__t">([^<]*)</g)].map((m) => m[1].trim());
    const ritLongest = ritualNames.reduce((n, t) => Math.max(n, t.length), 0);
    check(`ritual rail · short names (longest ${ritLongest})`, ritualNames.length > 0 && ritLongest <= 60, true);
  }

  /* ---------------------------------------------------- sold-out buy box -- */
  /* fetch resolves on a 422, so a sold-out add used to fall through to the cart
     drawer, which opened empty with nothing said. Twelve of the thirty-five
     live products are out of stock at any time, and every one of them offered
     an enabled "Add to cart". */
  {
    const handle = 'helbrede-berberine-capsules-400mg-berberis-aristata-with-cinnamon-black-pepper-metabolic-wellness-support-60-capsules';
    const inStock = await get(`/products/${handle}`);
    check('buy box · add to cart when in stock', count(inStock, /data-add-to-cart/g), 1);
    check('buy box · buy now when in stock', count(inStock, /data-buy-now/g), 1);
    check('buy box · error target present', count(inStock, /data-cart-error/g), 1);

    const soldOut = await get(`/products/${handle}?stock=out`);
    check('buy box · sold out label', count(soldOut, />Sold out</g), 1);
    check('buy box · no add to cart when sold out', count(soldOut, /data-add-to-cart/g), 0);
    check('buy box · no buy now when sold out', count(soldOut, /data-buy-now/g), 0);
    check('buy box · disabled when sold out', count(soldOut, /aria-disabled="true"/g), gte(1));
    check('buy box · offers an in-stock route', count(soldOut, /See what is in stock/g), 1);
  }

  /* ------------------------------------------------ customer-facing slots -- */
  /* media-slot renders a marked box — slot code, purpose, pixel size — which is
     a working note, not something a shopper should ever see. The marketplace
     wordmarks are third-party trademarks and will stay unset until the merchant
     uploads them, so that section must fall back to type rather than the box.
     It reached the live storefront showing "MKT-AMAZON · 600 × 180 px". */
  {
    const html = await get('/');
    check('marketplaces · wordmark fallback', count(html, /mktcard__wordmark/g), 2);
    check('marketplaces · no marked slot', count(html, /MKT-AMAZON|MKT-FLIPKART/g), 0);
    check('homepage · no unfilled slot codes', count(html, /class="slot__code"/g), 0);
  }

  /* --------------------------------------------------- theme settings ----- */
  /* dev/server.mjs used to hardcode its settings object and invented
     `settings.announcements`, which the theme never declared. Locally the bar
     rotated three offers; live it rendered empty and its collapsed height
     shifted every section below it. The server now reads theme/config, so a
     setting the theme has not declared is missing here too — assert the bar
     actually has lines, and that none is left over from the old array. */
  {
    const html = await get('/');
    check('announcement bar · present', count(html, /data-anno(?![-\w])/g), 1);
    check('announcement bar · rotating lines', count(html, /data-anno-item/g), 3);
    check('announcement bar · first line active', count(html, /anno__item is-on/g), 1);

    const fs = await import('node:fs');
    const declared = new Set();
    for (const g of JSON.parse(fs.readFileSync('theme/config/settings_schema.json', 'utf8'))) {
      for (const f of g.settings || []) if (f.id) declared.add(f.id);
    }
    const undeclared = new Set();
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = `${d}/${e.name}`;
        if (e.isDirectory()) { if (e.name !== '.shopify') walk(p); continue; }
        if (!/\.(liquid|js)$/.test(p)) continue;
        for (const m of fs.readFileSync(p, 'utf8').matchAll(/(?<![.\w])settings\.([a-zA-Z_][a-zA-Z0-9_]*)/g)) {
          if (!declared.has(m[1]) && m[1] !== 'logo') undeclared.add(`${m[1]} (${p})`);
        }
      }
    };
    walk('theme');
    check(`settings · none undeclared${undeclared.size ? ` — ${[...undeclared].join(', ')}` : ''}`, undeclared.size, 0);
  }

  /* ------------------------------------------------------- hb-catalog ----- */
  /* The Ritual Builder and Label Compare both JSON.parse this block, so one
     unprintable value anywhere in it takes both tools down silently. It
     shipped invalid: a nil pack emitted `"pack":,` and an imageless product
     made image_url inject its error text into the document. Parse it, do not
     just look for the tag. */
  for (const route of ['/pages/ritual-builder', '/pages/label-check']) {
    const html = await get(route);
    const m = html.match(/<script type="application\/json" id="hb-catalog">([\s\S]*?)<\/script>/);
    check(`hb-catalog · present on ${route}`, Boolean(m), true);
    if (!m) continue;
    check(`hb-catalog · no Liquid error on ${route}`, /Liquid error/.test(m[1]), false);
    let parsed = null;
    try { parsed = JSON.parse(m[1]); } catch (e) { fails.push(`hb-catalog on ${route} is not valid JSON — ${e.message}`); }
    if (parsed) {
      check(`hb-catalog · products on ${route}`, parsed.length, gte(20));
      check(`hb-catalog · every entry has a handle`, parsed.every((p) => typeof p.h === 'string' && p.h), true);
      check(`hb-catalog · every entry has a variant id`, parsed.every((p) => Number.isFinite(p.vid)), true);
    }
  }

  /* ------------------------------------------- JSON templates vs presets -- */
  /* A section's `presets` are applied only when a merchant adds it through the
     theme editor. A JSON template that names a block-driven section without
     declaring `blocks` renders the section's shell and nothing inside it on a
     real store. The dev server fabricates preset blocks, so this is invisible
     locally — it shipped four empty sections to production before being
     caught. Assert against the template files, not the DOM. */
  {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const T = 'theme/templates', S = 'theme/sections';

    const schemaOf = (type) => {
      const f = path.join(S, `${type}.liquid`);
      if (!fs.existsSync(f)) return null;
      const m = fs.readFileSync(f, 'utf8').match(/\{%-?\s*schema\s*-?%\}([\s\S]*?)\{%-?\s*endschema\s*-?%\}/);
      try { return m ? JSON.parse(m[1]) : null; } catch { return null; }
    };

    const relying = [];
    for (const tf of fs.readdirSync(T).filter((f) => f.endsWith('.json'))) {
      const tpl = JSON.parse(fs.readFileSync(path.join(T, tf), 'utf8'));
      for (const [id, sec] of Object.entries(tpl.sections || {})) {
        const sch = schemaOf(sec.type);
        if (!sch) continue;
        const usesBlocks = Array.isArray(sch.blocks) && sch.blocks.length > 0;
        const hasPresetBlocks = (sch.presets || []).some((p) => Array.isArray(p.blocks) && p.blocks.length);
        const declared = sec.blocks ? Object.keys(sec.blocks).length : 0;
        if (usesBlocks && hasPresetBlocks && !declared) relying.push(`${tf}:${id}`);
      }
    }
    check(`templates · no section relies on presets${relying.length ? ` (${relying.join(', ')})` : ''}`, relying.length, 0);
  }

  /* ---------------------------------------------- catalog data integrity -- */
  {
    const shop = JSON.parse(
      await (await import('node:fs')).promises.readFile(new URL('../data/shop.json', import.meta.url), 'utf8'),
    );
    check('data · 35 products', shop.products.length, 35);
    check('data · every product has 3 packs', shop.products.every((p) => p.variants.length === 3), true);
    check('data · every product has a concern', shop.products.every((p) => p.concern), true);
    check('data · every product has images', shop.products.every((p) => p.images.length > 0), true);
    check('data · no title is just the brand',
      shop.products.filter((p) => /^(helbrede|nutraherbs)$/i.test(p.title.trim())).length, 0);
    check('data · no HTML entities in titles',
      shop.products.filter((p) => /&(amp|lt|gt|quot|#39);/.test(p.title + p.subtitle)).length, 0);
    check('data · every product has benefits', shop.products.every((p) => p.metafields.benefits.length), true);
    check('data · every product has how-to-use', shop.products.every((p) => p.metafields.how_to_use.length), true);
    check('data · dosed ingredient rows',
      shop.products.reduce((n, p) => n + p.metafields.ingredients.filter((i) => i.dose).length, 0), gte(80));
  }

  /* -------------------------------------------------------------- report -- */
  console.log(`\n  ${pass} passed, ${fails.length} failed\n`);
  if (fails.length) {
    fails.forEach((f) => console.log(`  ✗ ${f}`));
    console.log('');
    process.exit(1);
  }
};

run().catch((e) => { console.error('\n  smoke run failed:', e.message, '\n'); process.exit(1); });
