// server.js
// 非同期解凍サーバ（サービスアカ不要）
// - /upload/init -> /upload/chunk -> /upload/finish でZIP受信（Base64チャンク）
// - /unzip/start で解凍ジョブを起動（即時 job_id を返却）
// - /unzip/status で状態確認
// - /unzip/files で展開結果の一覧
// - /unzip/download で1ファイルずつBase64取得
//
// ※GAS側は JSON Base64 前提。必要なら /unzip/download-binary 等を足してもOK。

import express from "express";
import cors from "cors";
import { v4 as uuid } from "uuid";
import fs from "fs/promises";
import fss from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import os from "os";
import dotenv from "dotenv";
import { path7za } from "7zip-bin";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ====== 基本設定 ======
const PORT = process.env.PORT || 3000;
const TMP_DIR = process.env.TMP_DIR || path.join(process.cwd(), "tmp"); // 永続不要でOK
const MAX_JSON_SIZE = process.env.MAX_JSON_SIZE || "10mb"; // 1チャンクあたり~2-5MB前提、余裕をみて
const ENABLE_CORS = process.env.ENABLE_CORS === "1";
const API_KEY = process.env.API_KEY || ""; // 任意: セキュリティ用

// TTL（お掃除間隔）
const UPLOAD_TTL_MS = 60 * 60 * 1000; // 60分
const JOB_TTL_MS = 6 * 60 * 60 * 1000; // 6時間

// ====== メモリ管理 ======
/**
 * uploads: upload_id -> {
 *   createdAt: number,
 *   parts: string[],      // Base64チャンク
 *   filename?: string,
 *   path?: string         // ZIP実体パス
 * }
 *
 * jobs: job_id -> {
 *   status: 'queued'|'running'|'done'|'error',
 *   error?: string,
 *   createdAt: number,
 *   dir: string,          // 展開先ディレクトリ
 *   files: {name:string, size:number}[]
 * }
 */
const uploads = new Map();
const jobs = new Map();

// ====== 初期化 ======
await fs.mkdir(TMP_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: MAX_JSON_SIZE }));

if (ENABLE_CORS) {
  app.use(cors());
}

// ====== APIキー認証（任意）=====
app.use((req, res, next) => {
  if (!API_KEY) return next(); // 無効化
  const key = req.header("x-api-key");
  if (key === API_KEY) return next();
  return res.status(401).json({ error: "unauthorized" });
});

// ====== ヘルスチェック ======
app.get("/healthz", (req, res) => {
  res.json({ ok: true });
});

// ====== アップロード（分割） ======
app.post("/upload/init", (req, res) => {
  const upload_id = uuid();
  uploads.set(upload_id, { createdAt: Date.now(), parts: [] });
  res.json({ upload_id });
});

app.post("/upload/chunk", (req, res) => {
  const { upload_id, index, data } = req.body || {};
  if (!upload_id || typeof index !== "number" || typeof data !== "string") {
    return res.status(400).json({ error: "invalid payload" });
  }
  const up = uploads.get(upload_id);
  if (!up) return res.status(400).json({ error: "invalid upload_id" });

  up.parts[index] = data; // Base64をインデックス通りに格納
  res.json({ ok: true });
});

app.post("/upload/finish", async (req, res) => {
  const { upload_id, filename } = req.body || {};
  if (!upload_id || !filename) return res.status(400).json({ error: "invalid payload" });
  const up = uploads.get(upload_id);
  if (!up) return res.status(400).json({ error: "invalid upload_id" });

  try {
    const zipPath = path.join(TMP_DIR, `${upload_id}.zip`);
    await fs.mkdir(path.dirname(zipPath), { recursive: true });

    const b64 = (up.parts || []).join("");
    const buf = Buffer.from(b64, "base64");
    await fs.writeFile(zipPath, buf);

    up.filename = filename;
    up.path = zipPath;

    res.json({ ok: true });
  } catch (e) {
    console.error("upload/finish error:", e);
    res.status(500).json({ error: "upload finish failed" });
  }
});

