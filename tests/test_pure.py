"""Phase 0 safety net: unit tests for server.py's pure functions.

No network, no Discord connection, no browser needed — run with:
    python -m pytest
"""

import io
from types import SimpleNamespace
from datetime import datetime, timezone

import pytest

import server as S


# ---------------------------------------------------------------------------
# validate_token
# ---------------------------------------------------------------------------

VALID_TOKEN = "a" * 59 + "." + "b" * 6 + "." + "c" * 38  # 3 parts, long enough


@pytest.mark.parametrize(
    "token,expected",
    [
        ("", "EMPTY-TOKEN"),
        ("   ", "TOKEN-WHITESPACE"),
        ("abc def.ghi.jkl", "TOKEN-WHITESPACE"),
        ("short.a.b", "TOKEN-SHORT"),
        ("a" * 60 + ".b.c!", "INVALID-TOKEN-CHARACTERS"),
        # length is checked before shape: these are long enough to reach it
        ("nodotsatall" + "x" * 60, "INVALID-TOKEN-FORMAT"),
        ("x" * 25 + "." + "y" * 25, "INVALID-TOKEN-FORMAT"),  # 2 parts
        ("x" * 20 + "." + "y" * 20 + ".z." + "w" * 20, "INVALID-TOKEN-FORMAT"),  # 4 parts
        (VALID_TOKEN, None),
    ],
)
def test_validate_token(token, expected):
    assert S.validate_token(token) == expected


def test_validate_token_default_arg():
    assert S.validate_token() == "EMPTY-TOKEN"


# ---------------------------------------------------------------------------
# sanitize_filename
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "name,expected",
    [
        ("../../etc/passwd", "passwd"),
        ("/abs/path/evil.png", "evil.png"),
        ("", "attachment"),
        ("   ", "attachment"),
        ("normal file.png", "normal file.png"),
        ("weird<>name|.mp3", "weird_name_.mp3"),  # each bad-char run -> one _
        ("...", "attachment"),
    ],
)
def test_sanitize_filename(name, expected):
    assert S.sanitize_filename(name) == expected


def test_sanitize_filename_truncates_long_names():
    long_name = "a" * 200 + ".png"
    out = S.sanitize_filename(long_name)
    assert len(out) <= 100
    assert out.endswith(".png")


def test_sanitize_filename_truncates_extensionless():
    out = S.sanitize_filename("b" * 200)
    assert len(out) <= 100


# ---------------------------------------------------------------------------
# read_upload_capped
# ---------------------------------------------------------------------------

def _upload_field(data: bytes):
    return SimpleNamespace(file=io.BytesIO(data))


def test_read_upload_capped_small():
    assert S.read_upload_capped(_upload_field(b"hello"), 100) == b"hello"


def test_read_upload_capped_exact_limit_ok():
    assert S.read_upload_capped(_upload_field(b"x" * 100), 100) == b"x" * 100


def test_read_upload_capped_over_limit_raises():
    with pytest.raises(S._UploadTooLarge):
        S.read_upload_capped(_upload_field(b"x" * 101), 100)


def test_read_upload_capped_empty():
    assert S.read_upload_capped(_upload_field(b""), 100) == b""


def test_read_upload_capped_multi_chunk():
    # bigger than the 256 KiB read window: exercises the streaming loop
    data = bytes((i % 251 for i in range(600 * 1024)))
    assert S.read_upload_capped(_upload_field(data), 1024 * 1024) == data
    with pytest.raises(S._UploadTooLarge):
        S.read_upload_capped(_upload_field(data), 300 * 1024)


# ---------------------------------------------------------------------------
# parse_int / coerce_content / _latency_ms / _int_env
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "value,default,minimum,maximum,expected",
    [
        ("50", 50, 1, 100, 50),
        ("  7 ", 50, 1, 100, 7),
        ("abc", 50, 1, 100, 50),
        (None, 50, 1, 100, 50),
        ("0", 50, 1, 100, 1),  # clamped to minimum
        ("9999", 50, 1, 100, 100),  # clamped to maximum
        (25, 50, 1, 100, 25),
    ],
)
def test_parse_int(value, default, minimum, maximum, expected):
    assert S.parse_int(value, default, minimum, maximum) == expected


