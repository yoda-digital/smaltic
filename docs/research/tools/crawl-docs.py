import re,sys,os,time,urllib.request,urllib.parse,json
out=sys.argv[1]; seeds=[l.strip() for l in open(sys.argv[2]) if l.strip()]
def norm(u):
    u=u.split('#')[0].split('?')[0].rstrip('/')
    if u.endswith('.md'): u=u[:-3]
    return u
queue=[norm(u) for u in seeds]; seen=set(); index={}
def fetch(u):
    req=urllib.request.Request(u,headers={'User-Agent':'prismic-oss-research/1.0 (ai-input)'})
    with urllib.request.urlopen(req,timeout=30) as r: return r.status,r.headers.get('content-type',''),r.read().decode('utf-8','replace')
while queue:
    u=queue.pop(0)
    if u in seen or not u.startswith('https://prismic.io/docs'): continue
    seen.add(u)
    mdurl=(u if u!='https://prismic.io/docs' else 'https://prismic.io/docs/llms')+'.md' if not u.endswith('llms') else u+'.txt'
    try: st,ct,body=fetch(mdurl)
    except Exception as e: index[u]={'error':str(e)}; continue
    if 'markdown' not in ct and 'text/plain' not in ct: index[u]={'error':'non-md '+ct}; continue
    rel=u[len('https://prismic.io/docs'):].strip('/') or 'index'
    p=os.path.join(out,rel+'.md'); os.makedirs(os.path.dirname(p),exist_ok=True)
    open(p,'w').write(f'<!-- source: {u} fetched 2026-10-19 -->\n'+body)
    index[u]={'file':rel+'.md','bytes':len(body)}
    for l in re.findall(r'\]\((https://prismic\.io/docs[^)\s]*|/docs[^)\s]*)\)',body):
        if l.startswith('/'): l='https://prismic.io'+l
        n=norm(l)
        if n not in seen: queue.append(n)
    time.sleep(0.25)
json.dump(index,open(os.path.join(out,'_index.json'),'w'),indent=1)
ok=sum(1 for v in index.values() if 'file' in v); print('ok',ok,'err',len(index)-ok)
for k,v in index.items():
    if 'error' in v: print('ERR',k,v['error'])
