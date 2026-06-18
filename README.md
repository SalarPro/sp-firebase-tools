# Firebase Backup Tool

A small web app that runs **only on your own computer**. Load a Firebase
service account key and back up your **Firestore** database and **Storage**
files into a local folder. Nothing is uploaded anywhere — your key and data
stay on your machine.

## What you need

1. **Node.js** installed (version 18 or newer). Get it from https://nodejs.org
   if you don't have it. To check, open a terminal and run `node --version`.
2. A **service account key** for your Firebase project (see below).

## Getting your service account key

> Note: this is **not** the legacy "server key" (that one is only for push
> notifications and cannot read your data). You need a service account private
> key.

1. Open the [Firebase Console](https://console.firebase.google.com/).
2. Pick your project → click the gear icon → **Project settings**.
3. Open the **Service accounts** tab.
4. Click **Generate new private key** → confirm. A `.json` file downloads.
5. Keep that file safe — it grants full access to your project.

## Running the app

Open a terminal **in this folder**, then:

```bash
npm install      # one time only — downloads the needed libraries
npm start
```

You'll see:

```
Firebase Backup Tool is running.
Open this in your browser:  http://localhost:4000
```

Open **http://localhost:4000** in your browser.

## Using it

1. **Connect** — select your service account `.json` file (or paste the JSON),
   then click **Connect**. The bucket is auto-detected; you can override it if
   needed.
2. **Backup Firestore** — exports every collection (including subcollections)
   as JSON files.
3. **Backup Storage** — downloads every file from your Storage bucket.

## Where backups go

Everything is saved inside a **`backups/`** folder next to this app. Each run
gets its own timestamped folder, for example:

```
backups/
  my-project_firestore_2026-06-18T10-30-00-000Z/
    users/__data__.json
    orders/__data__.json
    ...
  my-project_storage_2026-06-18T10-32-00-000Z/
    images/photo1.jpg
    uploads/file.pdf
    ...
```

### Firestore JSON format

Each collection is saved as one `__data__.json` file: an object keyed by
document ID. Subcollections are saved in nested folders. Special Firestore
types are preserved with a `__type__` marker so they are not lost:

- Timestamps → `{ "__type__": "timestamp", "value": "2026-06-18T..." }`
- GeoPoints → `{ "__type__": "geopoint", "latitude": .., "longitude": .. }`
- References → `{ "__type__": "reference", "path": "users/abc" }`
- Bytes → `{ "__type__": "bytes", "base64": "..." }`

## Troubleshooting

- **"This does not look like a service account key"** — you likely used the FCM
  server key. Generate a private key under Project Settings → Service Accounts.
- **Storage backup fails / bucket not found** — enter the exact bucket name when
  connecting. Find it in Firebase Console → Storage (e.g.
  `your-project.appspot.com` or `your-project.firebasestorage.app`).
- **Large databases** — backups read every document and download every file, so
  big projects can take a while. Watch the live log for progress.

## Notes & limits (first version)

- Firestore export reads all documents client-side (good for small/medium
  projects). For very large datasets, Google's managed export is more efficient.
- The app listens only on `127.0.0.1` (your machine) — it is not exposed to the
  network.
