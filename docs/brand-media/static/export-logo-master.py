"""Export the current header wordmark after comparing its real browser font.

Requires fontTools (including WOFF2 support). Capture the live header after
document.fonts.ready; supply its computed styles, character positions and the
loaded Latin WOFF2 as --browser-evidence and --webfont. Use --write to regenerate
the two outputs; the default checks them without changing any file.
"""

import argparse
import hashlib
import json
import re
import xml.etree.ElementTree as ET
from pathlib import Path

import fontTools
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont


ROOT = Path(__file__).resolve().parents[3]
MASTER = ROOT / "public/brand/packjoyu-logo-master.svg"
AUDIT = ROOT / "docs/brand-media/static/logo-source-audit.json"
FONT = ROOT / "src/assets/og-fonts/Manrope-ExtraBold.ttf"
WORD = "PackJoyU"
SOURCE_PATHS = [
    "src/components/layout/SiteHeader.tsx",
    "src/app/globals.css",
    "src/app/[locale]/layout.tsx",
    "src/styles/tokens.css",
    "src/app/icon.svg",
    "src/assets/og-fonts/Manrope-ExtraBold.ttf",
    "src/assets/og-fonts/OFL.txt",
    "design/og-src/og-article-font.py",
]


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def pair_adjustment(font, first, second):
    """Read only the font's active horizontal kern feature for this Latin logo."""
    if "GPOS" not in font:
        return 0
    table = font["GPOS"].table
    indices = set()
    for record in table.FeatureList.FeatureRecord:
        if record.FeatureTag == "kern":
            indices.update(record.Feature.LookupListIndex)
    adjustment = 0
    for index in sorted(indices):
        lookup = table.LookupList.Lookup[index]
        require(lookup.LookupType == 2, "Unexpected kern lookup; use a shaping engine")
        for sub in lookup.SubTable:
            if first not in sub.Coverage.glyphs:
                continue
            value = None
            matched = False
            if sub.Format == 1:
                pairs = sub.PairSet[sub.Coverage.glyphs.index(first)].PairValueRecord
                for pair in pairs:
                    if pair.SecondGlyph == second:
                        value = pair.Value1
                        require(not pair.Value2, "Unexpected second-glyph positioning")
                        matched = True
                        break
            elif sub.Format == 2:
                class1 = sub.ClassDef1.classDefs.get(first, 0)
                class2 = sub.ClassDef2.classDefs.get(second, 0)
                pair = sub.Class1Record[class1].Class2Record[class2]
                value = pair.Value1
                require(not pair.Value2, "Unexpected second-glyph positioning")
                matched = True
            else:
                raise ValueError("Unexpected pair positioning format")
            if matched:
                values = vars(value) if value else {}
                require(set(values) <= {"XAdvance"}, "Unexpected non-advance positioning")
                adjustment += values.get("XAdvance", 0)
                break
    return adjustment


def geometry(font):
    cmap, glyphs = font.getBestCmap(), font.getGlyphSet()
    names = [cmap[ord(char)] for char in WORD]
    rows, cursor = [], 0
    bounds = BoundsPen(glyphs)
    for index, (char, name) in enumerate(zip(WORD, names)):
        pen = SVGPathPen(glyphs)
        glyphs[name].draw(pen)
        glyphs[name].draw(TransformPen(bounds, (1, 0, 0, 1, cursor, 0)))
        advance = font["hmtx"].metrics[name][0]
        kern = pair_adjustment(font, name, names[index + 1]) if index + 1 < len(names) else 0
        rows.append({"character": char, "x": cursor, "advance": advance,
                     "kernAfter": kern, "outline": pen.getCommands()})
        cursor += advance + kern
    return {"unitsPerEm": font["head"].unitsPerEm, "advance": cursor,
            "bounds": list(bounds.bounds), "glyphs": rows}


def rgb(value):
    if re.fullmatch(r"#[0-9a-fA-F]{6}", value):
        return value.lower()
    match = re.fullmatch(r"rgb\((\d+),\s*(\d+),\s*(\d+)\)", value)
    require(match is not None, f"Unsupported computed color: {value}")
    return "#" + "".join(f"{int(channel):02x}" for channel in match.groups())


def build_svg(font, layout, main_color, joy_color):
    x_min, _, x_max, y_max = layout["bounds"]
    width = x_max - x_min
    height = y_max - layout["bounds"][1]
    paths = []
    glyphs, cmap = font.getGlyphSet(), font.getBestCmap()
    for index, row in enumerate(layout["glyphs"]):
        pen = SVGPathPen(glyphs)
        glyphs[cmap[ord(row["character"])]].draw(
            TransformPen(pen, (1, 0, 0, -1, row["x"] - x_min, y_max)))
        color = joy_color if 4 <= index <= 6 else main_color
        paths.append(f'  <path fill="{color}" d="{pen.getCommands()}"/>')
    view_box = f"0 0 {width:g} {height:g}"
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{view_box}" '
           f'width="{width / 10:g}" height="{height / 10:g}">\n'
           + "\n".join(paths) + "\n</svg>\n")
    tree = ET.fromstring(svg)
    require(len(tree) == 8 and all(node.tag.endswith("}path") for node in tree),
            "Master must contain eight paths only")
    require(all(set(node.attrib) == {"fill", "d"} for node in tree),
            "Unexpected SVG attributes")
    return svg.encode(), view_box


