/**
 * Firebase Backup Tool — local web server.
 *
 * Runs only on your machine. Lets you load a Firebase service account key
 * and back up Firestore (to JSON) and Storage (downloaded files) into a
 * local folder.
 */

const express = require("express");
const multer = require("multer");
const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 4000;
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Where backups are written. Each run gets its own timestamped subfolder.
const BACKUP_ROOT = path.join(__dirname, "backups");

// How many network operations run at the same time by default. Higher is
// faster but uses more memory/bandwidth and is more likely to hit Firebase
// rate limits. Both can be overridden per run with ?concurrency=N.
const FIRESTORE_CONCURRENCY = 25; // parallel Firestore reads (get + listCollections)
const STORAGE_CONCURRENCY = 12; // parallel Storage file downloads

// Holds the active Firebase connection for this session.
let state = {
  app: null,
  projectId: null,
  bucketName: null,
};

// ---------- helpers ----------

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

// A tiny promise pool (like p-limit). Returns a `limit(fn)` function that runs
// at most `concurrency` of the wrapped async functions at once and queues the
// rest. Only the wrapped call holds a slot, so recursive callers can fan out
// freely without deadlocking the pool.
function createLimiter(concurrency) {
  const max = Math.max(1, concurrency | 0);
  let active = 0;
  const queue = [];

  const drain = () => {
    while (active < max && queue.length > 0) {
      active++;
      const { fn, resolve, reject } = queue.shift();
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => {
          active--;
          drain();
        });
    }
  };

  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      drain();
    });
}

// Read a user-supplied ?concurrency=N value, falling back to a default and
// clamping to a sane range.
function parseConcurrency(raw, fallback) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, 100);
}

// Convert Firestore-specific data types into plain JSON-safe values.
function serializeValue(value) {
  if (value === null || value === undefined) return value;

  // Firestore Timestamp
  if (value instanceof admin.firestore.Timestamp) {
    return { __type__: "timestamp", value: value.toDate().toISOString() };
  }
  // GeoPoint
  if (value instanceof admin.firestore.GeoPoint) {
    return { __type__: "geopoint", latitude: value.latitude, longitude: value.longitude };
  }
  // DocumentReference
  if (value instanceof admin.firestore.DocumentReference) {
    return { __type__: "reference", path: value.path };
  }
  // Bytes / Buffer
  if (Buffer.isBuffer(value)) {
    return { __type__: "bytes", base64: value.toString("base64") };
  }
  if (Array.isArray(value)) {
    return value.map(serializeValue);
  }
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = serializeValue(v);
    return out;
  }
  return value;
}

// Recursively export a collection reference into outDir, sending progress
// strings through `log`. `limit` is the shared concurrency pool — every
// Firestore network call goes through it so the whole (recursive) export
// never exceeds the configured number of in-flight reads. Returns the
// document count for this collection level.
async function exportCollection(colRef, outDir, log, limit) {
  fs.mkdirSync(outDir, { recursive: true });
  const snapshot = await limit(() => colRef.get());

  const docsData = {};
  for (const doc of snapshot.docs) {
    docsData[doc.id] = serializeValue(doc.data());
  }
  const count = snapshot.size;

  // Write the whole collection as a single JSON file.
  fs.writeFileSync(
    path.join(outDir, "__data__.json"),
    JSON.stringify(docsData, null, 2)
  );

  // Walk every document's subcollections in parallel. The recursion fans out
  // freely; only the actual reads (listCollections / get) take a slot in the
  // shared pool, which keeps total concurrency bounded without deadlocking.
  await Promise.all(
    snapshot.docs.map(async (doc) => {
      const subcollections = await limit(() => doc.ref.listCollections());
      await Promise.all(
        subcollections.map(async (sub) => {
          const subDir = path.join(outDir, doc.id, sub.id);
          const subCount = await exportCollection(sub, subDir, log, limit);
          log(`    subcollection ${colRef.id}/${doc.id}/${sub.id}: ${subCount} docs`);
        })
      );
    })
  );

  return count;
}

// Server-Sent-Events helpers so the browser can show live progress.
function sseInit(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
}
function sseSend(res, type, message) {
  res.write(`data: ${JSON.stringify({ type, message })}\n\n`);
}

// ---------- routes ----------

