#!/usr/bin/env python3
"""
Thin wrapper the LocalMusic plugin spawns to drive a SpotiFLAC-py install.

Nothing is vendored: `--lib` points at your own spotiflac-py directory (the one
containing the `spotiflac/` package) and everything - providers, backends,
authentication - comes from there. This file adds only the one thing the plugin
needs and upstream's cli.py does not do: progress.

Upstream passes `progress=lambda d, t: None`, so a download is a black box until
it finishes. The plugin draws a bar per job, so this speaks a line protocol on
stdout instead - one prefixed record per line, flushed as it happens:

    [log] <free text from the library>
    [progress] <0-100>
    [done] <absolute path>
    [error] <message>
    [break] <seconds or -1>          backend is on a scheduled break
    [session] <status text>          oss backend only

Exit codes: 0 done, 1 error, 2 scheduled break, 3 auth missing/expired,
            4 the library could not be loaded from --lib.
"""

import argparse
import os
import sys

# Electron reads this over a pipe, and on Windows a piped stdout falls back to the
# locale codepage - which mangles the em-dashes the library logs into "?" long
# before they reach the download row.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def emit(kind, text=""):
    # one line, no embedded newlines - the reader splits on \n
    line = str(text).replace("\r", " ").replace("\n", " ")
    sys.stdout.write(f"[{kind}] {line}\n")
    sys.stdout.flush()


def load_library(lib):
    """Import spotiflac out of the user's own directory."""
    if not lib:
        emit("error", "No SpotiFLAC folder set - point the plugin at your "
                      "spotiflac-py directory in the settings.")
        return None

    lib = os.path.abspath(os.path.expanduser(lib))
    if not os.path.isdir(os.path.join(lib, "spotiflac")):
        emit("error", f"No 'spotiflac' package inside {lib} - the path should be the "
                      "spotiflac-py folder itself (the one with cli.py in it).")
        return None

    sys.path.insert(0, lib)
    try:
        import spotiflac
        return spotiflac
    except ImportError as e:
        emit("error", f"Could not import spotiflac from {lib}: {e}")
        return None


def check_deps(backend, lib_root):
    """
    Fail here rather than three minutes into a download. `python` on Windows is
    often a virtualenv shim with a different site-packages than the one you ran
    pip in, so name the interpreter that is actually short.
    """
    if backend != "next":
        return True  # the oss path is stdlib + hmac only

    try:
        import cryptography  # noqa: F401
        return True
    except ImportError:
        emit("error", "The 'next' backend needs the 'cryptography' package. Install it "
                      f"for this interpreter: \"{sys.executable}\" -m pip install cryptography")
        return False


def main():
    ap = argparse.ArgumentParser(description="SpotiFLAC download for LocalMusic")
    ap.add_argument("url", nargs="?", default="", help="Spotify track URL or id")
    ap.add_argument("--lib", required=True, help="path to your spotiflac-py directory")
    ap.add_argument("-q", "--quality", default="16", choices=["16", "24", "atmos"])
    ap.add_argument("-o", "--out", required=True)
    ap.add_argument("--order", default="tidal,qobuz,amazon")
    ap.add_argument("--backend", default="next", choices=["next", "oss"])
    ap.add_argument("--session", default="", help="oss session file, or empty for the default")
    ap.add_argument("--no-tag", action="store_true")
    ap.add_argument("--probe", action="store_true",
                    help="report library and auth status, then exit")
    args = ap.parse_args()

    sf = load_library(args.lib)
    if sf is None:
        return 4

    from spotiflac.errors import ScheduledBreak, SessionInvalid, SpotiflacError

    if not check_deps(args.backend, args.lib):
        return 3

    # only the oss backend takes a session; next authenticates itself inside the
    # library, so this wrapper never sees or handles a credential
    session = None
    if args.backend == "oss":
        try:
            session = sf.Session.load(args.session) if args.session.strip() else sf.Session.load()
            emit("session", session.status_text())
            if not session.is_valid():
                emit("error", "Session expired - re-verify in the SpotiFLAC desktop app")
                return 3
        except SpotiflacError as e:
            emit("error", e)
            return 3

    if args.probe:
        return 0
    if not args.url:
        emit("error", "No URL given.")
        return 1

    os.makedirs(args.out, exist_ok=True)

    # the library reports bytes; the plugin's bar wants whole percent, and
    # repeating the same integer just spams the pipe
    last = [-1]

    def progress(done, total):
        if not total:
            return
        percent = min(100, int(done * 100 / total))
        if percent != last[0]:
            last[0] = percent
            emit("progress", percent)

    try:
        result = sf.download_track(
            session, args.url, args.out, args.quality,
            order=[p.strip() for p in args.order.split(",") if p.strip()],
            tag=not args.no_tag,
            backend=args.backend,
            progress=progress,
            log=lambda msg: emit("log", msg),
        )
    except ScheduledBreak as e:
        emit("break", getattr(e, "seconds", 0) or -1)
        emit("error", f"Backend is on a scheduled break: {e}")
        return 2
    except SessionInvalid as e:
        emit("error", f"Session rejected: {e}")
        return 3
    except SpotiflacError as e:
        emit("error", e)
        return 1
    except Exception as e:  # noqa: BLE001 - the caller only ever sees stdout
        emit("error", f"{type(e).__name__}: {e}")
        return 1

    emit("done", os.path.abspath(result.path))
    return 0


if __name__ == "__main__":
    sys.exit(main())
