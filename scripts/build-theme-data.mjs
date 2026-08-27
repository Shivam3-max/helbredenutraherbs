/**
 * catalog/products.normalized.json  ->  data/shop.json
 *
 * Turns the parsed live catalog into the object graph the theme reads: products
 * carrying `helbrede.*` metafields, pack-size variants, concern collections and
 * the navigation menus.
 *
 * Anything invented here (pack ladders, MRPs, rating counts) is tagged
 * `seeded: true` and written out to docs/SEEDED-DATA.md, because the live store
 * has none of it — see docs/roadmap.html §2.2 and §2.3.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));

const products = read('catalog/products.normalized.json');
const concernFile = read('catalog/concerns.proposed.json');

/* SKUs that are merchandising placeholders on the live store, not products. */
const NOT_PRODUCTS = new Set(['pick-any-2-751', 'raksha-bandhan-janmashtami-offer-copy']);

/* ------------------------------------------------------------------ *
 * 1. Titles
 *
 * Live titles are keyword-stuffed to 255 chars. The first pipe segment is
 * the real name; the rest is usable as the Kapiva-style one-line promise.
 * ------------------------------------------------------------------ */
const BRAND_PREFIX = /^(helbrede\s+nutra\s?herbs|helbrede\s+nutraherbs|hebrede\s+nutraherbs|helbrede|nutraherbs)\s*/i;

/* Shopify returns titles HTML-escaped; they are rendered as text here. */
const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };
const unescapeHtml = (s) => String(s || '').replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m]);

function splitTitle(raw) {
  /* Titles separate the name from the descriptor with either a pipe or a
     spaced en/em dash — "Livohel Liver Detox Tablets – Advanced Liver Support". */
  const parts = unescapeHtml(raw).split(/\s*\|\s*|\s+[–—]\s+/)
    .map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  /* Some titles lead with the brand alone — "Helbrede Nutraherbs | Vitamin-C
     Chewable Tablets". Stripping the prefix empties the first segment, so the
     real name is the next one. */
  let nameIndex = 0;
  let name = parts[0].replace(BRAND_PREFIX, '').replace(/^[–—-]\s*/, '').trim();
  while (!name && nameIndex < parts.length - 1) {
    nameIndex += 1;
    name = parts[nameIndex].replace(BRAND_PREFIX, '').replace(/^[–—-]\s*/, '').trim();
  }
  if (!name) name = parts[0].trim();

  const rest = parts.slice(nameIndex + 1)
    .map((s) => s.replace(BRAND_PREFIX, '').trim())
    .filter((s) => s && !/^\d+\s*(capsules?|tablets?|ml|g)$/i.test(s));

  return {
    name: name.replace(/\s*[–—-]\s*$/, ''),
    subtitle: rest.join(' · ').replace(/\s*·\s*$/, ''),
  };
}

/* Pack size stated on the label, pulled out of the title or the spec table. */
function packSize(p) {
  const hay = [p.title, ...(p.sections.specs || []).map((kv) => kv.join(' '))].join(' ');
  const m = hay.match(/(\d+)\s*(capsules?|tablets?|caps\b)/i);
  if (m) return `${m[1]} ${/tab/i.test(m[2]) ? 'tablets' : 'capsules'}`;
  const v = hay.match(/(\d+)\s*(ml|ML|g\b|G\b)/);
  if (v) return `${v[1]} ${v[2].toLowerCase()}`;
  return '';
}

/* ------------------------------------------------------------------ *
 * 2. Pack ladder  [SEEDED]
 *
 * Every live product is a single bottle at a single price, so the ladder has
 * no source data. These multipliers produce an escalating saving that reads
 * the way Kapiva's does; the client replaces them with real pack economics.
 * ------------------------------------------------------------------ */
const MRP_MULTIPLIER = 1.25;                        // list price above selling price
const PACKS = [
  { units: 1, factor: 1.00, badge: 'Trial Pack', shipping: 'plus' },
  { units: 2, factor: 0.87, badge: 'Bestseller', shipping: 'free' },
  { units: 3, factor: 0.78, badge: 'Super Saver', shipping: 'free' },
];
const SHIP_FEE = 4900;                              // paise