// Connect using a service account key (JSON file upload or pasted JSON).
app.post("/api/connect", upload.single("keyfile"), (req, res) => {
  try {
    let raw;
    if (req.file) {
      raw = req.file.buffer.toString("utf8");
    } else if (req.body && req.body.keyjson) {
      raw =
        typeof req.body.keyjson === "string"
          ? req.body.keyjson
          : JSON.stringify(req.body.keyjson);
    } else {
      return res.status(400).json({ error: "No service account key provided." });
    }

    let serviceAccount;
    try {
      serviceAccount = JSON.parse(raw);
    } catch (e) {
      return res
        .status(400)
        .json({ error: "The key file is not valid JSON. Make sure you used the service account key from Firebase." });
    }

    if (!serviceAccount.project_id || !serviceAccount.private_key) {
      return res.status(400).json({
        error:
          "This does not look like a service account key. It needs a project_id and private_key. (The FCM 'server key' will not work — generate a private key under Project Settings → Service Accounts.)",
      });
    }

    // Tear down any previous connection so a new key can be loaded.
    if (state.app) {
      try { state.app.delete(); } catch (_) {}
    }

    const bucketName =
      (req.body && req.body.bucket && req.body.bucket.trim()) ||
      `${serviceAccount.project_id}.appspot.com`;

    const fbApp = admin.initializeApp(
      {
        credential: admin.credential.cert(serviceAccount),
        storageBucket: bucketName,
      },
      "backup-" + Date.now()
    );

    state = { app: fbApp, projectId: serviceAccount.project_id, bucketName };

    res.json({
      ok: true,
      projectId: serviceAccount.project_id,
      bucket: bucketName,
      backupRoot: BACKUP_ROOT,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Backup Firestore (SSE stream).
app.get("/api/backup/firestore", async (req, res) => {
  sseInit(res);
  const log = (m) => sseSend(res, "log", m);

  if (!state.app) {
    sseSend(res, "error", "Not connected. Load a service account key first.");
    return res.end();
  }

  try {
    const concurrency = parseConcurrency(req.query.concurrency, FIRESTORE_CONCURRENCY);
    const limit = createLimiter(concurrency);
    const db = state.app.firestore();
    const outDir = path.join(BACKUP_ROOT, `${state.projectId}_firestore_${timestamp()}`);
    fs.mkdirSync(outDir, { recursive: true });
    log(`Saving to: ${outDir}`);
    log(`Reading up to ${concurrency} documents/subcollections in parallel.`);

    const collections = await db.listCollections();
    if (collections.length === 0) {
      log("No collections found in Firestore.");
    }

    // Export top-level collections in parallel. The shared limiter caps the
    // total in-flight reads across all collections and their subcollections.
    const counts = await Promise.all(
      collections.map(async (col) => {
        log(`Exporting collection: ${col.id} ...`);
        const count = await exportCollection(col, path.join(outDir, col.id), log, limit);
        log(`  ${col.id}: ${count} documents`);
        return count;
      })
    );
    const total = counts.reduce((sum, c) => sum + c, 0);

    sseSend(res, "done", `Firestore backup complete — ${total} documents across ${collections.length} collections.\nFolder: ${outDir}`);
  } catch (err) {
    sseSend(res, "error", "Firestore backup failed: " + err.message);
  } finally {
    res.end();
  }
});

// Backup Storage (SSE stream).
app.get("/api/backup/storage", async (req, res) => {
  sseInit(res);
  const log = (m) => sseSend(res, "log", m);

  if (!state.app) {
    sseSend(res, "error", "Not connected. Load a service account key first.");
    return res.end();
  }

  try {
    const concurrency = parseConcurrency(req.query.concurrency, STORAGE_CONCURRENCY);
    const limit = createLimiter(concurrency);
    const bucket = state.app.storage().bucket();
    const outDir = path.join(BACKUP_ROOT, `${state.projectId}_storage_${timestamp()}`);
    fs.mkdirSync(outDir, { recursive: true });
    log(`Saving to: ${outDir}`);
    log(`Listing files in bucket: ${bucket.name} ...`);

    const [allFiles] = await bucket.getFiles();
    // Skip "folder placeholder" objects whose names end with a slash.
    const files = allFiles.filter((f) => !f.name.endsWith("/"));
    if (files.length === 0) {
      log("No files found in Storage.");
    }
    log(`Downloading ${files.length} files, up to ${concurrency} at a time ...`);

    let done = 0;
    let failed = 0;
    await Promise.all(
      files.map((file) =>
        limit(async () => {
          const dest = path.join(outDir, file.name);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          try {
            await file.download({ destination: dest });
            done++;
            log(`  (${done}/${files.length}) ${file.name}`);
          } catch (e) {
            failed++;
            log(`  ! failed: ${file.name} — ${e.message}`);
          }
        })
      )
    );

    const note = failed ? ` (${failed} failed)` : "";
    sseSend(res, "done", `Storage backup complete — ${done} files downloaded${note}.\nFolder: ${outDir}`);
  } catch (err) {
    let hint = "";
    if (/does not exist|notFound|No such/i.test(err.message)) {
      hint = " — the storage bucket name may be wrong. Try entering it manually when connecting (e.g. your-project.appspot.com or your-project.firebasestorage.app).";
    }
    sseSend(res, "error", "Storage backup failed: " + err.message + hint);
  } finally {
    res.end();
  }
});

app.get("/api/status", (req, res) => {
  res.json({
    connected: !!state.app,
    projectId: state.projectId,
    bucket: state.bucketName,
    backupRoot: BACKUP_ROOT,
  });
});

app.listen(PORT, "127.0.0.1", () => {
  fs.mkdirSync(BACKUP_ROOT, { recursive: true });
  console.log("\n  Firebase Backup Tool is running.");
  console.log(`  Open this in your browser:  http://localhost:${PORT}\n`);
});
