import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from memory_transaction import MemoryTransaction


class MemoryTransactionTests(unittest.TestCase):
    def test_commit_and_conflict_preserve_history(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            shared = root / "shared" / "history.md"
            shared.parent.mkdir()
            shared.write_text("old", encoding="utf-8")
            transaction = MemoryTransaction(shared, root / "run" / "history.md")
            transaction.working.write_text("new", encoding="utf-8")
            self.assertEqual(shared.read_text(encoding="utf-8"), "old")
            MemoryTransaction.resume(shared, transaction.working).commit()
            self.assertEqual(shared.read_text(encoding="utf-8"), "new")

            conflict = MemoryTransaction(shared, root / "next" / "history.md")
            conflict.working.write_text("candidate", encoding="utf-8")
            shared.write_text("external change", encoding="utf-8")
            with self.assertRaises(RuntimeError):
                MemoryTransaction.resume(shared, conflict.working).commit()
            self.assertEqual(shared.read_text(encoding="utf-8"), "external change")
            self.assertEqual(conflict.working.read_text(encoding="utf-8"), "candidate")

            missing = MemoryTransaction(shared, root / "missing" / "history.md")
            missing.working.unlink()
            with self.assertRaises(RuntimeError):
                MemoryTransaction.resume(shared, missing.working).commit()
            self.assertEqual(shared.read_text(encoding="utf-8"), "external change")

    def test_unexpected_exit_does_not_publish_working_copy(self):
        with tempfile.TemporaryDirectory() as tmp:
            shared = Path(tmp) / "history.md"
            working = Path(tmp) / "run" / "history.md"
            shared.write_text("original", encoding="utf-8")
            code = (
                "import os, sys; from memory_transaction import MemoryTransaction; "
                "t=MemoryTransaction(sys.argv[1], sys.argv[2]); "
                "t.working.write_text('partial', encoding='utf-8'); os._exit(9)"
            )
            result = subprocess.run([sys.executable, "-c", code, str(shared), str(working)],
                                    cwd=Path(__file__).parent, env={**os.environ, "PYTHON_DOTENV_DISABLED": "1"})
            self.assertEqual(result.returncode, 9)
            self.assertEqual(shared.read_text(encoding="utf-8"), "original")
            self.assertEqual(working.read_text(encoding="utf-8"), "partial")


if __name__ == "__main__":
    unittest.main()
