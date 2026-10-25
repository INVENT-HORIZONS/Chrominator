#!/bin/sh
# Builds the firmware for the PC (against the simulated Arduino in test/sim) and runs the
# end-to-end protocol tests with the extension's own protocol.js and link.js.
set -e
cd "$(dirname "$0")"
OUT="${TMPDIR:-/tmp}/chrominator-sim"
g++ -std=c++17 -Wall -Wextra -DCHROMINATOR_SIM -Isim -I../firmware/Chrominator \
    -o "$OUT" sim/sketch_sim.cpp sim/sim_main.cpp
node link.test.mjs "$OUT"
