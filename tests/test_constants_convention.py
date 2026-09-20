"""Enforces a review rule: class instantiations take named constants, not literals.

`nn.MultiheadAttention(dim, num_heads=1, batch_first=True)` should instead
read `num_heads=SELF_ATTENTION_NUM_HEADS, batch_first=ATTENTION_BATCH_FIRST`
— every such constant lives in src/seb_now/constants.py so a value's
meaning and its being changeable in one place don't depend on grepping for
it. Scoped to calls that look like a class instantiation (callee name
starts with an uppercase letter): lowercase builtins/functions (`tuple(...)`,
`range(0, n)`, `.unsqueeze(0)`) are exempt — constant-izing every literal
anywhere would ban idiomatic Python, not hardcoded metaparameters.

Scanned: src/seb_now/*.py (except this rule's own constants.py) and
examples/*.py. Not scanned: tests/, where literal fixtures/assertions are
normal pytest style.
"""

import ast
from pathlib import Path

REPO_ROOT = Path(__file__).parent.parent
SCANNED_DIRS = [REPO_ROOT / "src" / "seb_now", REPO_ROOT / "examples"]
EXCLUDED_FILES = {"constants.py"}
# TypeVar("V")'s string literal IS the type variable's name, per the stdlib
# typing idiom — there's no separate metaparameter to extract.
EXCLUDED_CALLEES = {"TypeVar"}

LITERAL_TYPES = (bool, int, float, str)


def _looks_like_a_class(callee: ast.expr) -> str | None:
    name = None
    if isinstance(callee, ast.Name):
        name = callee.id
    elif isinstance(callee, ast.Attribute):
        name = callee.attr
    if name and name[0].isupper() and name not in EXCLUDED_CALLEES:
        return name
    return None


def _literal_instantiation_args(source: str) -> list[str]:
    tree = ast.parse(source)
    offenders = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        class_name = _looks_like_a_class(node.func)
        if class_name is None:
            continue
        for arg in (*node.args, *(kw.value for kw in node.keywords)):
            if isinstance(arg, ast.Constant) and isinstance(arg.value, LITERAL_TYPES):
                offenders.append(f"line {node.lineno}: {class_name}(...) got literal {arg.value!r}")
    return offenders


def _scanned_files() -> list[Path]:
    files = []
    for directory in SCANNED_DIRS:
        files.extend(sorted(p for p in directory.glob("*.py") if p.name not in EXCLUDED_FILES))
    return files


def test_no_literal_arguments_to_class_instantiations() -> None:
    all_offenders = {}
    for path in _scanned_files():
        offenders = _literal_instantiation_args(path.read_text())
        if offenders:
            all_offenders[str(path.relative_to(REPO_ROOT))] = offenders

    assert all_offenders == {}, (
        "class instantiations with hardcoded literal arguments (move them to "
        f"src/seb_now/constants.py): {all_offenders}"
    )
