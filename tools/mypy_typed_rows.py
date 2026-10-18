"""mypy plugin: only a TypedDict may be indexed by a string literal.

`row["title"]` on a `dict` or `Mapping` is a record passed around untyped.
Declare its shape instead: a TypedDict for a row as the database returns it,
a NamedTuple or dataclass for a value of our own.
"""

from __future__ import annotations

from collections.abc import Callable

from mypy.errorcodes import ErrorCode
from mypy.nodes import StrExpr
from mypy.options import Options
from mypy.plugin import MethodContext, Plugin
from mypy.plugins.default import DefaultPlugin
from mypy.types import Type, TypedDictType, get_proper_type

TYPED_ROWS = ErrorCode("typed-rows", "Only a TypedDict is indexed by a string literal", "General")
MESSAGE = "String key on a dict: declare its shape as a TypedDict, or use a NamedTuple/dataclass"
KEYED_METHODS = frozenset(
    f"{owner}.{method}"
    for owner in ("builtins.dict", "typing.Mapping", "typing.MutableMapping")
    for method in ("__getitem__", "__setitem__", "__delitem__", "get", "pop", "setdefault")
)

type MethodHook = Callable[[MethodContext], Type]


def _refusing_string_keys(fallback: MethodHook | None) -> MethodHook:
    def hook(ctx: MethodContext) -> Type:
        keyed_by_literal = bool(ctx.args and ctx.args[0] and isinstance(ctx.args[0][0], StrExpr))
        if keyed_by_literal and not isinstance(get_proper_type(ctx.type), TypedDictType):
            ctx.api.fail(MESSAGE, ctx.context, code=TYPED_ROWS)
        return fallback(ctx) if fallback else ctx.default_return_type

    return hook


class TypedRowsPlugin(Plugin):
    def __init__(self, options: Options) -> None:
        super().__init__(options)
        self._default = DefaultPlugin(options)

    def get_method_hook(self, fullname: str) -> MethodHook | None:
        if fullname not in KEYED_METHODS:
            return None
        return _refusing_string_keys(self._default.get_method_hook(fullname))


def plugin(_version: str) -> type[Plugin]:
    return TypedRowsPlugin
