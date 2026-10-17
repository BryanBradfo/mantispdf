"""Generate e2e/fixtures/rotated.pdf: 4 pages with /Rotate 0/90/180/270 and text R0..R270."""
from pypdf import PdfWriter
from pypdf.generic import NameObject, DictionaryObject, DecodedStreamObject, ArrayObject, NumberObject

w = PdfWriter()
font = w._add_object(DictionaryObject({
    NameObject("/Type"): NameObject("/Font"),
    NameObject("/Subtype"): NameObject("/Type1"),
    NameObject("/BaseFont"): NameObject("/Helvetica"),
}))
for rot in (0, 90, 180, 270):
    page = w.add_blank_page(width=612, height=792)
    stream = DecodedStreamObject()
    stream.set_data(f"BT /F1 24 Tf 200 400 Td (R{rot}) Tj ET".encode())
    page[NameObject("/Contents")] = w._add_object(stream)
    page[NameObject("/Resources")] = DictionaryObject({
        NameObject("/Font"): DictionaryObject({NameObject("/F1"): font})
    })
    page[NameObject("/Rotate")] = NumberObject(rot)
w.write("e2e/fixtures/rotated.pdf")
