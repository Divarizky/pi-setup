#!/usr/bin/env python3
"""agent-memory: satu vault Obsidian untuk memory lintas agent (Pi, Claude Code, Codex).

Hanya memakai Python stdlib. Semua output sengaja ringkas supaya hemat token:
`brief` dan `search` hanya mengembalikan judul dan TL;DR, isi lengkap dibaca lewat
`read` bila memang dibutuhkan.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
import time
import uuid
from pathlib import Path
from zoneinfo import ZoneInfo

LEGACY_DEFAULT_VAULT = (
    "/Users/user/Library/CloudStorage/GoogleDrive-divarizky28@gmail.com"
    "/My Drive/AGENT-MEMORY/pi-memory"
)
try:
    WIB = ZoneInfo("Asia/Jakarta")
except Exception:  # Windows tanpa tzdata: WIB = UTC+7 tetap
    WIB = dt.timezone(dt.timedelta(hours=7), "WIB")


def default_vault_candidates() -> list[str]:
    """Lokasi vault umum per OS; dipakai bila AGENT_MEMORY_VAULT tidak di-set."""
    home = Path.home()
    if sys.platform == "darwin":
        import glob
        found = sorted(glob.glob(str(home / "Library/CloudStorage/GoogleDrive-*"
                                      "/My Drive/AGENT-MEMORY/pi-memory")))
        return found or [LEGACY_DEFAULT_VAULT]
    if sys.platform == "win32":
        return [
            "G:/My Drive/AGENT-MEMORY/pi-memory",
            str(home / "Google Drive/AGENT-MEMORY/pi-memory"),
            str(home / "GoogleDrive/AGENT-MEMORY/pi-memory"),
        ]
    return [
        str(home / "GoogleDrive/AGENT-MEMORY/pi-memory"),
        "/mnt/g/My Drive/AGENT-MEMORY/pi-memory",  # WSL dengan Drive ter-mount
    ]
SKIP_DIRS = {".obsidian", ".trash", ".git", "tools", "templates", "__pycache__"}
TOP_DIRS = ("core", "projects", "knowledge", "sessions", "meta")
NOTE_TYPES = ("note", "decision", "knowledge", "session", "core")
LINK_REQUIRED = {"note", "decision", "knowledge"}
TLDR_MAX = 6
REVIEW_DAYS = 180
BODY_WARN_CHARS = 8000
READ_FULL_CHARS = 6000
FM_ORDER = (
    "type", "project", "topic", "status", "agent", "updated", "review_after",
    "supersedes", "superseded_by", "claimed_by", "claimed_at", "tags", "aliases", "sources",
)

# ---------------------------------------------------------------- utilities


def now_wib() -> dt.datetime:
    return dt.datetime.now(WIB)


def today() -> str:
    return now_wib().date().isoformat()


def stamp() -> str:
    return now_wib().strftime("%Y-%m-%d %H:%M WIB")


def est_tokens(text: str) -> int:
    # Perkiraan kasar: ~3.5 karakter per token untuk campuran Indonesia/Inggris/markdown.
    return math.ceil(len(text) / 3.5)


def slugify(text: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return slug[:80] or "untitled"


def short(text: str, limit: int) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def as_list(value) -> list[str]:
    if value in (None, ""):
        return []
    return [str(v) for v in value] if isinstance(value, list) else [str(value)]


# Stdout/stderr UTF-8 agar karakter non-ASCII (mis. →, ≤) tidak crash saat output
# di-pipe ke hook di Windows yang codepage-nya bukan UTF-8.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
del _stream


def write_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    unique_suffix = f"{os.getpid()}-{uuid.uuid4().hex[:8]}.tmp"
    tmp = path.with_name(f".{path.name}.{unique_suffix}")
    try:
        # newline="\n": selalu LF di semua OS supaya file tidak bolak-balik CRLF/LF
        # saat vault disunting bergantian dari Windows dan macOS/Linux.
        with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(text)

        attempts = 3
        for i in range(attempts):
            try:
                os.replace(tmp, path)
                break
            except PermissionError:
                if i == attempts - 1:
                    raise
                time.sleep(0.05 * (2 ** i))
    finally:
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass


def die(message: str, code: int = 2) -> None:
    print(f"error: {message}", file=sys.stderr)
    sys.exit(code)


def expand_path(raw: str) -> Path:
    # Mendukung ~, $HOME (unix), dan %USERPROFILE% (Windows) agar projects.json portable antar OS.
    return Path(os.path.expandvars(os.path.expanduser(raw)))


def vault_root(args) -> Path:
    raw = getattr(args, "vault", None) or os.environ.get("AGENT_MEMORY_VAULT")
    if raw:
        vault = expand_path(raw)
        if not vault.is_dir():
            die(f"vault tidak ditemukan: {vault}")
        return vault
    for cand in default_vault_candidates():
        if Path(cand).is_dir():
            return Path(cand)
    die("vault tidak ditemukan. Set AGENT_MEMORY_VAULT ke path folder vault "
        "(atau pakai --vault). Contoh macOS: ~/Library/CloudStorage/GoogleDrive-<email>/My Drive/"\
        "AGENT-MEMORY/pi-memory; Windows: G:/My Drive/AGENT-MEMORY/pi-memory.")
    raise SystemExit  # unreachable


def read_stdin() -> str:
    if sys.stdin.isatty():
        die("isi dikirim lewat stdin, contoh: memory save ... <<'EOF' ... EOF")
    return sys.stdin.read().strip("\n")


def agent_name(explicit: str | None) -> str:
    if explicit:
        return explicit
    if os.environ.get("AGENT_MEMORY_AGENT"):
        return os.environ["AGENT_MEMORY_AGENT"]
    # Heuristik env; set AGENT_MEMORY_AGENT kalau tebakannya salah.
    if os.environ.get("CLAUDECODE"):
        return "claude-code"
    if any(k.startswith("CODEX_") for k in os.environ):
        return "codex"
    if any(k.startswith("PI_") for k in os.environ):
        return "pi"
    return "unknown"


# ---------------------------------------------------------------- redaction

SECRET_PATTERNS = [
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----", re.S),
    re.compile(r"\b(?:sk|pk|rk)-[A-Za-z0-9_\-]{16,}"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}"),
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"\bxox[abprs]-[A-Za-z0-9\-]{10,}"),
    re.compile(r"\bAIza[0-9A-Za-z_\-]{30,}"),
    re.compile(r"\beyJ[A-Za-z0-9_\-]{8,}\.eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}"),
    re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._\-]{16,}"),
]
SECRET_ASSIGN = re.compile(
    r"(?i)\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)"
    r"(\s*[:=]\s*)([\"']?)([^\s\"'`]{6,})\3"
)


def redact(text: str) -> tuple[str, int]:
    count = 0
    for pattern in SECRET_PATTERNS:
        text, n = pattern.subn("[REDACTED]", text)
        count += n

    def _assign(m: re.Match) -> str:
        return f"{m.group(1)}{m.group(2)}{m.group(3)}[REDACTED]{m.group(3)}"

    text, n = SECRET_ASSIGN.subn(_assign, text)
    return text, count + n


# ---------------------------------------------------------------- frontmatter

FM_RE = re.compile(r"\A---\n(.*?)\n---[ \t]*\n?", re.S)


def _scalar(raw: str):
    raw = raw.strip()
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in "\"'":
        if raw[0] == '"':
            try:
                return json.loads(raw)
            except json.JSONDecodeError:
                pass
        return raw[1:-1]
    return raw


def parse_fm(text: str) -> tuple[dict, str]:
    if text.startswith("\ufeff"):
        text = text[1:]
    match = FM_RE.match(text)
    if not match:
        return {}, text
    fm: dict = {}
    key = None
    for line in match.group(1).splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped.startswith("- ") and key is not None:
            if not isinstance(fm.get(key), list):
                fm[key] = []
            fm[key].append(_scalar(stripped[2:]))
            continue
        if ":" in line and not line[0].isspace():
            k, v = line.split(":", 1)
            key, v = k.strip(), v.strip()
            if not (v.startswith('"') or v.startswith("'")):
                v = re.sub(r"\s+#.*$", "", v)
            if v.startswith("[") and v.endswith("]"):
                fm[key] = [_scalar(x) for x in v[1:-1].split(",") if x.strip()]
            else:
                fm[key] = _scalar(v)
    return fm, text[match.end():]


def _yaml_value(value: str) -> str:
    value = str(value)
    if value == "" or re.search(r"(^[\[\]{}&*!|>'\"%@#`,?-])|(: )|( #)|(^\s)|(\s$)", value):
        return json.dumps(value, ensure_ascii=False)
    return value


def dump_fm(fm: dict) -> str:
    keys = [k for k in FM_ORDER if k in fm] + [k for k in fm if k not in FM_ORDER]
    lines = ["---"]
    for key in keys:
        value = fm[key]
        if value is None:
            continue
        if isinstance(value, list):
            if not value:
                lines.append(f"{key}: []")
            else:
                lines.append(f"{key}:")
                lines.extend(f"  - {_yaml_value(v)}" for v in value)
        else:
            lines.append(f"{key}: {_yaml_value(value)}")
    lines.append("---")
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------- notes

HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*#*\s*$")
LINK_RE = re.compile(r"\[\[([^\]]+)\]\]")


def headings(body: str) -> list[tuple[int, int, str]]:
    """Return (line_index, level, title) untuk heading di luar code fence."""
    out, fence = [], False
    for i, line in enumerate(body.splitlines()):
        if line.lstrip().startswith(("```", "~~~")):
            fence = not fence
            continue
        if not fence:
            m = HEADING_RE.match(line)
            if m:
                out.append((i, len(m.group(1)), m.group(2).strip()))
    return out


def section_span(body: str, name: str, exact: bool = False) -> tuple[int, int, int] | None:
    """Cari section; return (start_line, end_line_exclusive, level). Heading ikut di start."""
    lines = body.splitlines()
    hs = headings(body)
    want = name.strip().lower()
    for idx, (line_no, level, title) in enumerate(hs):
        t = title.lower()
        if (t == want) if exact else (t == want or t.startswith(want) or want in t):
            end = len(lines)
            for line2, level2, _ in hs[idx + 1:]:
                if level2 <= level:
                    end = line2
                    break
            return line_no, end, level
    return None


class Note:
    def __init__(self, vault: Path, path: Path):
        self.vault = vault
        self.path = path
        self.rel = path.relative_to(vault).as_posix()
        self.text = path.read_text(encoding="utf-8-sig", errors="replace")
        self.fm, self.body = parse_fm(self.text)

    @property
    def type(self) -> str:
        return str(self.fm.get("type", ""))

    @property
    def key(self) -> str:
        return self.rel[:-3] if self.rel.endswith(".md") else self.rel

    @property
    def title(self) -> str:
        for _, level, title in headings(self.body):
            if level == 1:
                return title
        return self.path.stem

    @property
    def tldr(self) -> list[str]:
        span = section_span(self.body, "TL;DR", exact=True)
        if not span:
            return []
        lines = self.body.splitlines()[span[0] + 1: span[1]]
        return [l.strip()[2:].strip() for l in lines if l.strip().startswith(("- ", "* "))]

    def is_stale_by_date(self) -> bool:
        review = str(self.fm.get("review_after", ""))
        return bool(re.match(r"\d{4}-\d{2}-\d{2}$", review)) and review < today()

    def changed_sources(self, root: Path | None) -> list[str]:
        if root is None:
            return []
        changed = []
        for entry in as_list(self.fm.get("sources")):
            rel, _, digest = entry.partition("#")
            if not digest:
                continue
            current = file_hash(root / rel)
            if current != digest:
                changed.append(rel if current else f"{rel} (hilang)")
        return changed

    def save(self) -> None:
        write_atomic(self.path, dump_fm(self.fm) + self.body.lstrip("\n"))


def iter_notes(vault: Path, include_meta: bool = False):
    for path in sorted(vault.rglob("*.md")):
        parts = path.relative_to(vault).parts
        if any(p in SKIP_DIRS or p.startswith(".") for p in parts[:-1]):
            continue
        if parts[0] not in TOP_DIRS or (parts[0] == "meta" and not include_meta):
            continue
        yield Note(vault, path)


def file_hash(path: Path) -> str:
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()[:12]
    except OSError:
        return ""


# ---------------------------------------------------------------- projects


def git(cwd: Path, *args: str) -> str:
    try:
        r = subprocess.run(["git", "-C", str(cwd), *args], capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return r.stdout.strip() if r.returncode == 0 else ""


def norm_remote(url: str) -> str:
    url = re.sub(r"\.git$", "", url.strip().rstrip("/"))
    m = re.match(r"^(?:[a-z+]+://)?(?:[^@/]+@)?([^/:]+)[:/](.+)$", url)
    return f"{m.group(1)}/{m.group(2)}".lower() if m else url.lower()


def load_projects(vault: Path) -> dict:
    path = vault / "meta" / "projects.json"
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8")).get("projects", {})
    except (json.JSONDecodeError, OSError) as exc:
        die(f"meta/projects.json tidak valid: {exc}")
        return {}


def project_root(vault: Path, slug: str) -> Path | None:
    for raw in load_projects(vault).get(slug, {}).get("paths", []):
        path = expand_path(raw)
        if path.is_dir():
            return Path(git(path, "rev-parse", "--show-toplevel") or path)
    return None


def detect_project(vault: Path, cwd: Path, explicit: str | None = None) -> tuple[str | None, Path | None]:
    cwd = cwd.resolve()
    toplevel = git(cwd, "rev-parse", "--show-toplevel")
    root = Path(toplevel) if toplevel else None
    projects = load_projects(vault)
    if explicit:
        return explicit, project_root(vault, explicit) or root

    best, best_len = None, -1
    for slug, cfg in projects.items():
        for raw in cfg.get("paths", []):
            path = expand_path(raw).resolve()
            if (cwd == path or path in cwd.parents) and len(str(path)) > best_len:
                best, best_len = (slug, root or path), len(str(path))
    if best:
        return best
    if root is None:
        return None, None
    remote = git(root, "config", "--get", "remote.origin.url")
    if remote:
        normalized = norm_remote(remote)
        for slug, cfg in projects.items():
            if normalized in (norm_remote(r) for r in cfg.get("remotes", [])):
                return slug, root
        return slugify(normalized.rsplit("/", 1)[-1]), root
    return slugify(root.name), root


# ---------------------------------------------------------------- init


SCHEMA = """---
type: meta
status: active
---
# Memory Schema v3

