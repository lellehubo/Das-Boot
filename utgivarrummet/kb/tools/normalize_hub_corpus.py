#!/usr/bin/env python3
"""Normalize the raw corpus already fetched by the hub's download_sources.py
into kb/sources/*.md files with provenance frontmatter.
Run from anywhere: python3 normalize_hub_corpus.py <hub-docs-dir> <kb-dir>
"""
import sys, re, json, hashlib, pathlib, datetime
HUB = pathlib.Path(sys.argv[1]); KB = pathlib.Path(sys.argv[2])
manifest = json.load(open(HUB/'manifest.json', encoding='utf-8'))
url_by_file = {}
for cat, items in manifest.get('kallor', {}).items():
    for it in items:
        url_by_file[(cat, it['fil'])] = (it['url'], it.get('beskrivning',''))
TODAY = datetime.date.today().isoformat()

def sha(b): return hashlib.sha256(b).hexdigest()[:16]

def frontmatter(d):
    out = ['---']
    for k, v in d.items():
        if isinstance(v, str) and (':' in v or '"' in v or v.startswith(('[','{'))):
            v = json.dumps(v, ensure_ascii=False)
        out.append(f'{k}: {v}')
    out.append('---'); return '\n'.join(out) + '\n\n'

def header_value(lines, key):
    for i, l in enumerate(lines[:60]):
        if l.strip() == key and i + 2 < len(lines) and lines[i+1].strip() == ':':
            return lines[i+2].strip()
    return ''

def clean_riksdagen(txt):
    lines = txt.split('\n')
    meta = {'sfs': header_value(lines, 'SFS nr'), 'utfardad': header_value(lines, 'Utfärdad'),
            'andrad': header_value(lines, 'Ändrad'), 'omtryck': header_value(lines, 'Omtryck'),
            'departement': header_value(lines, 'Departement/myndighet')}
    title = lines[0].split('|')[0].strip()
    # body start: after 'Innehåll:' TOC, at the second occurrence of the first TOC entry
    start = None
    i = lines.index('Innehåll:') if 'Innehåll:' in lines else 0
    for j in range(i + 1, len(lines)):
        if re.match(r'^1 §$', lines[j].strip()):
            start = j
            # keep the heading line right before 1 § when it repeats the first TOC entry
            # (chaptered laws: '1 kap. ...'; chapterless laws: first section heading)
            if j - 1 > i and lines[j-1].strip() and lines[j-1].strip() == lines[i+1].strip():
                start = j - 1
            elif j - 1 > i and re.match(r'^1 kap\.', lines[j-1].strip()):
                start = j - 1
            break
    if start is None: start = 0
    # body end: trailing site chrome
    end = len(lines)
    for j in range(len(lines)-1, start, -1):
        if lines[j].strip().startswith('Svensk författningssamling (SFS) innehåller'):
            end = j - 1 if lines[j-1].strip() == 'Svensk författningssamling' else j
            break
    body = '\n'.join(lines[start:end]).strip()
    return title, meta, body

def write(path, fm, body):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(frontmatter(fm) + body + '\n', encoding='utf-8')

summary = []
# --- statutes (riksdagen files only; lagen.nu copies go to notes as secondary)
for f in sorted((HUB/'lagar').glob('*.txt')):
    if not re.search(r'_\d{4}-\d+\.txt$', f.name):  # skip duplicate plain copies
        continue
    raw = f.read_text(encoding='utf-8', errors='replace')
    title, meta, body = clean_riksdagen(raw)
    url, desc = url_by_file.get(('lagar', f.name.replace('.txt', '.html')), ('', ''))
    sfs = meta['sfs'] or re.search(r'_(\d{4})-(\d+)', f.name).expand(r'\1:\2')
    slug = 'sfs-' + sfs.replace(':', '-') + '-' + re.sub(r'[^a-z0-9]+', '-', title.lower().split('(')[0].strip().replace('å','a').replace('ä','a').replace('ö','o')).strip('-')
    fm = {'id': slug, 'type': 'statute', 'title': title, 'sfs': sfs, 'issued': meta['utfardad'],
          'amended_through': meta['andrad'].replace('t.o.m. ', ''), 'reprint': meta['omtryck'],
          'source_url': url, 'source_site': 'riksdagen.se (konsoliderad SFS)', 'fetched_by': 'hub download_sources.py',
          'fetched_at': 'okänt (före 2026-03-12)', 'normalized_at': TODAY, 'sha256_16': sha(body.encode()),
          'verification_status': 'snapshot-unverified', 'note': 'Kör kb/fetch_sources.py för färsk lydelse och verifierat datum.'}
    write(KB/'sources/statutes'/(slug + '.md'), fm, body)
    ok = bool(re.search(r'^1 §', body, re.M))
    summary.append(('statute', slug, len(body), meta['andrad'], 'ok' if ok else 'CHECK'))

# --- simple pass-through categories
simple = {'eu': 'eu', 'pressetik': 'self-regulation', 'grn': 'guidance', 'jk': 'guidance', 'imy': 'guidance',
          'dronare': 'guidance', 'ovrigt': 'notes', 'hd': 'cases/hd', 'echr': 'cases/echr'}
for cat, dest in simple.items():
    d = HUB/cat
    if not d.exists(): continue
    for f in sorted(d.glob('*.txt')):
        body = f.read_text(encoding='utf-8', errors='replace').strip()
        if len(body) < 60:
            summary.append((cat, f.name, len(body), '', 'EMPTY-skipped')); continue
        url, desc = url_by_file.get((cat, f.name.replace('.txt', '.html')), ('', ''))
        slug = re.sub(r'[^a-z0-9]+', '-', f.stem.lower().replace('å','a').replace('ä','a').replace('ö','o')).strip('-')
        fm = {'id': f'{cat}-{slug}', 'type': cat, 'title': desc or f.stem, 'source_url': url,
              'fetched_by': 'hub download_sources.py', 'fetched_at': 'okänt (före 2026-03-12)',
              'normalized_at': TODAY, 'sha256_16': sha(body.encode()), 'verification_status': 'snapshot-unverified'}
        write(KB/'sources'/dest/(slug + '.md'), fm, body)
        summary.append((cat, slug, len(body), '', 'ok'))

for s in summary: print('%-14s %-60s %8d %-22s %s' % s)
print('files:', len(summary))
