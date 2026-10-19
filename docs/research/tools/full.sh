#!/bin/bash
# full screen: npm exact + create-, gh user + repo count, iTunes app exact-ish, domains dev/io/com/app
T=$(gh auth token)
for n in "$@"; do
  npm=$(curl -s -m 8 -o /dev/null -w '%{http_code}' https://registry.npmjs.org/$n)
  ghu=$(curl -s -m 8 -o /dev/null -w '%{http_code}' https://api.github.com/users/$n -H "Authorization: Bearer $T")
  [ "$npm" != 404 ] || [ "$ghu" != 404 ] && { echo "$n  OUT npm:$npm gh:$ghu"; continue; }
  repos=$(curl -s -m 8 "https://api.github.com/search/repositories?q=$n+in:name" -H "Authorization: Bearer $T" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("total_count","?"))'); sleep 2
  apps=$(curl -s -m 10 "https://itunes.apple.com/search?term=$n&entity=software&limit=50" | python3 -c "import json,sys;d=json.load(sys.stdin);print([r['trackName'] for r in d['results'] if '$n' in r['trackName'].lower().replace(' ','')][:3])")
  d=""; for t in dev io com app; do r=$(dig +time=2 +tries=1 +short $n.$t NS|head -1)$(dig +time=2 +tries=1 +short $n.$t A|head -1); [ -z "$r" ] && d+=" $t:FREE" || d+=" $t:used"; done
  echo "$n  OK repos:$repos apps:$apps$d"
done
