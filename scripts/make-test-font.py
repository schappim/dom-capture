"""Builds test/fixtures/localfont.woff2: a tiny original font (every glyph is a
plain box of a different height) so tests can exercise real web-font loading
without shipping anyone else's typeface.  Needs: pip install fonttools brotli"""
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

chars = "abcdefghijklmnopqrstuvwxyz0123456789"
names = [".notdef", "space"] + [f"g{ord(c):02x}" for c in chars]

def box(height):
    pen = TTGlyphPen(None)
    pen.moveTo((80, 0)); pen.lineTo((80, height)); pen.lineTo((520, height)); pen.lineTo((520, 0)); pen.closePath()
    return pen.glyph()

fb = FontBuilder(1000, isTTF=True)
fb.setupGlyphOrder(names)
fb.setupCharacterMap({32: "space", **{ord(c): f"g{ord(c):02x}" for c in chars}})
glyphs = {".notdef": box(700), "space": TTGlyphPen(None).glyph()}
for i, c in enumerate(chars):
    glyphs[f"g{ord(c):02x}"] = box(300 + (i * 37) % 450)
fb.setupGlyf(glyphs)
fb.setupHorizontalMetrics({n: (600, 80) for n in names})
fb.setupHorizontalHeader(ascent=800, descent=-200)
fb.setupNameTable({"familyName": "DOM Capture Test Boxes", "styleName": "Regular"})
fb.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWinAscent=800, usWinDescent=200)
fb.setupPost()
fb.font.flavor = "woff2"
fb.save("test/fixtures/localfont.woff2")
print("wrote test/fixtures/localfont.woff2")