// ====== 解凍ジョブ開始（非同期） ======
app.post("/unzip/start", async (req, res) => {
  const { upload_id, password } = req.body || {};
  if (!upload_id) return res.status(400).json({ error: "upload_id required" });
  const up = uploads.get(upload_id);
  if (!up || !up.path) return res.status(400).json({ error: "upload not ready" });

  // ジョブ生成
  const job_id = uuid();
  const outDir = path.join(TMP_DIR, job_id);
  await fs.mkdir(outDir, { recursive: true });
  jobs.set(job_id, { status: "queued", createdAt: Date.now(), dir: outDir, files: [] });

  // 非同期実行
  (async () => {
    try {
      jobs.get(job_id).status = "running";
      // 7zip で解凍（AES対応）。パスワードなしなら -p を付けない。
      const args = password
        ? ["x", `-p${password}`, `-o${outDir}`, up.path]
        : ["x", `-o${outDir}`, up.path];

      await new Promise((resolve, reject) => {
        const p = spawn(path7za, args);
        let stderr = "";
        p.stderr.on("data", (d) => (stderr += d.toString()));
        p.on("close", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`7z failed: code=${code}, stderr=${stderr}`));
        });
      });

      const names = await fs.readdir(outDir);
      const files = [];
      for (const n of names) {
        const full = path.join(outDir, n);
        const st = await fs.stat(full);
        if (st.isFile()) files.push({ name: n, size: st.size });
      }
      const job = jobs.get(job_id);
      if (!job) return; // TTL清掃が走った等
      job.files = files;
      job.status = "done";
    } catch (e) {
      const job = jobs.get(job_id);
      if (job) {
        job.status = "error";
        job.error = e.message || String(e);
      }
    } finally {
      // ※アップロード本体は不要になったら削除してOK（任意）
      try {
        if (up?.path && fss.existsSync(up.path)) await fs.unlink(up.path);
      } catch (_) {}
    }
  })();

  res.json({ job_id });
});

// ====== ステータス ======
app.get("/unzip/status", (req, res) => {
  const job_id = req.query.job_id;
  const job = job_id && jobs.get(job_id);
  if (!job) return res.status(404).json({ error: "job not found" });
  res.json({ status: job.status, error: job.error || null });
});

// ====== 展開ファイル一覧 ======
app.get("/unzip/files", (req, res) => {
  const job_id = req.query.job_id;
  const job = job_id && jobs.get(job_id);
  if (!job) return res.status(404).json({ error: "job not found" });
  if (job.status !== "done") return res.status(409).json({ error: "not ready", status: job.status });
  res.json({ files: job.files || [] });
});

// ====== 1ファイルDL（Base64 JSON） ======
app.get("/unzip/download", async (req, res) => {
  const job_id = req.query.job_id;
  const name = req.query.name;
  const job = job_id && jobs.get(job_id);
  if (!job) return res.status(404).json({ error: "job not found" });
  if (job.status !== "done") return res.status(409).json({ error: "not ready", status: job.status });
  if (!name) return res.status(400).json({ error: "name required" });

  const full = path.join(job.dir, name);
  try {
    const buf = await fs.readFile(full);
    res.json({ data: buf.toString("base64") });
  } catch (e) {
    res.status(404).json({ error: "file not found" });
  }
});

// ====== お掃除（TTLで古いものを削除） ======
async function cleanupOld() {
  const now = Date.now();
  // uploads
  for (const [id, up] of uploads.entries()) {
    if (now - (up.createdAt || 0) > UPLOAD_TTL_MS) {
      try {
        if (up.path && fss.existsSync(up.path)) await fs.unlink(up.path);
      } catch (_) {}
      uploads.delete(id);
    }
  }
  // jobs
  for (const [id, job] of jobs.entries()) {
    if (now - (job.createdAt || 0) > JOB_TTL_MS) {
      try {
        if (job.dir && fss.existsSync(job.dir)) {
          // 中身を削除
          const entries = await fs.readdir(job.dir).catch(() => []);
          for (const n of entries) {
            const full = path.join(job.dir, n);
            try { await fs.unlink(full); } catch (_) {}
          }
          await fs.rmdir(job.dir).catch(() => {});
        }
      } catch (_) {}
      jobs.delete(id);
    }
  }
}
setInterval(cleanupOld, 10 * 60 * 1000); // 10分おき

// ====== 起動 ======
app.listen(PORT, () => {
  console.log(`server started on :${PORT}`);
  console.log(`TMP_DIR = ${TMP_DIR}`);
  console.log(`7z path = ${path7za}`);
});
