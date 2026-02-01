#!/usr/bin/env python3
"""
Minimal Markdown -> standalone HTML renderer (stdlib-only).

Design goals:
- Offline readable (no network dependencies)
- Keep fenced code blocks (including ```mermaid) intact
- Generate a simple table of contents from headings

This is not a full Markdown implementation; it supports the subset we use in repo reports.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import html
import io
import os
import re
from dataclasses import dataclass
from typing import Iterable, List, Optional, Tuple


_RE_FENCE = re.compile(r"^```(?P<lang>[a-zA-Z0-9_-]*)\s*$")
_RE_HEADING = re.compile(r"^(?P<level>#{1,6})\s+(?P<title>.+?)\s*$")
_RE_UL_ITEM = re.compile(r"^\s*-\s+(?P<text>.+?)\s*$")


@dataclass
class TocEntry:
    level: int
    title: str
    anchor: str


def _strip_front_matter(lines: List[str]) -> List[str]:
    if not lines:
        return lines
    if lines[0].strip() != "---":
        return lines
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            return lines[i + 1 :]
    return lines


def _inline(text: str) -> str:
    # Escape first, then apply very small inline transforms.
    t = html.escape(text)

    # Inline code: `code`
    def repl_code(m: re.Match[str]) -> str:
        return f"<code>{m.group(1)}</code>"

    t = re.sub(r"`([^`]+)`", repl_code, t)

    # Bold: **text** (non-greedy)
    t = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", t)
    return t


def _render_blocks(lines: List[str]) -> Tuple[str, List[TocEntry]]:
    out: List[str] = []
    toc: List[TocEntry] = []

    in_code = False
    code_lang = ""
    code_buf: List[str] = []

    para_buf: List[str] = []
    ul_open = False

    heading_count = 0

    def flush_paragraph() -> None:
        nonlocal para_buf
        if not para_buf:
            return
        text = " ".join(s.strip() for s in para_buf if s.strip())
        if text:
            out.append(f"<p>{_inline(text)}</p>")
        para_buf = []

    def close_ul() -> None:
        nonlocal ul_open
        if ul_open:
            out.append("</ul>")
            ul_open = False

    def flush_code() -> None:
        nonlocal in_code, code_lang, code_buf
        if not in_code:
            return
        code_text = "".join(code_buf)
        cls = f"language-{code_lang}" if code_lang else ""
        # Keep mermaid blocks easy to find for offline tooling.
        pre_cls = "codeblock"
        if code_lang.strip().lower() == "mermaid":
            pre_cls += " mermaid"
        out.append(
            f'<pre class="{pre_cls}"><code class="{html.escape(cls)}">{html.escape(code_text)}</code></pre>'
        )
        in_code = False
        code_lang = ""
        code_buf = []

    for raw in lines:
        line = raw.rstrip("\n")

        if in_code:
            if line.strip() == "```":
                flush_code()
            else:
                code_buf.append(line + "\n")
            continue

        m_fence = _RE_FENCE.match(line)
        if m_fence:
            flush_paragraph()
            close_ul()
            in_code = True
            code_lang = (m_fence.group("lang") or "").strip()
            code_buf = []
            continue

        m_head = _RE_HEADING.match(line)
        if m_head:
            flush_paragraph()
            close_ul()
            heading_count += 1
            level = len(m_head.group("level"))
            title = m_head.group("title").strip()
            anchor = f"h-{heading_count}"
            toc.append(TocEntry(level=level, title=title, anchor=anchor))
            out.append(f'<h{level} id="{anchor}">{_inline(title)}</h{level}>')
            continue

        m_li = _RE_UL_ITEM.match(line)
        if m_li:
            flush_paragraph()
            if not ul_open:
                out.append("<ul>")
                ul_open = True
            out.append(f"<li>{_inline(m_li.group('text'))}</li>")
            continue

        if not line.strip():
            flush_paragraph()
            close_ul()
            continue

        para_buf.append(line)

    flush_paragraph()
    close_ul()
    flush_code()

    return "\n".join(out), toc


def _render_toc(toc: List[TocEntry], max_level: int = 3) -> str:
    items = [e for e in toc if e.level <= max_level]
    if not items:
        return ""

    out: List[str] = ["<nav class=\"toc\">", "<div class=\"tocTitle\">目录</div>", "<ul>"]
    for e in items:
        indent = (e.level - 1) * 12
        title = _inline(e.title)
        out.append(
            f'<li style="margin-left:{indent}px"><a href="#{e.anchor}">{title}</a></li>'
        )
    out.append("</ul></nav>")
    return "\n".join(out)


def render_markdown_to_html(md_text: str, title: str) -> str:
    lines = md_text.splitlines(True)
    lines = _strip_front_matter(lines)
    body, toc = _render_blocks(lines)
    toc_html = _render_toc(toc)

    generated_at = _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")

    css = """
    :root {
      --bg: #0b0c0f;
      --panel: #11131a;
      --text: #e7e8ee;
      --muted: #a8adbd;
      --link: #89b4ff;
      --border: rgba(255,255,255,0.12);
      --codebg: #0a0b10;
      --code: #e7e8ee;
      --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    }

    * { box-sizing: border-box; }
    html, body { height: 100%; }
    body {
      margin: 0;
      background: radial-gradient(1200px 800px at 20% -10%, rgba(137,180,255,0.16), transparent 60%),
                  radial-gradient(900px 600px at 90% 10%, rgba(255,140,140,0.12), transparent 55%),
                  var(--bg);
      color: var(--text);
      font: 14px/1.65 system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji";
    }
    a { color: var(--link); text-decoration: none; }
    a:hover { text-decoration: underline; }

    .wrap { max-width: 980px; margin: 0 auto; padding: 28px 18px 64px; }
    header {
      padding: 18px 18px;
      background: linear-gradient(180deg, rgba(17,19,26,0.92), rgba(17,19,26,0.75));
      border: 1px solid var(--border);
      border-radius: 14px;
      backdrop-filter: blur(10px);
    }
    header h1 { margin: 0 0 6px; font-size: 22px; letter-spacing: 0.2px; }
    header .meta { color: var(--muted); font-size: 12px; }

    main {
      margin-top: 16px;
      padding: 18px 18px;
      background: rgba(17,19,26,0.70);
      border: 1px solid var(--border);
      border-radius: 14px;
    }

    h1, h2, h3, h4, h5, h6 { scroll-margin-top: 20px; }
    h2 { margin-top: 26px; border-top: 1px solid var(--border); padding-top: 18px; }
    h3 { margin-top: 18px; }

    p { margin: 10px 0; }
    ul { margin: 10px 0 10px 22px; padding: 0; }
    li { margin: 6px 0; }
    code {
      font-family: var(--mono);
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.10);
      border-radius: 6px;
      padding: 1px 6px;
    }

    pre.codeblock {
      margin: 12px 0;
      background: var(--codebg);
      border: 1px solid rgba(255,255,255,0.10);
      border-radius: 12px;
      padding: 12px 12px;
      overflow: auto;
    }
    pre.codeblock code {
      display: block;
      background: transparent;
      border: 0;
      padding: 0;
      color: var(--code);
      font-family: var(--mono);
      font-size: 13px;
      white-space: pre;
    }
    pre.codeblock.mermaid {
      border-left: 4px solid rgba(137,180,255,0.45);
    }

    nav.toc {
      margin: 16px 0 18px;
      padding: 14px 14px;
      background: rgba(0,0,0,0.18);
      border: 1px solid rgba(255,255,255,0.10);
      border-radius: 12px;
    }
    .tocTitle { font-weight: 650; margin-bottom: 8px; }
    nav.toc ul { margin: 0; list-style: none; }
    nav.toc li { margin: 6px 0; }

    @media (max-width: 560px) {
      .wrap { padding: 18px 12px 48px; }
      header, main { padding: 14px 12px; }
    }
    """

    return f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{html.escape(title)}</title>
  <style>{css}</style>
</head>
<body>
  <div class="wrap">
    <header>
      <h1>{html.escape(title)}</h1>
      <div class="meta">Generated: {html.escape(generated_at)} · Standalone HTML (offline)</div>
    </header>
    <main>
      {toc_html}
      {body}
    </main>
  </div>
</body>
</html>
"""


def main(argv: Optional[List[str]] = None) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--in", dest="in_path", required=True, help="Input markdown path")
    p.add_argument("--out", dest="out_path", required=True, help="Output html path")
    p.add_argument("--title", dest="title", default="", help="HTML title (defaults to filename)")
    args = p.parse_args(argv)

    in_path = os.path.abspath(args.in_path)
    out_path = os.path.abspath(args.out_path)

    with io.open(in_path, "r", encoding="utf-8") as f:
        md = f.read()

    title = args.title.strip() or os.path.basename(in_path)
    html_text = render_markdown_to_html(md, title=title)

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with io.open(out_path, "w", encoding="utf-8", newline="\n") as f:
        f.write(html_text)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

