#!/bin/bash
# fast screen: npm, github user/org, .dev .com .io  (prints only names with npm free AND gh user free)
T=$(gh auth token)
for n in "$@"; do
  npm=$(curl -s -m 8 -o /dev/null -w '%{http_code}' https://registry.npmjs.org/$n)
  ghu=$(curl -s -m 8 -o /dev/null -w '%{http_code}' https://api.github.com/users/$n -H "Authorization: Bearer $T")
  d=""; for t in dev com io; do r=$(dig +time=2 +tries=1 +short $n.$t NS|head -1); [ -z "$r" ] && d+=" $t:FREE" || d+=" $t:used"; done
  echo "$n npm:$npm gh:$ghu$d"
done
