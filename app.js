"use strict";

/* ==========================================================
   Video Splitter Pro - アプリ本体
   動画ファイルを少しずつ読み込みながら分割する（丸ごとメモリに読み込まない）。
   MP4/MOVコンテナを箱（box）単位で解析できる mp4box.js を使い、
   ストリームコピー（再エンコードなし）でパーツを切り出す。
   処理はすべて端末内（ブラウザ内）で完結し、外部へ動画を送信しない。
   ========================================================== */

// 更新するたびに手動で書き換える（画面に表示され、更新が反映されたかの確認に使う）
const APP_VERSION = "2026-09-15.3";

const TARGET_SEGMENT_SECONDS = 110; // 目安の区切り時間（実際の区切りはキーフレーム基準で多少前後する）
const MIN_SEGMENT_SECONDS = 20; // これより短くはしない
const MIN_TAIL_SECONDS = 5; // 最後の端数がこの秒数以下なら、独立させず1つ前のパーツに含める
const CHUNK_BYTES = 8 * 1024 * 1024; // ファイルを読み込む1回あたりの量（これだけがメモリに乗る）
// 動画全体を一度にメモリへ読み込まない方式のため、以前の版のような「まるごと読み込みでクラッシュ」は
// 起きにくいはずだが、実績がまだ無いため、念のため大きめの安全側の目安値だけ残しておく。
const SIZE_WARN_BYTES = 3 * 1024 * 1024 * 1024; // 3GB
const MP4BOX_URL = "https://cdn.jsdelivr.net/npm/mp4box@0.5.3/dist/mp4box.all.min.js";

const screens = {
  select: document.getElementById("screen-select"),
  ready: document.getElementById("screen-ready"),
  processing: document.getElementById("screen-processing"),
  result: document.getElementById("screen-result"),
};

const fileInput = document.getElementById("file-input");
const readyFilename = document.getElementById("ready-filename");
const readyMeta = document.getElementById("ready-meta");
const readySizeWarning = document.getElementById("ready-size-warning");
const btnStart = document.getElementById("btn-start");
const btnReselect = document.getElementById("btn-reselect");
const btnRestart = document.getElementById("btn-restart");
const progressFill = document.getElementById("progress-bar-fill");
const progressOuter = document.getElementById("progress-bar-outer");
const progressLabel = document.getElementById("progress-label");
const progressElapsedEl = document.getElementById("progress-elapsed");
const resultHeading = document.getElementById("result-heading");
const resultElapsedEl = document.getElementById("result-elapsed");
const resultSourceDateEl = document.getElementById("result-source-date");
const resultSingleNote = document.getElementById("result-single-note");
const segmentList = document.getElementById("segment-list");
const toastEl = document.getElementById("toast");
const errorDetailEl = document.getElementById("error-detail");
const versionTagEl = document.getElementById("version-tag");

versionTagEl.textContent = `version ${APP_VERSION}`;

let currentFile = null;
let toastTimer = null;
let wakeLock = null;
let procLog = []; // サポート用の内部ログ（ffmpegLogの代わり）

/* ---------- 画面切り替え ---------- */
function showScreen(name) {
  for (const key in screens) {
    screens[key].hidden = key !== name;
  }
}

/* ---------- トースト（成功・失敗の合図） ---------- */
function showToast(message, type = "success", durationMs) {
  clearTimeout(toastTimer);
  toastEl.textContent = message;
  toastEl.dataset.type = type;
  toastEl.hidden = false;
  const defaultDuration = type === "success" ? 1700 : 6000;
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
  }, durationMs ?? defaultDuration);
}

const MEMORY_HINT = "端末のメモリが不足していないか確認してください。";

function showErrorToast(detail) {
  showToast(`処理に失敗しました。${MEMORY_HINT}${detail ? " " + detail : ""}`, "error");
}

function clearErrorDetail() {
  errorDetailEl.hidden = true;
  errorDetailEl.textContent = "";
}

function log(message) {
  procLog.push(message);
  if (procLog.length > 60) procLog.shift();
}

