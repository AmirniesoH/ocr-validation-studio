# Example files

Ready-to-import examples of every file layout OCR Validation Studio understands, plus a sample of every export. The pages are invented business documents with typical OCR mistakes, so there is something to correct.

To try one: download the repository, open the app, and use the **Import** menu (or drop the files onto the start screen). The full rules are in the [User Guide](../USER_GUIDE.md#4-preparing-your-files).

## Inputs

| Folder | How to import it | What it shows |
|---|---|---|
| [`01-single-image/`](01-single-image/) | Select the `.jpg` and the `.json` together | One image and one **flat JSON** list. Uses different field names (`char`, `box`, `confidence`, `line_id`, `idx`), `x, y, width, height` boxes and a **0–100** confidence scale, all detected automatically. Includes **rotated** stamp text as polygons. |
| [`02-folder-with-one-json/`](02-folder-with-one-json/) | **Import → Import folder** and choose `02-folder-with-one-json` | Two page images in a folder and **one nested JSON** (`pages → lines → characters`) that names each page's image. |
| [`03-book-one-json-per-page/`](03-book-one-json-per-page/) | **Import → Import folder** and choose `my-book` (or `03-book-one-json-per-page`) | A book: **one image and one JSON per page**, with matching names. The app combines the page files into one document. |
| [`04-pdf/`](04-pdf/) | Select the `.pdf` and the `.json` together | A two-page **PDF** and a JSON with **numbered pages** and the page size the OCR used. |
| [`05-parquet/`](05-parquet/) | Select the `.jpg` and the `.parquet` together | The same kind of data as a **Parquet** table, one row per character. |
| [`06-sqlite/`](06-sqlite/) | Select the `.jpg` and the `.sqlite` together | A **SQLite** database with a table `ocr_characters(image, line, char_index, text, confidence, x0, y0, x1, y1)`. |

## Templates

Three tiny files to copy and adapt in [`templates/`](templates/):

| File | Shape |
|---|---|
| [`minimal-flat.json`](templates/minimal-flat.json) | The smallest valid file: a list of characters with `text`, `conf` and `bbox`. |
| [`minimal-nested.json`](templates/minimal-nested.json) | Two pages, each naming its image, with lines of characters. |
| [`minimal-rotated.json`](templates/minimal-rotated.json) | Rotated characters given as four-corner polygons. |

## Exported results

[`07-exported-results/`](07-exported-results/) holds what the app wrote for the two-page document from example 02 after a short review (a few characters corrected and page 1 accepted), with the scope set to **Document**:

| File | Export format |
|---|---|
| `harrow-finch_correspondence.txt` | Plain text |
| `harrow-finch_correspondence.docx` | Word document |
| `harrow-finch_correspondence.pdf` | Text PDF |
| `harrow-finch_correspondence_searchable.pdf` | **Searchable PDF**: open it and search for a word |
| `harrow-finch_correspondence.validated.json` | Validated annotations (can be imported again with the images to continue) |
| `harrow-finch_correspondence.validated.parquet` | Parquet |
| `harrow-finch_correspondence.validated.sqlite` | SQLite database |
| `harrow-finch_correspondence.csv` | Character table |
| `harrow-finch_correspondence_alto.zip` | ALTO XML, one file per page |
| `harrow-finch_correspondence.hocr.html` | hOCR |

Each format is explained in the [User Guide](../USER_GUIDE.md#12-exporting).
