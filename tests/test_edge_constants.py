"""Enforces a review rule for the Edge Functions: metaparameters and the
environment live in supabase/functions/_shared/constants.ts.

The TypeScript twin of test_constants_convention: a model id, limit, threshold,
timeout, secret name or external service's address declared at the top of a
function is a decision worth naming in one place, and the environment is read
only through `ENV` there. So outside constants.ts:

- no top-level `const UPPER_CASE = ...`, unless its value is a regex literal
  (a pattern is code, not a setting) or it's in ALLOWED with the reason it
  isn't a metaparameter (a protocol table, a sentinel, a value derived at boot);
- no `Deno.env.get`.

Entries in ALLOWED that no longer match anything fail too, so it can't go stale.
Test files (`*_test.ts`) aren't scanned.
"""

import re
from pathlib import Path

FUNCTIONS_DIR = Path(__file__).parent.parent / "supabase" / "functions"
CONSTANTS_FILE = FUNCTIONS_DIR / "_shared" / "constants.ts"

TOP_LEVEL_CONSTANT = re.compile(r"^(?:export )?const ([A-Z][A-Z0-9_]*)(?::[^=\n]+)? =\s*(\S)", re.M)
ENV_READ = re.compile(r"\bDeno\.env\.get\(")

ALLOWED = {
    ("activitypub/index.ts", "PUBLIC_AUDIENCE"): "ActivityStreams' Public collection, fixed by the spec",
    ("activitypub/index.ts", "HANDLE_PATTERN"): "mirrors the profiles_handle_format check in the database",
    ("activitypub/index.ts", "SITE_ORIGIN"): "read from app_settings at boot",
    ("activitypub/index.ts", "DOMAIN"): "derived from SITE_ORIGIN",
    ("activitypub/index.ts", "USERNAME"): "read from app_settings at boot",
    ("activitypub/index.ts", "ACTOR_ID"): "derived from SITE_ORIGIN",
    ("activitypub/index.ts", "INBOX_URL"): "derived from SITE_ORIGIN",
    ("activitypub/index.ts", "OUTBOX_URL"): "derived from SITE_ORIGIN",
    ("activitypub/index.ts", "NOTES_URL"): "derived from SITE_ORIGIN",
    ("activitypub/index.ts", "POST_PAGE_URL"): "derived from SITE_ORIGIN",
    ("activitypub/index.ts", "KEY_ID"): "derived from SITE_ORIGIN",
    ("activitypub/index.ts", "POST_SELECT"): "a PostgREST select shape, changed with the code that reads it",
    ("topic-label/index.ts", "NONE"): "sentinel option key of the Jev question",
    ("topic-label/index.ts", "ROOT"): "sentinel for the taxonomy's root node",
    ("entity-extract/index.ts", "NEW_ENTITY"): "sentinel option key of the Jev question",
    ("entity-extract/index.ts", "SAME_AS_PREFIX"): "option-key prefix the code parses back",
    ("entity-extract/index.ts", "MENTION_OPTIONS"): "a Jev question's options (prompt schema)",
    ("entity-extract/index.ts", "KIND_OPTIONS"): "a Jev question's options (prompt schema)",
    ("entity-extract/index.ts", "CONCEPT"): "sentinel option key of the Jev question",
    ("entity-extract/index.ts", "NOT_A_NAME"): "sentinel option key of the Jev question",
    ("entity-extract/index.ts", "PAGE_MENTION_OPTIONS"): "a Jev question's options (prompt schema)",
    ("query-parse/index.ts", "NONE"): "sentinel option key of the Jev question",
    ("query-parse/index.ts", "DEFAULT_SORT"): "one of feed_query's sort names, checked by the database",
    ("query-parse/index.ts", "SORTS"): "feed_query's sort names with their Jev descriptions (prompt schema)",
    ("query-parse/index.ts", "ROLES"): "a Jev question's options (prompt schema)",
    ("query-parse/index.ts", "CORS"): "HTTP response headers",
    ("_shared/names.ts", "PARTICLES"): "grammar of names (particles joining a name's words)",
    ("_shared/names.ts", "CONJUNCTIONS"): "grammar of names (words splitting two names)",
    ("_shared/page.ts", "DEAD_TAGS"): "HTML elements that never hold article text",
    ("_shared/page.ts", "CHROME_TAGS"): "HTML elements of page chrome",
    ("_shared/page.ts", "BLOCK_TAGS"): "HTML block elements",
    ("_shared/page.ts", "HEADING_TAGS"): "HTML heading elements",
    ("_shared/page.ts", "BOLD_TAGS"): "HTML bold elements",
    ("_shared/page.ts", "DECLARED_KIND"): "schema.org types mapped to entity kinds",
    ("_shared/page.ts", "NOT_ABOUT_KEYS"): "schema.org properties naming who made a page, not what it's about",
    ("_shared/page.ts", "ELEMENT_NODE"): "DOM nodeType value",
    ("_shared/page.ts", "TEXT_NODE"): "DOM nodeType value",
    ("mcp/index.ts", "SERVER_INFO"): "MCP initialize response",
    ("mcp/index.ts", "PROTOCOL_VERSIONS"): "MCP protocol versions this server speaks",
    ("mcp/index.ts", "INSTRUCTIONS"): "MCP server instructions (prompt text)",
    ("mcp/index.ts", "USER_INSTRUCTIONS"): "MCP server instructions (prompt text)",
    ("mcp/index.ts", "PROPOSAL_STATUSES"): "topic_proposals.status values, checked by the database",
    ("mcp/index.ts", "PROPOSAL_SELECT"): "a PostgREST select shape, changed with the code that reads it",
    ("mcp/index.ts", "LINK_SELECT"): "a PostgREST select shape, changed with the code that reads it",
    ("mcp/index.ts", "PROTECTED_RESOURCE_METADATA_URL"): "derived from ENV.SUPABASE_URL",
    ("mcp/index.ts", "AUTHORIZATION_SERVER"): "derived from ENV.SUPABASE_URL",
    ("mcp/index.ts", "CORS_HEADERS"): "HTTP response headers",
    ("mcp/index.ts", "RANK_FORMULA"): "ranked_feed's formula, quoted to agents",
    ("mcp/index.ts", "TOOLS"): "MCP tool schemas",
    ("mcp/index.ts", "USER_TOOLS"): "MCP tool schemas",
    ("mcp/index.ts", "VOTE_VALUES"): "votes.value for each vote tool argument",
    ("mcp/index.ts", "HANDLERS"): "MCP tool dispatch table",
    ("mcp/index.ts", "USER_HANDLERS"): "MCP tool dispatch table",
    ("event-extract/index.ts", "NONE"): "sentinel option key of the Jev question",
    ("event-extract/index.ts", "PHRASE_PREFIX"): "option-key prefix the code parses back",
    ("event-extract/index.ts", "VENUE_KINDS"): "entity kinds that can be a venue",
    ("event-extract/index.ts", "NOT_AN_EVENT"): "sentinel option key of the Jev question",
    ("event-extract/index.ts", "PAGE_OPTIONS"): "a Jev question's options (prompt schema)",
    ("event-extract/index.ts", "RANGE_ROLES"): "a Jev question's options (prompt schema)",
    ("event-extract/index.ts", "DAY_ROLES"): "a Jev question's options (prompt schema)",
    ("event-extract/index.ts", "KIND_OPTIONS"): "a Jev question's options (prompt schema)",
    ("event-extract/index.ts", "JSON_LD_KINDS"): "schema.org event types mapped to event kinds",
}


