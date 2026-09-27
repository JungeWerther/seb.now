"""Enforces a review rule: no collection literal at module scope.

A list, tuple, set or dict written out at the top of a module (or wrapped as
`frozenset({...})`, `tuple([...])`, ...) is usually data: which domains count as
mainstream media, which channels to follow. Data changes without the code
changing, so it belongs in a Supabase table the code reads, not in the source.

Some module-level collections aren't data but part of the code's own logic (an
escape table, a security allowlist). Each of those is listed in ALLOWED with the
reason it isn't data; an entry that no longer matches anything fails too, so the
list can't go stale.

Scanned: src/seb_now/*.py and research/*.py, like test_constants_convention.
Not scanned: tests/ or research/test_*.py, where literal fixtures are normal
pytest style.
"""

import ast
from pathlib import Path

REPO_ROOT = Path(__file__).parent.parent
SCANNED_DIRS = [REPO_ROOT / "src" / "seb_now", REPO_ROOT / "research"]

COLLECTION_NODES = (ast.List, ast.Tuple, ast.Set, ast.Dict, ast.ListComp, ast.SetComp, ast.DictComp)
COLLECTION_CONSTRUCTORS = {"list", "tuple", "set", "frozenset", "dict"}

ALLOWED = {
    ("src/seb_now/constants.py", "SAFE_URL_SCHEMES"):
        "security policy for rendered hrefs (http/https only), not data that grows",
    ("src/seb_now/sanitize.py", "_SCRIPT_JSON_ESCAPES"):
        "the escape table is part of the escaping algorithm",
    ("src/seb_now/posts.py", "MARKDOWN_EXTENSIONS"):
        "renderer configuration, changed only together with the code that relies on it",
    ("research/train_compositional_embedding.py", "VOCAB"):
        "the research script's own toy corpus",
    ("research/train_compositional_embedding.py", "WORD_TO_INDEX"):
        "derived from the research script's toy corpus",
    ("research/train_compositional_embedding.py", "TEXTS"):
        "the research script's own toy corpus",
}


def _is_collection(value: ast.expr) -> bool:
    if isinstance(value, COLLECTION_NODES):
        return True
    return (
        isinstance(value, ast.Call)
        and isinstance(value.func, ast.Name)
        and value.func.id in COLLECTION_CONSTRUCTORS
    )


def module_level_collections(source: str) -> list[tuple[str, int]]:
    offenders = []
    for node in ast.parse(source).body:
        if isinstance(node, ast.Assign):
            targets, value = node.targets, node.value
        elif isinstance(node, ast.AnnAssign) and node.value is not None:
            targets, value = [node.target], node.value
        else:
            continue
        if _is_collection(value):
            offenders.extend((ast.unparse(target), node.lineno) for target in targets)
    return offenders


def _scanned_files() -> list[Path]:
    return [
        path
        for directory in SCANNED_DIRS
        for path in sorted(directory.glob("*.py"))
        if not path.name.startswith("test_")
    ]


def test_no_list_declaration_in_outer_scope() -> None:
    found = {
        (str(path.relative_to(REPO_ROOT)), name): lineno
        for path in _scanned_files()
        for name, lineno in module_level_collections(path.read_text())
    }

    offenders = {f"{file}:{lineno} {name}" for (file, name), lineno in found.items() if (file, name) not in ALLOWED}
    assert not offenders, (
        "module-level collection literals are data; move them to a Supabase table "
        f"(or, if they're code, add them to ALLOWED with a reason): {sorted(offenders)}"
    )

    stale = set(ALLOWED) - set(found)
    assert not stale, f"ALLOWED entries that no longer match anything: {sorted(stale)}"


def test_rule_catches_each_collection_shape() -> None:
    source = "\n".join(
        [
            "A = ['x']",
            "B = ('x',)",
            "C = {'x'}",
            "D = {'x': 1}",
            "E: frozenset[str] = frozenset({'x'})",
            "F = [c for c in 'xy']",
            "G = tuple(['x'])",
            "H = 3",
            "I = 'x'",
            "def f():\n    J = ['x']",
        ]
    )

    assert [name for name, _ in module_level_collections(source)] == ["A", "B", "C", "D", "E", "F", "G"]
