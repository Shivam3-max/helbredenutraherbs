# Helbrede Nutraherbs — custom Shopify theme

A custom Shopify **Online Store 2.0** theme built from scratch for
helbredenutraherbs.com, replacing the stock Corano 4.0.0 storefront. Structure
follows kapiva.in; the design, palette and three signature features are Helbrede's.

Liquid + vanilla ES modules + native CSS custom properties. No Dawn fork, no
React, no build step.

```bash
npm install
npm run dev      # http://localhost:3660
npm run smoke    # 301 DOM assertions against the running server
```

---

## Layout

```
catalog/          live catalog pulled from the store (source of truth)
  raw-products.json      37 SKUs exactly as Shopify returned them
  products.normalized.json   parsed into structured PDP sections
  concerns.proposed.json     8-concern taxonomy, all 35 products assigned
  images/                215 product images
  brand/logo.png
scripts/
  normalize-catalog.py    body_html -> structured sections
  build-theme-data.mjs    normalized catalog -> data/shop.json
  smoke.mjs               DOM assertions
data/shop.json     what the theme reads
dev/server.mjs     Express + LiquidJS Shopify emulator
theme/             the uploadable Shopify theme
docs/
  roadmap.html          the discovery + design roadmap
  SEEDED-DATA.md        everything invented for review, and why
```

Regenerate the data after editing either script:

```bash
python3 scripts/normalize-catalog.py && node scripts/build-theme-data.mjs
```

---

## The content pipeline

The live descriptions already contain benefits, dosed ingredients, directions,
spec tables, FAQs and safety text — they are just rendered as one wall of HTML.
`normalize-catalog.py` walks that markup and recovers them.

The source was authored three different ways (real `<h2>` headings, a Google-Docs
paste where `<strong>` carries the structure, and plain dosed lines followed by
bullets). The parser handles all three with an `HTMLParser` tree walk — **not**
regex, because nested `<div>`s silently swallow whole sections when you match
paired tags.

Recovery across the 35 real products:

| section | coverage |
|---|---|
| benefits | 35/35 |
| how to use | 35/35 |
| ingredients | 33/35 |
| specifications | 32/35 |
| description | 32/35 |
| safety | 31/35 |
| FAQ | 25/35 |
| suitable for | 24/35 |

237 ingredient rows, 83 of them carrying a declared dose, and 70 FAQ pairs.

---

## The three signature features

Each is built on data Helbrede already has and Kapiva does not expose.

**The Label Panel** (`sections/product-label.liquid`) — a supplement-facts panel
listing every active with the quantity printed on the pack. Where a dose is
genuinely not declared it says *not declared* rather than inventing one; that
honesty is the feature. `/pages/label-check` compares any two formulas side by side.

**The Ritual Builder** (`templates/page.ritual.liquid`) — pick a concern and a
depth, get a morning / evening / daily / night routine drawn from across the
catalog, addable to cart in one action. It works because Helbrede sells both the
ingestible and the topical half of a routine; an ingestibles-only brand cannot
assemble this shelf.

**The Safety & Interaction Check** (`sections/product-safety.liquid`) — the buyer
declares pregnancy, thyroid, diabetes medication and so on, and the matching
lines from *that product's own* safety copy are surfaced before add-to-cart.
Nothing is generated. A non-match says so explicitly instead of reassuring.

---

## Local harness

`dev/server.mjs` emulates Shopify's object graph, filters, tags and the
`/cart/*.js` AJAX API, so the theme builds and reviews with no store attached.

Two LiquidJS traps are handled deliberately, because both fail *silently* and
produce a valid 200 response with sections missing:

1. Custom block tags must use a generator `*render(ctx, emitter)`, never
   `async render` — awaiting `renderTemplates()` resolves the generator object
   without ever running it.
2. `{% render %}` isolates scope, so Shopify globals must be passed as
   `renderOptions.globals` or every snippet loses `settings` and `routes`.

This is why `npm run smoke` asserts on rendered DOM rather than status codes.

Debug flag: `?only=<section>` renders one section alone at the top of the page.

```bash
open "http://localhost:3660/?only=concern"
```

---

## Navigation

Desktop and mobile carry different navigation, deliberately:

- **Desktop (≥761px)** — a primary nav row under the masthead: a *Shop by concern*
  mega panel (all eight concerns with counts and taglines, plus the three tools),
  then Shop all · Best sellers · Build a ritual · Read the label · Ingredients ·
  Free consultancy. The concerns live in a panel rather than a flat rail because
  at 1440px the rail ran off the right edge and the last two were unreachable.
- **Phone (<761px)** — the hamburger drawer holds the full menu, and a
  **full-width search bar sits permanently under the masthead**, sized off The
  Man Company's own mobile bar: 343px wide inside a 16px gutter, 46px tall,
  10px radius, 15px placeholder. Search is not hidden behind an icon, because
  people arrive at this catalogue with a symptom in mind. The bar sits *above*
  the banner, never over it — header bottom and hero top meet at exactly 178px
  with zero overlap.

  The phone concern rail that used to sit here was removed when the search bar
  landed: announcement + masthead + search + rail pushed the banner a quarter of
  the way down an 812px screen, and the concern shelf sits directly under the
  hero anyway.

## The hero banner

A full-bleed image slideshow modelled on themancompany.com — **no text, button or
product composition in the markup**. All copy lives inside the artwork, the way
TMC does it, so the client can ship a campaign by uploading one image.

Ratios are taken from TMC's own stylesheet (`padding-bottom: 28.645833%` and
`145.132743%`):

| breakpoint | size | ratio |
|---|---|---|
| desktop (≥768px) | **1920 × 550** | 3.491 : 1 |
| mobile (<768px) | **1130 × 1640** | 0.689 : 1 |

Two separate artworks per slide, because a 3.49:1 strip cannot be cropped into a
portrait phone screen. Both render as marked placeholders (`HERO-01-D`,
`HERO-01-M`, …) until images are set in the theme editor, so the slot codes double
as the shot list.

The banner leads the homepage — `templates/index.json` order is
`hero, concern, best, label, ritual, story, why`, the same order The Man Company
uses (banner first, category shelf under it). It is drag-reorderable in the
theme editor.

## Placeholders

Every image goes through `snippets/media-slot.liquid`, which renders a *marked*
box — slot code, purpose, exact pixel size — until a real asset is set. Product
photography is real (215 images pulled from the live store). Hero banners,
concern portraits and trust marks are still slots; see §8 of `docs/roadmap.html`.

> **Liquid trap worth knowing:** never put a filter inside `{% render %}`
> arguments. LiquidJS lets the filter swallow every argument after it, so
> `{% render 'media-slot', code: x | default: 'A', label: y, w: 1920 %}` silently
> passes `label` and `w` as empty. Resolve defaults with `{% assign %}` first.

## Seeded data

Pack sizes and MRPs do not exist on the live store — every product is a single
bottle at a single price, with `compare_at_price` equal to `price` on 34 of 35.
Both were generated so the pack ladder and discount badge could be reviewed.
**`docs/SEEDED-DATA.md` lists exactly what was invented, per product.** Ratings
were deliberately *not* seeded: the theme reads a reviews-app metafield and
renders nothing without one.

---

## Pushing to Shopify

```bash
npm run shopify:push     # uploads as an unpublished theme
```

Before it will look right on a real store, the catalog needs the
`helbrede.*` metafields defined in §6.4 of `docs/roadmap.html`. Until then the
PDP renders the buy box and hides every content section, which is the intended
degradation.
