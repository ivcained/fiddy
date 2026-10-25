import os
import subprocess


ACTIONS = {
    "console": "console",
    "status": "console",
    "sync": "console",
    "logs": "console",
    "start": "console",
    "stop": "console",
    "grafana": "grafana",
    "fid-setup": "console",
    "settings": "console",
    "auto-upgrade": "console",
}


def open_pane(action, herdr_bin=None, plugin_id="fun.fiddy.console"):
    if action not in ACTIONS:
        raise ValueError("Unknown Fiddy console action: %s" % action)
    binary = herdr_bin or os.environ.get("HERDR_BIN_PATH", "herdr")
    entrypoint = ACTIONS[action]
    if os.name == "nt":
        entrypoint += "-windows"
    argv = [
        binary, "plugin", "pane", "open", "--plugin", plugin_id,
        "--entrypoint", entrypoint, "--focus",
    ]
    if entrypoint == "console":
        argv.extend(["--env", "FIDDY_CONSOLE_ACTION=" + action])
    result = subprocess.run(argv, check=False)
    return result.returncode


def main(argv=None):
    import sys
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) != 1 or args[0] not in ACTIONS:
        print("Choose a Fiddy console button.", file=sys.stderr)
        return 2
    return open_pane(args[0])


if __name__ == "__main__":
    raise SystemExit(main())
