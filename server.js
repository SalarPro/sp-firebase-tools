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
// strings through `log`. Returns the document count.
async function exportCollection(colRef, outDir, log) {
  fs.mkdirSync(outDir, { recursive: true });
  const snapshot = await colRef.get();
  let count = 0;
  const docsData = {};

  for (const doc of snapshot.docs) {
    docsData[doc.id] = serializeValue(doc.data());
    count++;

    // Recurse into any subcollections of this document.
    const subcollections = await doc.ref.listCollections();
    for (const sub of subcollections) {
      const subDir = path.join(outDir, doc.id, sub.id);
      const subCount = await exportCollection(sub, subDir, log);
      log(`    subcollection ${colRef.id}/${doc.id}/${sub.id}: ${subCount} docs`);
    }
  }

  // Write the whole collection as a single JSON file.
  fs.writeFileSync(
    path.join(outDir, "__data__.json"),
    JSON.stringify(docsData, null, 2)
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
    const db = state.app.firestore();
    const outDir = path.join(BACKUP_ROOT, `${state.projectId}_firestore_${timestamp()}`);
    fs.mkdirSync(outDir, { recursive: true });
    log(`Saving to: ${outDir}`);

    const collections = await db.listCollections();
    if (collections.length === 0) {
      log("No collections found in Firestore.");
    }

    let total = 0;
    for (const col of collections) {
      log(`Exporting collection: ${col.id} ...`);
      const count = await exportCollection(col, path.join(outDir, col.id), log);
      total += count;
      log(`  ${col.id}: ${count} documents`);
    }

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
    const bucket = state.app.storage().bucket();
    const outDir = path.join(BACKUP_ROOT, `${state.projectId}_storage_${timestamp()}`);
    fs.mkdirSync(outDir, { recursive: true });
    log(`Saving to: ${outDir}`);
    log(`Listing files in bucket: ${bucket.name} ...`);

    const [files] = await bucket.getFiles();
    if (files.length === 0) {
      log("No files found in Storage.");
    }

    let done = 0;
    for (const file of files) {
      const dest = path.join(outDir, file.name);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      // Skip "folder placeholder" objects that end with a slash.
      if (file.name.endsWith("/")) continue;
      await file.download({ destination: dest });
      done++;
      log(`  (${done}/${files.length}) ${file.name}`);
    }

    sseSend(res, "done", `Storage backup complete — ${done} files downloaded.\nFolder: ${outDir}`);
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
