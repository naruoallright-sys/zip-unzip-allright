// server.js
// 非同期解凍サーバ（サービスアカ不要・鍵付きAPI）
// - /upload/init -> /upload/chunk -> /upload/finish でZIP受信（Base64チャンク）
//   * totalChunks/size/sha256 で完全性検証（欠落・破損の早期検知）
// - /unzip/start で解凍ジョブを起動（即時 job_id を返却：非同期）
// - /unzip/status で状態確認
// - /unzip/files で展開結果一覧
// - /unzip/download で1ファイルずつBase64取得
//
// 特記事項：7zip バイナリを /tmp/bin にコピー＆chmod（noexec/EACCES 回避）
// 認証：全エンドポイントで x-api-key を検査（/healthz は除外）

import express from "express";
import cors from "cors";
import { v4 as uuid } from "uuid";
import fs from "fs/promises";
import fss from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import dotenv from "dotenv";
import { path7za } from "7zip-bin";
import crypto from "crypto";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ====== 設定 ======
const PORT = process.env.PORT || 3000;
const TMP_DIR = process.env.TMP_DIR || path.join(process.cwd(), "tmp");
const MAX_JSON_SIZE = process.env.MAX_JSON_SIZE || "10mb";
const ENABLE_CORS = process.env.ENABLE_CORS === "1";
const API_KEY = process.env.API_KEY || ""; // 必須

// TTL
const UPLOAD_TTL_MS = 60 * 60 * 1000; // 60分
const JOB_TTL_MS = 6 * 60 * 60 * 1000; // 6時間

// ====== 状態 ======
/**
 * uploads: upload_id -> {
 *   createdAt: number,
 *   parts: string[],      // Base64 チャンク（index順）
 *   receivedCount?: number,
 *   highestIndex?: number,
 *   totalChunks?: number,
 *   filename?: string,
 *   path?: string,        // ZIP 実体パス
 *   size?: number,
 *   sha256?: string
 * }
 *
 * jobs: job_id -> {
 *   status: 'queued'|'running'|'done'|'error',
 *   error?: string,
 *   createdAt: number,
 *   dir: string,          // 展開先
 *   files: {name:string, size:number}[]
 * }
 */
const uploads = new Map();
const jobs = new Map();

// ====== 7za を /tmp/bin へコピー（実行権限付与）======
async function prepare7zaExecutable(tmpDir) {
  const binDir = path.join(tmpDir, "bin");
  const dst = path.join(binDir, "7za");
  await fs.mkdir(binDir, { recursive: true });
  try {
    await fs.copyFile(path7za, dst);
  } catch (e) {
    if (e.code !== "EEXIST") {
      console.error("copy 7za error:", e);
      throw e;
    }
  }
  await fs.chmod(dst, 0o755);
  return dst;
}

// ====== 初期化 ======
await fs.mkdir(TMP_DIR, { recursive: true });
const EXEC_7Z_PATH = await prepare7zaExecutable(TMP_DIR);

const app = express();
app.use(express.json({ limit: MAX_JSON_SIZE }));
if (ENABLE_CORS) app.use(cors());

// ヘルスチェック（無認証）
app.get("/healthz", (req, res) => res.json({ ok: true }));

// 認証（API_KEY 必須）
app.use((req, res, next) => {
  if (!API_KEY) return res.status(500).json({ error: "server misconfigured: API_KEY not set" });
  const key = req.header("x-api-key");
  if (key === API_KEY) return next();
  return res.status(401).json({ error: "unauthorized" });
});

// ====== アップロード ======
app.post("/upload/init", (req, res) => {
  const upload_id = uuid();
  uploads.set(upload_id, { createdAt: Date.now(), parts: [] });
  res.json({ upload_id });
});

app.post("/upload/chunk", (req, res) => {
  let { upload_id, index, data, totalChunks } = req.body || {};
  if (!upload_id || typeof data !== "string") {
    return res.status(400).json({ error: "invalid payload" });
  }
  index = Number(index);
  if (!Number.isInteger(index) || index < 0) {
    return res.status(400).json({ error: "invalid index" });
  }
  const up = uploads.get(upload_id);
  if (!up) return res.status(400).json({ error: "invalid upload_id" });

  if (up.totalChunks == null) {
    if (typeof totalChunks !== "number" || totalChunks <= 0) {
      return res.status(400).json({ error: "totalChunks required on first chunk" });
    }
    up.totalChunks = totalChunks;
  }
  if (index >= up.totalChunks) {
    return res.status(400).json({ error: "index out of range", totalChunks: up.totalChunks });
  }

  // ★ 空データは受け付けない（ネットワーク/プロキシ由来の欠落検知）
  if (data.length === 0) {
    return res.status(400).json({ error: "empty_chunk", index });
  }

  if (!up.parts[index]) {
    up.receivedCount = (up.receivedCount || 0) + 1;
  }
  up.parts[index] = data;
  up.highestIndex = Math.max(up.highestIndex || 0, index);

  // 受信長（Base64文字列長）を返す
  return res.json({ ok: true, index, len: data.length, receivedCount: up.receivedCount || 1 });
});

