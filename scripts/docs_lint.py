from __future__ import annotations

import json
import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DOCS_DIR = ROOT / "docs"

ALLOWED_STATUS = {"draft", "active", "deprecated", "archived"}
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def parse_front_matter(text: str) -> dict[str, str] | None:
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return None

    end_idx = None
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            end_idx = i
            break
    if end_idx is None:
        return None

    data: dict[str, str] = {}
    for raw in lines[1:end_idx]:
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        match = re.match(r"^([A-Za-z0-9_-]+):\s*(.*)$", raw)
        if not match:
            continue
        key = match.group(1).strip()
        value = match.group(2).strip()
        if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
            value = value[1:-1]
        data[key] = value
    return data


def main() -> int:
    errors: list[str] = []

    if not DOCS_DIR.exists():
        print("docs/ directory not found", file=sys.stderr)
        return 1

    for md in sorted(DOCS_DIR.rglob("*.md")):
        rel = md.relative_to(ROOT).as_posix()
        if rel.startswith("docs/_meta/templates/"):
            continue
        if rel.startswith("docs/plans/"):
            continue
        if rel.startswith("docs/archive/plans/"):
            continue

        try:
            text = md.read_text(encoding="utf-8")
        except Exception as e:  # noqa: BLE001
            errors.append(f"{rel}: failed to read: {e}")
            continue

        fm = parse_front_matter(text)
        if fm is None:
            errors.append(f"{rel}: missing YAML front matter")
            continue

        for key in ("title", "owner", "status", "last_reviewed"):
            if not fm.get(key, "").strip():
                errors.append(f"{rel}: missing required field: {key}")

        status = fm.get("status", "").strip()
        if status and status not in ALLOWED_STATUS:
            errors.append(f"{rel}: invalid status: {status!r}")

        last_reviewed = fm.get("last_reviewed", "").strip()
        if last_reviewed and not DATE_RE.match(last_reviewed):
            errors.append(f"{rel}: invalid last_reviewed (expected YYYY-MM-DD): {last_reviewed!r}")

        superseded_by = fm.get("superseded_by", "").strip()
        if status == "deprecated" and not superseded_by:
            errors.append(f"{rel}: status=deprecated requires superseded_by")

        if rel.startswith("docs/archive/") and status and status != "archived":
            errors.append(f"{rel}: docs/archive/* must use status=archived (found {status!r})")
        if status == "archived" and not rel.startswith("docs/archive/"):
            errors.append(f"{rel}: status=archived must live under docs/archive/ (found {rel})")

    manifest_path = DOCS_DIR / "context-manifest.json"
    if manifest_path.exists():
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except Exception as e:  # noqa: BLE001
            errors.append(f"docs/context-manifest.json: invalid JSON: {e}")
            manifest = None

        if isinstance(manifest, dict):
            docs = manifest.get("docs", {})
            if isinstance(docs, dict):
                for key, item in docs.items():
                    if not isinstance(item, dict):
                        errors.append(f"docs/context-manifest.json: docs.{key} must be an object")
                        continue
                    p = str(item.get("path", "")).strip()
                    if not p:
                        errors.append(f"docs/context-manifest.json: docs.{key}.path is required")
                        continue
                    full = ROOT / p
                    if not full.exists():
                        errors.append(f"docs/context-manifest.json: docs.{key}.path not found: {p}")

    if errors:
        print("docs lint failed:\n", file=sys.stderr)
        for e in errors:
            print(f"- {e}", file=sys.stderr)
        return 1

    print("docs lint OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

