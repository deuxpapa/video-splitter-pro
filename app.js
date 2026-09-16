"use strict";

/* ==========================================================
   Video Splitter Pro - アプリ本体
   動画ファイルを少しずつ読み込みながら分割する（丸ごとメモリに読み込まない）。
   MP4/MOVコンテナを箱（box）単位で解析できる mp4box.js を使い、
   ストリームコピー（再エンコードなし）でパーツを切り出す。
   処理はすべて端末内（ブラウザ内）で完結し、外部へ動画を送信しない。
   ========================================================== */

// 更新するたびに手動で書き換える（画面に表示され、更新が反映されたかの確認に使う）
const APP_VERSION = "2026-09-16.5";

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
// 動画を選ぶピッカーを開く操作自体（大きい動画だと選択～読み込みに時間が
// かかることがある）の時点で、画面が暗くならないようにしておく。
fileInput.addEventListener("click", () => { requestWakeLock(); });

fileInput.addEventListener("change", () => {
  const file = fileInput.files && fileInput.files[0];
  if (!file) return;
  currentFile = file;
  requestWakeLock();

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
  releaseWakeLock();
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
      } else if (type === "elst") {
        // 編集リスト（トラックが「ムービー全体の中で何秒間再生されるか」を
        // 宣言する箱）。ここが元動画全体の長さのまま残っていると、mvhd/tkhd
        // を書き換えてもiPhone側はこちらを信用してしまい、動画情報の長さが
        // 元動画のまま表示されたり、実データが尽きた後もスクラバーだけ動き
        // 続けたり、音声が正しく再生されなくなったりする。
        const version = view.getUint8(offset + 8);
        const entryCount = view.getUint32(offset + 12, false);
        if (version === 0 && movieTimescale) {
          // media_time === -1 の entry は「空の間（dwell）」で、A/V同期用の
          // 固定オフセットなので触らない。実データを指すentry（通常1つ）だけを
          // このパーツの長さに書き換える。
          const realEntryOffsets = [];
          let entryOffset = offset + 16;
          for (let i = 0; i < entryCount; i++) {
            const mediaTime = view.getInt32(entryOffset + 4, false);
            if (mediaTime !== -1) realEntryOffsets.push(entryOffset);
            entryOffset += 12;
          }
          if (realEntryOffsets.length === 1) {
            view.setUint32(realEntryOffsets[0], Math.round(durationSeconds * movieTimescale), false); // segment_duration
          } else {
            log(`elstの補正をスキップ（entryCount=${entryCount}, 実データentry数=${realEntryOffsets.length}）`);
          }
        }
      } else if (type === "moov" || type === "trak" || type === "mdia" || type === "edts") {
        walk(offset + 8, boxEnd);
      }

      offset = boxEnd;
    }
  }

  walk(0, arrayBuffer.byteLength);
  return arrayBuffer;
}

/* ---------- 1パーツ分のサンプル列から、古典的な（断片化しない）MP4を自前で組み立てる ----------
   mp4box.js自身の断片化機能（setSegmentOptions/onSegment、あるいは自前でmoof+mdatを
   組み立てる方式）は、仕様上は正しいfMP4を作れるが、iPhoneのカメラ動画は本来この
   形式では保存されない。実際に試したところ、fMP4形式である限り、断片の粒度を
   変えても（1コマ単位でも、1パーツ単位でも）、写真アプリ側の動画情報の長さ表示・
   再生の挙動が直らなかった。
   そこで、mp4box.jsからは setExtractionOptions/onSamples で生のサンプル列
   （実データ・長さ・タイムスタンプ情報）だけを受け取り、パーツ1個分を、
   通常のカメラ動画と同じ「moovに直接サンプル位置の表（stbl）がある、
   断片化しない」古典的なMP4として自前で組み立てる。
   コーデック設定（stsd）やトラックの基本情報（tkhd/mdhd/hdlrなど）は、
   元動画からそのままコピーする（extractTrackTemplates）。 */