const round50 = (paise) => Math.round(paise / 5000) * 5000 || 5000;

function buildVariants(p, unitLabel) {
  const base = Math.round(p.price * 100);
  return PACKS.map((pack, i) => {
    const price = round50(base * pack.units * pack.factor);
    const compare = round50(base * pack.units * MRP_MULTIPLIER);
    return {
      id: p.id * 10 + i,
      title: `Pack of ${pack.units}`,
      option1: `Pack of ${pack.units}`,
      units: pack.units,
      unit_label: unitLabel ? `${unitLabel} × ${pack.units}` : `${pack.units} unit${pack.units > 1 ? 's' : ''}`,
      price,
      compare_at_price: compare > price ? compare : null,
      discount_pct: compare > price ? Math.round((1 - price / compare) * 100) : 0,
      per_unit: Math.round(price / pack.units),
      badge: pack.badge,
      shipping: pack.shipping,
      shipping_label: pack.shipping === 'free' ? 'Free Shipping' : `+ ₹${SHIP_FEE / 100} Shipping`,
      available: true,
      sku: `HB-${String(p.id).slice(-5)}-${pack.units}`,
      seeded: true,
    };
  });
}

/* ------------------------------------------------------------------ *
 * 2b. Ingredient doses
 *
 * The Label Panel publishes exact quantities, which is the whole point of the
 * feature — so the dose is split off the ingredient name here rather than being
 * re-parsed in Liquid. "Niacinamide (Vitamin B3) - 10%" -> name + "10%".
 * ------------------------------------------------------------------ */
/* `%` is not a word character, so a trailing \b after it never matches — the
   unit alternation keeps \b only for the letter units. */
const DOSE_RE = /(?:[–—-]\s*)?(\d[\d.,]*\s*(?:%|(?:mg|mcg|g|ml|iu|billion\s*cfu)\b)[^,;]*)$/i;

function splitDose(raw) {
  const clean = unescapeHtml(raw).replace(/\s+/g, ' ').trim();
  const m = clean.match(DOSE_RE);
  if (!m) return { name: clean.replace(/[\s–—-]+$/, ''), dose: '' };
  return {
    name: clean.slice(0, m.index).replace(/[\s–—-]+$/, '').trim() || clean,
    dose: m[1].trim(),
  };
}

/* ------------------------------------------------------------------ *
 * 3. Concerns
 * ------------------------------------------------------------------ */
const CONCERN_META = {
  'strength-performance': {
    tagline: 'Strength, stamina and everyday power',
    blurb: 'Ayurvedic and amino-acid formulas for people who train — built around Shilajit, Ashwagandha, Safed Musli and Kaunch Beej.',
    filters: ['Shilajit', 'Muscle Gain', 'Testosterone Support', 'Endurance'],
  },
  'skin-care': {
    tagline: 'Actives that do the work, botanicals that keep it calm',
    blurb: 'Dosed serums — Niacinamide 10%, Hyaluronic Acid 2%, Kojic Acid, Alpha Arbutin — blended with Aloe, Mulethi and Amla extracts.',
    filters: ['Brightening', 'Acne & Pores', 'Anti-Ageing', 'Under Eye'],
  },
  'hair-care': {
    tagline: 'From the scalp out, and from within',
    blurb: 'Leave-in serums, cold-pressed oils and a Biotin-Zinc-Selenium tablet — the topical and the ingestible halves of the same routine.',
    filters: ['Hair Fall', 'Scalp Health', 'Hair Growth', 'Hair Oils'],
  },
  'daily-essentials': {
    tagline: 'The everyday base layer',
    blurb: 'Multivitamins, minerals and Himalayan Sea Buckthorn — the daily nutrition that everything else sits on top of.',
    filters: ['Multivitamin', 'Immunity', 'Bone & Joint', 'Juices'],
  },
  'liver-detox': {
    tagline: 'Support for the organs that clear the load',
    blurb: 'Milk Thistle, Bhumiamla, Kalmegh, Kutki and Punarnava, formulated for liver and respiratory cleansing.',
    filters: ['Liver Support', 'Detox', 'Respiratory'],
  },
  'weight-metabolism': {
    tagline: 'Metabolism, appetite and healthy weight',
    blurb: 'Berberine, Garcinia and Green Tea formulas that support fat metabolism alongside diet and training.',
    filters: ['Fat Metabolism', 'Appetite', 'Blood Sugar'],
  },
  'sleep-stress': {
    tagline: 'Wind down, and stay down',
    blurb: 'Ashwagandha and Magnesium Glycinate for the body’s natural response to everyday stress, and for restful sleep.',
    filters: ['Sleep', 'Stress Support', 'Calm'],
  },
  'digestion-gut': {
    tagline: 'Digestion that stops getting in the way',
    blurb: 'Fungal Diastase, Papain and Activated Charcoal for everyday digestive comfort.',
    filters: ['Enzymes', 'Bloating'],
  },
};