def _sources() -> dict[str, str]:
    return {
        path.relative_to(FUNCTIONS_DIR).as_posix(): path.read_text()
        for path in sorted(FUNCTIONS_DIR.rglob("*.ts"))
        if path != CONSTANTS_FILE and not path.name.endswith("_test.ts")
    }


def top_level_constants(source: str) -> list[str]:
    """Top-level UPPER_CASE consts whose value isn't a regex literal."""
    return [name for name, first in TOP_LEVEL_CONSTANT.findall(source) if first != "/"]


def test_top_level_constants_live_in_constants_ts() -> None:
    found = {(path, name) for path, source in _sources().items() for name in top_level_constants(source)}
    offenders = sorted(found - ALLOWED.keys())
    assert not offenders, (
        "move these to supabase/functions/_shared/constants.ts, or add them to ALLOWED with a reason: "
        + ", ".join(f"{path}:{name}" for path, name in offenders)
    )
    stale = sorted(ALLOWED.keys() - found)
    assert not stale, "stale ALLOWED entries: " + ", ".join(f"{path}:{name}" for path, name in stale)


def test_environment_is_read_only_in_constants_ts() -> None:
    readers = sorted(path for path, source in _sources().items() if ENV_READ.search(source))
    assert not readers, "read the environment through ENV in _shared/constants.ts: " + ", ".join(readers)


def test_detector_skips_regexes_and_finds_typed_constants() -> None:
    source = 'const A = 1;\nexport const B: number[] = [2];\nconst C =\n  /x/;\nconst d = 3;\n  const E = 4;\n'
    assert top_level_constants(source) == ["A", "B"]
