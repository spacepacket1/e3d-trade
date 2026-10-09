import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import { acquireLock, releaseLock } from "./liveProcessLock.js";

const lockPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "live-lock-")), "pipeline.lock");
const me = process.pid; // the only pid this test can reliably assert is "alive"
const deadPid = 999999; // reliably not a running process

assert.equal(acquireLock(lockPath, me), true, "first acquire succeeds");
assert.equal(fs.readFileSync(lockPath, "utf8"), String(me));
assert.equal(acquireLock(lockPath, 12345), false, "a second process cannot acquire while the first (self, genuinely alive) holds the lock");

releaseLock(lockPath, 777);
assert(fs.existsSync(lockPath), "release by a non-owner pid must not remove the lock");

releaseLock(lockPath, me);
assert(!fs.existsSync(lockPath), "release by the owning pid removes the lock");

assert.equal(acquireLock(lockPath, me), true, "a new process can acquire after a clean release");
releaseLock(lockPath, me);

// A lock file left behind by a pid that no longer exists (a crash, not a clean
// exit) must not permanently block every future start.
fs.writeFileSync(lockPath, String(deadPid));
assert.equal(acquireLock(lockPath, me), true, "a stale lock from a dead pid is taken over, not treated as held");
assert.equal(fs.readFileSync(lockPath, "utf8"), String(me));
releaseLock(lockPath, me);

console.log("PASS: live process lock");
