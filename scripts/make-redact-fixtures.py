#!/usr/bin/env python3
"""Regenerate the Redact PDF e2e fixture in e2e/fixtures/ (needs Pillow).

    python3 scripts/make-redact-fixtures.py

Output (deterministic): redact.pdf, four US Letter pages, Helvetica (WinAnsi) text.
  p1  three lines at x 72:
        y 720  "Account number: 4417 1234 5678 9113"
        y 700  "JOHN SMITH, a tall man"
        y 680  "Public line stays"
      a 80x40 px red/blue JPEG (DCTDecode) drawn 160x80 at (72, 520),
      a 4x4 px gradient Flate RGB image drawn 80x80 at (300, 520),
      a blue filled rectangle 200x60 at (72, 400)
  p2  "Page two text" at (72, 720) and form Fm1 at (72, 600):
      "Form secret: CONFIDENTIAL" (the form has its own /Resources)
  p3  "Page three text" at (72, 720) and the same Fm1 object at (72, 500)
  p4  "Type3 page" at (72, 720) and "abc" in a Type3 font (filled squares) at (72, 600):
      the engine cannot redact this page in place, it is rasterized
"""
import io
import zlib
from pathlib import Path

from PIL import Image

OUT = Path(__file__).resolve().parent.parent / "e2e" / "fixtures"


def stream(dict_body: bytes, data: bytes) -> bytes:
    return b"<< " + dict_body + b" /Length %d >>\nstream\n" % len(data) + data + b"\nendstream"


def make_jpeg() -> bytes:
    im = Image.new("RGB", (80, 40))
    im.paste((220, 30, 30), (0, 0, 40, 40))
    im.paste((30, 30, 220), (40, 0, 80, 40))
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=95)
    return buf.getvalue()


def make_pdf(jpeg: bytes) -> bytes:
    gradient = bytes(v for y in range(4) for x in range(4) for v in (x * 80, y * 80, 128))
    flate = zlib.compress(gradient, 9)
    page1 = (
        b"BT /F1 12 Tf 72 720 Td (Account number: 4417 1234 5678 9113) Tj ET\n"
        b"BT /F1 12 Tf 72 700 Td (JOHN SMITH, a tall man) Tj ET\n"
        b"BT /F1 12 Tf 72 680 Td (Public line stays) Tj ET\n"
        b"q 160 0 0 80 72 520 cm /Im1 Do Q\n"
        b"q 80 0 0 80 300 520 cm /Im2 Do Q\n"
        b"q 0 0 1 rg 72 400 200 60 re f Q"
    )
    page2 = b"BT /F1 12 Tf 72 720 Td (Page two text) Tj ET\nq 1 0 0 1 72 600 cm /Fm1 Do Q"
    page3 = b"BT /F1 12 Tf 72 720 Td (Page three text) Tj ET\nq 1 0 0 1 72 500 cm /Fm1 Do Q"
    page4 = b"BT /F1 12 Tf 72 720 Td (Type3 page) Tj ET\nBT /T3 24 Tf 72 600 Td (abc) Tj ET"
    form = b"BT /F1 12 Tf 0 0 Td (Form secret: CONFIDENTIAL) Tj ET"
    square = b"750 0 0 0 750 750 d1 0 0 750 750 re f"
    font_res = b"/Font << /F1 5 0 R >>"
    objs = {
        1: b"<< /Type /Catalog /Pages 2 0 R >>",
        2: b"<< /Type /Pages /Kids [6 0 R 7 0 R 8 0 R 9 0 R] /Count 4 /MediaBox [0 0 612 792] >>",
        5: b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
        6: b"<< /Type /Page /Parent 2 0 R /Contents 10 0 R /Resources << " + font_res
           + b" /XObject << /Im1 14 0 R /Im2 15 0 R >> >> >>",
        7: b"<< /Type /Page /Parent 2 0 R /Contents 11 0 R /Resources << " + font_res + b" /XObject << /Fm1 16 0 R >> >> >>",
        8: b"<< /Type /Page /Parent 2 0 R /Contents 12 0 R /Resources << " + font_res + b" /XObject << /Fm1 16 0 R >> >> >>",
        9: b"<< /Type /Page /Parent 2 0 R /Contents 13 0 R /Resources << /Font << /F1 5 0 R /T3 17 0 R >> >> >>",
        10: stream(b"", page1),
        11: stream(b"", page2),
        12: stream(b"", page3),
        13: stream(b"", page4),
        14: stream(b"/Type /XObject /Subtype /Image /Width 80 /Height 40 /ColorSpace /DeviceRGB "
                   b"/BitsPerComponent 8 /Filter /DCTDecode", jpeg),
        15: stream(b"/Type /XObject /Subtype /Image /Width 4 /Height 4 /ColorSpace /DeviceRGB "
                   b"/BitsPerComponent 8 /Filter /FlateDecode", flate),
        16: stream(b"/Type /XObject /Subtype /Form /BBox [0 -10 400 30] /Resources << " + font_res + b" >>", form),
        17: b"<< /Type /Font /Subtype /Type3 /FontMatrix [0.001 0 0 0.001 0 0] /FontBBox [0 0 750 750] "
            b"/FirstChar 97 /LastChar 99 /Widths [750 750 750] "
            b"/Encoding << /Type /Encoding /Differences [97 /a /b /c] >> "
            b"/CharProcs << /a 18 0 R /b 18 0 R /c 18 0 R >> /Resources << >> >>",
        18: stream(b"", square),
    }
    out = bytearray(b"%PDF-1.7\n")
    offsets = {}
    size = max(objs) + 1
    for n in sorted(objs):
        offsets[n] = len(out)
        out += b"%d 0 obj\n" % n + objs[n] + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % size
    for n in range(1, size):
        out += b"%010d 00000 n \n" % offsets[n] if n in offsets else b"0000000000 65535 f \n"
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (size, xref)
    return bytes(out)


def main() -> None:
    (OUT / "redact.pdf").write_bytes(make_pdf(make_jpeg()))


if __name__ == "__main__":
    main()
