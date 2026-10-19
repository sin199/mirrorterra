import csv, glob, re, sys
D = glob.glob('./onet/*/')[0]
def rows(name):
    with open(D+name, encoding='utf-8') as f:
        r = csv.reader(f, delimiter='\t'); next(r)
        for x in r: yield x
def acts(gwa):
    s = set()
    p = lambda pre: gwa == pre or gwa.startswith(pre + '.')
    if any(p(x) for x in ['4.A.1','4.A.2','4.A.3.b.1','4.A.3.b.2','4.A.3.b.6','4.A.4.a.1','4.A.4.b.3','4.A.4.b.6']): s.add('learn')
    if any(p(x) for x in ['4.A.3','4.A.2.b.5','4.A.2.b.6','4.A.4.c','4.A.1.a.2','4.A.1.b.2','4.A.1.b.3']): s.add('work')
    if any(p(x) for x in ['4.A.4.b','4.A.4.a.2','4.A.2.b.1','4.A.2.b.4','4.A.4.c.2','4.A.4.c.3','4.A.3.a.2']): s.add('cooperate')
    if any(p(x) for x in ['4.A.4.a','4.A.4.b.5']): s.add('socialize')
    return sorted(s)
clean = lambda t: re.sub(r'\s+', ' ', t).strip().rstrip('.')[:240]
out = {}
gwa_names = {}
for x in rows('Content Model Reference.txt'):
    if re.fullmatch(r'4\.A\.[0-9]\.[a-z]\.[0-9]+', x[0]): gwa_names[x[0]] = x[1]
for g, n in gwa_names.items(): out['onet:gwa:'+g] = (1, '', clean(n), acts(g), g)
for g, i, n in rows('GWAs to IWAs.txt'): out['onet:iwa:'+i] = (2, 'onet:gwa:'+g, clean(n), acts(g), g)
dwa_gwa = {}
for g, i, d, n in rows('GWAs to IWAs to DWAs.txt'):
    out['onet:dwa:'+d] = (3, 'onet:iwa:'+i, clean(n), acts(g), g); dwa_gwa[d] = g
first_dwa = {}
for soc, tid, dwa, *_ in rows('Tasks to DWAs.txt'):
    first_dwa.setdefault(tid, dwa)
seen = set()
for soc, tid, task, ttype, *_ in rows('Task Statements.txt'):
    if tid in seen or tid not in first_dwa: continue
    seen.add(tid); d = first_dwa[tid]
    if d not in dwa_gwa: continue
    out['onet:task:'+tid] = (4, 'onet:dwa:'+d, clean(task), acts(dwa_gwa[d]), dwa_gwa[d])
bad = [k for k, v in out.items() if not v[3]]
assert not bad, bad[:5]
with open('library.tsv', 'w', encoding='utf-8') as f:
    for k, (tier, parent, name, a, g) in out.items():
        name = name.replace('\t',' ').replace('\\','/')
        f.write('\t'.join([k, str(tier), parent or '\\N', name, '{' + ','.join(a) + '}', g]) + '\n')
from collections import Counter
print(len(out), Counter(v[0] for v in out.values()), Counter(a for v in out.values() for a in v[3]))