## TL;DR
- Satu note = satu topik, wajib tepat satu `## TL;DR` (maksimal 6 bullet) di dekat atas.
- Folder: `core/`, `projects/<slug>/{<slug>.md,handoff.md,decisions/,notes/}`, `knowledge/<topic>/<topic>.md`, `sessions/YYYY-MM/`, `meta/`.
- Frontmatter: `type`, `project`, `status`, `updated`, `review_after`, `tags`, `sources` (opsional).
- Tulis lewat `memory save` agar redaksi secret, link hub, dan hash sources terisi otomatis.

## Types
- `core`: preferensi dan aturan yang selalu berlaku; masuk brief.
- `note`: fakta, arsitektur, gotcha project (`projects/<slug>/notes/`).
- `decision`: keputusan project; diganti dengan `supersedes`, bukan ditimpa.
- `knowledge`: pengetahuan lintas project (`knowledge/<topic>/`).
- `session`: recap percakapan ≤10 baris; tidak ikut search default.
- `handoff`: baton terakhir per project (`open` → `claimed` → `closed`).
- `index`: hub project atau topik.

## Freshness
- `review_after` lewat → stale, disembunyikan dari search default.
- `sources` berisi `path#sha256[:12]` relatif ke root repo; hash berubah → stale.
"""

TEMPLATES = {
    "note.md": "---\ntype: note\nproject: \nstatus: active\nupdated: \nreview_after: \ntags: []\nsources: []\n---\n# Judul\n\n## TL;DR\n- \n\n## Detail\n\n## Crux\n\n## Links\n- \n",
    "decision.md": "---\ntype: decision\nproject: \nstatus: active\nupdated: \nreview_after: \nsupersedes: \"\"\ntags: []\n---\n# Judul keputusan\n\n## TL;DR\n- \n\n## Context\n\n## Decision\n\n## Alternatives\n\n## Links\n- \n",
    "session.md": "---\ntype: session\nproject: \nagent: \nupdated: \n---\n# Judul sesi\n\n## TL;DR\n- \n\n## Links\n- \n",
    "handoff.md": "---\ntype: handoff\nproject: \nstatus: open\nagent: \nupdated: \n---\n# Handoff\n\n## Done\n- \n\n## Failed\n- \n\n## Next\n- \n",
}


def ensure_structure(vault: Path) -> list[str]:
    created = []
    for name in ("core", "projects", "knowledge", "sessions", "meta/templates"):
        if not (vault / name).is_dir():
            (vault / name).mkdir(parents=True)
            created.append(name + "/")
    files = {"meta/schema.md": SCHEMA, "meta/projects.json": json.dumps({"projects": {}}, indent=2) + "\n"}
    files.update({f"meta/templates/{k}": v for k, v in TEMPLATES.items()})
    for rel, content in files.items():
        if not (vault / rel).exists():
            write_atomic(vault / rel, content)
            created.append(rel)
    return created


def cmd_init(args) -> None:
    vault = vault_root(args)
    created = ensure_structure(vault)
    print("dibuat: " + ", ".join(created) if created else "struktur sudah lengkap")


# ---------------------------------------------------------------- hubs


def hub_path(vault: Path, rel_dir: str) -> Path:
    """Hub = file bernama sama dengan foldernya; fallback ke index.md lama bila masih ada."""
    new = vault / rel_dir / f"{Path(rel_dir).name}.md"
    old = vault / rel_dir / "index.md"
    return old if old.exists() and not new.exists() else new


def is_hub(note_rel: str) -> bool:
    parts = note_rel.split("/")
    return len(parts) == 3 and parts[0] in ("projects", "knowledge") and \
        parts[2] in (f"{parts[1]}.md", "index.md")


def ensure_hub(vault: Path, rel_dir: str, kind: str, name: str) -> Path:
    path = hub_path(vault, rel_dir)
    if not path.exists():
        fm = {"type": "index", kind: name, "status": "active", "updated": today()}
        label = "project" if kind == "project" else "topik"
        body = f"# {name}\n\n## TL;DR\n- Hub {label} `{name}`.\n"
        write_atomic(path, dump_fm(fm) + body)
    return path


def link_into_hub(vault: Path, hub: Path, target_key: str, heading: str) -> None:
    note = Note(vault, hub)
    link = f"[[{target_key}]]"
    if link in note.body:
        return
    lines = note.body.rstrip("\n").splitlines()
    span = section_span(note.body, heading, exact=True)
    if span:
        lines.insert(span[1], f"- {link}")
        # buang baris kosong tepat sebelum bullet baru supaya list tetap rapat
        if span[1] > 0 and lines[span[1] - 1] == "" and span[1] - 1 > span[0]:
            del lines[span[1] - 1]
    else:
        lines += ["", f"## {heading}", f"- {link}"]
    note.body = "\n".join(lines) + "\n"
    note.save()


# ---------------------------------------------------------------- brief


def cmd_brief(args) -> None:
    vault = vault_root(args)
    slug, root = detect_project(vault, Path(args.cwd or os.getcwd()), args.project)
    footer = 'Detail: `memory search "<query>"` · `memory read <path> [--section X]`'
    # Footer dan penanda "dipotong" selalu muat, jadi ruangnya dipesan dari awal.
    budget = args.max_tokens * 3.5 - len(footer) - 40
    out: list[str] = []
    dropped = 0

    def room() -> float:
        return budget - sum(len(l) + 1 for l in out)

    def add_line(line: str) -> None:
        nonlocal dropped
        if len(line) + 1 <= room():
            out.append(line)
        elif room() > 60:
            out.append(short(line, int(room()) - 1))
        else:
            dropped += 1

    def add_block(header: str, items: list[str], more_hint: str = "", share: float = 1.0) -> None:
        nonlocal dropped
        if not items:
            return
        start = budget - room()

        def block_room() -> float:
            used_by_block = budget - room() - start
            return min(room(), budget * share - used_by_block)

        marker = 12 + len(more_hint)
        if len(header) + len(items[0]) + marker > block_room():
            dropped += 1
            return
        out.append(header)
        for i, item in enumerate(items):
            last = i == len(items) - 1
            if len(item) + 1 + (0 if last else marker) > block_room():
                out.append(f"  …(+{len(items) - i}{more_hint})")
                return
            out.append(item)

    date = now_wib().strftime("%d-%m-%Y")
    out.append(f"# Memory brief · project: {slug or '-'} · {date}")

    if slug:
        handoff = vault / "projects" / slug / "handoff.md"
        if handoff.exists():
            h = Note(vault, handoff)
            if h.fm.get("status") == "open":
                items = []
                for sec in ("Next", "Failed"):
                    span = section_span(h.body, sec, exact=True)
                    if span:
                        lines = h.body.splitlines()[span[0] + 1: span[1]]
                        bullets = [l.strip()[2:] for l in lines if l.strip().startswith("- ")]
                        items += [f"- {sec}: {short(b, 160)}" for b in bullets[:3] if b.strip()]
                add_block(
                    f"Handoff open ({h.fm.get('agent', '?')}, {h.fm.get('updated', '?')}); "
                    f"lanjutkan? `memory handoff --claim`",
                    items,
                )

    core = [n for n in iter_notes(vault) if n.rel.startswith("core/")]
    core.sort(key=lambda n: (n.path.stem != "user-preferences", n.rel))
    core_items = [f"- {short(b, 180)}" for n in core for b in n.tldr]
    add_block("Core:", core_items, " bullet; memory read core/<file>", share=0.45 if slug else 0.8)

    if slug:
        pdir = vault / "projects" / slug
        index = hub_path(vault, f"projects/{slug}")
        if index.exists():
            add_block("Project:", [f"- {short(b, 180)}" for b in Note(vault, index).tldr])
        notes = [Note(vault, p) for p in sorted((pdir / "notes").glob("*.md"))] if (pdir / "notes").is_dir() else []
        decisions = [Note(vault, p) for p in sorted((pdir / "decisions").glob("*.md"))] if (pdir / "decisions").is_dir() else []
        decisions = [d for d in decisions if d.fm.get("status", "active") == "active"]
        stale = [n.path.stem for n in notes + decisions if n.is_stale_by_date() or n.changed_sources(root)]
        for label, group in (("Notes", notes), ("Decisions", decisions)):
            names = [n.path.stem for n in group]
            if names:
                add_line(short(f"{label} ({len(names)}): " + " · ".join(names), 400))
        if stale:
            add_line(short(f"Stale ({len(stale)}): " + " · ".join(stale), 300))
        if not index.exists() and not notes:
            add_line("(project belum punya memory)")

    topics = sorted(p.name for p in (vault / "knowledge").iterdir() if p.is_dir()) if (vault / "knowledge").is_dir() else []
    if topics:
        add_line(short("Knowledge: " + " · ".join(topics), 300))
    if root is not None and (root / "graft" / ".graph").is_dir():
        add_line('Code map: `graft map` · `graft ask "<task>"`')

    if slug:
        out.append("Simpan otomatis: `memory save --type session|note|decision` saat task selesai/keputusan/root-cause.")
    if dropped:
        footer = f"({dropped} bagian dipotong karena budget) " + footer
    out.append(footer)
    text = "\n".join(out)
    print(text)
    if args.show_tokens:
        print(f"(~{est_tokens(text)} token)")


# ---------------------------------------------------------------- search


def note_hidden(note: Note) -> str:
    if note.type == "decision" and note.fm.get("status") == "superseded":
        return "superseded"
    if note.type == "handoff" and note.fm.get("status") != "open":
        return "handoff-closed"
    if note.is_stale_by_date():
        return "stale"
    return ""


def score(note: Note, terms: list[str]) -> float:
    title, path = note.title.lower(), note.rel.lower()
    tags = " ".join(as_list(note.fm.get("tags")) + as_list(note.fm.get("aliases"))).lower()
    tldr, body = " ".join(note.tldr).lower(), note.body.lower()
    total, hits = 0.0, 0
    for term in terms:
        s = 5 * (term in title) + 3 * (term in path) + 4 * (term in tags) + 3 * (term in tldr)
        s += min(body.count(term), 5)
        if s:
            hits += 1
            total += s
    if not hits:
        return 0.0
    total *= hits / len(terms)
    total += 5 if hits == len(terms) else 0
    # Hub hanya berisi daftar link; jangan sampai menggeser note yang sebenarnya.
    return total * 0.3 if note.type == "index" else total


def in_scope(note: Note, slug: str | None, args) -> bool:
    top = note.rel.split("/", 1)[0]
    if args.type and note.type != args.type:
        return False
    if top == "sessions":
        return bool(args.sessions or args.type == "session")
    if top == "projects":
        return args.all or (slug is not None and note.rel.startswith(f"projects/{slug}/"))
    return top in ("core", "knowledge")


def cmd_search(args) -> None:
    vault = vault_root(args)
    slug, root = detect_project(vault, Path(args.cwd or os.getcwd()), args.project)
    terms = [t for t in re.findall(r"[\w.\-/]+", args.query.lower()) if len(t) > 1]
    if not terms:
        die("query kosong")
    notes = list(iter_notes(vault))

    def run(all_projects: bool):
        hidden, found = 0, []
        scoped = argparse.Namespace(**{**vars(args), "all": all_projects})
        for note in notes:
            if not in_scope(note, slug, scoped):
                continue
            s = score(note, terms)
            if not s:
                continue
            if note_hidden(note) and not args.include_old:
                hidden += 1
                continue
            found.append((s, note))
        return sorted(found, key=lambda x: (-x[0], x[1].rel)), hidden

    found, hidden = run(args.all)
    broadened = False
    if not found and not args.all:
        found, hidden = run(True)
        broadened = bool(found)

    if broadened:
        print("(tidak ada hasil di project aktif; menampilkan hasil dari semua project)")
    if not found:
        print("tidak ada hasil" + (f"; {hidden} disembunyikan, coba --include-old" if hidden else ""))
        return
    for _, note in found[: args.limit]:
        flags = []
        if note_hidden(note):
            flags.append(note_hidden(note))
        note_root = root if slug and note.rel.startswith(f"projects/{slug}/") else None
        if note.changed_sources(note_root):
            flags.append("source-changed")
        flag = f" [{', '.join(flags)}]" if flags else ""
        print(f"{note.rel} · {note.type or '?'} · {note.fm.get('updated', '?')}{flag}")
        bullets = note.tldr[:2] or [short(note.body, 160)]
        print(f"  {note.title}: " + " | ".join(short(b, 150) for b in bullets))
    extra = len(found) - args.limit
    tail = []
    if extra > 0:
        tail.append(f"+{extra} hasil lain (--limit)")
    if hidden:
        tail.append(f"{hidden} disembunyikan (--include-old)")
    if tail:
        print("(" + "; ".join(tail) + ")")


# ---------------------------------------------------------------- read


def resolve_note(vault: Path, ref: str) -> Path:
    ref = ref.strip().strip("[]")
    for cand in (vault / ref, vault / f"{ref}.md"):
        if cand.is_file():
            return cand
    stem = Path(ref).stem
    matches = [n.path for n in iter_notes(vault, include_meta=True)
               if n.path.stem == stem or n.key.endswith("/" + ref.removesuffix(".md"))]
    if len(matches) == 1:
        return matches[0]
    if matches:
        die("ref ambigu:\n" + "\n".join(f"  {m.relative_to(vault).as_posix()}" for m in matches))
    die(f"note tidak ditemukan: {ref}")
    raise SystemExit  # unreachable


def cmd_read(args) -> None:
    vault = vault_root(args)
    note = Note(vault, resolve_note(vault, args.ref))
    if args.section:
        span = section_span(note.body, args.section)
        if not span:
            names = ", ".join(t for _, lvl, t in headings(note.body) if lvl >= 2)
            die(f"section '{args.section}' tidak ada. Tersedia: {names}")
        lines = note.body.splitlines()[span[0]: span[1]]
        print(f"{note.rel} › {note.title}")
        print("\n".join(lines).strip())
        return
    if args.full or len(note.text) <= READ_FULL_CHARS:
        print(f"{note.rel}")
        print(note.text.strip())
        return
    # Note besar: tampilkan TL;DR + outline supaya agent memilih section yang perlu saja.
    print(f"{note.rel} · {note.type} · {note.fm.get('updated', '?')} · ~{est_tokens(note.text)} token")
    print(f"# {note.title}")
    for bullet in note.tldr:
        print(f"- {bullet}")
    print("\nSections:")
    lines = note.body.splitlines()
    hs = headings(note.body)
    for idx, (line_no, level, title) in enumerate(hs):
        if level == 1 or title == "TL;DR":
            continue
        end = next((l for l, lv, _ in hs[idx + 1:] if lv <= level), len(lines))
        size = est_tokens("\n".join(lines[line_no:end]))
        print(f"{'  ' * (level - 2)}- {title} (~{size} tok)")
    print(f"\nBaca: memory read {note.key} --section \"<nama>\"  (atau --full)")


# ---------------------------------------------------------------- save


def target_path(vault: Path, args, slug: str | None) -> Path:
    if args.path:
        rel = args.path if args.path.endswith(".md") else args.path + ".md"
        return vault / rel
    name = args.slug or slugify(args.title or "")
    if args.type in ("note", "decision"):
        if not slug:
            die("project tidak terdeteksi; pakai --project <slug>")
        return vault / "projects" / slug / ("notes" if args.type == "note" else "decisions") / f"{name}.md"
    if args.type == "knowledge":
        if not args.topic:
            die("knowledge butuh --topic <topik>")
        return vault / "knowledge" / slugify(args.topic) / f"{name}.md"
    if args.type == "core":
        return vault / "core" / f"{name}.md"
    date = today()
    folder = vault / "sessions" / date[:7]
    path = folder / f"{date}-{name}.md"
    n = 2
    while path.exists():
        path = folder / f"{date}-{name}-{n}.md"
        n += 1
    return path


def hash_sources(raw: str, root: Path | None) -> list[str]:
    entries = []
    for rel in [s.strip() for s in raw.split(",") if s.strip()]:
        rel = rel.partition("#")[0]
        if root is None:
            die("--sources butuh repo git (atau path di meta/projects.json)")
        path = (root / rel).resolve()
        if not path.is_file():
            die(f"source tidak ada: {rel} (relatif ke {root})")
        entries.append(f"{path.relative_to(root.resolve()).as_posix()}#{file_hash(path)}")
    return entries


def replace_section(body: str, heading: str, content: str) -> str:
    content = content.strip("\n")
    lines = body.rstrip("\n").splitlines()
    if not content.lstrip().startswith("#"):
        content = f"## {heading}\n{content}"
    new = content.splitlines()
    span = section_span(body, heading, exact=True)
    if span:
        lines[span[0]: span[1]] = new + [""]
    else:
        links = section_span(body, "Links", exact=True)
        at = links[0] if links else len(lines)
        lines[at:at] = ([""] if at and lines[at - 1].strip() else []) + new + [""]
    return "\n".join(lines).rstrip("\n") + "\n"


def check_note(text: str, kind: str) -> tuple[list[str], list[str]]:
    errors, warnings = [], []
    fm, body = parse_fm(text)
    count = sum(1 for _, lvl, t in headings(body) if lvl == 2 and t == "TL;DR")
    if kind not in ("handoff", "meta") and count != 1:
        errors.append(f"butuh tepat satu '## TL;DR' (ada {count})")
    span = section_span(body, "TL;DR", exact=True)
    if span:
        bullets = [l for l in body.splitlines()[span[0] + 1: span[1]] if l.strip().startswith(("- ", "* "))]
        if len(bullets) > TLDR_MAX:
            warnings.append(f"TL;DR {len(bullets)} bullet (maks {TLDR_MAX})")
        if not bullets:
            errors.append("TL;DR kosong")
    if kind in LINK_REQUIRED and not LINK_RE.search(body):
        warnings.append("tidak ada [[wikilink]] keluar")
    if kind != "meta" and len(body) > BODY_WARN_CHARS:
        warnings.append(f"note besar ({len(body)} karakter); pertimbangkan dipecah")
    return errors, warnings


def cmd_save(args) -> None:
    vault = vault_root(args)
    content, redacted = redact(read_stdin())
    slug, root = detect_project(vault, Path(args.cwd or os.getcwd()), args.project)
    path = target_path(vault, args, slug)
    exists = path.exists()

    if exists:
        note = Note(vault, path)
        kind = note.type or args.type
        fm = dict(note.fm)
        if args.section:
            body = replace_section(note.body, args.section, content)
        elif getattr(args, "replace_body", False):
            body = content if content.lstrip().startswith("# ") else f"# {note.title}\n\n{content}"
        else:
            die(f"note sudah ada ({path.relative_to(vault)}). Gunakan --section untuk memperbarui section tertentu, atau --replace-body bila benar-benar ingin menimpa seluruh isi.")
    else:
        if args.section:
            die(f"--section butuh note yang sudah ada: {path.relative_to(vault)}")
        if not args.type:
            die("note baru butuh --type")
        kind = args.type
        title = args.title or path.stem.replace("-", " ")
        body = content if content.lstrip().startswith("# ") else f"# {title}\n\n{content}"
        fm = {"type": kind, "status": "active"}
        rel_parts = path.relative_to(vault).parts
        if rel_parts[0] == "projects":
            fm["project"] = rel_parts[1]
        elif kind == "session" and slug:
            fm["project"] = slug
        if kind == "knowledge":
            fm["topic"] = rel_parts[1]
        if kind == "session":
            fm.pop("status")
            fm["agent"] = agent_name(args.agent)

    fm["updated"] = today()
    if kind != "session" and kind != "handoff":
        days = args.review_days or REVIEW_DAYS
        if args.review_days or "review_after" not in fm:
            fm["review_after"] = (now_wib().date() + dt.timedelta(days=days)).isoformat()
    if args.tags:
        fm["tags"] = sorted(set(as_list(fm.get("tags")) + [t.strip() for t in args.tags.split(",") if t.strip()]))
    if args.sources:
        fm["sources"] = hash_sources(args.sources, root if fm.get("project") in (None, slug) else project_root(vault, fm["project"]))

    project = fm.get("project")
    hub_key = None
    if path.relative_to(vault).parts[0] in ("projects", "sessions") and project:
        hub = ensure_hub(vault, f"projects/{project}", "project", project)
        hub_key = hub.relative_to(vault).as_posix()[:-3]
    elif kind == "knowledge":
        hub = ensure_hub(vault, f"knowledge/{fm['topic']}", "topic", fm["topic"])
        hub_key = hub.relative_to(vault).as_posix()[:-3]
    is_self_hub = hub_key is not None and path.resolve() == hub.resolve()
    if hub_key and not is_self_hub and f"[[{hub_key}]]" not in body:
        body = replace_section(body, "Links", "\n".join(
            [l for l in (section_text(body, "Links") or "").splitlines() if l.strip()] + [f"- [[{hub_key}]]"]))

    if args.supersedes:
        old_path = resolve_note(vault, args.supersedes)
        old = Note(vault, old_path)
        fm["supersedes"] = old.key

    text = dump_fm(fm) + body.lstrip("\n")
    errors, warnings = check_note(text, kind)
    if errors:
        die("; ".join(errors) + f" → {path.relative_to(vault)}")
    write_atomic(path, text)
    key = path.relative_to(vault).as_posix()[:-3]

    if args.supersedes:
        old.fm["status"] = "superseded"
        old.fm["superseded_by"] = key
        old.fm["updated"] = today()
        old.save()
    if hub_key and kind in ("note", "decision", "knowledge") and not is_self_hub:
        link_into_hub(vault, hub, key, {"note": "Notes", "decision": "Decisions"}.get(kind, "Notes"))

    verb = "diperbarui" if exists else "disimpan"
    print(f"{verb}: {key}.md (~{est_tokens(text)} token)")
    if redacted:
        print(f"redaksi: {redacted} secret diganti [REDACTED]")
    for w in warnings:
        print(f"warning: {w}")


def section_text(body: str, heading: str) -> str | None:
    span = section_span(body, heading, exact=True)
    if not span:
        return None
    return "\n".join(body.splitlines()[span[0] + 1: span[1]])


# ---------------------------------------------------------------- handoff


def cmd_handoff(args) -> None:
    vault = vault_root(args)
    slug, _ = detect_project(vault, Path(args.cwd or os.getcwd()), args.project)
    if not slug:
        die("handoff butuh project; pakai --project <slug>")
    path = vault / "projects" / slug / "handoff.md"
    agent = agent_name(args.agent)

    if args.show or args.claim or args.close:
        if not path.exists():
            print(f"belum ada handoff untuk {slug}")
            return
        note = Note(vault, path)
        if args.claim:
            note.fm.update(status="claimed", claimed_by=agent, claimed_at=stamp())
            note.save()
        elif args.close:
            note.fm.update(status="closed", updated=stamp())
            note.save()
        print(f"{note.rel} · {note.fm.get('status')} · {note.fm.get('agent', '?')} · {note.fm.get('updated', '?')}")
        if not args.close:
            print(note.body.strip())
        return

    content, redacted = redact(read_stdin())
    if not any(section_span(content, s, exact=True) for s in ("Done", "Failed", "Next")):
        die("handoff butuh minimal satu section: ## Done, ## Failed, ## Next")
    ensure_hub(vault, f"projects/{slug}", "project", slug)
    fm = {"type": "handoff", "project": slug, "status": "open", "agent": agent, "updated": stamp()}
    body = f"# Handoff {slug}\n\n{content.strip()}\n\n## Links\n- [[projects/{slug}/index]]\n"
    write_atomic(path, dump_fm(fm) + body)
    print(f"handoff disimpan: {path.relative_to(vault).as_posix()} (status open)")
    if redacted:
        print(f"redaksi: {redacted} secret diganti [REDACTED]")


# ---------------------------------------------------------------- status & lint


def cmd_status(args) -> None:
    vault = vault_root(args)
    slug, root = detect_project(vault, Path(args.cwd or os.getcwd()), args.project)
    counts: dict[str, int] = {}
    for note in iter_notes(vault):
        top = note.rel.split("/", 1)[0]
        counts[top] = counts.get(top, 0) + 1
    print(f"vault: {vault}")
    print(f"project: {slug or '-'} · repo: {root or '-'}")
    print("notes: " + ", ".join(f"{k}={v}" for k, v in sorted(counts.items())))


def cmd_lint(args) -> None:
    vault = vault_root(args)
    keys = {n.key for n in iter_notes(vault, include_meta=True)}
    errors: list[str] = []
    warnings: list[str] = []
    stale: list[str] = []
    roots: dict[str, Path | None] = {}
    notes = list(iter_notes(vault, include_meta=True))

    for note in notes:
        if note.rel == "meta/index.md":
            continue
        kind = note.type or ("meta" if note.rel.startswith("meta/") else "")
        if not note.fm and not note.rel.startswith("meta/"):
            errors.append(f"{note.rel}: tidak ada frontmatter")
            continue
        errs, warns = check_note(note.text, kind)
        errors += [f"{note.rel}: {e}" for e in errs]
        warnings += [f"{note.rel}: {w}" for w in warns]
        for raw in LINK_RE.findall(note.body):
            target = raw.split("|", 1)[0].split("#", 1)[0].strip()
            if target and target.removesuffix(".md") not in keys and not (vault / target).exists():
                errors.append(f"{note.rel}: link rusak [[{raw}]]")
        if kind == "decision" and note.fm.get("status") == "superseded" and not note.fm.get("superseded_by"):
            warnings.append(f"{note.rel}: superseded tanpa superseded_by")
        project = note.fm.get("project")
        if project and project not in roots:
            roots[project] = project_root(vault, project)
        changed = note.changed_sources(roots.get(project)) if project else []
        if note.is_stale_by_date():
            stale.append(f"{note.rel}: lewat review_after {note.fm.get('review_after')}")
        if changed:
            stale.append(f"{note.rel}: source berubah ({', '.join(changed)})")

    for label, items in (("ERROR", errors), ("WARNING", warnings), ("STALE", stale)):
        for item in items:
            print(f"{label} {item}")
    if not args.no_index:
        write_index(vault, notes)
    print(f"lint: {len(notes)} note · {len(errors)} error · {len(warnings)} warning · {len(stale)} stale"
          + ("" if args.no_index else " · meta/index.md diperbarui"))
    if errors:
        sys.exit(1)


def write_index(vault: Path, notes: list[Note]) -> None:
    groups: dict[str, list[str]] = {}
    for note in notes:
        if note.rel.startswith("meta/"):
            continue
        parts = note.rel.split("/")
        group = "/".join(parts[:2]) if parts[0] in ("projects", "knowledge", "sessions") and len(parts) > 2 else parts[0]
        first = short(note.tldr[0], 110) if note.tldr else ""
        groups.setdefault(group, []).append(f"- [[{note.key}]]" + (f" — {first}" if first else ""))
    lines = [dump_fm({"type": "meta", "status": "generated", "updated": today()}).rstrip("\n"),
             "# Vault Index", "", "## TL;DR",
             "- Dibuat otomatis oleh `memory lint`; jangan diedit manual.",
             "- Untuk agent: pakai `memory search`, bukan membaca file ini.", ""]
    for group in sorted(groups):
        lines += [f"## {group}", *groups[group], ""]
    write_atomic(vault / "meta" / "index.md", "\n".join(lines))


# ---------------------------------------------------------------- review & move

REVIEW_BIG = BODY_WARN_CHARS
HANDOFF_OLD_DAYS = 14


def cmd_review(args) -> None:
    vault = vault_root(args)
    slug, _ = detect_project(vault, Path(args.cwd or os.getcwd()), args.project)
    notes = [n for n in iter_notes(vault, include_meta=True)
             if not n.rel.startswith("meta/")]
    if slug and not args.all:
        notes = [n for n in notes if n.rel.startswith(("core/", "knowledge/", f"projects/{slug}/"))]
    keys = {n.key for n in notes}
    inbound: dict[str, list[str]] = {}
    for note in notes:
        for raw in LINK_RE.findall(note.body):
            target = raw.split("|", 1)[0].split("#", 1)[0].strip().removesuffix(".md")
            if target in keys:
                inbound.setdefault(target, []).append(note.key)
    roots: dict[str, Path | None] = {}
    findings: dict[str, list[str]] = {}

    def add(cat: str, line: str) -> None:
        findings.setdefault(cat, []).append(line)

    seen_titles: dict[str, str] = {}
    for note in sorted(notes, key=lambda n: n.rel):
        parts = note.rel.split("/")
        kind, name = note.type, note.path.name
        if name != "handoff.md" and not is_hub(note.rel):
            want = None
            if parts[0] == "projects" and len(parts) > 2:
                want = "decision" if parts[2] == "decisions" else "note"
            elif parts[0] == "knowledge":
                want = "knowledge"
            elif parts[0] == "sessions":
                want = "session"
            elif parts[0] == "core":
                want = "core"
            if want and kind != want:
                add("TYPE_MISMATCH", f"{note.rel} type={kind or '?'} sebaiknya {want}")
        if kind in ("note", "decision", "knowledge") and not is_hub(note.rel) \
                and not inbound.get(note.key):
            add("ORPHAN", f"{note.rel} tidak ditautkan dari note mana pun")
        title = note.title.lower()
        if title in seen_titles:
            add("DUPLICATE", f"{note.rel} judul sama dengan {seen_titles[title]}")
        else:
            seen_titles[title] = note.rel
        project = note.fm.get("project")
        if project and project not in roots:
            roots[project] = project_root(vault, project)
        if note.is_stale_by_date():
            add("STALE", f"{note.rel} lewat review_after {note.fm.get('review_after')}")
        elif project and note.changed_sources(roots.get(project)):
            add("STALE", f"{note.rel} source berubah")
        if len(note.body) > REVIEW_BIG:
            add("BIG", f"{note.rel} {len(note.body)} karakter; pertimbangkan dipecah")
        if kind == "session" and not LINK_RE.search(note.body):
            add("UNDISTILLED", f"{note.rel} tanpa link; promosikan fakta durable bila ada")
        if name == "handoff.md" and note.fm.get("status") == "open":
            m = re.match(r"(\d{4}-\d{2}-\d{2})", str(note.fm.get("updated", "")))
            if m and (now_wib().date() - dt.date.fromisoformat(m.group(1))).days > HANDOFF_OLD_DAYS:
                add("HANDOFF_LAMA", f"{note.rel} open sejak {m.group(1)}")
    total = sum(len(v) for v in findings.values())
    for cat in ("TYPE_MISMATCH", "DUPLICATE", "STALE", "BIG", "ORPHAN",
                "UNDISTILLED", "HANDOFF_LAMA"):
        for line in findings.get(cat, []):
            print(f"{cat} {line}")
    print(f"review: {len(notes)} note diperiksa · {total} temuan" +
          (" · --all untuk semua project" if slug and not args.all else ""))


def cmd_move(args) -> None:
    vault = vault_root(args)
    src = Note(vault, resolve_note(vault, args.old))
    new_rel = args.new if args.new.endswith(".md") else args.new + ".md"
    dst = vault / new_rel
    is_trash = new_rel.startswith(".trash/") or new_rel == ".trash"

    if dst.exists() and not args.force:
        die(f"target sudah ada: {new_rel} (pakai --force untuk timpa)")
    if not is_trash and (new_rel.split("/", 1)[0] not in TOP_DIRS or "/.trash/" in f"/{new_rel}"):
        die(f"target harus di dalam {TOP_DIRS} atau .trash/: {new_rel}")
    if dst.resolve() == src.path.resolve():
        die("sumber dan target sama")

    old_key, new_key = src.key, new_rel[:-3]
    fm = dict(src.fm)
    parts = new_rel.split("/")
    if parts[0] == "projects" and len(parts) > 2:
        fm["project"] = parts[1]
        fm.pop("topic", None)
        if parts[2] == "decisions" and fm.get("type") == "note":
            fm["type"] = "decision"
        elif parts[2] == "notes" and fm.get("type") == "decision":
            fm["type"] = "note"
    elif parts[0] == "knowledge":
        fm["topic"] = parts[1] if len(parts) > 2 else fm.get("topic")
        fm.pop("project", None)
    fm["updated"] = today()
    write_atomic(dst, dump_fm(fm) + src.body.lstrip("\n"))
    src.path.unlink()

    if is_trash:
        referencing = []
        for note in iter_notes(vault, include_meta=True):
            for raw in LINK_RE.findall(note.body):
                target = raw.split("|", 1)[0].split("#", 1)[0].strip().removesuffix(".md")
                if target == old_key:
                    referencing.append(note.rel)
                    break
        msg = f"dipindah ke trash: {old_key}.md → {new_rel}"
        if referencing:
            msg += f" · PERINGATAN: {len(referencing)} note masih merujuk ke note ini ({', '.join(referencing)})"
        print(msg)
        return

    rewritten = 0
    for note in iter_notes(vault, include_meta=True):
        if note.path.resolve() == dst.resolve():
            continue

        def repl(m: re.Match) -> str:
            nonlocal rewritten
            raw = m.group(1)
            target, sep, alias = raw.partition("|")
            path, hsep, anchor = target.partition("#")
            if path.strip().removesuffix(".md") == old_key:
                rewritten += 1
                return f"[[{new_key}{hsep}{anchor}{sep}{alias}]]"
            return m.group(0)

        new_body = LINK_RE.sub(repl, note.body)
        if new_body != note.body:
            note.body = new_body
            note.save()
    print(f"dipindah: {old_key}.md → {new_rel} · {rewritten} link ditulis ulang")


# ---------------------------------------------------------------- migrate (legacy schema v2)

LEGACY_DIRS = ("memory", "codebases", "inbox")
LEGACY_FILES = ("vault-graph.md",)
CODEBASE_ALIASES = {
    "github-itdevakasha-awi_smd_v3": ("awi-smd-v3", "github.com/itdevakasha/awi_smd_v3"),
    "github-itdevakasha-pedro_mobile_apps": ("pedro-mobile", "github.com/itdevakasha/pedro_mobile_apps"),
}
LEGACY_TRASH = {
    "memory/README.md", "memory/inbox/README.md", "codebases/README.md", "vault-graph.md",
}


def legacy_target(rel: str) -> tuple[str | None, str, list[str]]:
    """Return (path baru atau None=trash, type baru, flags) untuk satu file legacy."""
    parts = rel.split("/")
    if rel in LEGACY_TRASH or rel.startswith("memory/meta/"):
        return None, "", []
    if rel == "memory/core/vault-memory-system.md":
        return "core/memory-rules.md", "core", ["rewrite: aturan lama, tulis ulang untuk sistem baru"]
    if parts[:2] == ["memory", "core"]:
        return f"core/{parts[2]}", "core", []
    if parts[:2] == ["memory", "knowledge"] and len(parts) == 4:
        if parts[3] == "index.md":
            return f"knowledge/{parts[2]}/{parts[2]}.md", "index", []
        return f"knowledge/{parts[2]}/{parts[3]}", "knowledge", []
    if (parts[:2] == ["memory", "inbox"] and len(parts) == 4) or (parts[0] == "inbox" and len(parts) == 3):
        date = parts[-2]
        target = f"sessions/{date[:7]}/{date}-recap-{Path(parts[-1]).stem[-6:]}.md"
        return target, "session", ["condense: ringkas jadi ≤10 baris / gabungkan recap sehari"]
    if parts[0] == "codebases" and len(parts) >= 3:
        slug = CODEBASE_ALIASES.get(parts[1], (parts[1], ""))[0]
        name = parts[-1]
        if len(parts) == 3 and name == "index.md":
            return f"projects/{slug}/{slug}.md", "index", []
        if "decisions" in name:
            clean = name.replace("-decisions", "").replace("decisions-", "")
            return f"projects/{slug}/decisions/{clean}", "decision", []
        return f"projects/{slug}/notes/{name}", "note", []
    return None, "", ["unmapped"]


def migrate_fm(fm: dict, kind: str, target: str) -> dict:
    new = {"type": kind}
    parts = target.split("/")
    if parts[0] == "projects":
        new["project"] = parts[1]
    elif fm.get("project"):
        project = str(fm["project"])
        new["project"] = CODEBASE_ALIASES.get(project, (project, ""))[0]
    if parts[0] == "knowledge":
        new["topic"] = parts[1]
    if kind != "session":
        new["status"] = "active" if fm.get("status") in (None, "", "active", "raw") else fm["status"]
    else:
        new["agent"] = "pi"
    new["updated"] = str(fm.get("checked") or fm.get("updated") or fm.get("date") or fm.get("captured") or today())
    if fm.get("review_after") and kind != "session":
        new["review_after"] = str(fm["review_after"])
    for key in ("tags", "aliases"):
        if fm.get(key):
            new[key] = as_list(fm[key])
    return new


def rewrite_links(body: str, mapping: dict[str, str | None], valid: set[str]) -> tuple[str, int]:
    changed = 0
    out_lines = []
    for line in body.splitlines():
        drop = False

        def repl(m: re.Match) -> str:
            nonlocal changed, drop
            raw = m.group(1)
            target, sep, alias = raw.partition("|")
            path, hsep, anchor = target.partition("#")
            path = path.strip().removesuffix(".md").removesuffix(".json")
            if path in mapping and mapping[path]:
                changed += 1
                return f"[[{mapping[path]}{hsep}{anchor}{sep}{alias}]]"
            if path not in valid:
                changed += 1
                if re.fullmatch(r"\s*[-*]\s*\[\[[^\]]+\]\]\s*", line):
                    drop = True
                return alias or path.rsplit("/", 1)[-1]
            return m.group(0)

        new_line = LINK_RE.sub(repl, line)
        if not drop:
            out_lines.append(new_line)
    return "\n".join(out_lines) + ("\n" if body.endswith("\n") else ""), changed


def cmd_migrate(args) -> None:
    vault = vault_root(args)
    legacy = []
    for name in LEGACY_DIRS:
        base = vault / name
        if base.is_dir():
            legacy += [p for p in sorted(base.rglob("*")) if p.is_file() and "__pycache__" not in p.parts]
    legacy += [vault / f for f in LEGACY_FILES if (vault / f).is_file()]
    if not legacy:
        print("tidak ada struktur lama untuk dimigrasi")
        return

    plan, mapping = [], {}
    for path in legacy:
        rel = path.relative_to(vault).as_posix()
        if path.suffix != ".md":
            plan.append((path, rel, None, "", ["non-markdown → trash"]))
            continue
        target, kind, flags = legacy_target(rel)
        if target and (vault / target).exists():
            flags = flags + ["conflict: target sudah ada, dilewati"]
            target = None
        plan.append((path, rel, target, kind, flags))
        mapping[rel.removesuffix(".md")] = target.removesuffix(".md") if target else None
    targets = [t for _, _, t, _, _ in plan if t]
    # Link ke path yang tidak akan ada setelah migrasi (mis. projects/my-pi-setup/overview) di-unwrap.
    valid = {t.removesuffix(".md") for t in targets} | {n.key for n in iter_notes(vault, include_meta=True)}
    dupes = {t for t in targets if targets.count(t) > 1}

    projects_cfg = {}
    legacy_cfg = Path(args.legacy_config).expanduser()
    if legacy_cfg.is_file():
        try:
            for path_str, slug in json.loads(legacy_cfg.read_text()).get("projectMap", {}).items():
                projects_cfg.setdefault(slug, {"paths": [], "remotes": []})["paths"].append(path_str)
        except (json.JSONDecodeError, OSError):
            pass
    for slug, remote in CODEBASE_ALIASES.values():
        projects_cfg.setdefault(slug, {"paths": [], "remotes": []})["remotes"].append(remote)

    moved = sum(1 for p in plan if p[2])
    print(f"{'APPLY' if args.apply else 'DRY-RUN'}: {len(plan)} file legacy · {moved} dipindah · {len(plan) - moved} ke trash")
    for _, rel, target, kind, flags in plan:
        arrow = f"→ {target} ({kind})" if target else "→ .trash"
        note = f"  [{'; '.join(flags)}]" if flags else ""
        print(f"  {rel} {arrow}{note}")
    if dupes:
        print("error: beberapa file menuju target yang sama: " + ", ".join(sorted(dupes)))
        sys.exit(1)
    print("projects.json:", json.dumps(projects_cfg, ensure_ascii=False))
    preview = 0
    for path, _, target, _, _ in plan:
        if target:
            preview += rewrite_links(parse_fm(path.read_text(encoding="utf-8", errors="replace"))[1], mapping, valid)[1]
    print(f"link yang akan ditulis ulang/di-unwrap: {preview}")
    if not args.apply:
        print("Jalankan ulang dengan --apply untuk mengeksekusi (file lama dipindah ke .trash, bukan dihapus).")
        return

    ensure_structure(vault)
    link_changes = 0
    for path, rel, target, kind, flags in plan:
        if not target:
            continue
        fm, body = parse_fm(path.read_text(encoding="utf-8-sig", errors="replace"))
        body, n = rewrite_links(body, mapping, valid)
        link_changes += n
        write_atomic(vault / target, dump_fm(migrate_fm(fm, kind, target)) + body.lstrip("\n"))

    pj = vault / "meta" / "projects.json"
    current = json.loads(pj.read_text()).get("projects", {}) if pj.exists() else {}
    for slug, cfg in projects_cfg.items():
        entry = current.setdefault(slug, {"paths": [], "remotes": []})
        for key in ("paths", "remotes"):
            entry[key] = sorted(set(entry.get(key, [])) | set(cfg[key]))
    write_atomic(pj, json.dumps({"projects": current}, indent=2, ensure_ascii=False) + "\n")

    trash = vault / ".trash" / f"agent-memory-migration-{now_wib().strftime('%Y%m%d-%H%M%S')}"
    trash.mkdir(parents=True)
    for name in LEGACY_DIRS + LEGACY_FILES:
        if (vault / name).exists():
            shutil.move(str(vault / name), str(trash / name))
    print(f"selesai: {moved} note ditulis · {link_changes} link ditulis ulang · legacy dipindah ke {trash.relative_to(vault)}")
    print("Lanjut: `memory lint`, lalu tangani item bertanda rewrite/condense.")


# ---------------------------------------------------------------- cli


def build_parser() -> argparse.ArgumentParser:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--vault", help="path vault (default: env AGENT_MEMORY_VAULT atau bawaan)")
    common.add_argument("--project", help="paksa slug project")
    common.add_argument("--cwd", help="direktori kerja untuk deteksi project")

    parser = argparse.ArgumentParser(prog="memory", description="Memory vault lintas agent.")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("init", parents=[common], help="buat struktur vault").set_defaults(func=cmd_init)
    sub.add_parser("status", parents=[common], help="vault, project aktif, jumlah note").set_defaults(func=cmd_status)

    p = sub.add_parser("brief", parents=[common], help="ringkasan awal sesi (dibatasi token)")
    p.add_argument("--max-tokens", type=int, default=300)
    p.add_argument("--show-tokens", action="store_true")
    p.set_defaults(func=cmd_brief)

    p = sub.add_parser("search", parents=[common], help="cari note; output path + TL;DR")
    p.add_argument("query")
    p.add_argument("--limit", type=int, default=5)
    p.add_argument("--all", action="store_true", help="semua project")
    p.add_argument("--sessions", action="store_true", help="ikutkan recap sesi")
    p.add_argument("--type", choices=NOTE_TYPES + ("index", "handoff"))
    p.add_argument("--include-old", action="store_true", help="ikutkan stale/superseded")
    p.set_defaults(func=cmd_search)

    p = sub.add_parser("read", parents=[common], help="baca note (outline bila besar)")
    p.add_argument("ref", help="path relatif vault atau nama file")
    p.add_argument("--section")
    p.add_argument("--full", action="store_true")
    p.set_defaults(func=cmd_read)

    p = sub.add_parser("save", parents=[common], help="simpan/ubah note dari stdin")
    p.add_argument("--type", choices=NOTE_TYPES)
    p.add_argument("--title")
    p.add_argument("--slug")
    p.add_argument("--topic", help="topik untuk type knowledge")
    p.add_argument("--path", help="ubah note yang sudah ada (path relatif vault)")
    p.add_argument("--section", help="ganti/tambah satu section saja")
    p.add_argument("--replace-body", action="store_true", help="timpa seluruh isi note yang sudah ada tanpa --section")
    p.add_argument("--tags", help="dipisah koma")
    p.add_argument("--sources", help="file repo dipisah koma; hash dicatat untuk deteksi stale")
    p.add_argument("--supersedes", help="decision lama yang digantikan")
    p.add_argument("--review-days", type=int)
    p.add_argument("--agent")
    p.set_defaults(func=cmd_save)

    p = sub.add_parser("handoff", parents=[common], help="tulis/lihat/claim baton project")
    p.add_argument("--show", action="store_true")
    p.add_argument("--claim", action="store_true")
    p.add_argument("--close", action="store_true")
    p.add_argument("--agent")
    p.set_defaults(func=cmd_handoff)

    p = sub.add_parser("lint", parents=[common], help="validasi vault + regenerate meta/index.md")
    p.add_argument("--no-index", action="store_true")
    p.set_defaults(func=cmd_lint)

    p = sub.add_parser("review", parents=[common], help="daftar temuan kerapian vault (read-only)")
    p.add_argument("--all", action="store_true", help="semua project")
    p.set_defaults(func=cmd_review)

    p = sub.add_parser("move", parents=[common], help="pindah note + tulis ulang link")
    p.add_argument("old", help="path lama (relatif vault atau nama file)")
    p.add_argument("new", help="path baru relatif vault")
    p.add_argument("--force", action="store_true")
    p.set_defaults(func=cmd_move)

    p = sub.add_parser("migrate", parents=[common], help="migrasi struktur vault lama (schema v2)")
    p.add_argument("--apply", action="store_true")
    p.add_argument("--legacy-config", default="~/.pi/agent/obsidian-memory.json")
    p.set_defaults(func=cmd_migrate)
    return parser


def main(argv: list[str] | None = None) -> None:
    args = build_parser().parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
