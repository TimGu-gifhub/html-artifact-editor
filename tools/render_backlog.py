#!/usr/bin/env python3
"""Render the checked-in planning baseline; does not call GitHub."""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def render(data: dict) -> str:
    lines = [
        "# 实施任务清单",
        "",
        "本文件由 [backlog.json](backlog.json) 生成。范围变更先修改 JSON，再运行 `python tools/render_backlog.py`；GitHub Issues 记录实时执行状态。",
        "",
        "本表是规划与验收基线，执行进度见各 Issue 和实施记录；未勾选的模板条目不代表所有代码均待实现。M1–M4 构成文本产品路线，M5 是独立后续提案。",
        "",
        "## 任务总览",
        "",
        "| ID | 任务 | 里程碑 | 优先级 | 依赖 | GitHub |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for task in data["tasks"]:
        issue = f"[#{task['issueNumber']}]({task['issueUrl']})" if task.get("issueUrl") else "待创建"
        deps = "、".join(task["dependsOn"]) or "无"
        lines.append(f"| {task['id']} | {task['title']} | {task['milestone']} | {task['priority'].upper()} | {deps} | {issue} |")
    for milestone in data["milestones"]:
        lines.extend(["", f"## {milestone['title']}", "", milestone["description"]])
        for task in (t for t in data["tasks"] if t["milestone"] == milestone["id"]):
            lines.extend(["", f"### {task['id']} · {task['title']}", "", task["objective"], ""])
            lines.append(f"优先级：{task['priority'].upper()}；领域：{task['area']}；依赖：{'、'.join(task['dependsOn']) or '无'}。")
            if task.get("issueUrl"):
                lines.extend(["", f"[打开 GitHub Issue #{task['issueNumber']}]({task['issueUrl']})"])
            for title, field in [("范围", "scope"), ("产物", "deliverables"), ("验收条件", "acceptance")]:
                lines.extend(["", f"**{title}**", ""])
                prefix = "- [ ] " if field == "acceptance" else "- "
                lines.extend(prefix + item for item in task[field])
            lines.extend(["", "验证用例：" + ("、".join(task["tests"]) or "提案阶段；实施前新增针对性验证方案。")])
            links = [f"[{path}]({('../' if not path.startswith('docs/') else '') + (path[5:] if path.startswith('docs/') else path)})" for path in task["docs"]]
            lines.extend(["", "参考文档：" + "、".join(links) + "。"])
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    source = ROOT / "docs" / "backlog.json"
    data = json.loads(source.read_text(encoding="utf-8"))
    output = ROOT / "docs" / "BACKLOG.md"
    output.write_text(render(data), encoding="utf-8", newline="\n")
    print(f"Rendered {len(data['tasks'])} tasks in docs/BACKLOG.md")
