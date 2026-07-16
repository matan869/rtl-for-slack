"""Build the Edge and Firefox store zips from the shared source.

Chrome/Edge ship manifest.json as-is. Firefox additionally needs
browser_specific_settings.gecko.id (AMO requires a stable extension id) and a
min version; that key is injected here rather than kept in the shared manifest
so the Chrome Web Store never sees an unrecognized key during review.
"""
import json, zipfile, pathlib

ROOT = pathlib.Path(__file__).parent
SHIP = ["manifest.json", "content.js", "styles.css", "popup.html", "popup.js"]
SHIP_DIRS = ["icons", "fonts"]

manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
version = manifest["version"]

def files():
    for f in SHIP:
        yield ROOT / f, f
    for d in SHIP_DIRS:
        for p in sorted((ROOT / d).rglob("*")):
            if p.is_file():
                yield p, str(p.relative_to(ROOT)).replace("\\", "/")

def build(name, manifest_override=None):
    out = ROOT / "build" / name
    out.parent.mkdir(exist_ok=True)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for src, arc in files():
            if arc == "manifest.json" and manifest_override:
                z.writestr(arc, json.dumps(manifest_override, indent=2, ensure_ascii=False))
            else:
                z.write(src, arc)
    return out, out.stat().st_size

ff = json.loads(json.dumps(manifest))
ff["browser_specific_settings"] = {
    "gecko": {"id": "rtl-for-slack@mpialtd.com", "strict_min_version": "115.0"}
}

for label, (path, size) in {
    "edge":    build(f"rtl-for-slack-edge-v{version}.zip"),
    "firefox": build(f"rtl-for-slack-firefox-v{version}.zip", ff),
}.items():
    print(f"{label:8} {path.name:38} {size:,} bytes")
