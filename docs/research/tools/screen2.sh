#!/bin/bash
T=$(gh auth token)
while IFS='|' read -r n why; do
  npm=$(curl -s -m 10 -o /dev/null -w '%{http_code}' https://registry.npmjs.org/$n)
  gh=$(curl -s -m 10 "https://api.github.com/search/repositories?q=$n+in:name&per_page=3" -H "Authorization: Bearer $T" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('total_count','?'),'|',';'.join(r['full_name']+'*'+str(r['stargazers_count']) for r in d.get('items',[])))")
  sleep 2.2
  org=$(curl -s -m 10 -o /dev/null -w '%{http_code}' https://api.github.com/users/$n -H "Authorization: Bearer $T")
  doms=""; for t in com dev io org app; do r=$(dig +time=2 +tries=1 +short $n.$t NS | head -1); [ -z "$r" ] && r=$(dig +time=2 +tries=1 +short $n.$t A|head -1); [ -z "$r" ] && doms+=" $t:FREE?" || doms+=" $t:used"; done
  printf '%s\tnpm:%s\tghuser:%s\tgh:%s\t%s\n' "$n" "$npm" "$org" "$gh" "$doms"
done < "$1"
