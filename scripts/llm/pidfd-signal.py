#!/usr/bin/env python3
"""Signal one exact Linux process identity without a PID-reuse race."""

import os
import signal
import sys


def process_start_time_ticks(pid: int) -> str:
    with open(f"/proc/{pid}/stat", encoding="utf-8") as process_stat:
        raw = process_stat.read()
    command_end = raw.rfind(")")
    if command_end < 0:
        raise RuntimeError("malformed /proc process stat")
    fields_after_command = raw[command_end + 1 :].strip().split()
    if len(fields_after_command) <= 19 or not fields_after_command[19].isdigit():
        raise RuntimeError("missing process start time in /proc process stat")
    return fields_after_command[19]


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: pidfd-signal.py PID EXPECTED_START_TIME_TICKS")
    pid = int(sys.argv[1])
    expected_start_time = sys.argv[2]
    if pid <= 0 or not expected_start_time.isdigit() or int(expected_start_time) <= 0:
        raise SystemExit("PID and expected start time must be positive decimal integers")

    pidfd = os.pidfd_open(pid, 0)
    try:
        # Opening a pidfd pins the process object. Re-check the proc identity after
        # opening it so a reuse between TypeScript verification and pidfd_open fails.
        if process_start_time_ticks(pid) != expected_start_time:
            raise RuntimeError("process identity changed before shutdown signal")
        signal.pidfd_send_signal(pidfd, signal.SIGTERM)
    finally:
        os.close(pidfd)


if __name__ == "__main__":
    main()