function showErrorDetail(err) {
  const name = (err && err.name) || "UnknownError";
  const message = (err && err.message) || String(err);
  const fileInfo = currentFile
    ? `${currentFile.name} / ${formatBytes(currentFile.size)} / ${currentFile.type || "type不明"}`
    : "不明";
  const logTail = procLog.slice(-15).join("\n");
  errorDetailEl.textContent =
    `エラー詳細（サポート用）\n${name}: ${message}\n動画: ${fileInfo}` +
    (logTail ? `\n---- 内部ログ(直近) ----\n${logTail}` : "");
  errorDetailEl.hidden = false;
}

/* ---------- 画面が自動で消えないようにする（対応端末のみ） ---------- */
async function requestWakeLock() {
  if (!("wakeLock" in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => {
      wakeLock = null;
    });
  } catch (e) {
    wakeLock = null;
  }
}

async function releaseWakeLock() {
  if (!wakeLock) return;
  try {
    await wakeLock.release();
  } catch (e) { /* 何もしない */ }
  wakeLock = null;
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !screens.processing.hidden) {
    requestWakeLock();
  }
});

/* ---------- ユーティリティ ---------- */
function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function formatTime(totalSeconds) {
  const sec = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function getBaseName(filename) {
  return (filename || "video").replace(/\.[a-zA-Z0-9]+$/, "");
}

function formatDuration(totalSec) {
  const sec = Math.max(0, Math.floor(totalSec));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}分${s}秒` : `${s}秒`;
}

/* ---------- ステップ1→2：ファイル選択 ---------- */
fileInput.addEventListener("change", () => {
  const file = fileInput.files && fileInput.files[0];
  if (!file) return;
  currentFile = file;

  readyFilename.textContent = file.name;
  readyMeta.textContent = `${formatBytes(file.size)}・動画の長さは分割開始時に確認します`;

  if (file.size > SIZE_WARN_BYTES) {
    readySizeWarning.textContent =
      `この動画はかなりサイズが大きいため（${formatBytes(file.size)}）、この端末では処理中にアプリが` +
      `強制終了してしまう可能性があります。`;
    readySizeWarning.hidden = false;
  } else {
    readySizeWarning.hidden = true;
  }

  showScreen("ready");
});

btnReselect.addEventListener("click", () => resetToSelect());
btnRestart.addEventListener("click", () => resetToSelect());

function resetToSelect() {
  currentFile = null;
  fileInput.value = "";
  clearErrorDetail();
  showScreen("select");
}

/* ---------- 外部スクリプトの読み込み（動画解析エンジン本体） ---------- */
let mp4boxLoadPromise = null;
function ensureMp4Box() {
  if (window.MP4Box) return Promise.resolve();
  if (mp4boxLoadPromise) return mp4boxLoadPromise;
  mp4boxLoadPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = MP4BOX_URL;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`ライブラリの読み込みに失敗しました: ${MP4BOX_URL}`));
    document.head.appendChild(s);
  });
  return mp4boxLoadPromise;
}

/* ---------- 経過時間の表示（止まって見えるのを防ぐ） ---------- */
let elapsedTimerId = null;
let elapsedStartMs = 0;

function startElapsedTimer() {
  elapsedStartMs = Date.now();
  updateElapsedDisplay();
  clearInterval(elapsedTimerId);
  elapsedTimerId = setInterval(updateElapsedDisplay, 1000);
}

function stopElapsedTimer() {
  clearInterval(elapsedTimerId);
  elapsedTimerId = null;
  progressElapsedEl.textContent = "";
}

function updateElapsedDisplay() {
  const sec = (Date.now() - elapsedStartMs) / 1000;
  progressElapsedEl.textContent = `経過時間 ${formatDuration(sec)}`;
}

function updateProgress(ratio) {
  const pct = Math.min(100, Math.max(0, Math.round((ratio || 0) * 100)));
  progressFill.style.width = `${pct}%`;
  progressOuter.setAttribute("aria-valuenow", String(pct));
}

// 写真アプリが動画の日付表示に使う、Apple独自のメタデータ形式
// （例: 2022-04-07T17:48:02+0900）。現状は参考実装として保持（下記の箱書き換えでは未使用）。
function toAppleDateString(date) {
  const pad = (n) => String(n).padStart(2, "0");
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const absMin = Math.abs(offsetMin);
  const offH = pad(Math.floor(absMin / 60));
  const offM = pad(absMin % 60);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${offH}${offM}`
  );
}