@pytest.mark.parametrize(
    "value,expected",
    [
        ("hello", "hello"),
        ("", ""),
        (None, ""),
        (123, "123"),
        (4.5, "4.5"),
        (True, "True"),
        (["x"], ""),
        ({"a": 1}, ""),
    ],
)
def test_coerce_content(value, expected):
    assert S.coerce_content(value) == expected


def test_latency_ms():
    assert S._latency_ms(SimpleNamespace(latency=0.042)) == 42
    assert S._latency_ms(SimpleNamespace(latency=float("nan"))) is None
    assert S._latency_ms(SimpleNamespace(latency=float("inf"))) is None
    assert S._latency_ms(SimpleNamespace(latency=None)) is None
    assert S._latency_ms(object()) is None


def test_int_env(monkeypatch):
    monkeypatch.setenv("BOTCORD_TEST_INT", "42")
    assert S._int_env("BOTCORD_TEST_INT", 7) == 42
    monkeypatch.setenv("BOTCORD_TEST_INT", "garbage")
    assert S._int_env("BOTCORD_TEST_INT", 7) == 7
    monkeypatch.setenv("BOTCORD_TEST_INT", "0")
    assert S._int_env("BOTCORD_TEST_INT", 7) == 7  # below minimum
    monkeypatch.delenv("BOTCORD_TEST_INT")
    assert S._int_env("BOTCORD_TEST_INT", 7) == 7
    monkeypatch.setenv("BOTCORD_TEST_INT", "70000")
    assert S._int_env("BOTCORD_TEST_INT", 7, 1, 65535) == 7  # above maximum


def test_login_rate_limit_trips_and_is_bounded():
    ip = "198.51.100.99"  # TEST-NET-2, never a real client here
    S.LOGIN_ATTEMPTS.pop(ip, None)
    try:
        for _ in range(S.LOGIN_LIMIT):
            assert S.login_allowed(ip) is True
            S.record_login_attempt(ip)
        assert S.login_allowed(ip) is False
        # flood: memory stays bounded by the deque
        for _ in range(500):
            S.record_login_attempt(ip)
        assert len(S.LOGIN_ATTEMPTS[ip]) <= 64
        assert S.login_allowed(ip) is False
    finally:
        S.LOGIN_ATTEMPTS.pop(ip, None)


# ---------------------------------------------------------------------------
# map_tenor_results
# ---------------------------------------------------------------------------

def _tenor_payload():
    return {
        "results": [
            {
                "id": "123",
                "title": "a gif",
                "itemurl": "https://tenor.com/view/x-123",
                "media_formats": {
                    "gif": {"url": "https://media/g.gif", "dims": [220, 124]},
                    "tinygif": {"url": "https://media/g_tiny.gif"},
                    "nanogif": {"url": "https://media/g_nano.gif"},
                    "mp4": {"url": "https://media/g.mp4"},
                },
            },
            {"id": "no-media", "media_formats": {}},  # skipped: no playable url
        ],
        "next": "CAAS",
    }


def test_map_tenor_results():
    out = S.map_tenor_results(_tenor_payload())
    assert out["next"] == "CAAS"
    assert len(out["gifs"]) == 1
    g = out["gifs"][0]
    assert g["id"] == "123"
    assert g["gif_url"] == "https://media/g.gif"
    assert g["preview_url"] == "https://media/g_nano.gif"
    assert g["mp4_url"] == "https://media/g.mp4"
    assert (g["width"], g["height"]) == (220, 124)


@pytest.mark.parametrize("data", [None, {}, {"results": None}, {"results": [{"id": "x"}]}])
def test_map_tenor_results_degenerate(data):
    out = S.map_tenor_results(data)
    assert out == {"gifs": [], "next": ""}


# ---------------------------------------------------------------------------
# _MetaParser / _clean_text / _abs_http (link unfurls)
# ---------------------------------------------------------------------------

SAMPLE_HTML = """<html><head>
<title>Fallback Title</title>
<meta property="og:title" content="OG Title &amp; More">
<meta name="description" content="  spaced   out
desc  ">
<meta property="og:image" content="/img/preview.jpg">
<link rel="shortcut icon" href="/fav.ico">
</head><body></body></html>"""


def test_meta_parser():
    p = S._MetaParser()
    p.feed(SAMPLE_HTML)
    assert p.meta["og:title"] == "OG Title & More"
    assert p.meta["description"] == "  spaced   out\ndesc  "
    assert p.icon == "/fav.ico"
    assert "".join(p.title_parts) == "Fallback Title"


