#!/usr/bin/env python3
"""Extract v1alpha1 yaml fences from a skill dir, mirroring test/skill-snippets.test.ts naming."""
import os,re,sys,pathlib
root,out=sys.argv[1],sys.argv[2]
os.makedirs(out,exist_ok=True)
for f in pathlib.Path(out).glob("*.yaml"): f.unlink()
n=0
for dirpath,_,files in os.walk(root):
    for fn in sorted(files):
        if not fn.endswith(".md"): continue
        text=open(os.path.join(dirpath,fn)).read()
        for m in re.finditer(r"```yaml\n([\s\S]*?)```",text):
            raw=m.group(1)
            lines=raw.split("\n"); hint=None; i=0
            while i<len(lines):
                l=lines[i]
                if not l.strip(): i+=1; continue
                c=re.match(r"^#\s*(.+?)\s*$",l)
                if not c: break
                if c.group(1).endswith(".yaml") and not hint: hint=c.group(1)[:-5]
                i+=1
            body="\n".join(lines[i:])
            first=body.strip().split("\n")[0] if body.strip() else ""
            if not re.match(r"^version:\s*v1alpha1\b",first): continue
            n+=1
            name=hint or f"snip{n:02d}"
            open(os.path.join(out,f"{name}.yaml"),"w").write(body.lstrip("\n"))
print("fences:",n,file=sys.stderr)