const concernOf = {};
for (const [slug, d] of Object.entries(concernFile)) {
  for (const h of d.handles) concernOf[h] = { slug, label: d.label };
}

/* Sub-filter assignment: matched off the product's own name and ingredients so
   the pills on a concern page actually filter something. */
const FILTER_RULES = [
  ['Shilajit', /mahabali|balwan|testohel|testosterone/i],
  ['Muscle Gain', /muscle|bulk gainer/i],
  ['Testosterone Support', /testo/i],
  ['Endurance', /arginine|cordyceps|drops/i],
  ['Brightening', /niaglow|radiance|even tone|glutathione/i],
  ['Acne & Pores', /balance|clear/i],
  ['Anti-Ageing', /age defense|glutathione/i],
  ['Under Eye', /eye lift/i],
  ['Hair Fall', /bio fully|virgin hair oil|onion/i],
  ['Scalp Health', /scalp|hydra boost/i],
  ['Hair Growth', /bio fully|virgin hair/i],
  ['Hair Oils', /hair oil/i],
  ['Multivitamin', /one daily|multivitamin/i],
  ['Immunity', /vitamin.?c|sea buckthorn/i],
  ['Bone & Joint', /calcium|magnesium/i],
  ['Juices', /juice|pulp/i],
  ['Liver Support', /livohel|liver/i],
  ['Detox', /detox/i],
  ['Respiratory', /lung/i],
  ['Fat Metabolism', /fat burner|fit tummy/i],
  ['Appetite', /fit tummy/i],
  ['Blood Sugar', /berberine/i],
  ['Sleep', /relax mind|sleep/i],
  ['Stress Support', /ashwagandha|relax/i],
  ['Calm', /relax mind/i],
  ['Enzymes', /enzyme|diastase/i],
  ['Bloating', /enzyme|digestive/i],
];

/* ------------------------------------------------------------------ *
 * 4. Build
 * ------------------------------------------------------------------ */
const MEDIA = '/media';
const seedLog = [];