// 元ファイルからftyp/moovの箱を（中身を読まずに）探す。ファイルを丸ごと
// メモリへ読み込まず、箱のヘッダ（8〜16byte）だけを少しずつ読んで位置を
// 特定する。moovが動画の末尾にあるカメラ動画でも、負荷は小さい。
async function locateFtypAndMoov(file) {
  let offset = 0;
  const total = file.size;
  let ftypLoc = null;
  let moovLoc = null;
  while (offset + 8 <= total && (!ftypLoc || !moovLoc)) {
    const header = await file.slice(offset, offset + 8).arrayBuffer();
    const view = new DataView(header);
    let size = view.getUint32(0, false);
    const type = String.fromCharCode(
      view.getUint8(4), view.getUint8(5), view.getUint8(6), view.getUint8(7)
    );
    if (size === 1) {
      const ext = await file.slice(offset + 8, offset + 16).arrayBuffer();
      size = Number(new DataView(ext).getBigUint64(0, false));
    } else if (size === 0) {
      size = total - offset;
    }
    if (type === "ftyp") ftypLoc = { start: offset, size };
    if (type === "moov") moovLoc = { start: offset, size };
    if (size < 8) break;
    offset += size;
  }
  if (!ftypLoc || !moovLoc) throw new Error("ftyp/moovの箱を認識できませんでした。");
  return { ftypLoc, moovLoc };
}

// 元動画のmoov（生バイト）から、トラックごとに「stbl以外」の部分（tkhd、
// mdhd、hdlr、コーデック設定stsdなど）をテンプレートとして抜き出す。
// stbl（サンプル位置の表）だけは、パーツごとに自前で作り直す必要がある。
function extractTrackTemplates(moovBuf) {
  const moov = findBox(moovBuf, 0, moovBuf.byteLength, "moov");
  if (!moov) throw new Error("元動画のmoovを認識できませんでした。");
  const mvhd = findBox(moovBuf, moov.offset + 8, moov.offset + moov.size, "mvhd");
  if (!mvhd) throw new Error("mvhdを認識できませんでした。");
  const mvhdBytes = moovBuf.slice(mvhd.offset, mvhd.offset + mvhd.size);
  const view = new DataView(moovBuf);

  const templates = [];
  let trak = findBox(moovBuf, moov.offset + 8, moov.offset + moov.size, "trak");
  while (trak) {
    const tkhd = findBox(moovBuf, trak.offset + 8, trak.offset + trak.size, "tkhd");
    const mdia = findBox(moovBuf, trak.offset + 8, trak.offset + trak.size, "mdia");
    if (tkhd && mdia) {
      const minf = findBox(moovBuf, mdia.offset + 8, mdia.offset + mdia.size, "minf");
      const stbl = minf ? findBox(moovBuf, minf.offset + 8, minf.offset + minf.size, "stbl") : null;
      const stsd = stbl ? findBox(moovBuf, stbl.offset + 8, stbl.offset + stbl.size, "stsd") : null;
      if (minf && stbl && stsd) {
        templates.push({
          trackId: view.getUint32(tkhd.offset + 20, false),
          preMdiaBytes: moovBuf.slice(trak.offset + 8, mdia.offset),
          mdiaPreMinfBytes: moovBuf.slice(mdia.offset + 8, minf.offset),
          minfPreStblBytes: moovBuf.slice(minf.offset + 8, stbl.offset),
          stsdBytes: moovBuf.slice(stsd.offset, stsd.offset + stsd.size),
        });
      }
    }
    trak = findBox(moovBuf, trak.offset + trak.size, moov.offset + moov.size, "trak");
  }
  return { mvhdBytes, templates };
}

