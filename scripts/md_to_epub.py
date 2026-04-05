#!/usr/bin/env python3

from __future__ import annotations

import argparse
import datetime as dt
import html
import re
import sys
import uuid
import zipfile
from pathlib import Path


XML_TEMPLATE = """<?xml version="1.0" encoding="utf-8"?>
{body}
"""


CSS = """@namespace epub "http://www.idpf.org/2007/ops";
body {
  font-family: serif;
  line-height: 1.8;
  margin: 5%;
}
h1 {
  font-size: 1.6em;
  line-height: 1.3;
  margin: 1.4em 0 0.8em;
  page-break-after: avoid;
}
h2 {
  font-size: 1.2em;
  line-height: 1.4;
  margin: 1.2em 0 0.6em;
  page-break-after: avoid;
}
p {
  margin: 0 0 1em;
  text-align: left;
}
ul, ol {
  margin: 0 0 1em 1.4em;
  padding: 0;
}
li {
  margin: 0 0 0.4em;
}
.title-page {
  text-align: center;
  margin-top: 30%;
}
.book-title {
  font-size: 1.8em;
  line-height: 1.4;
  margin-bottom: 1.5em;
}
.book-author {
  font-size: 1em;
}
nav ol {
  margin-left: 1.2em;
}
"""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Convert a constrained Markdown manuscript into an EPUB file."
    )
    parser.add_argument("input", type=Path, help="Input markdown file")
    parser.add_argument(
        "output",
        type=Path,
        nargs="?",
        help="Output EPUB path. Defaults to books/<input-stem>.epub",
    )
    return parser.parse_args()


def normalize_lines(text: str) -> list[str]:
    return text.replace("\r\n", "\n").replace("\r", "\n").split("\n")


def parse_manuscript(path: Path) -> tuple[str, str, list[dict[str, object]]]:
    lines = normalize_lines(path.read_text(encoding="utf-8"))

    idx = 0
    while idx < len(lines) and not lines[idx].strip():
        idx += 1
    if idx >= len(lines) or not lines[idx].startswith("# "):
        raise ValueError("先頭行は書籍タイトルの '# ' 見出しで始めてください。")
    book_title = lines[idx][2:].strip()
    idx += 1

    while idx < len(lines) and not lines[idx].strip():
        idx += 1
    if idx >= len(lines):
        raise ValueError("著者名の行が見つかりません。")
    author = lines[idx].strip()
    idx += 1

    while idx < len(lines) and not lines[idx].strip():
        idx += 1

    chapters: list[dict[str, object]] = []
    current_title: str | None = None
    current_lines: list[str] = []

    def flush_chapter() -> None:
        nonlocal current_title, current_lines
        if current_title is None:
            return
        chapters.append(
            {
                "title": current_title,
                "blocks": parse_blocks(current_lines),
            }
        )
        current_title = None
        current_lines = []

    while idx < len(lines):
        line = lines[idx]
        if line.startswith("# "):
            flush_chapter()
            current_title = line[2:].strip()
        else:
            if current_title is None and line.strip():
                raise ValueError("本文は章タイトル '# ' から始めてください。")
            current_lines.append(line)
        idx += 1

    flush_chapter()

    if not chapters:
        raise ValueError("少なくとも1つの章が必要です。")

    return book_title, author, chapters


