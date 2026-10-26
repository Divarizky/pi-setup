"""Test end-to-end memory.py di vault dan repo git sementara. Jalankan: python3 -m unittest discover tests"""

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "memory.py"


class MemoryTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.vault = base / "vault"
        self.vault.mkdir()
        self.repo = base / "work" / "awi_smd_v3"
        (self.repo / "app").mkdir(parents=True)
        (self.repo / "app" / "Sync.kt").write_text("fun sync() = retry(3)\n")
        subprocess.run(["git", "init", "-q", str(self.repo)], check=True)
        subprocess.run(["git", "-C", str(self.repo), "remote", "add", "origin",
                        "git@github.com:itdevakasha/awi_smd_v3.git"], check=True)
        self.env = {**os.environ, "AGENT_MEMORY_VAULT": str(self.vault), "AGENT_MEMORY_AGENT": "test"}
        self.run_ok("init")

    def tearDown(self):
        self.tmp.cleanup()

    def run_cmd(self, *args, stdin=None, cwd=None):
        return subprocess.run([sys.executable, str(SCRIPT), *args], input=stdin, text=True,
                              capture_output=True, env=self.env, cwd=cwd or self.repo)

    def run_ok(self, *args, stdin=None, cwd=None):
        r = self.run_cmd(*args, stdin=stdin, cwd=cwd)
        self.assertEqual(r.returncode, 0, msg=f"{args}\nstdout:{r.stdout}\nstderr:{r.stderr}")
        return r.stdout

    def save_note(self):
        return self.run_ok("save", "--type", "note", "--title", "Sync retry", "--tags", "sync",
                           "--sources", "app/Sync.kt",
                           stdin="## TL;DR\n- Retry sync 3x.\n\n## Crux\n`retry(3)`\n")

    def test_review_and_move(self):
        self.run_ok("save", "--type", "note", "--title", "Sama", "--slug", "satu",
                    stdin="## TL;DR\n- A.\n")
        self.run_ok("save", "--type", "note", "--title", "sama", "--slug", "dua",
                    stdin="## TL;DR\n- B.\n")
        # Orphan ditulis langsung (tanpa save) supaya tidak ikut ter-link dari hub.
        (self.vault / "projects/awi-smd-v3/notes/orphan.md").write_text(
            "---\ntype: note\nproject: awi-smd-v3\nstatus: active\nupdated: 2026-10-04\n" +
            "review_after: 2027-04-04\n---\n# Orphan\n\n## TL;DR\n- O.\n", encoding="utf-8")
        out = self.run_ok("review")
        self.assertIn("DUPLICATE", out)
        self.assertIn("ORPHAN", out)
        self.run_ok("save", "--type", "note", "--title", "Induk",
                    stdin="## TL;DR\n- I.\n\n## Links\n- [[projects/awi-smd-v3/notes/orphan]]\n")
        out = self.run_ok("review")
        orphans = [l for l in out.splitlines() if l.startswith("ORPHAN")]
        self.assertNotIn("notes/orphan", " ".join(orphans))
        self.run_ok("move", "projects/awi-smd-v3/notes/dua", "projects/awi-smd-v3/decisions/dua")
        moved = self.vault / "projects/awi-smd-v3/decisions/dua.md"
        self.assertTrue(moved.exists())
        self.assertFalse((self.vault / "projects/awi-smd-v3/notes/dua.md").exists())
        text = moved.read_text()
        self.assertIn("type: decision", text)
        r = self.run_cmd("move", "projects/awi-smd-v3/notes/orphan", "projects/awi-smd-v3/notes/orphan")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("0 error", self.run_ok("lint"))

    def test_hub_named_after_folder_with_legacy_fallback(self):
        legacy = self.vault / "projects/awi-smd-v3/index.md"
        legacy.parent.mkdir(parents=True)
        legacy.write_text("---\ntype: index\nproject: awi-smd-v3\n---\n# AWI\n\n## TL;DR\n- Hub lama.\n")
        self.save_note()
        self.assertFalse((self.vault / "projects/awi-smd-v3/awi-smd-v3.md").exists())
        self.assertIn("[[projects/awi-smd-v3/notes/sync-retry]]", legacy.read_text())
        self.assertIn("Hub lama.", self.run_ok("brief"))
        self.run_ok("move", "projects/awi-smd-v3/index", "projects/awi-smd-v3/awi-smd-v3")
        note = (self.vault / "projects/awi-smd-v3/notes/sync-retry.md").read_text()
        self.assertIn("[[projects/awi-smd-v3/awi-smd-v3]]", note)
        self.assertNotIn("ORPHAN projects/awi-smd-v3/awi-smd-v3", self.run_ok("review"))
        self.assertIn("0 error", self.run_ok("lint"))

    def test_files_written_with_lf(self):
        self.save_note()
        raw = (self.vault / "projects/awi-smd-v3/notes/sync-retry.md").read_bytes()
        self.assertNotIn(b"\r", raw)

    def test_project_detected_from_git_remote(self):
        self.assertIn("project: awi-smd-v3", self.run_ok("status"))

    def test_portable_paths_and_vault_env(self):
        import json
        cfg = json.loads((self.vault / "meta/projects.json").read_text())
        cfg["projects"]["portable-proj"] = {"paths": ["$AGENT_MEMORY_TEST_HOME/portable"], "remotes": []}
        (self.vault / "meta/projects.json").write_text(json.dumps(cfg))
        (Path(self.tmp.name) / "portable").mkdir()
        env = {**self.env, "AGENT_MEMORY_TEST_HOME": self.tmp.name}
        r = subprocess.run([sys.executable, str(SCRIPT), "status"], capture_output=True, text=True,
                           env=env, cwd=str(Path(self.tmp.name) / "portable"))
        self.assertEqual(r.returncode, 0, msg=r.stderr)
        self.assertIn("project: portable-proj", r.stdout)
        # Vault yang disebut eksplisit tapi tidak ada -> error yang jelas.
        r2 = self.run_cmd("status", "--vault", str(Path(self.tmp.name) / "nope"))
        self.assertNotEqual(r2.returncode, 0)
        self.assertIn("vault tidak ditemukan", r2.stderr)

    def test_save_creates_hub_links_and_hash(self):
        out = self.save_note()
        self.assertIn("disimpan: projects/awi-smd-v3/notes/sync-retry.md", out)
        note = (self.vault / "projects/awi-smd-v3/notes/sync-retry.md").read_text()
        self.assertRegex(note, r"app/Sync\.kt#[0-9a-f]{12}")
        self.assertIn("[[projects/awi-smd-v3/awi-smd-v3]]", note)
        hub = (self.vault / "projects/awi-smd-v3/awi-smd-v3.md").read_text()
        self.assertIn("[[projects/awi-smd-v3/notes/sync-retry]]", hub)

    def test_save_requires_tldr(self):
        r = self.run_cmd("save", "--type", "note", "--title", "x", stdin="tanpa ringkasan\n")
        self.assertEqual(r.returncode, 2)
        self.assertIn("TL;DR", r.stderr)

    def test_redaction(self):
        out = self.run_ok("save", "--type", "note", "--title", "Creds",
                          stdin="## TL;DR\n- api_key=abcdef1234567890 dan ghp_" + "a" * 36 + "\n")
        self.assertIn("redaksi: 2", out)
        text = (self.vault / "projects/awi-smd-v3/notes/creds.md").read_text()
        self.assertNotIn("abcdef1234567890", text)
        self.assertNotIn("ghp_", text)

    def test_search_returns_tldr_and_flags_changed_source(self):
        self.save_note()
        out = self.run_ok("search", "retry sync")
        self.assertIn("projects/awi-smd-v3/notes/sync-retry.md", out)
        self.assertIn("Retry sync 3x.", out)
        self.assertNotIn("Crux", out)
        (self.repo / "app" / "Sync.kt").write_text("fun sync() = retry(5)\n")
        self.assertIn("source-changed", self.run_ok("search", "retry"))
        self.assertIn("Stale (1): sync-retry", self.run_ok("brief"))

    def test_search_broadens_to_other_projects(self):
        self.save_note()
        other = Path(self.tmp.name) / "plain"
        other.mkdir()
        subprocess.run(["git", "init", "-q", str(other)], check=True)
        out = self.run_ok("search", "retry", cwd=other)
        self.assertIn("semua project", out)
        self.assertIn("sync-retry", out)

    def test_section_update_and_read(self):
        self.save_note()
        self.run_ok("save", "--path", "projects/awi-smd-v3/notes/sync-retry", "--section", "Gotchas",
                    stdin="- 4xx tidak di-retry.\n")
        out = self.run_ok("read", "sync-retry", "--section", "Gotchas")
        self.assertIn("4xx tidak di-retry", out)
        self.assertNotIn("Crux", out)
        text = (self.vault / "projects/awi-smd-v3/notes/sync-retry.md").read_text()
        self.assertLess(text.index("## Gotchas"), text.index("## Links"))

    def test_read_large_note_shows_outline(self):
        body = "## TL;DR\n- Besar.\n\n## Detail\n" + ("isi panjang. " * 700) + "\n\n## Lain\n- x\n"
        self.run_ok("save", "--type", "note", "--title", "Besar", stdin=body)
        out = self.run_ok("read", "besar")
        self.assertIn("Sections:", out)
        self.assertIn("- Detail (~", out)
        self.assertNotIn("isi panjang. isi panjang.", out)

    def test_decision_supersede(self):
        self.run_ok("save", "--type", "decision", "--title", "Pakai MCP", stdin="## TL;DR\n- MCP.\n")
        self.run_ok("save", "--type", "decision", "--title", "Pakai skill",
                    "--supersedes", "projects/awi-smd-v3/decisions/pakai-mcp",
                    stdin="## TL;DR\n- Skill + script.\n")
        old = (self.vault / "projects/awi-smd-v3/decisions/pakai-mcp.md").read_text()
        self.assertIn("status: superseded", old)
        self.assertIn("superseded_by: projects/awi-smd-v3/decisions/pakai-skill", old)
        self.assertNotIn("pakai-mcp", self.run_ok("search", "pakai"))
        self.assertIn("pakai-mcp", self.run_ok("search", "pakai", "--include-old"))

    def test_handoff_cycle_and_brief(self):
        self.run_ok("handoff", stdin="## Next\n- Lanjut migrasi.\n## Failed\n- Regex parser gagal.\n")
        brief = self.run_ok("brief")
        self.assertIn("Handoff open (test", brief)
        self.assertIn("Next: Lanjut migrasi.", brief)
        out = self.run_ok("handoff", "--claim")
        self.assertIn("claimed", out)
        self.assertNotIn("Handoff open", self.run_ok("brief"))

    def test_brief_respects_budget(self):
        for i in range(12):
            self.run_ok("save", "--type", "core", "--title", f"Pref {i}",
                        stdin="## TL;DR\n" + "".join(f"- Aturan panjang nomor {i}-{j} " + "x" * 80 + "\n" for j in range(5)))
        out = self.run_ok("brief", "--max-tokens", "200")
        self.assertLessEqual(len(out), 200 * 3.5 + 200)  # footer dan marker boleh sedikit lewat
        self.assertIn("…(+", out)
        self.assertIn("memory search", out)

    def test_lint_detects_broken_link(self):
        self.save_note()
        self.assertIn("0 error", self.run_ok("lint"))
        self.run_ok("save", "--path", "projects/awi-smd-v3/notes/sync-retry", "--section", "See",
                    stdin="- [[projects/awi-smd-v3/notes/tidak-ada]]\n")
        r = self.run_cmd("lint")
        self.assertEqual(r.returncode, 1)
        self.assertIn("link rusak", r.stdout)
        self.assertTrue((self.vault / "meta/index.md").exists())

    def test_migrate_legacy_layout(self):
        legacy = {
            "memory/core/user-preferences.md": "---\ntype: core\nmemory: always\nchecked: 2026-09-19\n---\n# Prefs\n\n## TL;DR\n- Bahasa Indonesia.\n",
            "memory/knowledge/pi-agent/index.md": "---\ntype: knowledge\n---\n# Pi\n\n## TL;DR\n- Hub.\n\n## Related\n- [[codebases/my-pi-setup/notes/setup]]\n- [[memory/meta/index]]\n",
            "codebases/my-pi-setup/index.md": "---\ntype: knowledge\nproject: my-pi-setup\n---\n# Setup\n\n## TL;DR\n- Hub.\n\nLihat [[memory/meta/migration-report|laporan]].\n",
            "codebases/my-pi-setup/notes/setup.md": "---\ntype: knowledge\n---\n# Setup\n\n## TL;DR\n- Setup.\n\n- [[memory/knowledge/pi-agent/index]]\n",
            "codebases/my-pi-setup/notes/extension-decisions.md": "---\ntype: knowledge\n---\n# Ext\n\n## TL;DR\n- Ext.\n",
            "inbox/2026-10-03/abc.md": "---\ntype: pi-memory-inbox\n---\n# Recap\n\n## TL;DR\n- Recap.\n\n- [[projects/my-pi-setup/overview]]\n",
            "memory/meta/index.md": "# Index\n",
            "vault-graph.md": "# Graph\n",
        }
        for rel, text in legacy.items():
            (self.vault / rel).parent.mkdir(parents=True, exist_ok=True)
            (self.vault / rel).write_text(text)
        dry = self.run_ok("migrate", "--legacy-config", "/nonexistent")
        self.assertIn("DRY-RUN", dry)
        self.assertTrue((self.vault / "memory").exists())
        self.run_ok("migrate", "--apply", "--legacy-config", "/nonexistent")
        self.assertFalse((self.vault / "memory").exists())
        self.assertTrue((self.vault / "projects/my-pi-setup/decisions/extension.md").exists())
        self.assertTrue((self.vault / "sessions/2026-10/2026-10-03-recap-abc.md").exists())
        pi_index = (self.vault / "knowledge/pi-agent/pi-agent.md").read_text()
        self.assertIn("[[projects/my-pi-setup/notes/setup]]", pi_index)
        self.assertNotIn("memory/meta/index", pi_index)
        self.assertIn("Lihat laporan.", (self.vault / "projects/my-pi-setup/my-pi-setup.md").read_text())
        self.assertNotIn("memory: always", (self.vault / "core/user-preferences.md").read_text())
        self.assertTrue(any((self.vault / ".trash").glob("agent-memory-migration-*/memory")))
        lint = self.run_cmd("lint")
        self.assertNotIn("link rusak", lint.stdout)


if __name__ == "__main__":
    unittest.main()
