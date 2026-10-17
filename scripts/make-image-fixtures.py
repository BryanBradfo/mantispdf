#!/usr/bin/env python3
"""Regenerate the image-tool e2e fixtures in e2e/fixtures/ (needs Pillow).

    python3 scripts/make-image-fixtures.py

Outputs (deterministic):
  photo-exif6.jpg  40x20 px, left half red, right half blue, EXIF orientation 6
  alpha.png        20x20, left half opaque green, right half fully transparent
  images.pdf       p1: the JPEG as a DCTDecode XObject
                   p2: a 2x2 Flate RGB image plus the same JPEG object again
"""
import io
import zlib
from pathlib import Path

from PIL import Image

OUT = Path(__file__).resolve().parent.parent / "e2e" / "fixtures"


def make_jpeg() -> bytes:
    im = Image.new("RGB", (40, 20))
    im.paste((255, 0, 0), (0, 0, 20, 20))
    im.paste((0, 0, 255), (20, 0, 40, 20))
    exif = Image.Exif()
    exif[0x0112] = 6
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=95, exif=exif.tobytes())
    return buf.getvalue()


def make_png() -> bytes:
    im = Image.new("RGBA", (20, 20), (0, 0, 0, 0))
    im.paste((0, 160, 0, 255), (0, 0, 10, 20))
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return buf.getvalue()


def make_pdf(jpeg: bytes) -> bytes:
    flate = zlib.compress(bytes([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]), 9)
    content1 = b"q 200 0 0 100 50 600 cm /Im1 Do Q"
    content2 = b"q 100 0 0 100 50 600 cm /Im2 Do Q q 200 0 0 100 50 400 cm /Im1 Do Q"
    objs = {
        1: b"<< /Type /Catalog /Pages 2 0 R >>",
        2: b"<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
        3: b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 800] /Contents 5 0 R "
           b"/Resources << /XObject << /Im1 7 0 R >> >> >>",
        4: b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 800] /Contents 6 0 R "
           b"/Resources << /XObject << /Im1 7 0 R /Im2 8 0 R >> >> >>",
        5: b"<< /Length %d >>\nstream\n" % len(content1) + content1 + b"\nendstream",
        6: b"<< /Length %d >>\nstream\n" % len(content2) + content2 + b"\nendstream",
        7: b"<< /Type /XObject /Subtype /Image /Width 40 /Height 20 /ColorSpace /DeviceRGB "
           b"/BitsPerComponent 8 /Filter /DCTDecode /Length %d >>\nstream\n" % len(jpeg) + jpeg + b"\nendstream",
        8: b"<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB "
           b"/BitsPerComponent 8 /Filter /FlateDecode /Length %d >>\nstream\n" % len(flate) + flate + b"\nendstream",
    }
    out = bytearray(b"%PDF-1.4\n")
    offsets = {}
    for n in sorted(objs):
        offsets[n] = len(out)
        out += b"%d 0 obj\n" % n + objs[n] + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
    for n in sorted(objs):
        out += b"%010d 00000 n \n" % offsets[n]
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)
    return bytes(out)


def main() -> None:
    jpeg = make_jpeg()
    (OUT / "photo-exif6.jpg").write_bytes(jpeg)
    (OUT / "alpha.png").write_bytes(make_png())
    (OUT / "images.pdf").write_bytes(make_pdf(jpeg))


if __name__ == "__main__":
    main()