// ====== /upload/finish（完全性チェック：欠落・空チャンク・size・sha256）======
app.post("/upload/finish", async (req, res) => {
  const { upload_id, filename, size, sha256 } = req.body || {};
  if (!upload_id || !filename) {
    return res.status(400).json({ error: "invalid payload" });
  }

  const up = uploads.get(upload_id);
  if (!up) {
    return res.status(400).json({ error: "invalid upload_id" });
  }

  // totalChunks がセットされていない＝プロトコル違反
  if (typeof up.totalChunks !== "number" || up.totalChunks <= 0) {
    return res.status(409).json({ ok: false, error: "totalChunks_not_set" });
  }
  const expected = up.totalChunks;

  // 欠落チェック（undefined だけでなく "" の空データも欠落扱い）
  const missing = [];
  for (let i = 0; i < expected; i++) {
    if (!up.parts[i] || up.parts[i].length === 0) {
      missing.push(i);
    }
  }
  if (missing.length) {
    return res.status(422).json({
      ok: false,
      error: "missing_chunks",
      missing,
      receivedCount: up.receivedCount || 0,
      expected
    });
  }

  try {
    const zipPath = path.join(TMP_DIR, `${upload_id}.zip`);
    await fs.mkdir(path.dirname(zipPath), { recursive: true });

    const b64 = up.parts.join("");
    const buf = Buffer.from(b64, "base64");

    // サイズ検証（任意だが推奨）
    if (typeof size === "number" && size !== buf.length) {
      return res.status(422).json({
        ok: false,
        error: "size_mismatch",
        got: buf.length,
        expect: size,
        expectedChunks: expected
      });
    }

    // ハッシュ検証（強く推奨）
    if (typeof sha256 === "string" && sha256.length === 64) {
      const calc = crypto.createHash("sha256").update(buf).digest("hex");
      if (calc !== sha256) {
        return res.status(422).json({
          ok: false,
          error: "sha256_mismatch",
          got: calc,
          expect: sha256
        });
      }
    }

    await fs.writeFile(zipPath, buf);
    up.filename = filename;
    up.path = zipPath;
    up.size = buf.length;
    up.sha256 = sha256 || null;

    return res.json({ ok: true });
  } catch (e) {
    console.error("upload/finish error:", e);
    return res.status(500).json({ ok: false, error: "upload_finish_failed" });
  }
});

// ====== 解凍ジョブ ======
app.post("/unzip/start", async (req, res) => {
  const { upload_id, password } = req.body || {};
  if (!upload_id) return res.status(400).json({ error: "upload_id required" });
  const up = uploads.get(upload_id);
  if (!up || !up.path) return res.status(400).json({ error: "upload not ready" });

  const job_id = uuid();
  const outDir = path.join(TMP_DIR, job_id);
  await fs.mkdir(outDir, { recursive: true });
  jobs.set(job_id, { status: "queued", createdAt: Date.now(), dir: outDir, files: [] });

  (async () => {
    try {
      jobs.get(job_id).status = "running";
      const args = password
        ? ["x", `-p${password}`, `-o${outDir}`, up.path]
        : ["x", `-o${outDir}`, up.path];

      await new Promise((resolve, reject) => {
        const p = spawn(EXEC_7Z_PATH, args);
        let stderr = "";
        p.stderr.on("data", (d) => (stderr += d.toString()));
        p.on("close", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`7z failed: code=${code}, stderr=${stderr}`));
        });
        p.on("error", (err) => reject(err));
      });

      const names = await fs.readdir(outDir);
      const files = [];
      for (const n of names) {
        const full = path.join(outDir, n);
        const st = await fs.stat(full);
        if (st.isFile()) files.push({ name: n, size: st.size });
      }
      const job = jobs.get(job_id);
      if (!job) return;
      job.files = files;
      job.status = "done";
    } catch (e) {
      const job = jobs.get(job_id);
      if (job) {
        job.status = "error";
        job.error = e.message || String(e);
      }
    } finally {
      try {
        if (up?.path && fss.existsSync(up.path)) await fs.unlink(up.path);
      } catch (_) {}
    }
  })();

  res.json({ job_id });
});

app.get("/unzip/status", (req, res) => {
  const job_id = req.query.job_id;
  const job = job_id && jobs.get(job_id);
  if (!job) return res.status(404).json({ error: "job not found" });
  res.json({ status: job.status, error: job.error || null });
});

app.get("/unzip/files", (req, res) => {
  const job_id = req.query.job_id;
  const job = job_id && jobs.get(job_id);
  if (!job) return res.status(404).json({ error: "job not found" });
  if (job.status !== "done") return res.status(409).json({ error: "not ready", status: job.status });
  res.json({ files: job.files || [] });
});

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

// ====== 自動掃除 ======
async function cleanupOld() {
  const now = Date.now();
  for (const [id, up] of uploads.entries()) {
    if (now - (up.createdAt || 0) > UPLOAD_TTL_MS) {
      try { if (up.path && fss.existsSync(up.path)) await fs.unlink(up.path); } catch (_) {}
      uploads.delete(id);
    }
  }
  for (const [id, job] of jobs.entries()) {
    if (now - (job.createdAt || 0) > JOB_TTL_MS) {
      try {
        if (job.dir && fss.existsSync(job.dir)) {
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
setInterval(cleanupOld, 10 * 60 * 1000);

// ====== 起動 ======
app.listen(PORT, () => {
  console.log(`server started on :${PORT}`);
  console.log(`TMP_DIR = ${TMP_DIR}`);
  console.log(`7z module path = ${path7za}`);
  console.log(`7z exec path = ${EXEC_7Z_PATH}`);
});
