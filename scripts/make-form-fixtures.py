#!/usr/bin/env python3
"""Write the Fill PDF form e2e fixtures to e2e/fixtures/ (needs reportlab and
pypdf). Output is deterministic (reportlab invariant mode). Every field uses
Helvetica: reportlab writes a second /Font key into /DR otherwise.

  form.pdf        2 pages, AcroForm made by reportlab:
                    page 1: full_name (text), notes (multiline), pin (comb,
                            MaxLen 6), agree (checkbox), color (radio: red,
                            green, blue), country (combo, "France"), fruits
                            (multi-select list, "Banana" selected), ref_code (read-only, value "MP-2026"),
                            vertical (text, widget /MK /R 90)
                    page 2: comments (text), secret (password)
  xfa-pure.pdf    1 page, /AcroForm with /XFA and empty /Fields (stdlib)
  xfa-hybrid.pdf  1 page, /AcroForm with /XFA and one text field "name" (stdlib)

Run: python3 -I scripts/make-form-fixtures.py
"""
import io
import os

from pypdf import PdfReader, PdfWriter
from pypdf.generic import ArrayObject, DictionaryObject, NameObject, NumberObject
from reportlab.lib.colors import black, white
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "e2e", "fixtures")


def label(c, x, y, text):
    c.setFont("Helvetica", 10)
    c.drawString(x, y, text)


def form_pdf() -> bytes:
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4, invariant=1)
    f = c.acroForm
    common = dict(borderColor=black, fillColor=white, textColor=black, forceBorder=True)
    # reportlab gives every text field /MaxLen 100 unless told otherwise.
    free = dict(maxlen=None)
    c.setFont("Helvetica-Bold", 14)
    c.drawString(50, 800, "MantisPDF form fixture, page 1")

    label(c, 50, 765, "Full name")
    f.textfield(**free, name="full_name", tooltip="Full name", x=150, y=755, width=250, height=22, fontName="Helvetica", fontSize=12, **common)

    label(c, 50, 725, "Notes")
    f.textfield(**free, name="notes", tooltip="Notes", x=150, y=660, width=250, height=75, fontName="Helvetica", fontSize=10,
                fieldFlags="multiline", **common)

    label(c, 50, 630, "PIN")
    f.textfield(name="pin", tooltip="PIN", x=150, y=620, width=150, height=22, fontName="Helvetica", fontSize=14,
                maxlen=6, fieldFlags="comb", **common)

    label(c, 50, 590, "I agree")
    f.checkbox(name="agree", tooltip="I agree", x=150, y=585, size=16, buttonStyle="check", checked=False, **common)

    label(c, 50, 550, "Colour")
    for i, value in enumerate(["red", "green", "blue"]):
        f.radio(name="color", tooltip="Colour", value=value, selected=False, x=150 + 60 * i, y=545, size=16,
                buttonStyle="circle", shape="circle", **common)
        label(c, 170 + 60 * i, 549, value)

    label(c, 50, 510, "Country")
    f.choice(name="country", tooltip="Country", value="France", options=["France", "Germany", "Spain"],
             x=150, y=500, width=150, height=22, fontName="Helvetica", fontSize=11, **common)

    label(c, 50, 470, "Fruits")
    f.listbox(name="fruits", tooltip="Fruits", value=["Banana"], options=["Apple", "Banana", "Cherry", "Date"],
              x=150, y=400, width=150, height=80, fontName="Helvetica", fontSize=11, fieldFlags="multiSelect", **common)

    label(c, 50, 370, "Reference")
    f.textfield(**free, name="ref_code", tooltip="Reference", value="MP-2026", x=150, y=360, width=150, height=22,
                fontName="Helvetica", fontSize=12, fieldFlags="readOnly", **common)

    label(c, 450, 520, "Vertical")
    f.textfield(**free, name="vertical", tooltip="Vertical", x=460, y=360, width=24, height=150, fontName="Helvetica",
                fontSize=12, **common)
    c.showPage()

    c.setFont("Helvetica-Bold", 14)
    c.drawString(50, 800, "MantisPDF form fixture, page 2")
    label(c, 50, 765, "Comments")
    f.textfield(**free, name="comments", tooltip="Comments", x=150, y=755, width=300, height=22, fontName="Helvetica",
                fontSize=12, **common)
    label(c, 50, 725, "Password")
    f.textfield(**free, name="secret", tooltip="Password", x=150, y=715, width=150, height=22, fontName="Helvetica",
                fontSize=12, fieldFlags="password", **common)
    c.showPage()
    c.save()

    # reportlab cannot set /MK /R: turn the "vertical" widget a quarter turn.
    reader = PdfReader(io.BytesIO(buf.getvalue()))
    writer = PdfWriter(clone_from=reader)
    for annot in writer.pages[0].get("/Annots", []):
        w = annot.get_object()
        if w.get("/T") == "vertical":
            mk = w.get("/MK")
            mk = mk.get_object() if mk is not None else DictionaryObject()
            mk[NameObject("/R")] = NumberObject(90)
            w[NameObject("/MK")] = mk
            # Drop reportlab's upright appearance: the engine regenerates it turned.
            if "/AP" in w:
                del w["/AP"]
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


def raw_pdf(objs: dict) -> bytes:
    out = bytearray(b"%PDF-1.7\n")
    offsets = {}
    for n in sorted(objs):
        offsets[n] = len(out)
        out += b"%d 0 obj\n" % n + objs[n] + b"\nendobj\n"
    xref = len(out)
    size = max(objs) + 1
    out += b"xref\n0 %d\n" % size + b"0000000000 65535 f \n"
    for n in range(1, size):
        out += b"%010d 00000 n \n" % offsets[n] if n in offsets else b"0000000000 65535 f \n"
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (size, xref)
    return bytes(out)


def stream(body: bytes, extra: bytes = b"") -> bytes:
    return b"<< " + extra + b" /Length %d >>\nstream\n" % len(body) + body + b"\nendstream"


XDP = b'<?xml version="1.0"?><xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/"><template/></xdp:xdp>'


def xfa_pdf(hybrid: bool) -> bytes:
    fields = b"[6 0 R]" if hybrid else b"[]"
    annots = b" /Annots [6 0 R]" if hybrid else b""
    objs = {
        1: b"<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields " + fields + b" /XFA 5 0 R /DA (/Helv 12 Tf 0 g) /DR << /Font << /Helv 4 0 R >> >> >> >>",
        2: b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        3: b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R" + annots + b" >>",
        4: b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        5: stream(XDP),
        7: stream(b"BT /F1 14 Tf 20 160 Td (" + (b"XFA hybrid form" if hybrid else b"XFA form") + b") Tj ET"),
    }
    if hybrid:
        objs[6] = b"<< /Type /Annot /Subtype /Widget /FT /Tx /T (name) /Rect [20 100 200 125] /P 3 0 R /F 4 /DA (/Helv 12 Tf 0 g) >>"
    return raw_pdf(objs)


def write(name: str, data: bytes) -> None:
    dest = os.path.normpath(os.path.join(OUT, name))
    with open(dest, "wb") as f:
        f.write(data)
    print("wrote", dest)


write("form.pdf", form_pdf())
write("xfa-pure.pdf", xfa_pdf(False))
write("xfa-hybrid.pdf", xfa_pdf(True))
