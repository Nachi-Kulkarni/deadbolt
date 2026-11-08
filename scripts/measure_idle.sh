#!/bin/sh
# Idle cost of the installed agent and guardian, with test launchd labels and a dry device.
# usage: scripts/measure_idle.sh <empty dir> <seconds>. Run on a release build. Prints CPU-seconds unlocked, then locked.
D=$1; T=$2; ROOT=$(pwd)
rm -rf "${D:?}"; mkdir -p $D/LaunchAgents $D/apps
ditto dist/Deadbolt.app $D/apps/Deadbolt.app
export DEADBOLT_HOME=$D/home DEADBOLT_LABEL=com.deadbolt.meas-$$ DEADBOLT_AGENTS_DIR=$D/LaunchAgents DEADBOLT_SKIP_HOSTS=1 DEADBOLT_TEST_BROWSER_APP=/nonexistent DEADBOLT_DRY_DEVICE=1
B=$D/apps/Deadbolt.app/Contents/MacOS/Deadbolt
$B install >/dev/null; sleep 4
cpu() { for l in agent guardian; do p=$(launchctl print gui/$(id -u)/$DEADBOLT_LABEL.$l | awk '/\tpid = /{print $3}'); ps -o time= -p $p | awk -F'[:.]' '{printf "%.2f ", $1*60+$2+$3/100}'; done; }
diff() { echo "$1 $2" | awk '{printf "agent %.2f guardian %.2f", $3-$1, $4-$2}'; }
spawns() { log show --last ${T}s --predicate 'eventMessage CONTAINS "launchctl"' 2>/dev/null | wc -l; }
a=$(cpu); sleep $T; b=$(cpu); echo "unlocked ${T}s: $(diff "$a" "$b") cpu-s"
SP=$D/home/app/Deadbolt.app/Contents/MacOS/Deadbolt
$SP rpc saveBlock '{"block":{"id":"m","name":"m","enabled":true,"websites":["x.test"],"apps":[{"path":"/Applications/Chess.app"}]}}' >/dev/null
$SP rpc lock '{"id":"m","lock":{"kind":"password"},"newPassword":"p"}' >/dev/null
sleep 3; a=$(cpu); sleep $T; b=$(cpu); echo "locked ${T}s: $(diff "$a" "$b") cpu-s; launchctl spawns: $(grep -c "restored job" $DEADBOLT_HOME/agent.log)"
$SP rpc unlock '{"id":"m","password":"p"}' >/dev/null; sleep 2; $SP uninstall >/dev/null