def run():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--webfont", type=Path, required=True)
    parser.add_argument("--browser-evidence", type=Path, required=True)
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args()
    source = {path: (ROOT / path).read_bytes() for path in SOURCE_PATHS}
    header = source[SOURCE_PATHS[0]].decode("utf-8")
    require('className="logo">Pack<i>Joy</i>U</Link>' in header, "Header wordmark changed")
    browser_bytes = args.browser_evidence.read_bytes()
    browser_path = args.browser_evidence.resolve().relative_to(ROOT).as_posix()
    webfont_path = args.webfont.resolve().relative_to(ROOT).as_posix()
    source[browser_path] = browser_bytes
    source[webfont_path] = args.webfont.read_bytes()
    browser = json.loads(browser_bytes)
    logo = browser["logo"]
    require(browser["fontStatus"] == "loaded", "Browser font was not loaded")
    require(logo["text"] == WORD, "Browser did not inspect the complete current wordmark")
    require(logo["fontSize"] == "20px" and logo["fontWeight"] == "800", "Header size/weight changed")
    require(logo["fontStyle"] == logo["joyFontStyle"] == "normal", "Header became italic")
    require(logo["letterSpacing"] in ("normal", "0px"), "Unexpected tracking")
    require(logo["fontKerning"] in ("auto", "normal"), "Kerning disabled")
    require(logo["lineHeight"] == "24px", "Header line height changed")
    main_color, joy_color = rgb(logo["color"]), rgb(logo["joyColor"])
    require(main_color == "#000000" and joy_color == "#c2381a", "Header colors changed")
    font, webfont = TTFont(FONT), TTFont(args.webfont)
    require(font["OS/2"].usWeightClass == 800, "Wrong static font weight")
    if "fvar" in webfont:
        webfont = instantiateVariableFont(webfont, {"wght": 800}, inplace=False)
    layout = geometry(font)
    require(layout == geometry(webfont), "Real next/font and committed TTF outlines/kerning differ")
    webfont_sha = sha256(args.webfont.read_bytes())
    require(browser["fontResource"]["sha256"] == webfont_sha, "Browser font hash mismatch")
    scale = 20 / layout["unitsPerEm"]
    # Pack, Joy and U are three inline text runs, each quantized to 1/64 CSS px.
    width_delta = logo["width"] - layout["advance"] * scale
    require(abs(width_delta) <= 3 / 64, "Browser wordmark width mismatch")
    require(len(logo["characterLefts"]) == 8, "Missing browser character positions")
    require(all(abs(actual - row["x"] * scale) <= 1 / 32
                for actual, row in zip(logo["characterLefts"], layout["glyphs"])),
            "Browser character positions differ from kerned glyphs")
    svg, view_box = build_svg(font, layout, main_color, joy_color)
    audit = {
        "task": "M1-T3", "scope": "Current SiteHeader complete wordmark; icon is provenance only",
        "sourceFiles": [{"path": path, "sha256": sha256(data)} for path, data in source.items()],
        "export": {"path": MASTER.relative_to(ROOT).as_posix(), "sha256": sha256(svg), "viewBox": view_box,
                   "format": "SVG; eight outlined paths; no text/font/script/external references/metadata"},
        "font": {"path": FONT.relative_to(ROOT).as_posix(), "weight": 800, "unitsPerEm": layout["unitsPerEm"],
                 "version": font["name"].getDebugName(5), "webfontSha256": webfont_sha,
                 "browserFontUrl": browser["fontResource"]["url"], "exactOutlineAdvanceKerningMatch": True},
        "styleSources": {"wordmark": "src/components/layout/SiteHeader.tsx:56",
                         "weightSizeJoyStyle": "src/app/globals.css:14",
                         "mainColorCascade": "src/app/globals.css:330; src/styles/tokens.css:29",
                         "joyColor": "src/styles/tokens.css:6",
                         "fontFamily": "src/app/[locale]/layout.tsx:20,57; src/app/globals.css:8"},
        "geometry": {key: value for key, value in layout.items() if key != "glyphs"},
        "glyphPositions": [{key: value for key, value in row.items() if key != "outline"}
                           for row in layout["glyphs"]],
        "colors": {"PackAndU": main_color, "Joy": joy_color},
        "browserVerification": {"evidencePath": browser_path, "evidenceSha256": sha256(browser_bytes),
                                "webfontPath": webfont_path, "pageUrl": browser["pageUrl"],
                                "widthDeltaPx": width_delta, "widthTolerancePx": 3 / 64,
                                "widthToleranceBasis": "Three inline runs; each quantized to 1/64 CSS px",
                                "computedStylesAndPositions": logo},
        "license": {"path": "src/assets/og-fonts/OFL.txt", "name": "SIL Open Font License 1.1",
                    "output": "Outlined wordmark artwork; no font software embedded or redistributed by this export",
                    "basis": "OFL preamble and condition 5 exclude documents created using the font from font-license requirements"},
        "reproduction": "python docs/brand-media/static/export-logo-master.py --webfont <captured-latin.woff2> --browser-evidence <header.json> [--write]",
        "exporter": {"path": "docs/brand-media/static/export-logo-master.py", "fontToolsVersion": fontTools.__version__},
    }
    audit_bytes = (json.dumps(audit, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    if args.write:
        MASTER.parent.mkdir(parents=True, exist_ok=True)
        MASTER.write_bytes(svg)
        AUDIT.write_bytes(audit_bytes)
    else:
        require(MASTER.read_bytes() == svg, "Master differs from reproducible export")
        require(AUDIT.read_bytes() == audit_bytes, "Source audit differs from current source/browser evidence")
    print(json.dumps({"mode": "write" if args.write else "check", "masterSha256": sha256(svg),
                      "viewBox": view_box, "browserFontMatch": True, "safeSvg": True}))


if __name__ == "__main__":
    run()