// 1トラック分のサンプル位置の表（stbl）を組み立てる。stco（サンプル実データの
// ファイル内オフセット）はこの時点ではまだ分からないので0で仮置きし、
// 呼び出し側でファイル全体の組み立てが終わってから書き換える（patchStco）。
function buildStbl(stsdBytes, samples, isVideo) {
  const sttsRuns = [];
  for (const s of samples) {
    if (sttsRuns.length && sttsRuns[sttsRuns.length - 1][1] === s.duration) sttsRuns[sttsRuns.length - 1][0]++;
    else sttsRuns.push([1, s.duration]);
  }
  const needsCtts = samples.some((s) => s.cts !== s.dts);
  const cttsRuns = [];
  if (needsCtts) {
    for (const s of samples) {
      const off = s.cts - s.dts;
      if (cttsRuns.length && cttsRuns[cttsRuns.length - 1][1] === off) cttsRuns[cttsRuns.length - 1][0]++;
      else cttsRuns.push([1, off]);
    }
  }
  const syncNumbers = [];
  if (isVideo) samples.forEach((s, i) => { if (s.is_sync) syncNumbers.push(i + 1); });
  const needsStss = isVideo && syncNumbers.length > 0 && syncNumbers.length < samples.length;

  const sttsSize = 16 + sttsRuns.length * 8;
  const cttsSize = needsCtts ? (16 + cttsRuns.length * 8) : 0;
  const stssSize = needsStss ? (16 + syncNumbers.length * 4) : 0;
  const stscSize = 12 + 4 + 12;
  const stszSize = 12 + 8 + samples.length * 4;
  const stcoSize = 12 + 4 + 4;
  const stblContentSize = stsdBytes.byteLength + sttsSize + cttsSize + stscSize + stszSize + stssSize + stcoSize;
  const stblSize = 8 + stblContentSize;

  const out = new ArrayBuffer(stblSize);
  const view = new DataView(out);
  const bytes = new Uint8Array(out);
  let pos = 0;
  function u32(v) { view.setUint32(pos, v, false); pos += 4; }
  function boxType(t) { for (let i = 0; i < 4; i++) { view.setUint8(pos, t.charCodeAt(i)); pos += 1; } }
  function plainHeader(size, type) { u32(size); boxType(type); }
  function fullHeader(size, type) { u32(size); boxType(type); u32(0); } // version(1)+flags(3)=0

  plainHeader(stblSize, "stbl");
  bytes.set(new Uint8Array(stsdBytes), pos);
  pos += stsdBytes.byteLength;

  fullHeader(sttsSize, "stts");
  u32(sttsRuns.length);
  for (const [count, delta] of sttsRuns) { u32(count); u32(delta); }

  if (needsCtts) {
    fullHeader(cttsSize, "ctts");
    u32(cttsRuns.length);
    for (const [count, off] of cttsRuns) { u32(count); u32(off); }
  }

  fullHeader(stscSize, "stsc");
  u32(1);
  u32(1); u32(samples.length); u32(1); // first_chunk, samples_per_chunk, sample_description_index

  fullHeader(stszSize, "stsz");
  u32(0); // sample_size=0 → 以降は1個ずつのサイズ表
  u32(samples.length);
  for (const s of samples) u32(s.size);

  if (needsStss) {
    fullHeader(stssSize, "stss");
    u32(syncNumbers.length);
    for (const n of syncNumbers) u32(n);
  }

  fullHeader(stcoSize, "stco");
  u32(1);
  u32(0); // 実際のオフセットは後で書き換える

  return out;
}

// テンプレート（stbl以外）＋このパーツのサンプル列から、1トラック分のtrak箱を
// 組み立てる。内側（stbl）から外側（trak）へ、サイズを積み上げながら組み立てる。
function buildTrak(template, samples, isVideo) {
  const stbl = buildStbl(template.stsdBytes, samples, isVideo);
  const minfContent = concatArrayBuffers([template.minfPreStblBytes, stbl]);
  const minfBytes = concatArrayBuffers([boxHeader(8 + minfContent.byteLength, "minf"), minfContent]);
  const mdiaContent = concatArrayBuffers([template.mdiaPreMinfBytes, minfBytes]);
  const mdiaBytes = concatArrayBuffers([boxHeader(8 + mdiaContent.byteLength, "mdia"), mdiaContent]);
  const trakContent = concatArrayBuffers([template.preMdiaBytes, mdiaBytes]);
  return concatArrayBuffers([boxHeader(8 + trakContent.byteLength, "trak"), trakContent]);
}

