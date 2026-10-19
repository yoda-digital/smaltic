import re, sys, os
R = '/home/ubuntu/gits/prismic-oss/docs/research'
srcs = ['rea/01-apis-and-delivery.md','rea/02-content-modeling.md','rea/03-product-editor-admin.md','rea/04-sdks-and-frameworks.md','api-contracts.md']
extra = sys.argv[1:]  # additional files e.g. 05
texts = {s: open(os.path.join(R,s)).read() for s in srcs+extra}
pages = [l.strip() for l in open('/tmp/claude-1000/-home-ubuntu-gits-prismic-oss/d05bf397-7d0d-4e4b-ba82-66303d54a29a/scratchpad/pages.txt') if l.strip()]
short = {'rea/01-apis-and-delivery.md':'01','rea/02-content-modeling.md':'02','rea/03-product-editor-admin.md':'03','rea/04-sdks-and-frameworks.md':'04','api-contracts.md':'AC','rea/05-coverage-sweep.md':'05'}
def pats(p):
    out=[re.compile(r'(?:(?<=pages/)|(?<![\w/.-]))'+re.escape(p)+r'(?![\w-])')]
    if p.startswith('technical-reference/'):
        s=p[len('technical-reference/'):]
        out.append(re.compile(r'(?:(?<=technical-reference/)|(?<![\w/.-]))'+re.escape(s)+r'(?![\w-])'))
    return out
rows=[]
for p in pages:
    hits=[]
    for s,t in texts.items():
        n=sum(len(x.findall(t)) for x in pats(p))
        if n: hits.append(f"{short.get(s,s)}({n})")
    size=os.path.getsize(os.path.join(R,'prismic-docs-mirror/pages',p))
    rows.append((p,size,hits))
for p,size,h in rows:
    print(f"| `{p}` | {size} | {', '.join(h) if h else '**none**'} |")
