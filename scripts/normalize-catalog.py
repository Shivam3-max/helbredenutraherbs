#!/usr/bin/env python3
"""
Parse Helbrede's Shopify body_html into structured PDP sections.

The live descriptions come from two authoring habits:
  A. real <h1>-<h4> headings                      (~15 products)
  B. a Google-Docs paste where <strong> carries   (~13 products)
     the structure and spans carry the styling

Both reduce to the same block grammar, so the theme can render every product
through one set of sections:

    HEADING   <p> (or <h*>) whose entire content is bold  -> section break
    KV        <p> with a bold label and plain remainder   -> spec pair
    BULLET    <li>, or a line opening with ✔/✅/•/-        -> list item
    PROSE     anything else                               -> body copy

Inside an ingredients section, HEADING + following PROSE pairs as name + body.

Output: catalog/products.normalized.json
"""
import json, re, html, os
from collections import Counter, OrderedDict

ROOT = os.path.join(os.path.dirname(__file__), '..')
SRC  = os.path.join(ROOT, 'catalog', 'raw-products.json')
OUT  = os.path.join(ROOT, 'catalog', 'products.normalized.json')

SECTION_MAP = OrderedDict([
    # 'ingredient' is tested before 'benefit': headings such as
    # "INGREDIENTS & THEIR BENEFITS" carry both words and are ingredient blocks.
    ('ingredients', ['ingredient', 'natural botanical', 'natural herbal',
                     'cold pressed', 'aqueous herbal', 'advanced active']),
    ('benefits',    ['key benefits', 'product benefits', 'benefits of', 'key features',
                     'why you’ll love it', "why you'll love it", 'visible results',
                     'visible glow', 'get fit', 'why choose', 'benefits']),
    ('how_to_use',  ['how to take', 'how to use', 'how to apply', 'direction for use',
                     'directions for use', 'am & pm routine', 'daily serving',
                     'how to', 'direction']),
    ('suitable',    ['who can use', 'who should use', 'who is it for', 'suitable for']),
    ('faq',         ['frequently asked', 'faqs', 'faq']),
    ('safety',      ['safety information', 'important note', 'safety']),
    ('specs',       ['product information', 'more information', 'product highlights',
                     'quality you can trust', 'specification']),
    ('description', ['product description', 'description']),
])

BULLET_GLYPHS = '✔✓✅★•·◆▪'
STRIP_RE = re.compile(r'[\U0001F300-\U0001FAFF☀-➿️]')

def text(s):
    s = re.sub(r'(?is)<br\s*/?>', '\n', s or '')
    s = re.sub(r'<[^>]+>', '', s)
    s = html.unescape(s).replace('\xa0', ' ')
    s = STRIP_RE.sub('', s)
    s = re.sub(r'[ \t]+', ' ', s)
    return s.strip()

def clean_runs(runs):
    s = ''.join(t for t, _ in runs)
    s = html.unescape(s).replace('\xa0', ' ')
    s = STRIP_RE.sub('', s)
    s = re.sub(r'[ \t]+', ' ', s)
    return s.strip(' \n')


def label_text(s):
    return text(s).strip(' :–—-')

def canon(label):
    l = label_text(label).lower()
    if not l:
        return None
    for key, needles in SECTION_MAP.items():
        for n in needles:
            if n in l:
                return key
    return None

from html.parser import HTMLParser