/* ---------- MP4のメタデータ書き換え（mvhd/tkhd/mdhd を直接パッチする） ----------
   mp4box.js には日付や長さを書き込むAPIが無いため、初期化セグメント（moovボックス）の
   中を自前で歩いて該当フィールドを書き換える。version 0（32bitフィールド）のみ対応し、
   version 1（64bit、iPhoneではまれ）は安全のため書き換えをスキップする。

   日付：全パーツで同じ初期化セグメントを使い回しているため、そのままだと撮影日時が
   正しく引き継がれない。
   長さ：同じ理由で、全パーツが「元動画全体の長さ」のままになってしまう
   （実際のパーツより長く表示される・シーク時の見え方がおかしくなる）ため、
   そのパーツ自身の実際の長さに書き換える。 */
const MP4_EPOCH_OFFSET = 2082844800; // 1904-01-01 と 1970-01-01 の秒差

function patchMp4Metadata(arrayBuffer, date, durationSeconds) {
  const view = new DataView(arrayBuffer);
  const dateSeconds = Math.floor(date.getTime() / 1000) + MP4_EPOCH_OFFSET;
  let movieTimescale = null;

  function walk(start, end) {
    let offset = start;
    while (offset + 8 <= end) {
      const size = view.getUint32(offset, false);
      const type = String.fromCharCode(
        view.getUint8(offset + 4), view.getUint8(offset + 5),
        view.getUint8(offset + 6), view.getUint8(offset + 7)
      );
      if (size < 8) break; // 不正な箱。これ以上は歩けない
      const boxEnd = offset + size;

      if (type === "mvhd" || type === "mdhd") {
        const version = view.getUint8(offset + 8);
        if (version === 0) {
          view.setUint32(offset + 12, dateSeconds, false); // creation_time
          view.setUint32(offset + 16, dateSeconds, false); // modification_time
          const timescale = view.getUint32(offset + 20, false);
          if (type === "mvhd") movieTimescale = timescale;
          view.setUint32(offset + 24, Math.round(durationSeconds * timescale), false); // duration
        }
      } else if (type === "tkhd") {
        const version = view.getUint8(offset + 8);
        if (version === 0) {
          view.setUint32(offset + 12, dateSeconds, false); // creation_time
          view.setUint32(offset + 16, dateSeconds, false); // modification_time
          if (movieTimescale) {
            // tkhdのdurationは「ムービー全体のタイムスケール」で表す（トラック自身のではない）
            view.setUint32(offset + 28, Math.round(durationSeconds * movieTimescale), false);
          }
        }
      } else if (type === "moov" || type === "trak" || type === "mdia") {
        walk(offset + 8, boxEnd);
      }

      offset = boxEnd;
    }
  }

  walk(0, arrayBuffer.byteLength);
  return arrayBuffer;
}

/* ---------- 断片（moof+mdat）のタイムスタンプを、このパーツの先頭=0秒に補正する ----------
   mp4box.js が出力する moof 内の tfdt（baseMediaDecodeTime）は、元動画全体の中での
   絶対位置のままになっている（パーツごとにリセットされない）。そのため、例えば
   「元動画の7分00秒〜7分28秒」のパーツは、実際のデータは28秒分しかないのに、
   コンテナ上は「0〜7分28秒の動画で、たまたま末尾28秒分だけデータがある」ように
   見えてしまう。これが、日時のずれ・再生の途中停止・サムネイル生成失敗の原因になる。
   このパーツに含まれる全moofのtfdtから、最初の値（＝このパーツの開始位置）を
   引き、0始まりに補正する。映像・音声はタイムスケールが異なるため、それぞれの
   バッファ（同一トラックのみを含む）ごとに個別に呼び出す。 */
