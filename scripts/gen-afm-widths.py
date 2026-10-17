#!/usr/bin/env python3
"""Generate crates/mantis-wasm/src/stamp/afm_widths.rs from Adobe core AFMs.

Usage: scripts/gen-afm-widths.py <dir with Helvetica.afm, Helvetica-Bold.afm,
Times-Roman.afm, Courier.afm> [--ts src/lib/editor/afmWidths.ts]
> crates/mantis-wasm/src/stamp/afm_widths.rs

With --ts, the same tables are also written as TypeScript to the given path
(the editor preview wraps text with them exactly like the engine).

AFM "C" codes use StandardEncoding, so widths are looked up by glyph NAME
using the PDF WinAnsiEncoding glyph-name table below (codes 32..255).
Only the standard library is needed.
"""
import re
import sys
import textwrap
from pathlib import Path

FONTS = ["Helvetica", "Helvetica-Bold", "Times-Roman", "Courier"]

# WinAnsiEncoding glyph names, code -> name. Unused codes 127/129/141/143/144/157
# are bullet and 160/173 are space/hyphen, as in the PDF specification.
WINANSI = {
    32: 'space', 33: 'exclam', 34: 'quotedbl', 35: 'numbersign', 36: 'dollar', 37: 'percent',
    38: 'ampersand', 39: 'quotesingle', 40: 'parenleft', 41: 'parenright', 42: 'asterisk',
    43: 'plus', 44: 'comma', 45: 'hyphen', 46: 'period', 47: 'slash', 48: 'zero', 49: 'one',
    50: 'two', 51: 'three', 52: 'four', 53: 'five', 54: 'six', 55: 'seven', 56: 'eight',
    57: 'nine', 58: 'colon', 59: 'semicolon', 60: 'less', 61: 'equal', 62: 'greater',
    63: 'question', 64: 'at', 91: 'bracketleft', 92: 'backslash', 93: 'bracketright',
    94: 'asciicircum', 95: 'underscore', 96: 'grave', 123: 'braceleft', 124: 'bar',
    125: 'braceright', 126: 'asciitilde', 127: 'bullet', 128: 'Euro', 129: 'bullet',
    130: 'quotesinglbase', 131: 'florin', 132: 'quotedblbase', 133: 'ellipsis',
    134: 'dagger', 135: 'daggerdbl', 136: 'circumflex', 137: 'perthousand', 138: 'Scaron',
    139: 'guilsinglleft', 140: 'OE', 141: 'bullet', 142: 'Zcaron', 143: 'bullet',
    144: 'bullet', 145: 'quoteleft', 146: 'quoteright', 147: 'quotedblleft',
    148: 'quotedblright', 149: 'bullet', 150: 'endash', 151: 'emdash', 152: 'tilde',
    153: 'trademark', 154: 'scaron', 155: 'guilsinglright', 156: 'oe', 157: 'bullet',
    158: 'zcaron', 159: 'Ydieresis', 160: 'space', 161: 'exclamdown', 162: 'cent',
    163: 'sterling', 164: 'currency', 165: 'yen', 166: 'brokenbar', 167: 'section',
    168: 'dieresis', 169: 'copyright', 170: 'ordfeminine', 171: 'guillemotleft',
    172: 'logicalnot', 173: 'hyphen', 174: 'registered', 175: 'macron', 176: 'degree',
    177: 'plusminus', 178: 'twosuperior', 179: 'threesuperior', 180: 'acute', 181: 'mu',
    182: 'paragraph', 183: 'periodcentered', 184: 'cedilla', 185: 'onesuperior',
    186: 'ordmasculine', 187: 'guillemotright', 188: 'onequarter', 189: 'onehalf',
    190: 'threequarters', 191: 'questiondown', 192: 'Agrave', 193: 'Aacute',
    194: 'Acircumflex', 195: 'Atilde', 196: 'Adieresis', 197: 'Aring', 198: 'AE',
    199: 'Ccedilla', 200: 'Egrave', 201: 'Eacute', 202: 'Ecircumflex', 203: 'Edieresis',
    204: 'Igrave', 205: 'Iacute', 206: 'Icircumflex', 207: 'Idieresis', 208: 'Eth',
    209: 'Ntilde', 210: 'Ograve', 211: 'Oacute', 212: 'Ocircumflex', 213: 'Otilde',
    214: 'Odieresis', 215: 'multiply', 216: 'Oslash', 217: 'Ugrave', 218: 'Uacute',
    219: 'Ucircumflex', 220: 'Udieresis', 221: 'Yacute', 222: 'Thorn', 223: 'germandbls',
    224: 'agrave', 225: 'aacute', 226: 'acircumflex', 227: 'atilde', 228: 'adieresis',
    229: 'aring', 230: 'ae', 231: 'ccedilla', 232: 'egrave', 233: 'eacute',
    234: 'ecircumflex', 235: 'edieresis', 236: 'igrave', 237: 'iacute', 238: 'icircumflex',
    239: 'idieresis', 240: 'eth', 241: 'ntilde', 242: 'ograve', 243: 'oacute',
    244: 'ocircumflex', 245: 'otilde', 246: 'odieresis', 247: 'divide', 248: 'oslash',
    249: 'ugrave', 250: 'uacute', 251: 'ucircumflex', 252: 'udieresis', 253: 'yacute',
    254: 'thorn', 255: 'ydieresis',
}
for _c in range(65, 91):
    WINANSI[_c] = chr(_c)