def parse_blocks(lines: list[str]) -> list[str]:
    blocks: list[str] = []
    i = 0

    while i < len(lines):
        line = lines[i]
        stripped = line.strip()

        if not stripped:
            i += 1
            continue

        if stripped.startswith("## "):
            blocks.append(f"<h2>{inline_to_html(stripped[3:].strip())}</h2>")
            i += 1
            continue

        if re.match(r"^[-*] ", stripped):
            items: list[str] = []
            while i < len(lines):
                candidate = lines[i].strip()
                if not re.match(r"^[-*] ", candidate):
                    break
                items.append(candidate[2:].strip())
                i += 1
            lis = "".join(f"<li>{inline_to_html(item)}</li>" for item in items)
            blocks.append(f"<ul>{lis}</ul>")
            continue

        if re.match(r"^\d+\. ", stripped):
            items = []
            while i < len(lines):
                candidate = lines[i].strip()
                if not re.match(r"^\d+\. ", candidate):
                    break
                items.append(re.sub(r"^\d+\. ", "", candidate, count=1).strip())
                i += 1
            lis = "".join(f"<li>{inline_to_html(item)}</li>" for item in items)
            blocks.append(f"<ol>{lis}</ol>")
            continue

        paragraph_lines = [stripped]
        i += 1
        while i < len(lines):
            candidate = lines[i].strip()
            if (
                not candidate
                or candidate.startswith("## ")
                or re.match(r"^[-*] ", candidate)
                or re.match(r"^\d+\. ", candidate)
            ):
                break
            paragraph_lines.append(candidate)
            i += 1
        paragraph = " ".join(paragraph_lines)
        blocks.append(f"<p>{inline_to_html(paragraph)}</p>")

    return blocks


def inline_to_html(text: str) -> str:
    escaped = html.escape(text, quote=False)
    escaped = re.sub(
        r"\[(.+?)\]\((.+?)\)",
        lambda match: (
            f'<a href="{html.escape(match.group(2), quote=True)}">'
            f"{match.group(1)}</a>"
        ),
        escaped,
    )
    escaped = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", escaped)
    return escaped


def xhtml_document(title: str, body: str) -> str:
    return XML_TEMPLATE.format(
        body=(
            '<html xmlns="http://www.w3.org/1999/xhtml" '
            'xmlns:epub="http://www.idpf.org/2007/ops" '
            'xml:lang="ja" lang="ja">'
            "<head>"
            '<meta charset="utf-8" />'
            f"<title>{html.escape(title)}</title>"
            '<link rel="stylesheet" type="text/css" href="stylesheet.css" />'
            "</head>"
            f"<body>{body}</body>"
            "</html>"
        )
    )


def build_title_page(book_title: str, author: str) -> str:
    body = (
        '<section epub:type="titlepage" class="title-page">'
        f'<h1 class="book-title">{html.escape(book_title)}</h1>'
        f'<p class="book-author">{html.escape(author)}</p>'
        "</section>"
    )
    return xhtml_document(book_title, body)


def build_nav(book_title: str, chapters: list[dict[str, object]]) -> str:
    items = [
        '<li><a href="title.xhtml">表紙</a></li>',
    ]
    for index, chapter in enumerate(chapters, start=1):
        items.append(
            f'<li><a href="chapter-{index:02d}.xhtml">'
            f'{html.escape(str(chapter["title"]))}</a></li>'
        )
    body = (
        '<nav epub:type="toc" id="toc">'
        f"<h1>{html.escape(book_title)}</h1>"
        f"<ol>{''.join(items)}</ol>"
        "</nav>"
    )
    return xhtml_document("目次", body)


def build_toc_ncx(
    book_id: str, book_title: str, author: str, chapters: list[dict[str, object]]
) -> str:
    nav_points = [
        (
            '<navPoint id="navpoint-title" playOrder="1">'
            "<navLabel><text>表紙</text></navLabel>"
            '<content src="title.xhtml" />'
            "</navPoint>"
        )
    ]
    for index, chapter in enumerate(chapters, start=2):
        nav_points.append(
            f'<navPoint id="navpoint-{index}" playOrder="{index}">'
            f"<navLabel><text>{html.escape(str(chapter['title']))}</text></navLabel>"
            f'<content src="chapter-{index - 1:02d}.xhtml" />'
            "</navPoint>"
        )

    return XML_TEMPLATE.format(
        body=(
            '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">'
            "<head>"
            f'<meta name="dtb:uid" content="{html.escape(book_id)}" />'
            '<meta name="dtb:depth" content="1" />'
            '<meta name="dtb:totalPageCount" content="0" />'
            '<meta name="dtb:maxPageNumber" content="0" />'
            "</head>"
            f"<docTitle><text>{html.escape(book_title)}</text></docTitle>"
            f"<docAuthor><text>{html.escape(author)}</text></docAuthor>"
            f"<navMap>{''.join(nav_points)}</navMap>"
            "</ncx>"
        )
    )


