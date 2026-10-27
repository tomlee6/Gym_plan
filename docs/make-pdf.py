"""
Writes a Markdown document from docs/ as a PDF beside it, for people who
read it outside the repository (deployment-guide.md -> deployment-guide.pdf).

    python docs/make-pdf.py docs/deployment-guide.md [--chrome <path to Chrome or Chromium>]

Needs Python's `markdown` package (pip install markdown) and Chrome or
Chromium, which prints the page to PDF. Run it again whenever the document
changes, and commit both.
"""
from __future__ import annotations

import argparse
import html
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import markdown

CHROMES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "google-chrome",
    "chromium",
    "chromium-browser",
]

STYLE = """
@page { size: A4; margin: 18mm 16mm; }
body { font-family: "Segoe UI", Helvetica, Arial, sans-serif; font-size: 10.5pt; line-height: 1.45; color: #1a1a1a; }
h1 { font-size: 20pt; margin: 0 0 10pt; }
h2 { font-size: 15pt; margin: 22pt 0 8pt; padding-bottom: 3pt; border-bottom: 1px solid #ccc; break-after: avoid; }
h3 { font-size: 12pt; margin: 16pt 0 6pt; break-after: avoid; }
h2 + p, h3 + p { break-before: avoid; }
p, li { orphans: 3; widows: 3; }
code { font-family: Consolas, "Courier New", monospace; font-size: 9pt; background: #f3f3f3; padding: 0 2pt; border-radius: 2pt; }
pre { background: #f6f6f6; border: 1px solid #e2e2e2; border-radius: 3pt; padding: 7pt 9pt; white-space: pre-wrap; word-break: break-all; break-inside: avoid; }
pre code { background: none; padding: 0; }
table { border-collapse: collapse; width: 100%; margin: 6pt 0 10pt; font-size: 9.5pt; break-inside: auto; }
th, td { border: 1px solid #ccc; padding: 4pt 6pt; vertical-align: top; text-align: left; }
th { background: #efefef; }
tr { break-inside: avoid; }
hr { border: none; border-top: 1px solid #ddd; margin: 18pt 0; }
img { width: 100%; height: auto; break-inside: avoid; }
/* A diagram on its own A3 landscape page, at about the size it was drawn. */
@page diagram { size: A3 landscape; margin: 10mm; }
p:has(> img:only-child) { page: diagram; break-before: page; break-after: page; margin: 0; }
a { color: #1a4fa0; text-decoration: none; }
"""


LIST_ITEM = re.compile(r"^\s*(?:[-*]|\d+\.)\s")


def for_python_markdown(text: str) -> str:
    """
    What GitHub reads the same way, as Python-Markdown needs it: a blank
    line before a list that follows a paragraph, and nested lists and their
    paragraphs indented by four spaces, not three (or, for a list nested
    under a bullet, two). Code blocks are left as they are.
    """
    out, fenced, previous = [], False, ""
    for line in text.splitlines():
        if line.lstrip().startswith("```"):
            fenced = not fenced
        if not fenced:
            spaces = len(line) - len(line.lstrip(" "))
            if spaces and spaces % 3 == 0 and spaces % 4:
                line = " " * (spaces // 3 * 4) + line.lstrip(" ")
            elif spaces == 2 and LIST_ITEM.match(line):
                line = "    " + line.lstrip(" ")
            if LIST_ITEM.match(line) and previous.strip() and not LIST_ITEM.match(previous):
                out.append("")
        out.append(line)
        previous = line
    return "\n".join(out)


def find_chrome(given: str | None) -> str:
    for candidate in ([given] if given else []) + CHROMES:
        path = shutil.which(candidate) or (candidate if Path(candidate).is_file() else None)
        if path:
            return path
    sys.exit("No Chrome or Chromium found: pass --chrome <path>.")


def main() -> None:
    parser = argparse.ArgumentParser(description="A Markdown document as a PDF beside it.")
    parser.add_argument("source", type=Path)
    parser.add_argument("--chrome")
    args = parser.parse_args()
    source = args.source.resolve()
    text = source.read_text(encoding="utf-8")
    title = next((line[2:].strip() for line in text.splitlines() if line.startswith("# ")), source.stem)
    body = markdown.markdown(for_python_markdown(text), extensions=["tables", "fenced_code", "sane_lists"])
    # Images (the architecture diagram) are found beside the document.
    base = source.parent.as_uri() + "/"
    page = f'<!doctype html><html><head><meta charset="utf-8"><base href="{base}"><title>{html.escape(title)}</title><style>{STYLE}</style></head><body>{body}</body></html>'
    target = source.with_suffix(".pdf")
    with tempfile.TemporaryDirectory() as work:
        page_path = Path(work) / "page.html"
        page_path.write_text(page, encoding="utf-8")
        subprocess.run(
            [find_chrome(args.chrome), "--headless=new", "--disable-gpu", "--no-pdf-header-footer",
             f"--user-data-dir={Path(work) / 'profile'}", f"--print-to-pdf={target}", page_path.as_uri()],
            check=True, capture_output=True, timeout=180,
        )
    print(f"Wrote {target}")


if __name__ == "__main__":
    main()
