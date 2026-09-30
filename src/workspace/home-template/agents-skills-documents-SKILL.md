---
name: documents
description: Read PDF, Word (docx), PowerPoint (pptx), Excel (xlsx), OpenDocument, EPUB and RTF files as text with pdftotext, pandoc and xlsx2csv. Use when a file or attachment in one of these formats needs to be read, searched, summarized or quoted.
---

# Documents

| Format | Command |
|---|---|
| PDF | `pdftotext -layout file.pdf -` (stdout) |
| docx, odt, pptx, epub, rtf, html | `pandoc -t gfm-raw_html file.docx` |
| xlsx | `xlsx2csv -a file.xlsx` (all sheets as CSV) |

## PDF

- `pdfinfo file.pdf` shows the page count and metadata.
- `pdftotext -layout -f 3 -l 5 file.pdf -` extracts pages 3 to 5 only. `-layout` keeps columns and
  tables aligned; drop it for flowing prose.
- Empty or garbled output means a scanned PDF with no text layer. Render the pages to images with
  `pdftoppm -png -r 100 -f 1 -l 1 file.pdf ~/scratch/page` and look at them with image input.

## pandoc

- The input format comes from the extension; pass `-f docx` (etc.) if the extension is missing or wrong.
- `--extract-media ~/scratch/<name>` saves embedded images so you can look at them.
- Legacy binary `.doc`, `.xls` and `.ppt` files are not supported. Ask for the modern format.

## xlsx2csv

- `-a` prints every sheet, each under a `-------- N - SheetName` line; without it you get the first sheet only.
- `-n SheetName` or `-s N` (1-based) picks one sheet. Use `xlsx2csv`, not `pandoc`, for xlsx: pandoc's reader misses cells.

## Large files

Don't print a big document into the conversation. Write it to scratch, then search it:

```sh
pandoc -t gfm-raw_html report.docx -o ~/scratch/report.md
wc -l ~/scratch/report.md
rg -n "keyword" ~/scratch/report.md
```

Then read only the ranges you need.