def build_content_opf(
    book_id: str, book_title: str, author: str, chapters: list[dict[str, object]]
) -> str:
    modified = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    manifest_items = [
        '<item id="toc" href="toc.ncx" media-type="application/x-dtbncx+xml" />',
        '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav" />',
        '<item id="style" href="stylesheet.css" media-type="text/css" />',
        '<item id="title" href="title.xhtml" media-type="application/xhtml+xml" />',
    ]
    spine_refs = ['<itemref idref="title" />']

    for index, _chapter in enumerate(chapters, start=1):
        manifest_items.append(
            f'<item id="chapter-{index}" href="chapter-{index:02d}.xhtml" '
            'media-type="application/xhtml+xml" />'
        )
        spine_refs.append(f'<itemref idref="chapter-{index}" />')

    return XML_TEMPLATE.format(
        body=(
            '<package xmlns="http://www.idpf.org/2007/opf" '
            'version="3.0" unique-identifier="bookid" xml:lang="ja">'
            '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">'
            f"<dc:identifier id=\"bookid\">{html.escape(book_id)}</dc:identifier>"
            f"<dc:title>{html.escape(book_title)}</dc:title>"
            f"<dc:creator>{html.escape(author)}</dc:creator>"
            "<dc:language>ja</dc:language>"
            '<meta property="dcterms:modified">'
            f"{modified}</meta>"
            "</metadata>"
            f"<manifest>{''.join(manifest_items)}</manifest>"
            f'<spine toc="toc">{"".join(spine_refs)}</spine>'
            "</package>"
        )
    )


def write_epub(output_path: Path, book_title: str, author: str, chapters: list[dict[str, object]]) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    book_id = f"urn:uuid:{uuid.uuid4()}"

    with zipfile.ZipFile(output_path, "w") as epub:
        epub.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        epub.writestr(
            "META-INF/container.xml",
            XML_TEMPLATE.format(
                body=(
                    '<container version="1.0" '
                    'xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
                    "<rootfiles>"
                    '<rootfile full-path="OEBPS/content.opf" '
                    'media-type="application/oebps-package+xml" />'
                    "</rootfiles>"
                    "</container>"
                )
            ),
            compress_type=zipfile.ZIP_DEFLATED,
        )

        epub.writestr("OEBPS/stylesheet.css", CSS, compress_type=zipfile.ZIP_DEFLATED)
        epub.writestr(
            "OEBPS/title.xhtml",
            build_title_page(book_title, author),
            compress_type=zipfile.ZIP_DEFLATED,
        )
        epub.writestr(
            "OEBPS/nav.xhtml",
            build_nav(book_title, chapters),
            compress_type=zipfile.ZIP_DEFLATED,
        )
        epub.writestr(
            "OEBPS/toc.ncx",
            build_toc_ncx(book_id, book_title, author, chapters),
            compress_type=zipfile.ZIP_DEFLATED,
        )
        epub.writestr(
            "OEBPS/content.opf",
            build_content_opf(book_id, book_title, author, chapters),
            compress_type=zipfile.ZIP_DEFLATED,
        )

        for index, chapter in enumerate(chapters, start=1):
            body = f"<h1>{html.escape(str(chapter['title']))}</h1>{''.join(chapter['blocks'])}"
            epub.writestr(
                f"OEBPS/chapter-{index:02d}.xhtml",
                xhtml_document(str(chapter["title"]), body),
                compress_type=zipfile.ZIP_DEFLATED,
            )


def main() -> int:
    args = parse_args()
    input_path = args.input
    output_path = args.output or Path("books") / f"{input_path.stem}.epub"

    try:
        book_title, author, chapters = parse_manuscript(input_path)
        write_epub(output_path, book_title, author, chapters)
    except Exception as exc:  # noqa: BLE001
        print(f"error: {exc}", file=sys.stderr)
        return 1

    print(f"created: {output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
