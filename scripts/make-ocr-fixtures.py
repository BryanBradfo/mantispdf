#!/usr/bin/env python3
"""Regenerate the OCR PDF e2e fixtures in e2e/fixtures/ (needs Pillow and DejaVu Sans).

    python3 scripts/make-ocr-fixtures.py

Output (deterministic):
  scan.pdf          one US Letter page: a 300 dpi grayscale scan image of two lines of text,
                    no text layer
  scan-mixed.pdf    p1 real Helvetica text (more than 20 characters), p2 the scan of scan.pdf
  scan-long.pdf     12 pages, each the scan of scan.pdf (one shared image): a run long enough
                    to cancel mid-way
  scan-rotated.pdf  one page, MediaBox [0 0 612 792], CropBox [36 36 576 756], /Rotate 90: shown
                    landscape 720 x 540 pt, with an upright scan of the visible page
  ocr-expected.json per fixture and page, the words drawn on the scans with their ink boxes in
                    visible space (points, origin bottom-left of the page as displayed,
                    [x, y, w, h]) and their baseline y
"""
import json
import zlib
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent.parent / "e2e" / "fixtures"
DPI = 300
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
# (text, font size pt, left x pt, baseline y pt) in visible space.
LINES = [
    ("MANTIS OCR TEST 2026", 36, 72, 0),
    ("SEARCHABLE SCANNED PAGE", 24, 72, -60),
]


def px(pt: float) -> float:
    return pt * DPI / 72


def scan(width_pt: float, height_pt: float, top_baseline_pt: float):
    """A white gray image of the visible page with LINES drawn (first baseline at
    `top_baseline_pt`), and the words' boxes in visible points."""
    w, h = round(px(width_pt)), round(px(height_pt))
    im = Image.new("L", (w, h), 255)
    draw = ImageDraw.Draw(im)
    words = []
    for text, size_pt, x_pt, dy in LINES:
        font = ImageFont.truetype(FONT, round(px(size_pt)))
        baseline_px = h - px(top_baseline_pt + dy)
        x0 = px(x_pt)
        # anchor "ls": x at the left, y at the baseline.
        draw.text((x0, baseline_px), text, font=font, fill=0, anchor="ls")
        offset = 0
        for word in text.split(" "):
            start = text.index(word, offset)
            offset = start + len(word)
            left = x0 + draw.textlength(text[:start], font=font)
            # The ink box, from pixels (textbbox spans the advance, not the ink, horizontally).
            ink = Image.new("L", (w, h), 0)
            ImageDraw.Draw(ink).text((left, baseline_px), word, font=font, fill=255, anchor="ls")
            l, t, r, b = ink.getbbox()
            words.append({
                "text": word,
                "box": [round(l * 72 / DPI, 2), round((h - b) * 72 / DPI, 2), round((r - l) * 72 / DPI, 2), round((b - t) * 72 / DPI, 2)],
                "baseline": round(top_baseline_pt + dy, 2),
            })
    return im, words


def stream(dict_body: bytes, data: bytes) -> bytes:
    return b"<< " + dict_body + b" /Length %d >>\nstream\n" % len(data) + data + b"\nendstream"


def image_xobject(im: Image.Image) -> bytes:
    data = zlib.compress(im.tobytes(), 9)
    return stream(b"/Type /XObject /Subtype /Image /Width %d /Height %d /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode" % im.size, data)


def write_pdf(path: Path, pages: list) -> None:
    """`pages`: dicts with `box` (page dictionary entries), `content` and optional `image`."""
    objects = [b"<< /Type /Catalog /Pages 2 0 R >>", None, b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"]
    kids = []
    # One image object per distinct image, shared by the pages drawing it.
    image_ids = {}
    for page in pages:
        resources = b"/Font << /F1 3 0 R >>"
        if "image" in page:
            if id(page["image"]) not in image_ids:
                objects.append(image_xobject(page["image"]))
                image_ids[id(page["image"])] = len(objects)
            resources += b" /XObject << /Im1 %d 0 R >>" % image_ids[id(page["image"])]
        objects.append(stream(b"", page["content"]))
        content = len(objects)
        objects.append(b"<< /Type /Page /Parent 2 0 R " + page["box"] + b" /Resources << " + resources + b" >> /Contents %d 0 R >>" % content)
        kids.append(b"%d 0 R" % len(objects))
    objects[1] = b"<< /Type /Pages /Kids [" + b" ".join(kids) + b"] /Count %d >>" % len(kids)
    out = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for i, body in enumerate(objects, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % i + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    for o in offsets:
        out += b"%010d 00000 n \n" % o
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, xref)
    path.write_bytes(bytes(out))


def main() -> None:
    letter = b"/MediaBox [0 0 612 792]"
    full_page = b"q 612 0 0 792 0 0 cm /Im1 Do Q\n"
    im, words = scan(612, 792, 650)
    expected = {"scan.pdf": {"1": words}, "scan-mixed.pdf": {"2": words}}
    write_pdf(OUT / "scan.pdf", [{"box": letter, "content": full_page, "image": im}])
    real_text = b"BT /F1 14 Tf 72 700 Td (This page already has real text on it.) Tj ET\n"
    write_pdf(OUT / "scan-mixed.pdf", [
        {"box": letter, "content": real_text},
        {"box": letter, "content": full_page, "image": im},
    ])
    write_pdf(OUT / "scan-long.pdf", [{"box": letter, "content": full_page, "image": im}] * 12)
    # Rotate 90 over CropBox [36 36 576 756]: visible is 720 x 540 and visible (x, y) is user
    # (576 - y, 36 + x), so the upright visible image is drawn with that matrix.
    rot_im, rot_words = scan(720, 540, 420)
    expected["scan-rotated.pdf"] = {"1": rot_words}
    write_pdf(OUT / "scan-rotated.pdf", [{
        "box": b"/MediaBox [0 0 612 792] /CropBox [36 36 576 756] /Rotate 90",
        "content": b"q 0 720 -540 0 576 36 cm /Im1 Do Q\n",
        "image": rot_im,
    }])
    (OUT / "ocr-expected.json").write_text(json.dumps(expected, indent=2) + "\n")
    for name in ("scan.pdf", "scan-mixed.pdf", "scan-long.pdf", "scan-rotated.pdf", "ocr-expected.json"):
        print(f"wrote {OUT / name} ({(OUT / name).stat().st_size} bytes)")


if __name__ == "__main__":
    main()