function rebaseFragmentTimestamps(buffer) {
  const view = new DataView(buffer);
  const end = buffer.byteLength;
  const tfdtOffsets = [];

  function readType(offset) {
    return String.fromCharCode(
      view.getUint8(offset + 4), view.getUint8(offset + 5),
      view.getUint8(offset + 6), view.getUint8(offset + 7)
    );
  }

  let offset = 0;
  while (offset + 8 <= end) {
    const size = view.getUint32(offset, false);
    const type = readType(offset);
    if (size < 8) break;
    if (type === "moof") {
      let coff = offset + 8;
      const cend = offset + size;
      while (coff + 8 <= cend) {
        const csize = view.getUint32(coff, false);
        const ctype = readType(coff);
        if (csize < 8) break;
        if (ctype === "traf") {
          let toff = coff + 8;
          const tend = coff + csize;
          while (toff + 8 <= tend) {
            const tsize = view.getUint32(toff, false);
            const ttype = readType(toff);
            if (ttype === "tfdt") tfdtOffsets.push(toff);
            if (tsize < 8) break;
            toff += tsize;
          }
        }
        coff += csize;
      }
    }
    offset += size;
  }

  if (tfdtOffsets.length === 0) return;

  function readTfdt(off) {
    const version = view.getUint8(off + 8);
    return version === 1 ? view.getBigUint64(off + 12, false) : BigInt(view.getUint32(off + 12, false));
  }
  function writeTfdt(off, value) {
    const version = view.getUint8(off + 8);
    if (version === 1) view.setBigUint64(off + 12, value, false);
    else view.setUint32(off + 12, Number(value), false);
  }

  let base = null;
  for (const off of tfdtOffsets) {
    const v = readTfdt(off);
    if (base === null || v < base) base = v;
  }
  for (const off of tfdtOffsets) {
    writeTfdt(off, readTfdt(off) - base);
  }
}

/* ---------- ステップ2→3→4：分割開始 ---------- */
btnStart.addEventListener("click", async () => {
  if (!currentFile) return;
  clearErrorDetail();
  procLog = [];

  showScreen("processing");
  progressLabel.textContent = "準備しています…";
  updateProgress(0);
  startElapsedTimer();
  await requestWakeLock();

  const baseName = getBaseName(currentFile.name);

  try {
    progressLabel.textContent = "動画解析エンジンを準備しています…";
    await ensureMp4Box();

    // 元動画の撮影日時（file.lastModified）。各パーツができ次第、その場で
    // メタデータを書き換えてBlob化するため、先に計算しておく。
    const fileLastModifiedDate = currentFile.lastModified ? new Date(currentFile.lastModified) : null;

    const finalSegments = await splitVideo(currentFile, {
      baseName,
      fileLastModifiedDate,
      onPhase: (text) => { progressLabel.textContent = text; },
      onProgress: (ratio) => updateProgress(ratio),
    });

    if (finalSegments.length === 0) {
      throw new Error("分割結果を読み取れませんでした。");
    }

    renderResults(finalSegments);
    resultElapsedEl.textContent = `処理時間 ${formatDuration((Date.now() - elapsedStartMs) / 1000)}`;
    if (fileLastModifiedDate) {
      resultSourceDateEl.innerHTML =
        `元動画の撮影日時：${fileLastModifiedDate.toLocaleString("ja-JP")}<br>元動画の日時に更新しています。`;
    } else {
      resultSourceDateEl.textContent = "";
    }
    showScreen("result");
    showToast("分割が完了しました", "success");
  } catch (err) {
    console.error(err);
    showErrorToast("動画を短くするか、他のアプリを閉じてからもう一度お試しください。");
    showErrorDetail(err);
    showScreen("ready");
  } finally {
    stopElapsedTimer();
    releaseWakeLock();
  }
});

/* ---------- 分割の中心処理（mp4box.js） ----------
   ファイルを少しずつ読み込みながら mp4box.js に渡し、映像・音声トラックを
   目標の長さ（約110秒。iPhoneのカメラで撮影した動画の平均的なフレームレートから、
   その秒数に相当するサンプル数を逆算して渡す）ごとにストリームコピーで切り出す。 */
