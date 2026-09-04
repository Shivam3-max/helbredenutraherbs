#!/usr/bin/env node
/**
 * Gives the live store the data the custom theme reads.
 *
 * The theme was built against dev/server.mjs, which injects `product.hb.*`,
 * a global `concerns` list and eight concern collections. None of that exists
 * on Shopify, so the unpublished theme renders its buy box and hides every
 * content section. This script closes that gap:
 *
 *   defs         12 `helbrede.*` product metafield definitions
 *   metafields   seeds them on all 35 catalogue products, matched by handle
 *   collections  creates the missing concern collections and fills them
 *   pages        creates the seven pages the nav links to, with the right
 *                template suffix so page.ritual.liquid et al. actually bind
 *
 * Every step is idempotent — it reads what is already there and only writes the
 * difference — so re-running after a partial failure is safe.
 *
 *   node scripts/shopify-configure.mjs --dry-run
 *   node scripts/shopify-configure.mjs
 *   node scripts/shopify-configure.mjs --only=metafields
 *
 * Auth comes from SHOPIFY_ADMIN_TOKEN — a custom-app Admin API token.
 *
 * It deliberately does not read the Shopify CLI's session store. `shopify auth
 * logout` does not dislodge the credential the theme commands use here, and that
 * credential is theme-scoped anyway: it can read metafield *definitions* but
 * cannot write products, collections or pages. A custom app also pins the exact
 * scopes this script needs instead of inheriting whatever the CLI happens to hold.
 *
 * The token is read from the environment and never printed.
 */

import fs from 'node:fs';
import path from 'node:path';

const API_VERSION = process.env.SHOPIFY_API_VERSION || '2025-07';
const ROOT = path.resolve(import.meta.dirname, '..');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const onlyArg = args.find((a) => a.startsWith('--only='));
const ONLY = onlyArg ? onlyArg.slice(7).split(',').map((s) => s.trim()) : null;
const wants = (step) => !ONLY || ONLY.includes(step);
// Opt in to topping up collections that already existed before this project.
const SYNC_EXISTING = args.includes('--sync-existing');

/* ========================================================================== *
 * Auth
 * ========================================================================== */

function resolveStore() {
  if (process.env.SHOPIFY_STORE) return process.env.SHOPIFY_STORE;
  const p = path.join(process.env.APPDATA || '', 'shopify-cli-theme-conf-nodejs', 'Config', 'config.json');
  if (fs.existsSync(p)) {
    const s = JSON.parse(fs.readFileSync(p, 'utf8')).themeStore;
    if (s) return s;
  }
  throw new Error('No store. Set SHOPIFY_STORE=<shop>.myshopify.com');
}

const REQUIRED_SCOPES = [
  'write_products',          // products, metafields and collections
  'write_content',           // pages (older API surface)
  'write_online_store_pages',
  'write_publications',      // publishing new collections to the Online Store
];

/**
 * Reads KEY=value lines out of a gitignored .env at the repo root. An env var
 * that is already set wins, so CI can override the file.
 */
function loadDotEnv() {
  const p = path.join(ROOT, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    // Tolerate quotes and trailing comments people paste in from a shell.
    const value = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
    if (!(key in process.env)) process.env[key] = value;
  }
}

const SETUP_HELP =
  `Dev Dashboard apps do not display an access token — Shopify retired\n` +
  `admin-created custom apps on 2026-01-01. The app instead trades its own\n` +
  `credentials for one (the client credentials grant), which is allowed because\n` +
  `the app and the store belong to the same Shopify organization.\n\n` +
  `Install the app on the store with these scopes:\n` +
  REQUIRED_SCOPES.map((s) => `    ${s}`).join('\n') + '\n\n' +
  `then put its Client ID and Client secret in .env at the repo root\n` +
  `(already gitignored), one per line:\n\n` +
  `    SHOPIFY_CLIENT_ID=...\n` +
  `    SHOPIFY_CLIENT_SECRET=shpss_...\n\n` +
  `A SHOPIFY_ADMIN_TOKEN, if set, is used directly and skips the exchange.\n`;

