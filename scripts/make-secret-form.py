#!/usr/bin/env python3
"""Write e2e/fixtures/secret-form.pdf (stdlib only): a 2-page PDF used by the
document-tool leak regression. Streams are uncompressed on purpose so raw-byte
checks for the marker strings are meaningful.

  page 1: text KEEPPAGE, text widget (child of field "grp")
  page 2: text DROPPAGE, sibling widget with /V (SECRETFIELD) and AP "SECRETAP"
  Info /Title (SECRETTITLE)

Run: python3 -I scripts/make-secret-form.py
"""
import os

def stream(body: str) -> bytes:
    b = body.encode("latin1")
    return b"<< /Length %d >>\nstream\n" % len(b) + b + b"\nendstream"

objs = {
    1: b"<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [7 0 R] /DA (/Helv 12 Tf 0 g) /DR << /Font << /Helv 5 0 R >> >> >> >>",
    2: b"<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    3: b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 10 0 R /Resources << /Font << /F1 5 0 R >> >> /Annots [8 0 R] >>",
    4: b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 11 0 R /Resources << /Font << /F1 5 0 R >> >> /Annots [9 0 R] >>",
    5: b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    6: b"<< /Title (SECRETTITLE) /Author (SECRETAUTHOR) >>",
    7: b"<< /FT /Tx /T (grp) /Kids [8 0 R 9 0 R] >>",
    8: b"<< /Type /Annot /Subtype /Widget /Parent 7 0 R /T (a) /Rect [20 100 150 130] /P 3 0 R /F 4 /DA (/Helv 12 Tf 0 g) >>",
    9: b"<< /Type /Annot /Subtype /Widget /Parent 7 0 R /T (b) /V (SECRETFIELD) /Rect [20 100 150 130] /P 4 0 R /F 4 /DA (/Helv 12 Tf 0 g) /AP << /N 12 0 R >> >>",
    10: stream("BT /F1 18 Tf 20 160 Td (KEEPPAGE) Tj ET"),
    11: stream("BT /F1 18 Tf 20 160 Td (DROPPAGE) Tj ET"),
    12: stream("BT /F1 12 Tf 2 8 Td (SECRETAP) Tj ET").replace(
        b"<< /Length", b"<< /Type /XObject /Subtype /Form /BBox [0 0 130 30] /Resources << /Font << /F1 5 0 R >> >> /Length", 1),
}

out = bytearray(b"%PDF-1.7\n")
offsets = {}
for n in sorted(objs):
    offsets[n] = len(out)
    out += b"%d 0 obj\n" % n + objs[n] + b"\nendobj\n"
xref = len(out)
size = max(objs) + 1
out += b"xref\n0 %d\n" % size + b"0000000000 65535 f \n"
for n in range(1, size):
    out += b"%010d 00000 n \n" % offsets[n]
out += b"trailer\n<< /Size %d /Root 1 0 R /Info 6 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (size, xref)

dest = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "e2e", "fixtures", "secret-form.pdf")
with open(dest, "wb") as f:
    f.write(out)
print("wrote", os.path.normpath(dest))
