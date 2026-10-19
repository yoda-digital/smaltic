import json,glob,sys,collections
samples=collections.OrderedDict()
def kind(v):
    if isinstance(v,list):
        if v and isinstance(v[0],dict) and 'slice_type' in v[0]: return 'slicezone'
        if v and isinstance(v[0],dict) and 'type' in v[0] and 'spans' in v[0]: return 'richtext'
        if v==[]: return 'empty-list'
        return 'group'
    if isinstance(v,dict):
        if 'link_type' in v: return 'link:'+v['link_type']+(':'+v.get('kind','') if v.get('kind') else '')
        if 'dimensions' in v or ('url' in v and 'alt' in v): return 'image'
        if 'embed_url' in v or 'html' in v: return 'embed'
        if 'latitude' in v: return 'geopoint'
        if 'head' in v and 'body' in v: return 'table'
        return 'object:'+','.join(sorted(v)[:6])
    return type(v).__name__
def walk(o):
    if isinstance(o,dict):
        for k,v in o.items():
            kd=kind(v); samples.setdefault(kd,(k,v))
            if kd=='richtext':
                for b in v:
                    samples.setdefault('rt-block:'+b['type'],(k,b))
                    for s in b.get('spans',[]): samples.setdefault('rt-span:'+s['type'],(k,s))
            if kd=='slicezone':
                samples.setdefault('slice',(k,{x:y for x,y in v[0].items()}))
            walk(v)
    elif isinstance(o,list):
        for x in o: walk(x)
for f in sys.argv[1:]:
    try: walk([r['data'] for r in json.load(open(f)).get('results',[])])
    except Exception as e: pass
for k,(n,v) in samples.items():
    s=json.dumps(v)[:700]
    print(f'## {k}  (field "{n}")\n{s}\n')
