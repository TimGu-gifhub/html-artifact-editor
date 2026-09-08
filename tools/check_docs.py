#!/usr/bin/env python3
"""Check local documentation links and the planning task graph, without network."""

import json
import re
import sys
from pathlib import Path
from urllib.parse import unquote, urlsplit

from render_backlog import render

ROOT = Path(__file__).resolve().parents[1]
ERRORS: list[str] = []


def require(condition: bool, message: str) -> None:
    if not condition:
        ERRORS.append(message)


def main() -> int:
    data = json.loads((ROOT / "docs/backlog.json").read_text(encoding="utf-8"))
    tasks = data["tasks"]
    ids = [task["id"] for task in tasks]
    milestone_ids = [m["id"] for m in data["milestones"]]
    require(data["schemaVersion"] == 1, "Unsupported backlog schema")
    require(len(ids) == len(set(ids)), "Duplicate task IDs")
    require(len(milestone_ids) == len(set(milestone_ids)), "Duplicate milestone IDs")
    require(all(re.fullmatch(r"HAE-\d{3}", task_id) for task_id in ids), "Invalid task ID")
    test_text = (ROOT / "docs/TEST_PLAN.md").read_text(encoding="utf-8")
    known_tests = set(re.findall(r"\b(?:T|S)-\d{2}\b", test_text))
    graph = {task["id"]: task["dependsOn"] for task in tasks}
    issue_numbers = []
    for task in tasks:
        task_id = task["id"]
        require(task["milestone"] in milestone_ids, f"{task_id}: unknown milestone")
        require(task["priority"] in {"p0", "p1", "p2"}, f"{task_id}: invalid priority")
        require(len(task["acceptance"]) >= 2, f"{task_id}: insufficient acceptance criteria")
        for field in ["title", "objective", "scope", "deliverables", "acceptance", "docs"]:
            require(bool(task[field]), f"{task_id}: empty {field}")
        for dependency in task["dependsOn"]:
            require(dependency in graph and dependency != task_id, f"{task_id}: invalid dependency {dependency}")
        for test in task["tests"]:
            require(test in known_tests, f"{task_id}: unknown test {test}")
        for doc in task["docs"]:
            candidate = (ROOT / doc).resolve()
            require(candidate.is_relative_to(ROOT) and candidate.is_file(), f"{task_id}: missing/invalid doc {doc}")
        if task.get("issueUrl"):
            number = task.get("issueNumber")
            require(isinstance(number, int) and number > 0, f"{task_id}: invalid issue number")
            require(task["issueUrl"] == f"https://github.com/{data['repository']}/issues/{number}", f"{task_id}: inconsistent issue URL")
            issue_numbers.append(number)
    require(len(issue_numbers) == len(set(issue_numbers)), "Duplicate issue mappings")

    visited: set[str] = set()
    active: set[str] = set()

    def visit(node: str) -> None:
        if node in active:
            ERRORS.append(f"Dependency cycle at {node}")
            return
        if node in visited or node not in graph:
            return
        active.add(node)
        for dependency in graph[node]:
            visit(dependency)
        active.remove(node)
        visited.add(node)

    for task_id in ids:
        visit(task_id)
    rendered = (ROOT / "docs/BACKLOG.md").read_text(encoding="utf-8")
    require(rendered == render(data), "docs/BACKLOG.md is stale; run python tools/render_backlog.py")

    markdown = list(ROOT.glob("*.md")) + list((ROOT / "docs").rglob("*.md")) + list((ROOT / ".github").rglob("*.md"))
    link_count = 0
    for path in markdown:
        content = path.read_text(encoding="utf-8")
        require("\ufffd" not in content, f"{path.relative_to(ROOT)}: replacement character")
        for target in re.findall(r"\]\(([^)\s]+)\)", content):
            target = target.strip("<>")
            parsed = urlsplit(target)
            if parsed.scheme or target.startswith("#"):
                continue
            candidate = (path.parent / unquote(parsed.path)).resolve()
            require(candidate.is_relative_to(ROOT) and candidate.is_file(), f"{path.relative_to(ROOT)}: broken local link {target}")
            link_count += 1
    license_text = (ROOT / "LICENSE").read_text(encoding="utf-8")
    require(license_text.startswith("MIT License\n"), "Missing MIT license header")
    require("[year]" not in license_text and "[fullname]" not in license_text, "Unfilled license placeholder")
    if ERRORS:
        for error in ERRORS:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1
    print(f"PASS: {len(markdown)} Markdown files, {link_count} local links, {len(tasks)} tasks, {len(milestone_ids)} milestones; DAG and rendering valid.")
    print("Documentation checks only; this command does not run desktop or platform acceptance.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