function splitVideo(file, { baseName, fileLastModifiedDate, onPhase, onProgress }) {
  return new Promise((resolve, reject) => {
    const mp4boxfile = MP4Box.createFile();
    let videoTrackId = null;
    let audioTrackId = null;
    let initBuffer = null;
    let totalDuration = 0;
    let segmentPlan = []; // [{index, startSample, endSample, startSec, endSec}, ...]（映像基準）
    const pending = new Map(); // segmentIndex -> { video: buffer|null, audio: buffer|null }
    const finished = [];
    let readerDone = false;
    let settled = false;

    function fail(err) {
      if (settled) return;
      settled = true;
      reject(err instanceof Error ? err : new Error(String(err)));
    }

    function finishIfDone() {
      if (!readerDone || settled) return;
      // 未確定のまま残っているパーツが無いか確認する
      for (const [, parts] of pending) {
        if (parts.video && !parts.audio && audioTrackId) return; // 音声待ち
      }
      settled = true;
      finished.sort((a, b) => a.index - b.index);
      resolve(finished);
    }

    function emitIfReady(segIndex) {
      const parts = pending.get(segIndex);
      if (!parts) return;
      const needAudio = audioTrackId !== null;
      if (!parts.video) return;
      if (needAudio && !parts.audio) return;

      // mp4box.jsは各断片の tfdt（このパーツの先頭が元動画全体の中で何秒目に
      // あたるか）を、パーツ単位でリセットせず元動画全体での絶対位置のまま
      // 出力する。そのままだと、パーツ自身は数十秒しか実データが無いのに、
      // コンテナ上は「元動画全体と同じ長さで、たまたま途中だけデータがある
      // ファイル」に見えてしまい、日時のズレ・再生の途中停止・サムネイル
      // 生成失敗の原因になる。このパーツの先頭を0秒とみなすよう補正する。
      try {
        rebaseFragmentTimestamps(parts.video);
        if (parts.audio) rebaseFragmentTimestamps(parts.audio);
      } catch (e) {
        log(`タイムスタンプの補正に失敗（${segIndex + 1}番目）: ${e.message}`);
      }

      const buffers = [initBuffer, parts.video];
      if (needAudio) buffers.push(parts.audio);
      const arrayBuffer = concatArrayBuffers(buffers);
      // 使い終わった映像・音声の断片への参照をすぐ手放す（次のパーツの処理と
      // 同時に、全パーツ分のバッファを溜め込んだままにしないため）
      parts.video = null;
      parts.audio = null;
      pending.delete(segIndex);

      const plan = segmentPlan[segIndex];
      const segIndex1 = segIndex + 1;

      // 日付・長さの書き換えは、全パーツ分のバッファが出そろうのを待たず、
      // このパーツができた時点ですぐに行う。書き換え後はBlob化して、生の
      // ArrayBufferへの参照を残さない（Blobにした方がメモリ圧迫が少ない）。
      const segTime = fileLastModifiedDate
        ? new Date(fileLastModifiedDate.getTime() + (plan.startSec + 1) * 1000)
        : new Date();
      try {
        patchMp4Metadata(arrayBuffer, segTime, plan.endSec - plan.startSec);
      } catch (e) {
        log(`メタデータの書き換えに失敗（${segIndex1}番目）: ${e.message}`);
      }

      const sizeBytes = arrayBuffer.byteLength;
      const blob = new Blob([arrayBuffer], { type: "video/mp4" });
      finished.push({
        index: segIndex1,
        start: plan.startSec,
        end: plan.endSec,
        url: URL.createObjectURL(blob),
        blob,
        filename: `${baseName}_${String(segIndex1).padStart(2, "0")}.mp4`,
        sizeBytes,
      });

      onProgress(segIndex1 / segmentPlan.length);
      onPhase(`切り出しています…（${segIndex1}/${segmentPlan.length}個目）`);
      finishIfDone();
    }

    mp4boxfile.onError = (e) => fail(new Error(`動画の解析に失敗しました: ${e}`));

    mp4boxfile.onReady = (info) => {
      try {
        totalDuration = info.duration / info.timescale;
        const videoTrack = info.tracks.find((t) => t.type === "video" || (t.video && t.video.width));
        const audioTrack = info.tracks.find((t) => t.type === "audio" || (t.audio && t.audio.sample_rate));
        if (!videoTrack) throw new Error("映像トラックが見つかりませんでした。");
        videoTrackId = videoTrack.id;
        if (audioTrack) audioTrackId = audioTrack.id;

        // 動画の合計サイズから、パーツ1個の目標データ量を超えないよう区切り秒数を調整
        const bytesPerSecond = file.size / Math.max(1, totalDuration);
        const targetSegmentBytes = 113 * 1024 * 1024;
        const effectiveSeconds = Math.max(
          MIN_SEGMENT_SECONDS,
          Math.min(TARGET_SEGMENT_SECONDS, Math.floor(targetSegmentBytes / bytesPerSecond))
        );

        // 映像トラックのサンプルを、目標秒数ごとの範囲に分ける
        const videoFps = videoTrack.nb_samples / totalDuration;
        const nbSamplesPerSeg = Math.max(1, Math.round(videoFps * effectiveSeconds));

        let segCount = Math.max(1, Math.ceil(totalDuration / effectiveSeconds));
        if (segCount > 1) {
          const tailSec = totalDuration - (segCount - 1) * effectiveSeconds;
          if (tailSec <= MIN_TAIL_SECONDS + 1) segCount -= 1;
        }
        segmentPlan = [];
        for (let i = 0; i < segCount; i++) {
          const startSec = i * effectiveSeconds;
          const endSec = i === segCount - 1 ? totalDuration : startSec + effectiveSeconds;
          segmentPlan.push({ startSec, endSec });
          pending.set(i, { video: null, audio: audioTrackId ? null : undefined });
        }

        log(`duration=${totalDuration.toFixed(1)}s videoFps=${videoFps.toFixed(2)} nbSamplesPerSeg=${nbSamplesPerSeg} segCount=${segCount}`);

        mp4boxfile.setSegmentOptions(videoTrackId, "video", { nbSamples: nbSamplesPerSeg, rapAlignement: true });
        if (audioTrackId) {
          const audioTrack = info.tracks.find((t) => t.id === audioTrackId);
          const audioRate = audioTrack.nb_samples / totalDuration;
          const audioNbSamples = Math.max(1, Math.round(audioRate * effectiveSeconds));
          mp4boxfile.setSegmentOptions(audioTrackId, "audio", { nbSamples: audioNbSamples, rapAlignement: true });
        }

        // initializeSegmentation() はトラックごとに別々の初期化セグメント（moov）を返す
        // （"combined"モードでも共有されない）。音声がある場合は、映像側のmoovに
        // 音声のtrak/trexを直接埋め込んで、1つのmoovにまとめる必要がある。
        const initSegs = mp4boxfile.initializeSegmentation();
        const videoInitEntry = initSegs.find((s) => s.id === videoTrackId);
        const audioInitEntry = audioTrackId ? initSegs.find((s) => s.id === audioTrackId) : null;
        initBuffer = audioInitEntry
          ? buildCombinedInitSegment(videoInitEntry.buffer, audioInitEntry.buffer)
          : videoInitEntry.buffer;

        onPhase("切り出しています…");
        mp4boxfile.start();
      } catch (e) {
        fail(e);
      }
    };

    let segCounterVideo = 0;
    let segCounterAudio = 0;

    mp4boxfile.onSegment = (id, user, buffer, sampleNumber, last) => {
      const isVideo = id === videoTrackId;
      const idx = isVideo ? segCounterVideo++ : segCounterAudio++;
      if (idx >= segmentPlan.length) return; // 想定外の余剰断片は無視
      if (!pending.has(idx)) pending.set(idx, { video: null, audio: audioTrackId ? null : undefined });
      const parts = pending.get(idx);
      if (isVideo) parts.video = buffer; else parts.audio = buffer;
      emitIfReady(idx);
      mp4boxfile.releaseUsedSamples(id, sampleNumber);
    };

    // ファイルを少しずつ読み込んで渡す
    (async () => {
      try {
        let offset = 0;
        const total = file.size;
        while (offset < total) {
          const end = Math.min(offset + CHUNK_BYTES, total);
          const chunk = await file.slice(offset, end).arrayBuffer();
          chunk.fileStart = offset;
          mp4boxfile.appendBuffer(chunk);
          offset = end;
          if (!segmentPlan.length) {
            // まだ onReady 前（解析中）
            onPhase(`動画を読み込んでいます…（${formatBytes(offset)}/${formatBytes(total)}）`);
          }
        }
        mp4boxfile.flush();
        readerDone = true;
        finishIfDone();
      } catch (e) {
        fail(e);
      }
    })();
  });
}