for _c in range(97, 123):
    WINANSI[_c] = chr(_c)


def parse(path):
    text = path.read_text(encoding="latin-1")
    notice = next(
        l[len("Comment "):].strip()
        for l in text.splitlines()
        if l.startswith("Comment Copyright")
    )
    asc = int(re.search(r"^Ascender (-?\d+)", text, re.M).group(1))
    desc = int(re.search(r"^Descender (-?\d+)", text, re.M).group(1))
    widths = {m.group(2): int(m.group(1)) for m in re.finditer(r"WX (\d+) ; N (\S+) ;", text)}
    return notice, asc, desc, widths


def load(root):
    """(notice, rows of 224 widths, (asc, desc) per font) in FONTS order."""
    notice, tables, metrics = None, [], []
    for i, name in enumerate(FONTS):
        font_notice, asc, desc, widths = parse(root / f"{name}.afm")
        if i == 0:
            notice = font_notice
        row = []
        for code in range(32, 256):
            glyph = WINANSI.get(code)
            if glyph not in widths:
                sys.exit(f"{name}: no glyph {glyph!r} for WinAnsi code {code}")
            row.append(widths[glyph])
        tables.append(row)
        metrics.append((asc, desc))
    return notice, tables, metrics


def rust(notice, tables, metrics):
    out = [
        "// @generated by scripts/gen-afm-widths.py. Do not edit.",
        "//",
        "// Glyph widths and vertical metrics (1/1000 em) of the PDF standard fonts,",
        "// indexed by WinAnsi code - 32 (codes 32..=255), from the Adobe core AFMs.",
        "// Order: Helvetica, Helvetica-Bold, Times-Roman, Courier.",
        "//",
        f"// AFM notice: {notice}",
    ]
    out.append("")
    out.append("pub(super) const WIDTHS: [[u16; 224]; 4] = [")
    for row in tables:
        body = textwrap.fill(", ".join(map(str, row)) + ",", width=96,
                             initial_indent="        ", subsequent_indent="        ")
        out.append("    [\n" + body + "\n    ],")
    out.append("];")
    out.append("")
    out.append("/// (ascender, descender) per font, in the same order as `WIDTHS`.")
    out.append("pub(super) const VMETRICS: [(i16, i16); 4] = [")
    for asc, desc in metrics:
        out.append(f"    ({asc}, {desc}),")
    out.append("];")
    return "\n".join(out)


def typescript(notice, tables, metrics):
    out = [
        "// @generated by scripts/gen-afm-widths.py --ts. Do not edit.",
        "//",
        "// Same tables as crates/mantis-wasm/src/stamp/afm_widths.rs: glyph widths and",
        "// vertical metrics (1/1000 em) of the PDF standard fonts, widths indexed by",
        "// WinAnsi code - 32 (codes 32..255), from the Adobe core AFMs.",
        "//",
        f"// AFM notice: {notice}",
        "",
        'import type { StdFont } from "../stampJob";',
        "",
        "export const AFM_WIDTHS: Readonly<Record<StdFont, readonly number[]>> = {",
    ]
    for name, row in zip(FONTS, tables):
        body = textwrap.fill(", ".join(map(str, row)) + ",", width=96,
                             initial_indent="    ", subsequent_indent="    ")
        out.append(f'  "{name}": [\n' + body + "\n  ],")
    out.append("};")
    out.append("")
    out.append("/** Ascender and descender (negative) per font. */")
    out.append("export const AFM_VMETRICS: Readonly<Record<StdFont, { ascender: number; descender: number }>> = {")
    for name, (asc, desc) in zip(FONTS, metrics):
        out.append(f'  "{name}": {{ ascender: {asc}, descender: {desc} }},')
    out.append("};")
    return "\n".join(out) + "\n"


def main():
    args = sys.argv[1:]
    ts_out = None
    if "--ts" in args:
        i = args.index("--ts")
        if i + 1 >= len(args):
            sys.exit(__doc__)
        ts_out = Path(args[i + 1])
        del args[i:i + 2]
    if len(args) != 1:
        sys.exit(__doc__)
    notice, tables, metrics = load(Path(args[0]))
    if ts_out is not None:
        ts_out.write_text(typescript(notice, tables, metrics), encoding="utf-8")
    print(rust(notice, tables, metrics))


main()
