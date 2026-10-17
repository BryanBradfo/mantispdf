"""Generate e2e/fixtures/margins.pdf: 2 Letter pages, each with a black filled rectangle
from (100,150) to (400,600) pt (300 x 450 pt), for the crop auto-detect test.

Raw PDF writing, no dependencies. The output path is resolved from this file:

    python3 scripts/make-margins-fixture.py
"""
from pathlib import Path

content = b"0 g 100 150 300 450 re f"
objs = [
    b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
]
for _ in range(2):
    objs.append(b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R /Resources << >> >>")
objs.append(b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream")

out = bytearray(b"%PDF-1.4\n")
offsets = []
for i, body in enumerate(objs, 1):
    offsets.append(len(out))
    out += b"%d 0 obj\n" % i + body + b"\nendobj\n"
xref = len(out)
out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
for o in offsets:
    out += b"%010d 00000 n \n" % o
out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)

OUT = Path(__file__).resolve().parent.parent / "e2e" / "fixtures" / "margins.pdf"
OUT.write_bytes(bytes(out))
print(f"wrote {OUT}")
