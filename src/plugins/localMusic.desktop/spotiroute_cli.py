#!/usr/bin/env python3
"""
Thin wrapper the LocalMusic plugin spawns to drive your own spotiroute.py.

Nothing is vendored: `--script` points at your copy of spotiroute.py and every
provider, router and credential comes from there. This file adds only the two
things the plugin needs and spotiroute's own main() does not offer: a progress
bar, and a machine-readable answer to "where did the file go".

    python3 spotiroute_cli.py <spotify-url-or-id> --script /path/spotiroute.py
                              -o OUTDIR [-q 16|24|atmos] [--order tidal,qobuz]
                              [--no-tag] [--probe]

It speaks the plugin's line protocol on stdout - one prefixed record per line,
flushed as it happens:

    [log] <free text from spotiroute>
    [progress] <0-100>
    [done] <absolute path>
    [error] <message>
    [break] <seconds or -1>          the router is on a scheduled break

Exit codes: 0 done, 1 error, 2 scheduled break,
            4 spotiroute.py could not be loaded from --script.
"""

import argparse
import importlib.util
import os
import sys

# Electron reads this over a pipe, and on Windows a piped stdout falls back to
# the locale codepage - which mangles the em-dashes and accented artist names
# spotiroute logs into "?" long before they reach the download row.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def emit(kind, text=""):
    # one line, no embedded newlines - the reader splits on \n
    line = str(text).replace("\r", " ").replace("\n", " ")
    sys.stdout.write("[" + kind + "] " + line + "\n")
    sys.stdout.flush()


def load_script(path):
    """Import spotiroute.py from wherever the user actually keeps it."""
    if not path:
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "spotiroute.py")

    path = os.path.abspath(os.path.expanduser(path))
    if not os.path.isfile(path):
        emit("error", "No spotiroute.py at " + path + " - point the plugin at your copy "
                      "of the script in the tool's arguments.")
        return None

    try:
        spec = importlib.util.spec_from_file_location("spotiroute", path)
        module = importlib.util.module_from_spec(spec)
        # registered before exec so a module that imports itself still resolves
        sys.modules["spotiroute"] = module
        spec.loader.exec_module(module)
    except Exception as e:
        emit("error", "Could not load " + path + ": " + type(e).__name__ + ": " + str(e))
        return None

    missing = [name for name in ("resolve", "FETCHERS", "Err", "ScheduledBreak", "tag_file") if not hasattr(module, name)]
    if missing:
        emit("error", path + " doesn't look like spotiroute.py (no " + ", ".join(missing) + ")")
        return None

    return module


def main():
    ap = argparse.ArgumentParser(description="spotiroute download for LocalMusic")
    ap.add_argument("url", nargs="?", default="", help="Spotify track URL or id")
    ap.add_argument("--script", default="", help="path to your spotiroute.py")
    ap.add_argument("-q", "--quality", default="16", choices=["16", "24", "atmos"])
    ap.add_argument("-o", "--out", required=True)
    ap.add_argument("--order", default="tidal,qobuz,amazon")
    ap.add_argument("--no-tag", action="store_true")
    ap.add_argument("--probe", action="store_true",
                    help="report whether the script loads, then exit")
    args = ap.parse_args()

    sr = load_script(args.script)
    if sr is None:
        return 4
    if args.probe:
        emit("log", "spotiroute loaded, router " + getattr(sr, "ROUTER_URL", "?"))
        return 0
    if not args.url:
        emit("error", "No URL given.")
        return 1

    os.makedirs(args.out, exist_ok=True)

    try:
        track = sr.resolve(args.url)
    except sr.Err as e:
        emit("error", "Could not resolve the track: " + str(e))
        return 1

    emit("log", track.artist + " - " + track.title + "  " + str(track.providers()))

    # spotiroute reports bytes; the plugin's bar wants whole percent, and
    # repeating the same integer just spams the pipe
    last = [-1]

    def progress(done, total):
        if not total:
            return
        percent = min(100, int(done * 100 / total))
        if percent != last[0]:
            last[0] = percent
            emit("progress", percent)

    def log(message):
        emit("log", message)

    last_error = None
    for name in [p.strip() for p in args.order.split(",") if p.strip()]:
        fetch = sr.FETCHERS.get(name)
        if not fetch:
            continue
        # the same skips spotiroute's own main() makes: a provider that has no id
        # for this track can only fail, slowly
        if name == "tidal" and not track.tidal_id:
            continue
        if name == "amazon" and not track.amazon_asin:
            continue

        last[0] = -1
        emit("log", "trying " + name)

        try:
            path, container = fetch(track, args.out, args.quality, progress, log)
        except sr.ScheduledBreak as e:
            emit("break", getattr(e, "seconds", 0) or -1)
            emit("error", "The router is on a scheduled break: " + str(e))
            return 2
        except sr.Err as e:
            emit("log", name + " failed: " + str(e))
            last_error = e
            continue
        except Exception as e:
            emit("log", name + " failed: " + type(e).__name__ + ": " + str(e))
            last_error = e
            continue

        if not args.no_tag:
            try:
                if sr.tag_file(path, track, container):
                    emit("log", "tagged")
            except Exception as e:
                # an untagged file still plays; the library just falls back to its name
                emit("log", "could not tag: " + type(e).__name__ + ": " + str(e))

        emit("progress", 100)
        emit("done", os.path.abspath(path))
        return 0

    emit("error", "All providers failed" + (": " + str(last_error) if last_error else ""))
    return 1


if __name__ == "__main__":
    sys.exit(main())
