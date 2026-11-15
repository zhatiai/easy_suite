import { lstat, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { verifyBackup, writeRestoreData } from "./maintenance.mjs";
import { runMigrationGatekeeper } from "./server.mjs";

async function assertEmptyTarget(dataDir) {
  try { await lstat(path.join(dataDir, "state")); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  throw new Error("Target state already exists. Import requires a fresh volume and a stopped server.");
}

// Stage all data privately; failed imports never publish a partial database or object store.
export async function importServerBackup(backupDir, dataDir, check = false) {
  const verified = await verifyBackup(backupDir);
  await assertEmptyTarget(dataDir);
  if (check) return;
  await mkdir(dataDir, { recursive: true });
  const staging = await mkdtemp(path.join(dataDir, ".import-"));
  let runtime;
  try {
    await runMigrationGatekeeper(staging);
    runtime = new Miniflare({
      modules: true, script: "export default { fetch() { return new Response(); } }",
      host: "127.0.0.1", port: 0, cf: false,
      d1Databases: { DB: "easynote-db" }, d1Persist: path.join(staging, "state/d1"),
      r2Buckets: { IMAGES: "easynote-images" }, r2Persist: path.join(staging, "state/r2"),
    });
    const db = await runtime.getD1Database("DB");
    const bucket = await runtime.getR2Bucket("IMAGES");
    for (const object of verified.manifest.objects) {
      await bucket.put(object.key, await readFile(path.join(verified.directory, object.path)),
        { httpMetadata: { contentType: object.mime } });
    }
    const sqlFile = path.join(staging, "restore.sql");
    await writeRestoreData(verified.databasePath, sqlFile);
    const statements = (await readFile(sqlFile, "utf8")).split("\n").filter((line) => line.trim());
    // Dumps can contain child rows before parents; validate constraints at transaction commit.
    await db.batch([db.prepare("PRAGMA defer_foreign_keys=ON"), ...statements.map((sql) => db.prepare(sql))]);
    const violations = await db.prepare("PRAGMA foreign_key_check").all();
    if (violations.results.length) throw new Error("Backup contains invalid foreign key references.");
    await runtime.dispose();
    runtime = undefined;
    await assertEmptyTarget(dataDir);
    await rename(path.join(staging, "state"), path.join(dataDir, "state"));
  } finally {
    await runtime?.dispose();
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [backupDir, option] = process.argv.slice(2);
  if (!backupDir || (option && option !== "--check") || process.argv.length > 4) {
    console.error("Usage: node scripts/server-import.mjs BACKUP_DIR [--check] (DATA_DIR defaults to /data)");
    process.exitCode = 1;
  } else {
    importServerBackup(backupDir, process.env.DATA_DIR || "/data", option === "--check")
      .then(() => console.log(option ? "Import preflight passed; no data changed." : "Server data import completed."))
      .catch((error) => { console.error(`EasyNote: ${error.message}`); process.exitCode = 1; });
  }
}
