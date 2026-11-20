#!/usr/bin/env python3
"""Regenerate the Compare e2e/unit fixtures in e2e/fixtures/ (needs pypdf).

    python3 scripts/make-compare-fixtures.py

Outputs (deterministic):
  compare-a.pdf     original: 2 pages (US Letter)
  compare-b.pdf     modified: a replaced word (quick -> swift), an added sentence, a removed line,
                    a moved paragraph, and one extra page (3 pages)
  compare-scan.pdf  1 page, a single image and no text (like a scan)
"""
import zlib
from pathlib import Path

from pypdf import PdfWriter
from pypdf.generic import (
    ArrayObject, DecodedStreamObject, DictionaryObject, NameObject, NumberObject,
)

OUT = Path(__file__).resolve().parent.parent / "e2e" / "fixtures"

A_PAGE1 = [
    "Compare Fixture",
    "The quick brown fox jumps over the lazy dog.",
    "This line will be removed in the modified copy.",
    "Paragraph one stays near the top of the page.",
    "Paragraph two moves to the bottom later.",
]
A_PAGE2 = ["Second page keeps the same words in both files."]

B_PAGE1 = [
    "Compare Fixture",
    "The swift brown fox jumps over the lazy dog.",
    "This sentence was added in the modified copy.",
    "Paragraph one stays near the top of the page.",
]
B_PAGE2 = ["Second page keeps the same words in both files.", "Paragraph two moves to the bottom later."]
B_PAGE3 = ["Third page exists only in the modified copy."]


def esc(s: str) -> str:
    return s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def add_text_page(w: PdfWriter, font, lines):
    page = w.add_blank_page(width=612, height=792)
    ops = ["BT /F1 14 Tf 18 TL 72 700 Td"]
    for line in lines:
        ops.append(f"({esc(line)}) Tj T*")
    ops.append("ET")
    stream = DecodedStreamObject()
    stream.set_data("\n".join(ops).encode("latin-1"))
    page[NameObject("/Contents")] = w._add_object(stream)
    page[NameObject("/Resources")] = DictionaryObject({NameObject("/Font"): DictionaryObject({NameObject("/F1"): font})})


def new_writer():
    w = PdfWriter()
    font = w._add_object(DictionaryObject({
        NameObject("/Type"): NameObject("/Font"),
        NameObject("/Subtype"): NameObject("/Type1"),
        NameObject("/BaseFont"): NameObject("/Helvetica"),
    }))
    return w, font


def write(w: PdfWriter, name: str):
    w.add_metadata({"/Producer": "mantispdf fixtures"})
    path = OUT / name
    w.write(str(path))
    print(f"wrote {path}")


def make_text(name, pages):
    w, font = new_writer()
    for lines in pages:
        add_text_page(w, font, lines)
    write(w, name)


def make_scan(name):
    w = PdfWriter()
    page = w.add_blank_page(width=612, height=792)
    pixels = bytes((x * 8 + y * 4) % 256 for y in range(32) for x in range(32))
    img = DecodedStreamObject()
    img.set_data(zlib.compress(pixels))
    img[NameObject("/Filter")] = NameObject("/FlateDecode")
    img.update({
        NameObject("/Type"): NameObject("/XObject"),
        NameObject("/Subtype"): NameObject("/Image"),
        NameObject("/Width"): NumberObject(32),
        NameObject("/Height"): NumberObject(32),
        NameObject("/ColorSpace"): NameObject("/DeviceGray"),
        NameObject("/BitsPerComponent"): NumberObject(8),
    })
    # set_data wrote raw bytes; mark them as already compressed
    img._data = zlib.compress(pixels)
    content = DecodedStreamObject()
    content.set_data(b"q 400 0 0 400 106 196 cm /Im1 Do Q")
    page[NameObject("/Contents")] = w._add_object(content)
    page[NameObject("/Resources")] = DictionaryObject({
        NameObject("/XObject"): DictionaryObject({NameObject("/Im1"): w._add_object(img)})
    })
    write(w, name)


make_text("compare-a.pdf", [A_PAGE1, A_PAGE2])
make_text("compare-b.pdf", [B_PAGE1, B_PAGE2, B_PAGE3])
make_scan("compare-scan.pdf")