const built = products
  .filter((p) => !NOT_PRODUCTS.has(p.handle))
  .map((p) => {
    let { name, subtitle } = splitTitle(p.title);
    /* A handful of products carry no descriptor in the title; their top
       benefits read as a promise line, which is what this slot is for. */
    if (!subtitle) subtitle = (p.sections.benefits || []).slice(0, 3).join(' · ');
    const pack = packSize(p);
    const variants = buildVariants(p, pack);
    const concern = concernOf[p.handle] || { slug: 'daily-essentials', label: 'Daily Essentials & Immunity' };
    const meta = CONCERN_META[concern.slug];

    const filters = FILTER_RULES
      .filter(([label, re]) => meta.filters.includes(label) && re.test(`${p.title} ${p.handle}`))
      .map(([label]) => label);

    const images = p.gallery.map((src, i) => {
      const ext = path.extname(new URL(src).pathname) || '.jpg';
      return `${MEDIA}/${p.handle.slice(0, 60)}__${i + 1}${ext}`;
    });

    seedLog.push({
      handle: p.handle,
      packs: variants.map((v) => `${v.title} ₹${v.price / 100} (MRP ₹${v.compare_at_price / 100})`).join(', '),
    });

    const s = p.sections;
    return {
      id: p.id,
      handle: p.handle,
      title: name,
      subtitle,
      full_title: p.title,
      vendor: 'Helbrede Nutraherbs',
      type: concern.label,
      concern: concern.slug,
      concern_label: concern.label,
      filters: filters.length ? filters : [meta.filters[0]],
      tags: p.tags,
      pack_size: pack,
      featured_image: images[0] || null,
      images,
      variants,
      price: variants[0].price,
      compare_at_price: variants[0].compare_at_price,
      price_min: Math.min(...variants.map((v) => v.price)),
      price_max: Math.max(...variants.map((v) => v.price)),
      available: true,
      /* --- helbrede.* metafields, straight from the parsed descriptions --- */
      metafields: {
        subtitle,
        benefits: s.benefits,
        ingredients: s.ingredients.map((i) => {
        const { name, dose } = splitDose(i.name);
        return { name, dose, body: i.body };
      }),
        how_to_use: s.how_to_use,
        suitable_for: s.suitable,
        faq: s.faq,
        safety: s.safety,
        specs: s.specs,
        description: s.description,
        usage_horizon: 'For best results, use consistently for at least 3 months',
      },
      /* Ratings have no source. Seeded for layout review only — the theme reads
         a reviews-app metafield in production and renders nothing without it. */
      rating: { value: 0, count: 0, seeded: false },
    };
  });

const byHandle = new Map(built.map((p) => [p.handle, p]));

/* collections ------------------------------------------------------- */
const collections = {};
for (const [slug, d] of Object.entries(concernFile)) {
  const meta = CONCERN_META[slug];
  const items = d.handles.map((h) => byHandle.get(h)).filter(Boolean);
  collections[slug] = {
    handle: slug,
    title: d.label,
    kind: 'concern',
    tagline: meta.tagline,
    description: meta.blurb,
    filters: meta.filters.filter((f) => items.some((p) => p.filters.includes(f))),
    products: items,
    products_count: items.length,
  };
}

const CATEGORY = {
  'health-care': { title: 'Health Care', match: (p) => !['skin-care', 'hair-care'].includes(p.concern) },
  'skin-care': { title: 'Skin Care', match: (p) => p.concern === 'skin-care' },
  'hair-care': { title: 'Hair Care', match: (p) => p.concern === 'hair-care' },
};
for (const [handle, c] of Object.entries(CATEGORY)) {
  /* 'skin-care' and 'hair-care' are already concern collections, and the concern
     version is richer (tagline, blurb, sub-filters). Writing the category over
     it silently stripped the filter pills off those two pages. */
  if (collections[handle]) continue;
  const items = built.filter(c.match);
  collections[handle] = {
    handle, title: c.title, kind: 'category',
    tagline: '', description: '', filters: [],
    products: items, products_count: items.length,
  };
}
const bestsellers = ['mahabali-capsule-for-men-women-gym-athlete-strength-booster-ayurvedic-power-booster-with-shilajit-ashwagandha-safed-musli-kaunch-beej-boost-strength-stamina-energy-vitality-60-capsules-copy',
  'helbrede-nutraherbs-niaglow-face-serum-niacinamide-10-hyaluronic-acid-2-serum-for-glowing-skin',
  'helbrede-bio-fully-hair-tablet-hair-growth-supplement-with-biotin-zinc-selenium',
  'levohel-liver-detox-tablets-advanced-liver-support-natural-detox-formula',
  'helbrede-nutraherbs-ashwagandha-capsules-500mg-withania-somnifera-root-60-capsules',
  'helbrede-nutraherbs-sea-buckthorn-99-pulp-juice-500-ml',
  'virgin-hair-oil',
  'helbrede-nutraherbs-cordyceps-mushroom-complex-energy-stamina-immune-support-60-vegetarian-capsules'];