def test_meta_parser_first_wins_and_twitter():
    p = S._MetaParser()
    p.feed(
        '<meta name="twitter:title" content="First">'
        '<meta name="twitter:title" content="Second">'
        '<meta property="og:description" content="D">'
    )
    assert p.meta["twitter:title"] == "First"
    assert p.meta["og:description"] == "D"


@pytest.mark.parametrize(
    "raw,limit,expected",
    [
        ("  A   b\nc  ", 500, "A b c"),
        ("fish &amp; chips", 500, "fish & chips"),
        ("", 500, None),
        ("   ", 10, None),
        ("abcdef", 3, "abc"),
    ],
)
def test_clean_text(raw, limit, expected):
    assert S._clean_text(raw, limit) == expected


@pytest.mark.parametrize(
    "ref,expected",
    [
        ("/img/p.jpg", "https://example.com/img/p.jpg"),
        ("https://cdn.example.com/a.png", "https://cdn.example.com/a.png"),
        ("javascript:alert(1)", None),
        ("ftp://example.com/f", None),
        (None, None),
        ("", None),
    ],
)
def test_abs_http(ref, expected):
    assert S._abs_http("https://example.com/blog/post", ref) == expected


# ---------------------------------------------------------------------------
# Unfurl SSRF guards
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "host",
    [
        "", "localhost", "LOCALHOST.", "127.0.0.1", "10.0.0.5", "172.16.9.9",
        "192.168.1.1", "169.254.169.254", "::1", "0.0.0.0",
        "238.0.0.1", "224.0.0.5",  # multicast: TCP can't, never fetch
        "foo.local", "x.internal", "y.lan",
    ],
)
def test_unfurl_host_blocked(host):
    assert S._unfurl_host_blocked(host) is True


@pytest.mark.parametrize(
    "host", ["example.com", "8.8.8.8", "1.1.1.1", "93.184.216.34"]
)
def test_unfurl_host_allowed(host):
    assert S._unfurl_host_blocked(host) is False


# ---------------------------------------------------------------------------
# Serializers (stub-based contract tests)
# ---------------------------------------------------------------------------

def test_role_json():
    r = SimpleNamespace(
        id=10, name="Mods", color=SimpleNamespace(value=0xFF0000),
        position=3, hoist=True,
    )
    assert S.role_json(r) == {
        "id": "10", "name": "Mods", "color": "#ff0000",
        "position": 3, "hoist": True,
    }


def test_role_json_no_color():
    r = SimpleNamespace(
        id=11, name="@everyone", color=SimpleNamespace(value=0),
        position=0, hoist=False,
    )
    assert S.role_json(r)["color"] is None


def test_guild_json_acronym_and_iconless():
    g = SimpleNamespace(
        id=5, name="Test Server", icon=None, member_count=42,
        owner_id=7, available=True,
    )
    out = S.guild_json(g)
    assert out["id"] == "5"
    assert out["acronym"] == "TS"
    assert out["icon"] is None
    assert out["member_count"] == 42


def _stub_user(uid=1):
    return SimpleNamespace(
        id=uid, name="bob", username="bob", global_name="Bobby",
        discriminator="0", display_avatar=SimpleNamespace(url="https://cdn/av.png"),
        bot=False,
    )


def test_message_json_happy_path():
    author = _stub_user()
    m = SimpleNamespace(
        id=100, content="hi <@1>", clean_content="hi @bob",
        channel=SimpleNamespace(id=9),
        guild=SimpleNamespace(id=8),
        author=author,
        mentions=[], raw_role_mentions=[], raw_channel_mentions=[],
        embeds=[], attachments=[], reactions=[], stickers=[], components=[],
        poll=None, reference=None,
        created_at=datetime(2026, 1, 2, 3, 4, 5, tzinfo=timezone.utc),
        edited_at=None, pinned=False, tts=False,
        flags=SimpleNamespace(value=0, is_components_v2=False),
        mention_everyone=False,
    )
    out = S.message_json(m)
    assert out["id"] == "100"
    assert out["channel_id"] == "9"
    assert out["guild_id"] == "8"
    assert out["author"]["username"] == "bob"
    assert out["member"] is None  # stub author is not a discord.Member
    assert out["mentions"] == {"users": [], "roles": [], "channels": []}
    assert out["mention_everyone"] is False
    assert out["timestamp"] == "2026-01-02T03:04:05+00:00"
    assert out["edited_timestamp"] is None
