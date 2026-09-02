#!/usr/bin/env node
// Test double for ffmpeg that never finishes: does not open any of the fifos
// it's told to (`-i <fifo>`) and never exits on its own. Stands in for a
// wedged real ffmpeg so selftest-mixhang.js can exercise mixSession()'s
// watchdog without waiting on an actual stuck process.
//
// Writes its own pid to FAKE_FFMPEG_PIDFILE (if set) so the test can confirm
// it was actually killed, not just that mixSession() gave up on it.
import fs from 'node:fs';

const pidFile = process.env.FAKE_FFMPEG_PIDFILE;
if (pidFile) fs.writeFileSync(pidFile, String(process.pid));

// Keep the event loop alive forever without doing anything.
setInterval(() => {}, 1_000_000);
