# pdf.ttf

`pdf.ttf` is the "GlyphLessFont" of Tesseract OCR (tesseract-ocr/tesseract,
`tessdata/pdf.ttf`), the font Tesseract embeds in its own searchable PDFs. It
has a single empty glyph, so text drawn with it is never visible; MantisPDF
uses it the same way for its OCR text layer.

- Source: https://github.com/tesseract-ocr/tesseract (copied byte for byte
  from the Debian/Ubuntu `libtesseract5` 5.3.4 package,
  `/usr/share/tesseract-ocr/5/tessdata/pdf.ttf`, 572 bytes,
  SHA-256 `c7845420925a23d88ed830a63957b8af85a66a8daf8d9fc90e843673b2ef1a59`).
- Copyright: 2006-2024 Google Inc.
- License: Apache License, Version 2.0,
  https://www.apache.org/licenses/LICENSE-2.0

Licensed under the Apache License, Version 2.0 (the "License"); you may not
use this file except in compliance with the License. Unless required by
applicable law or agreed to in writing, software distributed under the
License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS
OF ANY KIND, either express or implied. See the License for the specific
language governing permissions and limitations under the License.