function concatArrayBuffers(buffers) {
  let total = 0;
  for (const b of buffers) total += b.byteLength;
  const result = new Uint8Array(total);
  let offset = 0;
  for (const b of buffers) {
    result.set(new Uint8Array(b), offset);
    offset += b.byteLength;
  }
  return result.buffer;
}

/* ---------- 映像・音声の初期化セグメント（moov）を1つに結合する ----------
   mp4box.js の initializeSegmentation() は、映像・音声それぞれに独立した
   moovを返す。映像側のmoovに、音声側の trak（トラック構造）と trex
   （mvex内のフラグメント既定値）を挿入し、1つのファイルとして両方の
   トラックを正しく記述するmoovを組み立てる。 */
function findBox(buf, start, end, type) {
  const view = new DataView(buf);
  let offset = start;
  while (offset + 8 <= end) {
    const size = view.getUint32(offset, false);
    const t = String.fromCharCode(
      view.getUint8(offset + 4), view.getUint8(offset + 5),
      view.getUint8(offset + 6), view.getUint8(offset + 7)
    );
    if (t === type) return { offset, size };
    if (size < 8) break;
    offset += size;
  }
  return null;
}

function boxHeader(size, type) {
  const b = new ArrayBuffer(8);
  const dv = new DataView(b);
  dv.setUint32(0, size, false);
  for (let i = 0; i < 4; i++) dv.setUint8(4 + i, type.charCodeAt(i));
  return b;
}

