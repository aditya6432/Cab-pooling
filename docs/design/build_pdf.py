#!/usr/bin/env python3
"""Builds the submission PDFs from Markdown:
     docs/design/DESIGN.md  -> docs/PoolUp_Design_Document.pdf   (max 5 pages)
     docs/VIVA_GUIDE.md     -> docs/PoolUp_Viva_Guide.pdf
Needs: Python 3 with `markdown`, Node.js with `playwright` (Chromium).
Team names / BITS IDs come from docs/team.json ({{M1_NAME}} … placeholders)."""
import json, pathlib, re, subprocess, sys
import markdown

DOCS = pathlib.Path(__file__).resolve().parent.parent
DESIGN = DOCS / 'design'
TEAM = {k: v for k, v in json.loads((DOCS / 'team.json').read_text()).items() if not k.startswith('_')}

CSS = """
@page { size: A4; margin: 13mm 13mm 14mm; }
@page wide { size: A4 landscape; margin: 9mm 10mm 11mm; }
* { box-sizing: border-box; }
body { font-family: "DejaVu Sans", sans-serif; font-size: 8.55pt; line-height: 1.42; color: #16181d; margin: 0; }
.cover { border-bottom: 2.5px solid #2a78d6; padding-bottom: 7px; margin-bottom: 9px; display: flex; justify-content: space-between; align-items: flex-end; gap: 12px; }
.kicker { color: #2a78d6; font-weight: 700; font-size: 7.6pt; letter-spacing: .06em; text-transform: uppercase; }
.sub { color: #555; font-size: 7.8pt; margin-top: 2px; }
h1 { font-size: 16pt; margin: 2px 0 0; letter-spacing: -0.01em; }
h2 { font-size: 11pt; color: #1c5cab; margin: 11px 0 5px; padding-bottom: 2px; border-bottom: 1px solid #d9dde3; page-break-after: avoid; }
h3 { font-size: 9.5pt; margin: 9px 0 4px; page-break-after: avoid; }
p { margin: 4px 0; } ul, ol { margin: 4px 0; padding-left: 17px; } li { margin: 1.5px 0; }
table { border-collapse: collapse; width: 100%; margin: 5px 0 8px; font-size: 7.55pt; }
thead { display: table-header-group; } tr { page-break-inside: avoid; }
th { background: #eef3fb; color: #1c3f6e; text-align: left; font-weight: 700; }
th, td { border: 1px solid #d5dae1; padding: 2.6px 5px; vertical-align: top; }
tbody tr:nth-child(even) td { background: #fafbfc; }
code { font-family: "DejaVu Sans Mono", monospace; font-size: 7.3pt; background: #f2f4f7; border-radius: 3px; padding: 0 2px; }
pre { background: #f5f6f8; border: 1px solid #dfe3e8; border-radius: 5px; padding: 6px 8px; white-space: pre-wrap; page-break-inside: avoid; }
pre code { background: none; padding: 0; }
.team table { font-size: 7.8pt; margin-top: 0; }
.landscape { page: wide; page-break-before: always; page-break-after: always; }
.landscape h2 { margin-top: 0; }
figure { margin: 4px 0 0; text-align: center; }
figure img { width: 100%; max-height: 172mm; object-fit: contain; }
figcaption { font-size: 7.2pt; color: #555; margin-top: 3px; }
u { text-decoration-thickness: 1px; text-underline-offset: 2px; }
.page-break { page-break-before: always; }
"""

def build(src: pathlib.Path, html_out: pathlib.Path, kicker: str, sub: str):
    text = src.read_text(encoding='utf-8')
    for k, v in TEAM.items():
        text = text.replace('{{' + k + '}}', v)
    m = re.match(r'#\s+(.+)\n', text)
    title, body = m.group(1).strip(), text[m.end():]
    html_body = markdown.markdown(body, extensions=['tables', 'fenced_code', 'sane_lists', 'md_in_html'])
    html = (f'<!doctype html><html><head><meta charset="utf-8"><title>{title}</title><style>{CSS}</style></head><body>'
            f'<div class="cover"><div><div class="kicker">{kicker}</div><h1>{title}</h1><div class="sub">{sub}</div></div></div>'
            f'{html_body}</body></html>')
    html_out.write_text(html, encoding='utf-8')
    return html_out

def main():
    jobs = [
        (DESIGN / 'DESIGN.md', DESIGN / 'design.html', DOCS / 'PoolUp_Design_Document.pdf',
         'PoolUp · DBMS course project · Final design document', 'BITS Pilani, Hyderabad Campus · cab-pooling with Splitwise-style splitting · PostgreSQL 16 + Express + React'),
        (DOCS / 'VIVA_GUIDE.md', DESIGN / 'viva.html', DOCS / 'PoolUp_Viva_Guide.pdf',
         'PoolUp · DBMS course project · Demo and viva guide', 'Who shows what, in what order, and the questions to expect'),
    ]
    for src, html, pdf, kicker, sub in jobs:
        if not src.exists():
            continue
        build(src, html, kicker, sub)
        subprocess.run(['node', str(DESIGN / 'print_pdf.cjs'), str(html), str(pdf)], check=True)
        print('wrote', pdf)

if __name__ == '__main__':
    sys.exit(main())
