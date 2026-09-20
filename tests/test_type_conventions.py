"""Enforces a review rule: record-like tuples in seb_now must be NamedTuple.

`Vector` is the one sanctioned exception: it's a variable-length numeric
sequence, not a fixed-field record, so it can't be expressed as a NamedTuple
without losing its arbitrary dimensionality.
"""

import ast
from pathlib import Path

ALGEBRA_SOURCE = Path(__file__).parent.parent / "src" / "seb_now" / "algebra.py"
VECTOR_ALIAS = "tuple[float, ...]"


def _bare_tuple_subscripts(source: str) -> list[str]:
    tree = ast.parse(source)
    return [
        ast.unparse(node)
        for node in ast.walk(tree)
        if isinstance(node, ast.Subscript)
        and isinstance(node.value, ast.Name)
        and node.value.id == "tuple"
    ]


def test_no_bare_tuple_annotations_outside_the_vector_alias():
    offenders = _bare_tuple_subscripts(ALGEBRA_SOURCE.read_text())

    assert offenders == [VECTOR_ALIAS], (
        "found bare tuple[...] type annotation(s) outside the Vector alias "
        f"(must be a NamedTuple): {[o for o in offenders if o != VECTOR_ALIAS]}"
    )
