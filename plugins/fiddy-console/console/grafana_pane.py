import os
import sys
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from console.config import ConfigStore
from console.node import NodeError, NodeManager
from console.proxy import GrafanaProxy


def hyperlink(url, label):
    if sys.stdout.isatty():
        return "\033]8;;%s\033\\%s\033]8;;\033\\" % (url, label)
    return "%s\n%s" % (label, url)


def main():
    store = ConfigStore()
    manager = NodeManager(store)
    tunnel = manager.endpoint_mapper
    try:
        _, upstream = manager.endpoints()
        proxy = GrafanaProxy(upstream, port=int(os.environ.get("FIDDY_CONSOLE_PORT", "43117")))
    except (NodeError, OSError, ValueError) as error:
        print("Fiddy could not open Grafana: %s" % error, file=sys.stderr)
        return 1
    print("\033[38;5;154mFIDDY / LIVE GRAFANA\033[0m")
    print("Real Snapchain metrics. Loopback only. No AI or API key needed.")
    print("")
    print(hyperlink(proxy.url, "[ Open live Grafana ]"))
    print("")
    print("EMBED IT HERE: Shift-click the link above and Grafana opens beside")
    print("this pane, inside Ovis. No second browser tab.")
    print("To make a plain click embed too, set Ovis Settings > Web links > Beside the pane.")
    print("Grafana's first login is admin / admin; change that password in Grafana.")
    print("Keep this pane open: closing it closes the dashboard tunnel.")
    print("")
    try:
        proxy.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        proxy.server_close()
        if hasattr(tunnel, "close"):
            tunnel.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