function buildCombinedInitSegment(videoBuf, audioBuf) {
  const vFtyp = findBox(videoBuf, 0, videoBuf.byteLength, "ftyp");
  const vMoov = findBox(videoBuf, 0, videoBuf.byteLength, "moov");
  const aMoov = findBox(audioBuf, 0, audioBuf.byteLength, "moov");
  if (!vFtyp || !vMoov || !aMoov) throw new Error("初期化セグメントの箱を認識できませんでした。");

  const aTrak = findBox(audioBuf, aMoov.offset + 8, aMoov.offset + aMoov.size, "trak");
  const aMvex = findBox(audioBuf, aMoov.offset + 8, aMoov.offset + aMoov.size, "mvex");
  const aTrex = aMvex ? findBox(audioBuf, aMvex.offset + 8, aMvex.offset + aMvex.size, "trex") : null;
  if (!aTrak) throw new Error("音声トラックの構造（trak）を認識できませんでした。");

  const vMvex = findBox(videoBuf, vMoov.offset + 8, vMoov.offset + vMoov.size, "mvex");
  const aTrakBytes = audioBuf.slice(aTrak.offset, aTrak.offset + aTrak.size);
  const aTrexBytes = aTrex ? audioBuf.slice(aTrex.offset, aTrex.offset + aTrex.size) : new ArrayBuffer(0);

  let newMoovContentParts;
  if (vMvex) {
    const beforeMvex = videoBuf.slice(vMoov.offset + 8, vMvex.offset);
    const mvexContent = videoBuf.slice(vMvex.offset + 8, vMvex.offset + vMvex.size);
    const newMvexSize = 8 + mvexContent.byteLength + aTrexBytes.byteLength;
    const afterMvex = videoBuf.slice(vMvex.offset + vMvex.size, vMoov.offset + vMoov.size);
    newMoovContentParts = [beforeMvex, boxHeader(newMvexSize, "mvex"), mvexContent, aTrexBytes, afterMvex, aTrakBytes];
  } else {
    const wholeMoovContent = videoBuf.slice(vMoov.offset + 8, vMoov.offset + vMoov.size);
    newMoovContentParts = [wholeMoovContent, aTrakBytes];
  }

  const newMoovContent = concatArrayBuffers(newMoovContentParts);
  const newMoovSize = 8 + newMoovContent.byteLength;
  const ftypBytes = videoBuf.slice(vFtyp.offset, vFtyp.offset + vFtyp.size);
  return concatArrayBuffers([ftypBytes, boxHeader(newMoovSize, "moov"), newMoovContent]);
}