/**
 * Trades the app's own client id and secret for an Admin API access token.
 * The token lives 24 hours — far longer than a full run — so there is no
 * refresh logic here; re-running the script just mints a fresh one.
 */
async function exchangeClientCredentials(store, clientId, clientSecret) {
  const res = await fetch(`https://${store}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `Token exchange failed (HTTP ${res.status}) for ${store}.\n${text.slice(0, 300)}\n\n` +
      `Usual causes: the app is not installed on this store, the secret was\n` +
      `rotated after it was copied into .env, or the app and store sit in\n` +
      `different organizations — the grant requires the same org.\n`,
    );
  }

  const body = JSON.parse(text);
  if (!body.access_token) throw new Error(`Token exchange returned no access_token: ${text.slice(0, 200)}`);
  return body.access_token;
}

async function resolveToken(store) {
  loadDotEnv();

  if (process.env.SHOPIFY_ADMIN_TOKEN) return { token: process.env.SHOPIFY_ADMIN_TOKEN, from: 'SHOPIFY_ADMIN_TOKEN' };

  const id = process.env.SHOPIFY_CLIENT_ID;
  const secret = process.env.SHOPIFY_CLIENT_SECRET;
  if (id && secret) {
    return { token: await exchangeClientCredentials(store, id, secret), from: 'client credentials grant' };
  }

  throw new Error(`No Admin API credential for ${store}.\n\n${SETUP_HELP}`);
}

const STORE = resolveStore();
const ENDPOINT = `https://${STORE}/admin/api/${API_VERSION}/graphql.json`;
// Top-level await: the client credentials grant is a network round trip.
const { token: TOKEN, from: TOKEN_SOURCE } = await resolveToken(STORE);

/* ========================================================================== *
 * GraphQL
 * ========================================================================== */

let callCount = 0;

async function gql(query, variables = {}, { retries = 5 } = {}) {
  callCount++;
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': TOKEN },
    body: JSON.stringify({ query, variables }),
  });

  if (res.status === 429 && retries > 0) {
    await new Promise((r) => setTimeout(r, 2000));
    return gql(query, variables, { retries: retries - 1 });
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} — ${(await res.text()).slice(0, 400)}`);

  const body = await res.json();
  if (body.errors?.length) {
    const throttled = body.errors.some((e) => e.extensions?.code === 'THROTTLED');
    if (throttled && retries > 0) {
      await new Promise((r) => setTimeout(r, 2000));
      return gql(query, variables, { retries: retries - 1 });
    }
    throw new Error(`GraphQL: ${body.errors.map((e) => e.message).join('; ')}`);
  }
  return body.data;
}

/** Every mutation in this file returns userErrors under a single top-level field. */
function assertNoUserErrors(payload, label) {
  const errs = payload?.userErrors || [];
  if (errs.length) throw new Error(`${label}: ${errs.map((e) => `${(e.field || []).join('.')} ${e.message}`).join('; ')}`);
}

/* ========================================================================== *
 * Source data
 * ========================================================================== */

const shop = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'shop.json'), 'utf8'));

/**
 * `specs` is an array of [label, value] pairs and `ingredients`/`faq` are arrays
 * of objects, so those ride as `json`. Liquid gets the parsed structure back
 * from `.value`, which is exactly the shape the dev server handed the templates.
 */
const DEFINITIONS = [
  { key: 'title',         name: 'Short name',          type: 'single_line_text_field', description: 'Display name for cards and the PDP heading. product.title is the full merchandising title — brand, pipes, specs, ~100 characters — which the card layout cannot absorb.' },
  { key: 'subtitle',      name: 'Subtitle',            type: 'single_line_text_field', description: 'The line under the product title on cards and the PDP.' },
  { key: 'concern',       name: 'Concern handle',      type: 'single_line_text_field', description: 'Handle of the concern collection this product belongs to. Drives related products.' },
  { key: 'pack_size',     name: 'Pack size',           type: 'single_line_text_field', description: 'Net quantity printed on the pack, e.g. "60 capsules".' },
  { key: 'usage_horizon', name: 'Usage horizon',       type: 'single_line_text_field', description: 'How long the product should be used for a fair trial.' },
  { key: 'description',   name: 'Short description',   type: 'multi_line_text_field',  description: 'Plain-text summary recovered from the original body_html.' },
  { key: 'benefits',      name: 'Benefits',            type: 'json', description: 'Array of strings.' },
  { key: 'ingredients',   name: 'Ingredients',         type: 'json', description: 'Array of { name, dose, body }. Powers the Label Panel.' },
  { key: 'how_to_use',    name: 'How to use',          type: 'json', description: 'Array of strings.' },
  { key: 'suitable_for',  name: 'Suitable for',        type: 'json', description: 'Array of strings.' },
  { key: 'faq',           name: 'FAQ',                 type: 'json', description: 'Array of { q, a }.' },
  { key: 'safety',        name: 'Safety',              type: 'json', description: 'Array of strings. Powers the Safety & Interaction Check.' },
  { key: 'specs',         name: 'Specifications',      type: 'json', description: 'Array of [label, value] pairs.' },
];

const NAMESPACE = 'helbrede';

/* ========================================================================== *
 * Step 1 — metafield definitions
 * ========================================================================== */

async function stepDefinitions() {
  console.log('\n── metafield definitions ───────────────────────────────');

  const data = await gql(`
    query($ns: String!) {
      metafieldDefinitions(first: 250, ownerType: PRODUCT, namespace: $ns) {
        edges { node { id key type { name } access { admin storefront } } }
      }
    }`, { ns: NAMESPACE });

  const existing = new Map(data.metafieldDefinitions.edges.map((e) => [e.node.key, e.node]));
  let created = 0;

  for (const def of DEFINITIONS) {
    const found = existing.get(def.key);
    if (found) {
      const mismatch = found.type.name !== def.type;
      console.log(`  = ${NAMESPACE}.${def.key.padEnd(14)} exists${mismatch ? `  !! type is ${found.type.name}, expected ${def.type}` : ''}`);
      continue;
    }
    if (DRY) { console.log(`  + ${NAMESPACE}.${def.key.padEnd(14)} would create (${def.type})`); created++; continue; }

    const res = await gql(`
      mutation($d: MetafieldDefinitionInput!) {
        metafieldDefinitionCreate(definition: $d) {
          createdDefinition { id }
          userErrors { field message }
        }
      }`, {
      d: {
        name: def.name,
        namespace: NAMESPACE,
        key: def.key,
        description: def.description,
        type: def.type,
        ownerType: 'PRODUCT',
        // Access is deliberately not specified. An app creating a definition in
        // a plain (non-`$app:`) namespace is not allowed to choose the admin
        // access level — Shopify rejects both MERCHANT_READ_WRITE and
        // PUBLIC_READ_WRITE, each with a different error — so let it apply the
        // defaults. `verifyStorefrontAccess` below checks what it actually set,
        // since storefront read is what exposes the metafield to Liquid.
      },
    });
    assertNoUserErrors(res.metafieldDefinitionCreate, `create ${def.key}`);
    console.log(`  + ${NAMESPACE}.${def.key.padEnd(14)} created (${def.type})`);
    created++;
  }

  console.log(`  ${created} created, ${DEFINITIONS.length - created} already present`);
  if (!DRY) await verifyStorefrontAccess();
}

/**
 * Liquid only sees a metafield whose definition grants storefront read. Shopify
 * picks the access level itself here, so confirm rather than assume — a silently
 * NONE definition renders every PDP section empty with no error anywhere.
 */
async function verifyStorefrontAccess() {
  const data = await gql(`
    query($ns: String!) {
      metafieldDefinitions(first: 250, ownerType: PRODUCT, namespace: $ns) {
        edges { node { key access { admin storefront } } }
      }
    }`, { ns: NAMESPACE });

  const nodes = data.metafieldDefinitions.edges.map((e) => e.node);
  const blind = nodes.filter((n) => n.access?.storefront !== 'PUBLIC_READ');
  const sample = nodes[0]?.access;
  console.log(`  access: admin=${sample?.admin}, storefront=${sample?.storefront}`);

  if (!blind.length) return;

  // Creation ignores the access we ask for, but an update accepts it.
  console.log(`  granting storefront read to ${blind.length} definition(s)...`);
  for (const n of blind) {
    const res = await gql(`
      mutation($d: MetafieldDefinitionUpdateInput!) {
        metafieldDefinitionUpdate(definition: $d) {
          updatedDefinition { key access { storefront } }
          userErrors { field message }
        }
      }`, {
      d: {
        namespace: NAMESPACE,
        key: n.key,
        ownerType: 'PRODUCT',
        access: { storefront: 'PUBLIC_READ' },
      },
    });
    assertNoUserErrors(res.metafieldDefinitionUpdate, `grant storefront read to ${n.key}`);
    const got = res.metafieldDefinitionUpdate.updatedDefinition?.access?.storefront;
    console.log(`    ${n.key.padEnd(14)} storefront=${got}`);
  }
}

/* ========================================================================== *
 * Step 2 — seed the values
 * ========================================================================== */

async function fetchLiveProducts() {
  const out = new Map();
  let cursor = null;
  do {
    const data = await gql(`
      query($cursor: String) {
        products(first: 250, after: $cursor) {
          edges { cursor node { id handle title } }
          pageInfo { hasNextPage }
        }
      }`, { cursor });
    for (const e of data.products.edges) out.set(e.node.handle, e.node);
    cursor = data.products.pageInfo.hasNextPage ? data.products.edges.at(-1).cursor : null;
  } while (cursor);
  return out;
}

async function stepMetafields() {
  console.log('\n── product metafields ──────────────────────────────────');

  const live = await fetchLiveProducts();
  console.log(`  ${live.size} products on the store, ${shop.products.length} in the local catalogue`);

  const payload = [];
  const stale = [];
  const missing = [];

  for (const p of shop.products) {
    const target = live.get(p.handle);
    if (!target) { missing.push(p.handle); continue; }

    const values = { ...p.metafields };
    // `concern`, `pack_size` and the short `title` sit at the top level of
    // shop.json, not under metafields. The short title matters: Shopify's own
    // product.title is the full merchandising string, and the card layout was
    // designed around this ~26-character name plus the subtitle.
    if (p.concern) values.concern = p.concern;
    if (p.pack_size) values.pack_size = p.pack_size;
    if (p.title) values.title = p.title;

    for (const def of DEFINITIONS) {
      const v = values[def.key];
      /* An empty value means the local data no longer has anything worth
         showing. metafieldsSet only ever writes, so without an explicit delete
         a value seeded by an earlier run would linger on the store — which is
         exactly how the garbled spec tables would have survived their fix. */
      const empty = v === undefined || v === null
        || (typeof v === 'string' && v.trim() === '')
        || (Array.isArray(v) && v.length === 0);
      if (empty) {
        stale.push({ ownerId: target.id, namespace: NAMESPACE, key: def.key });
        continue;
      }

      payload.push({
        ownerId: target.id,
        namespace: NAMESPACE,
        key: def.key,
        type: def.type,
        value: def.type === 'json' ? JSON.stringify(v) : String(v),
      });
    }
  }

  if (missing.length) {
    console.log(`  !! ${missing.length} local product(s) have no matching handle on the store:`);
    missing.forEach((h) => console.log(`       ${h}`));
  }

  console.log(`  ${payload.length} metafield values across ${shop.products.length - missing.length} products`);
  console.log(`  ${stale.length} empty key(s) to clear`);
  if (DRY) { console.log('  (dry run — nothing written)'); return; }

  // Clearing a key that was never set is a no-op, so this stays idempotent.
  let cleared = 0;
  for (let i = 0; i < stale.length; i += 25) {
    const batch = stale.slice(i, i + 25);
    const res = await gql(`
      mutation($mf: [MetafieldIdentifierInput!]!) {
        metafieldsDelete(metafields: $mf) {
          deletedMetafields { key }
          userErrors { field message }
        }
      }`, { mf: batch });
    assertNoUserErrors(res.metafieldsDelete, `metafieldsDelete batch ${i / 25 + 1}`);
    cleared += (res.metafieldsDelete.deletedMetafields || []).filter(Boolean).length;
  }
  if (cleared) console.log(`  cleared ${cleared} stale value(s)`);

  // metafieldsSet caps at 25 per call.
  let written = 0;
  for (let i = 0; i < payload.length; i += 25) {
    const batch = payload.slice(i, i + 25);
    const res = await gql(`
      mutation($mf: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $mf) {
          metafields { id }
          userErrors { field message }
        }
      }`, { mf: batch });
    assertNoUserErrors(res.metafieldsSet, `metafieldsSet batch ${i / 25 + 1}`);
    written += res.metafieldsSet.metafields.length;
    process.stdout.write(`\r  written ${written}/${payload.length}`);
  }
  console.log('');
}

/* ========================================================================== *
 * Step 3 — concern collections
 * ========================================================================== */

/**
 * A collection created through the API is not published to any sales channel,
 * and an unpublished collection is invisible to Liquid — `collections[handle]`
 * comes back empty and the concern rail silently renders nothing. So every
 * collection this script creates gets published to the Online Store.
 */
async function onlineStorePublicationId() {
  const data = await gql(`{ publications(first: 25) { edges { node { id name } } } }`);
  const node = data.publications.edges.map((e) => e.node).find((n) => n.name === 'Online Store');
  if (!node) throw new Error('No "Online Store" publication found — cannot publish collections.');
  return node.id;
}

/** Handles already in a collection, so --sync-existing only adds what is absent. */
async function collectionProductHandles(collectionId) {
  const out = new Set();
  let cursor = null;
  do {
    const data = await gql(`
      query($id: ID!, $cursor: String) {
        collection(id: $id) {
          products(first: 250, after: $cursor) {
            edges { cursor node { handle } }
            pageInfo { hasNextPage }
          }
        }
      }`, { id: collectionId, cursor });
    const conn = data.collection.products;
    for (const e of conn.edges) out.add(e.node.handle);
    cursor = conn.pageInfo.hasNextPage ? conn.edges.at(-1).cursor : null;
  } while (cursor);
  return out;
}

async function stepCollections() {
  console.log('\n── concern collections ─────────────────────────────────');

  const live = await fetchLiveProducts();
  const publicationId = DRY ? null : await onlineStorePublicationId();

  for (const concern of shop.concerns) {
    const handle = concern.slug;
    const found = await gql(`
      query($q: String!) {
        collections(first: 1, query: $q) { edges { node { id handle title productsCount { count } } } }
      }`, { q: `handle:${handle}` });

    const node = found.collections.edges[0]?.node;
    const source = shop.collections[handle];
    const wantHandles = (source?.products || []).map((p) => p.handle);

    if (node && node.handle === handle) {
      // Collections that predate this project are left alone by default, so a
      // run cannot disturb the published storefront. --sync-existing opts in to
      // topping them up with the products the local taxonomy expects; it only
      // ever adds, never removes.
      if (!SYNC_EXISTING) {
        console.log(`  = ${handle.padEnd(22)} exists (${node.productsCount.count} products) — left untouched`);
        continue;
      }

      const have = await collectionProductHandles(node.id);
      const absent = wantHandles.filter((h) => !have.has(h));
      if (!absent.length) {
        console.log(`  = ${handle.padEnd(22)} exists, already has all ${wantHandles.length} — nothing to add`);
        continue;
      }
      if (DRY) {
        console.log(`  ~ ${handle.padEnd(22)} would add ${absent.length}: ${absent.join(', ')}`);
        continue;
      }
      const ids = absent.map((h) => live.get(h)?.id).filter(Boolean);
      const add = await gql(`
        mutation($id: ID!, $ids: [ID!]!) {
          collectionAddProducts(id: $id, productIds: $ids) { userErrors { field message } }
        }`, { id: node.id, ids });
      assertNoUserErrors(add.collectionAddProducts, `top up ${handle}`);
      console.log(`  ~ ${handle.padEnd(22)} added ${ids.length}: ${absent.join(', ')}`);
      continue;
    }

    if (DRY) {
      console.log(`  + ${handle.padEnd(22)} would create with ${wantHandles.length} products`);
      continue;
    }

    const res = await gql(`
      mutation($i: CollectionInput!) {
        collectionCreate(input: $i) {
          collection { id handle }
          userErrors { field message }
        }
      }`, {
      i: {
        title: concern.label,
        handle,
        descriptionHtml: source?.description || concern.tagline || '',
      },
    });
    assertNoUserErrors(res.collectionCreate, `create collection ${handle}`);
    const collectionId = res.collectionCreate.collection.id;

    const productIds = wantHandles.map((h) => live.get(h)?.id).filter(Boolean);
    if (productIds.length) {
      const add = await gql(`
        mutation($id: ID!, $ids: [ID!]!) {
          collectionAddProducts(id: $id, productIds: $ids) {
            userErrors { field message }
          }
        }`, { id: collectionId, ids: productIds });
      assertNoUserErrors(add.collectionAddProducts, `fill collection ${handle}`);
    }

    const pub = await gql(`
      mutation($id: ID!, $pid: ID!) {
        publishablePublish(id: $id, input: { publicationId: $pid }) {
          userErrors { field message }
        }
      }`, { id: collectionId, pid: publicationId });
    assertNoUserErrors(pub.publishablePublish, `publish collection ${handle}`);

    console.log(`  + ${handle.padEnd(22)} created with ${productIds.length}/${wantHandles.length} products, published`);
  }
}

/* ========================================================================== *
 * Step 4 — pages
 * ========================================================================== */

/** handle -> the `page.<suffix>.liquid` template the theme ships. */
const PAGES = [
  { handle: 'ritual-builder', title: 'Build Your Ritual',  suffix: 'ritual' },
  { handle: 'label-check',    title: 'Read the Label',     suffix: 'label' },
  { handle: 'ingredients',    title: 'Ingredient Library', suffix: 'ingredients' },
  { handle: 'consultancy',    title: 'Free Consultancy',   suffix: 'consultancy' },
  { handle: 'about',          title: 'About Helbrede',     suffix: 'about' },
  { handle: 'contact',        title: 'Contact',            suffix: 'contact' },
  { handle: 'faq',            title: 'FAQs',               suffix: 'faq' },
];

async function stepPages() {
  console.log('\n── pages ───────────────────────────────────────────────');

  const data = await gql(`
    query { pages(first: 250) { edges { node { id handle title templateSuffix } } } }`);
  const existing = new Map(data.pages.edges.map((e) => [e.node.handle, e.node]));

  for (const page of PAGES) {
    const found = existing.get(page.handle);

    if (found) {
      if (found.templateSuffix === page.suffix) {
        console.log(`  = /pages/${page.handle.padEnd(16)} exists, template page.${page.suffix}`);
        continue;
      }
      if (DRY) { console.log(`  ~ /pages/${page.handle.padEnd(16)} would retarget ${found.templateSuffix || '(default)'} -> page.${page.suffix}`); continue; }
      const res = await gql(`
        mutation($id: ID!, $p: PageUpdateInput!) {
          pageUpdate(id: $id, page: $p) { userErrors { field message } }
        }`, { id: found.id, p: { templateSuffix: page.suffix } });
      assertNoUserErrors(res.pageUpdate, `update page ${page.handle}`);
      console.log(`  ~ /pages/${page.handle.padEnd(16)} retargeted ${found.templateSuffix || '(default)'} -> page.${page.suffix}`);
      continue;
    }

    if (DRY) { console.log(`  + /pages/${page.handle.padEnd(16)} would create with template page.${page.suffix}`); continue; }

    const res = await gql(`
      mutation($p: PageCreateInput!) {
        pageCreate(page: $p) { page { id } userErrors { field message } }
      }`, {
      p: {
        title: page.title,
        handle: page.handle,
        templateSuffix: page.suffix,
        isPublished: true,
        // The template renders everything; the body stays empty on purpose.
        body: '',
      },
    });
    assertNoUserErrors(res.pageCreate, `create page ${page.handle}`);
    console.log(`  + /pages/${page.handle.padEnd(16)} created with template page.${page.suffix}`);
  }
}

/* ========================================================================== *
 * Step 5 — the ingredient library, as metaobjects
 * ========================================================================== */

const INGREDIENT_TYPE = 'ingredient';
/* Shopify routes entries to /pages/{urlHandle}/{entry}, so this exact value is
   what keeps the theme's existing /pages/ingredients/<handle> links working. */
const INGREDIENT_URL_HANDLE = 'ingredients';

/** Must match dev/server.mjs, or local and live URLs diverge. */
const ingredientHandle = (name) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function ensureIngredientDefinition() {
  const found = await gql(`
    query($type: String!) {
      metaobjectDefinitionByType(type: $type) {
        id
        capabilities { onlineStore { enabled data { urlHandle } } }
      }
    }`, { type: INGREDIENT_TYPE });

  if (found.metaobjectDefinitionByType) {
    const url = found.metaobjectDefinitionByType.capabilities?.onlineStore;
    console.log(`  = definition "${INGREDIENT_TYPE}" exists (onlineStore=${url?.enabled}, urlHandle=${url?.data?.urlHandle})`);
    return found.metaobjectDefinitionByType.id;
  }
  if (DRY) { console.log(`  + definition "${INGREDIENT_TYPE}" would be created, urlHandle=${INGREDIENT_URL_HANDLE}`); return null; }

  const res = await gql(`
    mutation($d: MetaobjectDefinitionCreateInput!) {
      metaobjectDefinitionCreate(definition: $d) {
        metaobjectDefinition { id }
        userErrors { field message }
      }
    }`, {
    d: {
      name: 'Ingredient',
      type: INGREDIENT_TYPE,
      displayNameKey: 'name',
      fieldDefinitions: [
        { key: 'name', name: 'Name', type: 'single_line_text_field', required: true },
        { key: 'body', name: 'Description', type: 'multi_line_text_field' },
        { key: 'products', name: 'Found in', type: 'list.product_reference' },
      ],
      capabilities: {
        publishable: { enabled: true },
        onlineStore: { enabled: true, data: { urlHandle: INGREDIENT_URL_HANDLE, createRedirects: true } },
      },
    },
  });
  assertNoUserErrors(res.metaobjectDefinitionCreate, 'create ingredient definition');
  console.log(`  + definition "${INGREDIENT_TYPE}" created, urlHandle=${INGREDIENT_URL_HANDLE}`);
  return res.metaobjectDefinitionCreate.metaobjectDefinition.id;
}

async function stepIngredients() {
  console.log('\n── ingredient library ──────────────────────────────────');

  await ensureIngredientDefinition();

  const live = await fetchLiveProducts();
  const entries = shop.ingredients.map((i) => ({
    handle: ingredientHandle(i.name),
    name: i.name,
    body: i.body || '',
    productIds: (i.products || []).map((h) => live.get(h)?.id).filter(Boolean),
  }));

  const linked = entries.reduce((n, e) => n + e.productIds.length, 0);
  console.log(`  ${entries.length} ingredients, ${linked} product links`);

  if (DRY) { console.log('  (dry run — nothing written)'); return; }

  let done = 0;
  for (const e of entries) {
    const res = await gql(`
      mutation($handle: MetaobjectHandleInput!, $mo: MetaobjectUpsertInput!) {
        metaobjectUpsert(handle: $handle, metaobject: $mo) {
          metaobject { handle }
          userErrors { field message }
        }
      }`, {
      handle: { type: INGREDIENT_TYPE, handle: e.handle },
      mo: {
        fields: [
          { key: 'name', value: e.name },
          { key: 'body', value: e.body },
          { key: 'products', value: JSON.stringify(e.productIds) },
        ],
        capabilities: { publishable: { status: 'ACTIVE' } },
      },
    });
    assertNoUserErrors(res.metaobjectUpsert, `upsert ingredient ${e.handle}`);
    done++;
    if (done % 10 === 0 || done === entries.length) process.stdout.write(`\r  upserted ${done}/${entries.length}`);
  }
  console.log('');
}

/* ========================================================================== *
 * Step 6 — the pack ladder's automatic discounts
 * ========================================================================== */

/*
 * The ladder on the product page sets quantity, not a variant, so the saving
 * has to come from a discount. These two must stay in step with the
 * pack_tier2_pct / pack_tier3_pct theme settings — the page quotes a figure the
 * cart has to honour.
 */
const PACK_DISCOUNTS = [
  { title: 'Pack of 2 — 10% off', quantity: 2, percentage: 0.10 },
  { title: 'Pack of 3 — 15% off', quantity: 3, percentage: 0.15 },
];

async function stepDiscounts() {
  console.log('\n── pack discounts ──────────────────────────────────────');

  const existing = await gql(`
    query {
      automaticDiscountNodes(first: 50) {
        edges { node { id automaticDiscount { __typename ... on DiscountAutomaticBasic { title status } } } }
      }
    }`);

  const byTitle = new Map(
    existing.automaticDiscountNodes.edges
      .map((e) => [e.node.automaticDiscount?.title, e.node])
      .filter(([t]) => t),
  );

  for (const d of PACK_DISCOUNTS) {
    const found = byTitle.get(d.title);
    if (found) {
      console.log(`  = ${d.title} exists (${found.automaticDiscount.status})`);
      continue;
    }
    if (DRY) { console.log(`  + ${d.title} would be created — min qty ${d.quantity}, ${d.percentage * 100}%`); continue; }

    const res = await gql(`
      mutation($d: DiscountAutomaticBasicInput!) {
        discountAutomaticBasicCreate(automaticBasicDiscount: $d) {
          automaticDiscountNode { id }
          userErrors { field message }
        }
      }`, {
      d: {
        title: d.title,
        startsAt: new Date().toISOString(),
        minimumRequirement: { quantity: { greaterThanOrEqualToQuantity: String(d.quantity) } },
        customerGets: { value: { percentage: d.percentage }, items: { all: true } },
        /* Product discounts cannot combine on one line outside Plus, and this
           store is on Basic. Say so explicitly rather than leaving it to a
           default that might change. */
        combinesWith: { productDiscounts: false, orderDiscounts: true, shippingDiscounts: true },
      },
    });
    assertNoUserErrors(res.discountAutomaticBasicCreate, `create ${d.title}`);
    console.log(`  + ${d.title} created — min qty ${d.quantity}, ${d.percentage * 100}% off all products`);
  }
}

/* ========================================================================== *
 * Run
 * ========================================================================== */

async function main() {
  console.log(`store       ${STORE}`);
  console.log(`api         ${API_VERSION}`);
  console.log(`auth        ${TOKEN_SOURCE}`);
  console.log(`mode        ${DRY ? 'DRY RUN — no writes' : 'WRITING'}`);
  if (ONLY) console.log(`steps       ${ONLY.join(', ')}`);

  if (wants('defs')) await stepDefinitions();
  if (wants('metafields')) await stepMetafields();
  if (wants('collections')) await stepCollections();
  if (wants('pages')) await stepPages();
  if (wants('ingredients')) await stepIngredients();
  if (wants('discounts')) await stepDiscounts();

  console.log(`\ndone — ${callCount} API calls${DRY ? ' (dry run)' : ''}\n`);
}

main().catch((err) => {
  console.error(`\n${err.message}\n`);
  process.exit(1);
});
