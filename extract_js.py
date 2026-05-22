import re, sys
src = open("copper-beta.html", encoding="utf-8").read()
matches = re.findall(r"<script(?![^>]*src=)[^>]*>(.*?)</script>", src, re.DOTALL)
out = "\n;\n".join(matches)
open("/tmp/copper_inline.js", "w").write(out)
print(f"extracted {len(matches)} inline blocks, {len(out)} chars")
