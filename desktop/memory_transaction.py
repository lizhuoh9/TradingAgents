"""Stage official shared history so an interrupted run cannot truncate it."""

import hashlib
import os
import tempfile
from pathlib import Path

from tradingagents.dataflows.files import locked


def _read(path):
    return path.read_bytes() if path.exists() else None


def _digest(data):
    return hashlib.sha256(data).digest() if data is not None else None


class MemoryTransaction:
    def __init__(self, target, working):
        self.target = Path(target)
        self.working = Path(working)
        self.target.parent.mkdir(parents=True, exist_ok=True)
        self.working.parent.mkdir(parents=True, exist_ok=True)
        with locked(self.target):
            data = _read(self.target)
            self.original_digest = _digest(data)
            if data is not None:
                self.working.write_bytes(data)
            baseline = self.working.with_name(self.working.name + ".baseline")
            baseline.write_text(self.original_digest.hex() if self.original_digest else "absent", encoding="ascii")

    @classmethod
    def resume(cls, target, working):
        transaction = cls.__new__(cls)
        transaction.target = Path(target)
        transaction.working = Path(working)
        baseline = transaction.working.with_name(transaction.working.name + ".baseline").read_text(encoding="ascii")
        if baseline == "absent":
            transaction.original_digest = None
        else:
            digest = bytes.fromhex(baseline)
            if len(digest) != hashlib.sha256().digest_size:
                raise ValueError("历史记录的基线摘要无效")
            transaction.original_digest = digest
        return transaction

    def commit(self):
        if not self.working.exists():
            if self.original_digest is not None:
                raise RuntimeError("本次历史副本缺失，未覆盖共享历史")
            return
        data = self.working.read_bytes()
        with locked(self.target):
            if _digest(_read(self.target)) != self.original_digest:
                raise RuntimeError("共享历史已被其他程序更改；已保留本次副本，未覆盖共享历史")
            name = None
            try:
                with tempfile.NamedTemporaryFile(dir=self.target.parent, prefix=".history-", suffix=".tmp", delete=False) as handle:
                    name = handle.name
                    handle.write(data)
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(name, self.target)
            finally:
                if name and os.path.exists(name):
                    os.unlink(name)