/* ---------- 保存する（共有シート経由。使えない環境ではダウンロードにフォールバック） ---------- */
function markSaved(btn) {
  btn.textContent = "保存済み ✓";
  btn.dataset.saved = "true";
}

function fallbackDownload(seg) {
  const a = document.createElement("a");
  a.href = seg.url;
  a.download = seg.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function saveSegment(seg, btn) {
  const file = new File([seg.blob], seg.filename, { type: "video/mp4" });
  let canShareFile = false;
  if (typeof navigator.share === "function" && typeof navigator.canShare === "function") {
    try {
      canShareFile = navigator.canShare({ files: [file] });
    } catch (e) {
      canShareFile = false;
    }
  }

  if (canShareFile) {
    try {
      await navigator.share({ files: [file] });
      markSaved(btn);
      showToast(`${seg.index}番目を保存しました`, "success");
    } catch (err) {
      if (err && err.name === "AbortError") return;
      console.error(err);
      showToast(`共有に失敗しました。${MEMORY_HINT}`, "error");
    }
    return;
  }

  fallbackDownload(seg);
  markSaved(btn);
  showToast(`${seg.index}番目を保存しました`, "success");
}

/* ---------- 結果表示 ---------- */
function renderResults(segments) {
  segmentList.innerHTML = "";
  resultHeading.textContent = `${segments.length}個に分割できました`;
  resultSingleNote.hidden = segments.length !== 1;

  for (const seg of segments) {
    const li = document.createElement("li");
    li.className = "segment-item";

    const row = document.createElement("div");
    row.className = "segment-item__row";

    const badge = document.createElement("div");
    badge.className = "segment-item__badge";
    badge.textContent = String(seg.index);
    badge.setAttribute("aria-hidden", "true");

    const info = document.createElement("div");
    info.className = "segment-item__info";

    const range = document.createElement("p");
    range.className = "segment-item__range";
    range.textContent = `元動画の ${formatTime(seg.start)}〜${formatTime(seg.end)}`;

    const dur = document.createElement("p");
    dur.className = "segment-item__dur";
    dur.textContent = `長さ ${formatTime(seg.end - seg.start)}・${formatBytes(seg.sizeBytes)}`;

    info.appendChild(range);
    info.appendChild(dur);

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "segment-item__save";
    saveBtn.textContent = "保存する";
    saveBtn.setAttribute("aria-label", `${seg.index}番目（元動画の${formatTime(seg.start)}から${formatTime(seg.end)}）を保存する`);
    saveBtn.addEventListener("click", () => saveSegment(seg, saveBtn));

    row.appendChild(badge);
    row.appendChild(info);
    row.appendChild(saveBtn);

    const preview = document.createElement("video");
    preview.className = "segment-item__preview";
    preview.src = seg.url;
    preview.controls = true;
    preview.playsInline = true;
    preview.setAttribute("aria-label", `${seg.index}番目のプレビュー`);

    li.appendChild(row);
    li.appendChild(preview);
    segmentList.appendChild(li);
  }
}

/* ---------- 想定外のクラッシュも必ず日本語で伝える ---------- */
window.addEventListener("error", (event) => {
  if (!screens.processing.hidden) {
    stopElapsedTimer();
    releaseWakeLock();
    showErrorToast();
    showErrorDetail(event.error || { name: "Error", message: event.message });
    showScreen("ready");
  }
});
window.addEventListener("unhandledrejection", (event) => {
  if (!screens.processing.hidden) {
    stopElapsedTimer();
    releaseWakeLock();
    showErrorToast();
    showErrorDetail(event.reason);
    showScreen("ready");
  }
});

/* ---------- PWA: サービスワーカー登録 ---------- */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {
      // オフライン用の登録に失敗しても、通常の利用には影響しない
    });
  });
}
