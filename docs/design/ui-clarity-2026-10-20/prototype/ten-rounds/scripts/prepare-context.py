#!/usr/bin/env python3
"""Copy feature-baseline documents byte-for-byte for offline review."""
from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DESIGN = ROOT.parents[1]
REPO = DESIGN.parents[2]
CODE_BASELINE = "2c78ca8d52a7d17fae20962cf68d09a717ffc73a"


def main() -> None:
    context = ROOT / "context"
    context.mkdir(exist_ok=True)
    files = []
    for name in ("feature-inventory.md", "feature-manifest.json"):
        original = DESIGN / name
        data = original.read_bytes()
        copy = context / name
        if copy.exists() and copy.read_bytes() != data:
            raise SystemExit("Existing offline baseline differs from canonical source: " + name)
        copy.write_bytes(data)
        links = re.findall(r"\]\(([^)]+)\)", data.decode("utf-8"))
        local_links = [link for link in links if not re.match(r"^(https?://|#|mailto:)", link)]
        if local_links:
            raise SystemExit("Review direct local baseline links before packaging: " + json.dumps(local_links))
        files.append({"path": "context/" + name, "canonical_repository_path": str(original.relative_to(REPO)),
                      "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(), "byte_exact_copy": True,
                      "direct_local_markdown_links": local_links})
    manifest = {"schema": "mote-ui-offline-context-v1", "copied_at_utc": datetime.now(timezone.utc).isoformat(),
                "source_repository": "https://github.com/utopiafar/mote", "inventory_code_baseline": CODE_BASELINE,
                "canonical_documents": "docs/design/ui-clarity-2026-10-20/feature-inventory.md and feature-manifest.json",
                "files": files}
    (context / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    table = "\n".join(f"| [{Path(f['path']).name}]({Path(f['path']).name}) | {f['bytes']:,} | `{f['sha256']}` |" for f in files)
    (context / "README.md").write_text(
        "# 离线功能与旅程基线\n\n"
        "此目录保存两个维护源文档的逐字节副本，便于下载包离线阅读。维护源仍位于仓库的 `docs/design/ui-clarity-2026-10-20/`。\n\n"
        f"功能盘点对应的源码基线：`{CODE_BASELINE}`。文中的代码路径是该基线的源码锚点；两个文档没有需要追加复制的直接 Markdown 相对链接。\n\n"
        "| 文件 | 字节数 | SHA-256 |\n| --- | ---: | --- |\n" + table + "\n\n"
        "完整来源和校验信息见 [manifest.json](manifest.json)。\n"
    )
    readme = ROOT / "README.md"
    text = readme.read_text()
    for name in ("feature-inventory.md", "feature-manifest.json"):
        text = text.replace(f"](../../{name})", f"](context/{name})")
    readme.write_text(text)
    for name in ("feature-inventory.md", "feature-manifest.json"):
        target = "context/" + name
        if f"]({target})" not in text or not (ROOT / target).is_file():
            raise SystemExit("Offline baseline README link missing: " + target)
    print(json.dumps({"files": files, "readme_feature_links": "verified", "context": str(context)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
