import fs from "fs";

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

// Not race-free (check-then-write) -- acceptable here: this guards against a
// human/ops mistake (starting a second pm2 instance against the same live
// portfolio), not a distributed system with concurrent untrusted writers.
export function acquireLock(lockPath, pid = process.pid) {
  try {
    fs.writeFileSync(lockPath, String(pid), { flag: "wx" });
    return true;
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
  }
  const existingPid = Number(fs.readFileSync(lockPath, "utf8").trim());
  if (isProcessAlive(existingPid)) return false;
  fs.writeFileSync(lockPath, String(pid), { flag: "w" });
  return true;
}

export function releaseLock(lockPath, pid = process.pid) {
  try {
    const owner = Number(fs.readFileSync(lockPath, "utf8").trim());
    if (owner === pid) fs.rmSync(lockPath, { force: true });
  } catch {
    /* already gone */
  }
}

export function releaseLockOnExit(lockPath) {
  const release = () => releaseLock(lockPath);
  process.once("exit", release);
  process.once("SIGINT", () => { release(); process.exit(130); });
  process.once("SIGTERM", () => { release(); process.exit(143); });
}
