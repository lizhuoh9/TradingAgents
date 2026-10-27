import sys

from memory_transaction import MemoryTransaction


if __name__ == "__main__":
    MemoryTransaction.resume(sys.argv[1], sys.argv[2]).commit()
