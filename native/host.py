"""Native Messaging host: runs Xray-core on behalf of the Every Proxy extension.

Protocol: 4-byte little-endian length + UTF-8 JSON, both directions.
  {"cmd": "start", "config": {...}}  -> {"ok": true}   (starts/restarts xray)
  {"cmd": "stop"}                    -> {"ok": true}
  {"cmd": "status"}                  -> {"ok": true, "core": bool}  (is xray.exe installed?)
  {"cmd": "ping", "targets": [{"id", "host", "port"}]} -> {"ok": true, "results": {id: ms | -1}}
The core is also killed when the browser closes the pipe.
"""
import json
import os
import socket
import struct
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(os.environ.get("LOCALAPPDATA", HERE), "EveryProxy")
XRAY = os.path.join(HERE, "core", "xray.exe")
CONFIG = os.path.join(DATA, "config.json")

proc = None


def read_msg():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    size = struct.unpack("<I", raw)[0]
    return json.loads(sys.stdin.buffer.read(size).decode("utf-8"))


def send(obj):
    data = json.dumps(obj).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)) + data)
    sys.stdout.buffer.flush()


def stop():
    global proc
    if proc and proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()
    proc = None


def start(config):
    global proc
    stop()
    if not os.path.isfile(XRAY):
        raise RuntimeError("xray.exe not found. Run install.ps1 to download it.")
    os.makedirs(DATA, exist_ok=True)
    with open(CONFIG, "w", encoding="utf-8") as f:
        json.dump(config, f)
    proc = subprocess.Popen(
        [XRAY, "run", "-c", CONFIG],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL,
        creationflags=0x08000000,  # CREATE_NO_WINDOW
    )
    time.sleep(0.8)  # give xray a moment to fail fast on a bad config or busy port
    if proc.poll() is not None:
        out = proc.stdout.read().decode("utf-8", "replace").strip()
        proc = None
        raise RuntimeError(out.splitlines()[-1] if out else "xray exited immediately")


def ping(targets):
    """TCP connect time to each server in ms, or -1 on failure/timeout."""
    results = {}

    def one(t):
        t0 = time.perf_counter()
        try:
            with socket.create_connection((t["host"], int(t["port"])), timeout=3):
                results[t["id"]] = round((time.perf_counter() - t0) * 1000)
        except OSError:
            results[t["id"]] = -1

    threads = [threading.Thread(target=one, args=(t,)) for t in targets]
    for th in threads:
        th.start()
    for th in threads:
        th.join()
    return results


def main():
    try:
        while True:
            msg = read_msg()
            if msg is None:
                break
            try:
                if msg.get("cmd") == "start":
                    start(msg["config"])
                elif msg.get("cmd") == "stop":
                    stop()
                elif msg.get("cmd") == "status":
                    send({"ok": True, "core": os.path.isfile(XRAY)})
                    continue
                elif msg.get("cmd") == "ping":
                    send({"ok": True, "results": ping(msg.get("targets", []))})
                    continue
                send({"ok": True})
            except Exception as e:  # report to the extension instead of dying
                send({"ok": False, "error": str(e)})
    finally:
        stop()


if __name__ == "__main__":
    main()
