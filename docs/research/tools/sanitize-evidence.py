"""Make live Prismic API captures safe to publish: keep every key, id, date, number, type and URL,
replace prose (article text, titles, alt text...) with same-length placeholder text so span offsets stay valid.
Usage: python3 -I tools/sanitize-evidence.py <raw_dir> <out_dir>  (originals stay in the git-ignored raw dir)."""
import json, sys, pathlib

PROSE_KEYS = {"text", "title", "alt", "copyright", "description", "author_name", "caption", "name"}
KEEP_KEYS = {"url", "embed_url", "href", "next_page", "prev_page", "thumbnail_url", "author_url",
             "provider_url", "action", "html", "oauth_initiate", "oauth_token", "message"}
LOREM = ("lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt "
         "ut labore et dolore magna aliqua ")

def placeholder(s: str) -> str:
    letters = LOREM.replace(" ", "")
    out, i = [], 0
    for c in s:  # keep the original whitespace layout, fill everything else with lorem letters
        if c.isspace():
            out.append(c)
        else:
            out.append(letters[i % len(letters)]); i += 1
    return "".join(out)

def scrub(node, key=None):
    if isinstance(node, dict):
        return {k: scrub(v, k) for k, v in node.items()}
    if isinstance(node, list):
        return [scrub(v, key) for v in node]
    if isinstance(node, str) and key not in KEEP_KEYS:
        if key in PROSE_KEYS or node.count(" ") >= 3:
            return placeholder(node)
    return node

raw, out = map(pathlib.Path, sys.argv[1:3])
out.mkdir(parents=True, exist_ok=True)
for f in sorted(raw.glob("*.json")):
    data = json.loads(f.read_text())
    (out / f.name).write_text(json.dumps(scrub(data), ensure_ascii=False, separators=(",", ":")))
    print("sanitized", f.name)