collections['best-sellers'] = {
  handle: 'best-sellers', title: 'Best Sellers', kind: 'category',
  tagline: '', description: '', filters: [],
  products: bestsellers.map((h) => byHandle.get(h)).filter(Boolean),
  products_count: bestsellers.length,
};

/* ingredient library ------------------------------------------------ */
const ingIndex = new Map();
for (const p of built) {
  for (const ing of p.metafields.ingredients) {
    /* Some names arrived as "Gokshura-Supports male vitality…" — the source
       ran the label into its own description with no space. */
    const label = ing.name
      .split(/\s+[–—]\s+|\s*\(|(?<=[a-z])[-–—](?=[A-Z])/)[0]
      .replace(/[:,.\s]+$/, '').trim();
    const key = label.toLowerCase();
    if (key.length < 3 || key.length > 32) continue;
    if (!ingIndex.has(key)) {
      const tail = ing.name.slice(label.length).replace(/^[\s–—(:-]+/, '').trim();
      ingIndex.set(key, { name: label, body: ing.body || tail, products: [] });
    }
    const rec = ingIndex.get(key);
    if (!rec.body && ing.body) rec.body = ing.body;
    if (!rec.products.includes(p.handle)) rec.products.push(p.handle);
  }
}
const ingredients = [...ingIndex.values()]
  .filter((i) => i.body && i.body.length > 25 && i.products.length)
  .sort((a, b) => b.products.length - a.products.length || a.name.localeCompare(b.name));

/* menus -------------------------------------------------------------- */
const menu = Object.entries(concernFile).map(([slug, d]) => ({
  title: d.label, url: `/collections/${slug}`, count: d.handles.length,
}));

const out = {
  generated_at: new Date().toISOString(),
  products: built,
  collections,
  concerns: Object.entries(concernFile).map(([slug, d]) => ({
    slug, label: d.label, count: d.handles.length,
    tagline: CONCERN_META[slug].tagline,
    short: d.label.split(/[&·]/)[0].trim(),
  })),
  ingredients,
  menu,
};

fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'data/shop.json'), JSON.stringify(out, null, 1));

/* seeded-data disclosure -------------------------------------------- */
const doc = `# Seeded data

Generated by \`scripts/build-theme-data.mjs\`. Everything listed here is
**invented for review** — it does not exist on helbredenutraherbs.com and must be
replaced with real values before launch.

## 1. Pack ladder (${built.length} products × 3 variants)

The live store has one single-variant SKU per product. Kapiva's "Select a Pack"
module needs a ladder, so one is generated: Pack of 1 / 2 / 3 at
×${PACKS.map((p) => p.factor).join(' / ×')} of unit price.

## 2. MRP / compare-at price

The live store sets \`compare_at_price\` equal to \`price\` on 34 of 35 products,
so no discount can render. Here MRP = selling price × ${MRP_MULTIPLIER}, giving a
${Math.round((1 - 1 / MRP_MULTIPLIER) * 100)}% headline saving on a single pack.
**Under the Legal Metrology Act the struck-through figure must be the actual MRP
printed on the pack** — these numbers are placeholders, not a pricing proposal.

## 3. Ratings

Not seeded. The theme reads a reviews-app metafield and renders nothing without
one, so no invented star ratings or review counts appear anywhere.

## 4. Per-product ladder

${seedLog.map((s) => `- \`${s.handle.slice(0, 56)}\` — ${s.packs}`).join('\n')}
`;
fs.writeFileSync(path.join(ROOT, 'docs/SEEDED-DATA.md'), doc);

console.log(`products     ${built.length}`);
console.log(`variants     ${built.length * PACKS.length}`);
console.log(`concerns     ${Object.keys(concernFile).length}`);
console.log(`collections  ${Object.keys(collections).length}`);
console.log(`ingredients  ${ingredients.length}`);
console.log(`images       ${built.reduce((n, p) => n + p.images.length, 0)}`);
console.log(`-> data/shop.json, docs/SEEDED-DATA.md`);