BLOCK_TAGS = {'p', 'div', 'li', 'tr', 'td', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'}
BOLD_TAGS  = {'strong', 'b'}


class BlockWalker(HTMLParser):
    """Walk the description tree and emit one record per leaf block.

    A regex pass cannot do this: the Google-Docs paste nests <div> inside <div>
    and <span> inside <strong>, so paired-tag matching silently swallows whole
    sections. Tracking open tags gives correct nesting, and tracking <strong>
    depth tells a heading ("all bold") apart from a spec pair ("bold label,
    plain value").
    """

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.blocks = []        # (tag, [(text, is_bold), ...])
        self.stack = []         # open block tags
        self.runs = []          # runs for the innermost open block
        self.bold = 0

    def _flush(self, tag):
        if any(t.strip() for t, _ in self.runs):
            self.blocks.append((tag, self.runs))
        self.runs = []

    def handle_starttag(self, tag, attrs):
        if tag in BOLD_TAGS:
            self.bold += 1
        elif tag == 'br':
            self.runs.append(('\n', False))
        elif tag in BLOCK_TAGS:
            # content seen so far belongs to the parent block
            self._flush(self.stack[-1] if self.stack else 'p')
            self.stack.append(tag)

    def handle_endtag(self, tag):
        if tag in BOLD_TAGS:
            self.bold = max(0, self.bold - 1)
        elif tag in BLOCK_TAGS:
            self._flush(tag)
            if tag in self.stack:
                while self.stack and self.stack.pop() != tag:
                    pass

    def handle_data(self, data):
        if data.strip():
            self.runs.append((data, self.bold > 0))

    def close(self):
        super().close()
        self._flush(self.stack[-1] if self.stack else 'p')


def blocks(body):
    """Flatten the description into a linear list of typed blocks."""
    w = BlockWalker()
    w.feed(body or '')
    w.close()

    out = []
    row = []
    for tag, runs in w.blocks:
        joined = clean_runs(runs)
        bold = clean_runs([r for r in runs if r[1]])
        rest = clean_runs([r for r in runs if not r[1]]).strip(' :–—-')
        if not joined:
            continue

        if tag in ('td', 'th'):
            row.append(joined)
            continue
        if row:
            if len(row) >= 2:
                out.append(('kv', row[0].strip(' :'), ' '.join(row[1:])))
            else:
                out.append(('prose', '', row[0]))
            row = []

        if tag.startswith('h'):
            out.append(('heading', joined.strip(' :–—-'), ''))
        elif tag == 'li':
            out.append(('bullet', '', joined))
        elif bold and not rest:
            out.append(('heading', bold.strip(' :–—-'), ''))
        elif bold and rest and len(bold) < 60:
            out.append(('kv', bold.strip(' :'), rest))
        elif joined[:1] in BULLET_GLYPHS or joined.startswith(('- ', '• ')):
            out.append(('bullet', '', joined.lstrip(BULLET_GLYPHS + '-• ').strip()))
        else:
            out.append(('prose', '', joined))

    if len(row) >= 2:
        out.append(('kv', row[0].strip(' :'), ' '.join(row[1:])))
    return out


DOSE_RE = re.compile(r'[–—-]\s*[\d.,]+\s*(?:mg|mcg|g|ml|%|iu)\b', re.I)

def is_ingredient_name(kind, val):
    """Ingredient names appear as bold headings, or as short plain lines that
    carry a dose ('Reduced L-Glutathione — 500 mg') rather than a sentence."""
    if kind == 'heading':
        return True
    if kind != 'prose' or len(val) > 90:
        return False
    if DOSE_RE.search(val):
        return True
    return len(val) < 55 and not val.rstrip().endswith(('.', '!', '?'))

def parse(p):
    body = p['body_html'] or ''
    secs = {k: [] for k in ('benefits', 'ingredients', 'how_to_use',
                            'suitable', 'safety', 'specs')}
    faq, lead, cur = [], [], None
    pending_name = None

    for kind, key, val in blocks(body):
        if kind == 'heading':
            nxt = canon(key)
            if nxt:
                cur, pending_name = nxt, None
                continue
            if cur == 'faq' and key.rstrip().endswith('?'):
                faq.append({'q': key, 'a': ''})
            elif cur == 'ingredients':
                pending_name = key
                secs['ingredients'].append({'name': key, 'body': ''})
            elif cur in ('benefits', 'how_to_use', 'suitable', 'safety') and key:
                secs[cur].append(key)
            continue

        if cur is None:
            if kind in ('prose', 'bullet') and len(val) > 40:
                lead.append(val)
            continue

        if kind == 'kv':
            if cur in ('specs', 'description', None) or cur == 'suitable':
                secs['specs'].append([key, val])
            else:
                secs['specs'].append([key, val])
        elif cur == 'faq':
            if faq and not faq[-1]['a']:
                faq[-1]['a'] = val[:900]
            elif val.rstrip().endswith('?'):
                faq.append({'q': val, 'a': ''})
        elif cur == 'ingredients':
            if is_ingredient_name(kind, val):
                secs['ingredients'].append({'name': val.strip(' :'), 'body': ''})
                pending_name = val
            elif secs['ingredients']:
                tgt = secs['ingredients'][-1]
                tgt['body'] = (tgt['body'] + ' ' + val).strip()[:600]
            elif len(val) > 20:
                secs['ingredients'].append({'name': val.split('–')[0].split('-')[0].strip()[:60],
                                            'body': val})
        elif cur in ('benefits', 'how_to_use', 'suitable', 'safety'):
            if len(val) > 3:
                secs[cur].append(val)
        elif cur == 'description':
            lead.append(val)

    secs['ingredients'] = [i for i in secs['ingredients'] if i['name']]
    # the source copy numbers its FAQs and sprinkles stray bullet glyphs into
    # the spec table; strip both so the theme never has to.
    for f in faq:
        f['q'] = re.sub(r'^\s*\d+[.)]\s*', '', f['q'])
    secs['specs'] = [[k.lstrip('•· ').strip(), v.lstrip('•· ').strip()]
                     for k, v in secs['specs'] if k and v]
    faq = [f for f in faq if f['q'] and f['a']]
    imgs = re.findall(r'(?is)<img[^>]+src=["\']([^"\']+)', body)
    v0 = p['variants'][0]

    return {
        'id': p['id'],
        'handle': p['handle'],
        'title': p['title'],
        'title_short': re.split(r'\s*[|–]\s*', p['title'])[0].strip(),
        'vendor': p['vendor'],
        'product_type': p['product_type'],
        'tags': p.get('tags', []),
        'published_at': (p.get('published_at') or '')[:10],
        'price': float(v0['price']),
        'compare_at': float(v0['compare_at_price']) if v0.get('compare_at_price') else None,
        'variant_count': len(p['variants']),
        'options': [{'name': o['name'], 'values': o['values']} for o in p.get('options', [])],
        'gallery': [i['src'] for i in p['images']],
        'inline_images': imgs,
        'sections': {
            'description': ' '.join(lead)[:2500],
            'benefits': secs['benefits'][:14],
            'ingredients': secs['ingredients'][:18],
            'how_to_use': secs['how_to_use'][:8],
            'suitable': secs['suitable'][:6],
            'faq': faq[:10],
            'safety': secs['safety'][:12],
            'specs': secs['specs'][:22],
        },
    }

def main():
    data = json.load(open(SRC))['products']
    rows = [parse(p) for p in data]
    json.dump(rows, open(OUT, 'w'), indent=1, ensure_ascii=False)

    fields = ['description', 'benefits', 'ingredients', 'how_to_use',
              'suitable', 'faq', 'safety', 'specs']
    cov = Counter()
    for r in rows:
        for f in fields:
            if r['sections'][f]:
                cov[f] += 1
    n = len(rows)
    print(f"normalized {n} products -> {os.path.relpath(OUT, ROOT)}\n")
    print("SECTION COVERAGE")
    for f in fields:
        print(f"  {f:12} {cov[f]:2}/{n}  {cov[f]/n*100:4.0f}%  {'#' * round(cov[f]/n*34)}")
    thin = [r['handle'] for r in rows if sum(1 for f in fields if r['sections'][f]) < 4]
    print(f"\nNEEDS MANUAL AUTHORING ({len(thin)}):")
    for h in thin:
        print("  -", h[:78])

if __name__ == '__main__':
    main()
