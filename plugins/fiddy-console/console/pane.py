import os
import sys
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def status_text(status):
    phase = status.get("phase", "unavailable")
    lines = [
        "STATE     " + phase.upper(),
        "NETWORK   " + str(status.get("network", "snapchain")),
        "CONTAINER " + (status.get("container") or "not running / not found"),
    ]
    if status.get("version"):
        lines.append("VERSION   " + str(status["version"]))
    snapshot = status.get("snapshot")
    if snapshot:
        lines.append("SNAPSHOT  chunk %(chunk)s / %(total)s  (%(percent)s%%)" % snapshot)
    if status.get("shards"):
        lines.append("")
        lines.append("SHARD     HEIGHT             LAST BLOCK")
        for shard in status["shards"]:
            delay = shard.get("block_delay_seconds", 0)
            freshness = "%ss ago" % delay if isinstance(delay, (int, float)) else "not reported"
            lines.append("%-9s %-18s %s" % (shard.get("id"), shard.get("max_height"), freshness))
    if status.get("notice"):
        lines.extend(["", status["notice"]])
    lines.extend(["", "Read directly from the node and Docker. No agent interpretation."])
    return "\n".join(lines)


def settings_text(settings):
    public = dict(settings)
    if public.get("ssh_key"):
        public["ssh_key"] = "configured (path hidden)"
    return "\n".join("%-16s %s" % (key.upper(), value) for key, value in public.items() if key not in ("agent_configured", "agent_model", "agent_cap_cents"))


def wait_for_return(single):
    if single:
        input("\nPress Enter to close this pane. ")
    else:
        input("\nPress Enter to return to Fiddy console. ")


def main():
    from console.config import ConfigStore
    from console.node import NodeError, NodeManager
    from console.herdr_action import open_pane

    store = ConfigStore()
    manager = NodeManager(store)
    action = os.environ.get("FIDDY_CONSOLE_ACTION", "console")
    single = action != "console"
    while True:
        print("\033[2J\033[H", end="")
        print("\033[38;5;154mFIDDY / NODE CONSOLE\033[0m")
        print("Native node controls. Grafana works with zero AI.\n")
        try:
            if action in ("console", "status", "sync"):
                print(status_text(manager.status()))
            elif action == "logs":
                print(manager.logs()["logs"])
            elif action == "start":
                answer = input("Start the Snapchain and statsd containers? [y/N] ")
                print(manager.start()["message"] if answer.lower() == "y" else "Nothing changed.")
            elif action == "stop":
                answer = input("Stop the node containers? Grafana will stop too. [y/N] ")
                print(manager.stop()["message"] if answer.lower() == "y" else "Nothing changed.")
            elif action == "fid-setup":
                print("Set the Farcaster account number that operates this node.")
                print("This changes HUB_OPERATOR_FID only. It never asks for a seed phrase.")
                raw = input("Operator FID (blank cancels): ").strip()
                print(manager.set_operator_fid(int(raw))["message"] if raw else "Nothing changed.")
            elif action == "settings":
                current = store.load_settings()
                print(settings_text(store.public_settings()))
                print("\nLeave a value blank to keep it. Target 'local' means this machine.")
                changes = {}
                for key, label in (("target", "SSH target"), ("ssh_key", "SSH private-key path"), ("ssh_proxyjump", "SSH jump host (optional)"), ("node_url", "Node loopback URL"), ("grafana_url", "Grafana loopback URL")):
                    raw = input("%s [%s]: " % (label, current.get(key, ""))).strip()
                    if raw:
                        changes[key] = os.path.expanduser(raw) if key == "ssh_key" else raw
                if changes:
                    store.update_settings(changes)
                    print("Settings saved. Reopen Grafana to rebuild its tunnel.")
                else:
                    print("Nothing changed.")
            elif action == "auto-upgrade":
                print("0 off\n1 weekly (Tuesday 03:00)\n2 daily (03:00)\n3 hourly")
                choice = input("Schedule (blank cancels): ").strip()
                schedules = {"0": "off", "1": "weekly", "2": "daily", "3": "hourly"}
                print(manager.set_auto_upgrade(schedules[choice])["message"] if choice else "Nothing changed.")
            elif action == "grafana":
                open_pane("grafana")
                print("Grafana pane opened. Shift-click its [ Open live Grafana ] button in Ovis.")
            else:
                raise ValueError("Unknown console action")
        except (NodeError, ValueError, KeyError, OSError) as error:
            print("Could not complete that action: %s" % error)
        if action != "console":
            wait_for_return(single)
            return 0
        print("\n\033[38;5;154mBUTTONS\033[0m  Open Ovis Command Palette (Cmd/Ctrl+Shift+K), then type Fiddy.")
        print("[1] Refresh  [2] Logs  [3] Grafana  [4] Start  [5] Stop")
        print("[6] Operator FID  [7] Settings  [8] Auto-upgrade  [q] Quit")
        choice = input("Choose a button: ").strip().lower()
        if choice == "q":
            return 0
        action = {"1": "status", "2": "logs", "3": "grafana", "4": "start", "5": "stop", "6": "fid-setup", "7": "settings", "8": "auto-upgrade"}.get(choice, "status")


if __name__ == "__main__":
    raise SystemExit(main())
