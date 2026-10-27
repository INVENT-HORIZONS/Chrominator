#!/bin/sh
# Builds the firmware for the PC (against the simulated Arduino in test/sim) and runs the
# end-to-end protocol tests with the extension's own protocol.js and link.js:
# once with the Uno R3 pin map, once with the Nano R4 pin map.
set -e
cd "$(dirname "$0")"
OUT="${TMPDIR:-/tmp}/chrominator-sim"
g++ -std=c++17 -Wall -Wextra -DCHROMINATOR_SIM -Isim -I../firmware/Chrominator \
    -o "$OUT" sim/sketch_sim.cpp sim/sim_main.cpp
node link.test.mjs "$OUT"
g++ -std=c++17 -Wall -Wextra -DCHROMINATOR_SIM -DCHROMINATOR_SIM_NANOR4 -Isim -I../firmware/Chrominator \
    -o "$OUT-nanor4" sim/sketch_sim.cpp sim/sim_main.cpp
node nanor4.test.mjs "$OUT-nanor4"
# The real Nano R4 build defines ARDUINO_NANO_R4 *and* ARDUINO_UNOR4_MINIMA (see the core's
# boards.txt): make sure board_config.h picks the Nano R4 block, not the Minima one.
printf '#include "board_config.h"\nBOARD_ID\n' > "$OUT-board.h"
ID=$(g++ -E -P -DARDUINO_NANO_R4 -DARDUINO_UNOR4_MINIMA -DARDUINO_nanor4 -Isim -I../firmware/Chrominator "$OUT-board.h" | tail -1)
[ "$ID" = "4" ] || { echo "FAIL: Nano R4 build selects board ID $ID, expected 4"; exit 1; }
echo "  ok  Nano R4 build defines select the Nano R4 board block"