// buildTrak()が返したtrak箱の中のstco（サンプル実データの絶対オフセット）を、
// ファイル全体の組み立てが終わって初めて分かる実際の値に書き換える。
function patchStco(trakBuffer, dataOffset) {
  const trak = findBox(trakBuffer, 0, trakBuffer.byteLength, "trak");
  const mdia = findBox(trakBuffer, trak.offset + 8, trak.offset + trak.size, "mdia");
  const minf = findBox(trakBuffer, mdia.offset + 8, mdia.offset + mdia.size, "minf");
  const stbl = findBox(trakBuffer, minf.offset + 8, minf.offset + minf.size, "stbl");
  const stco = findBox(trakBuffer, stbl.offset + 8, stbl.offset + stbl.size, "stco");
  new DataView(trakBuffer).setUint32(stco.offset + 16, dataOffset, false); // header(12)+entry_count(4)
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
   その秒数に相当するサンプル数を逆算して渡す）ごとにストリームコピーで切り出す。
   各パーツは、断片化（fMP4）ではなく、通常のカメラ動画と同じ古典的な構造
   （moovに直接サンプル位置の表がある）で組み立てる。 */
function splitVideo(file, { baseName, fileLastModifiedDate, onPhase, onProgress }) {
  return new Promise((resolve, reject) => {
    const mp4boxfile = MP4Box.createFile();
    let videoTrackId = null;
    let audioTrackId = null;
    let templateFtypBytes = null;
    let templateMvhdBytes = null;
    let trackTemplates = null; // [{trackId, preMdiaBytes, mdiaPreMinfBytes, minfPreStblBytes, stsdBytes}, ...]
    let totalDuration = 0;
    let segmentPlan = []; // [{startSec, endSec}, ...]（映像基準）
    const pending = new Map(); // segmentIndex -> { video: samples|null, audio: samples|null }
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

      const videoSamples = parts.video;
      const audioSamples = parts.audio;
      // 使い終わった映像・音声のサンプル列への参照をすぐ手放す（次のパーツの
      // 処理と同時に、全パーツ分を溜め込んだままにしないため）
      parts.video = null;
      parts.audio = null;
      pending.delete(segIndex);

      const videoTemplate = trackTemplates.find((t) => t.trackId === videoTrackId);
      const audioTemplate = needAudio ? trackTemplates.find((t) => t.trackId === audioTrackId) : null;

      const videoTrakBuffer = buildTrak(videoTemplate, videoSamples, true);
      const audioTrakBuffer = needAudio ? buildTrak(audioTemplate, audioSamples, false) : null;

      // moov全体の大きさは、trak（サイズ固定・stcoの値だけこの後書き換える）が
      // 組み上がった時点で確定する。stcoに入れるべき絶対オフセットは、
      // 「ftyp＋moov＋mdatヘッダ」の直後から始まる。
      const headerLen = templateFtypBytes.byteLength + 8 + templateMvhdBytes.byteLength
        + videoTrakBuffer.byteLength + (audioTrakBuffer ? audioTrakBuffer.byteLength : 0);

      let videoDataSize = 0;
      for (const s of videoSamples) videoDataSize += s.size;
      let audioDataSize = 0;
      if (audioSamples) for (const s of audioSamples) audioDataSize += s.size;

      const videoDataOffset = headerLen + 8; // mdatヘッダの直後
      const audioDataOffset = videoDataOffset + videoDataSize;
      patchStco(videoTrakBuffer, videoDataOffset);
      if (audioTrakBuffer) patchStco(audioTrakBuffer, audioDataOffset);

      const moovContentParts = [templateMvhdBytes, videoTrakBuffer];
      if (audioTrakBuffer) moovContentParts.push(audioTrakBuffer);
      const moovContent = concatArrayBuffers(moovContentParts);
      const moovBytes = concatArrayBuffers([boxHeader(8 + moovContent.byteLength, "moov"), moovContent]);
      const mdatHeader = boxHeader(8 + videoDataSize + audioDataSize, "mdat");

      const fileParts = [templateFtypBytes, moovBytes, mdatHeader];
      for (const s of videoSamples) fileParts.push(s.data);
      if (audioSamples) for (const s of audioSamples) fileParts.push(s.data);
      const arrayBuffer = concatArrayBuffers(fileParts);

      const plan = segmentPlan[segIndex];
      const segIndex1 = segIndex + 1;

      // 日付・長さの書き換えは、このパーツができた時点ですぐに行う。書き換え後は
      // Blob化して、生のArrayBufferへの参照を残さない（Blobにした方がメモリ
      // 圧迫が少ない）。
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

        mp4boxfile.setExtractionOptions(videoTrackId, "video", { nbSamples: nbSamplesPerSeg });
        if (audioTrackId) {
          const audioTrack2 = info.tracks.find((t) => t.id === audioTrackId);
          const audioRate = audioTrack2.nb_samples / totalDuration;
          const audioNbSamples = Math.max(1, Math.round(audioRate * effectiveSeconds));
          mp4boxfile.setExtractionOptions(audioTrackId, "audio", { nbSamples: audioNbSamples });
        }

        onPhase("切り出しています…");
        mp4boxfile.start();
      } catch (e) {
        fail(e);
      }
    };

    let segCounterVideo = 0;
    let segCounterAudio = 0;
    let sampleCounterVideo = 0;
    let sampleCounterAudio = 0;

    mp4boxfile.onSamples = (id, user, samples) => {
      const isVideo = id === videoTrackId;
      const idx = isVideo ? segCounterVideo++ : segCounterAudio++;
      // mp4box.jsは releaseUsedSamples() を呼ぶと、内部で保持している
      // sample.data を null にしてしまう。パーツが完成する（emitIfReady）まで
      // このサンプルのデータが必要なので、ここで独立したコピーとして持っておく。
      const copied = samples.map((s) => ({
        data: new Uint8Array(s.data), size: s.size, duration: s.duration, cts: s.cts, dts: s.dts, is_sync: s.is_sync,
      }));
      if (isVideo) sampleCounterVideo += samples.length; else sampleCounterAudio += samples.length;
      if (idx < segmentPlan.length) {
        if (!pending.has(idx)) pending.set(idx, { video: null, audio: audioTrackId ? null : undefined });
        const parts = pending.get(idx);
        if (isVideo) parts.video = copied; else parts.audio = copied;
        emitIfReady(idx);
      } // 想定外の余剰バッチは無視
      mp4boxfile.releaseUsedSamples(id, isVideo ? sampleCounterVideo : sampleCounterAudio);
    };

    (async () => {
      try {
        // トラックの基本情報（tkhd/mdhd/hdlr/コーデック設定など）のテンプレートを、
        // 元ファイルから直接（mp4box.jsを介さず）取得しておく。
        const { ftypLoc, moovLoc } = await locateFtypAndMoov(file);
        templateFtypBytes = await file.slice(ftypLoc.start, ftypLoc.start + ftypLoc.size).arrayBuffer();
        const moovBuf = await file.slice(moovLoc.start, moovLoc.start + moovLoc.size).arrayBuffer();
        const extracted = extractTrackTemplates(moovBuf);
        templateMvhdBytes = extracted.mvhdBytes;
        trackTemplates = extracted.templates;

        // ファイルを少しずつ読み込んで渡す
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

/* ---------- MP4の箱（box）を読み書きするための共通ヘルパー ---------- */
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
