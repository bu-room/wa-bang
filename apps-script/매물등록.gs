/* =============================================================================
 * 와방 매물 등록 서버 (사진 자동 압축 등록 페이지용)
 * -----------------------------------------------------------------------------
 * ※ '문의접수' Apps Script와 따로, 새 Apps Script 프로젝트에 붙여넣으세요.
 *    (한 프로젝트에 doPost가 두 개 있으면 서로 충돌해요)
 *
 * 설치 순서
 *  1) script.google.com → 새 프로젝트 → 이 코드 전체 붙여넣기
 *  2) 아래 SHEET_ID 에 매물 구글 시트 주소의 /d/ 와 /edit 사이 값을 넣기
 *  3) 위쪽 함수 선택에서 '설치하기' 선택 → 실행 → 권한 허용
 *     → 실행 로그에 나온 '등록 비밀번호'를 메모
 *  4) 배포 → 새 배포 → 유형: 웹 앱 / 실행: 나 / 액세스: 모든 사용자 → 배포
 *     → 웹앱 주소(…/exec)를 register/index.html 의 CONFIG.REGISTER_URL 에 넣기
 *
 * 하는 일
 *  - 등록 페이지에서 줄여서 보낸 사진(장당 약 200KB)을 드라이브 '와방 매물사진' 폴더에 저장
 *  - 매물 시트에 한 줄 추가 (매물번호 자동, 상태 '진행중' 자동)
 *  - (구글폼을 계속 써도) 폼 제출 시 매물번호·상태 자동 입력
 *  - 비밀번호 5번 틀리면 10분 잠금
 * ============================================================================= */

const SHEET_ID          = "";            // 예: "1AbC...xyz" (시트 주소 /d/ 와 /edit 사이)
const LISTING_SHEET_GID = 2111395519;    // 손님에게 공개되는 매물 탭 (CSV 주소의 gid= 값)
const PHOTO_FOLDER_NAME = "와방 매물사진";
const SITE_URL          = "https://skylee-lang.github.io/wa-bang/";

const PROPS = PropertiesService.getScriptProperties();
const COLS = ["타임스탬프", "거래유형", "매물종류", "지역", "보증금", "월세", "전세금", "매매가", "관리비",
              "전용면적", "공급면적", "층수", "방향", "반려동물", "한줄특징", "사진", "상태", "매물번호"];
const DEALS = ["월세", "전세", "매매", "단기"];
const MAX_PHOTO_BYTES = 3 * 1024 * 1024;   // 압축 후 장당 3MB 넘으면 거부 (보통 0.2MB)
const DAILY_PHOTO_LIMIT = 300;             // 하루 사진 업로드 상한 (비밀번호 유출 대비)

/* ---------------------------------------------------------------- 웹앱 ---- */
function doGet() {
  return ContentService.createTextOutput("와방 매물 등록 서버가 켜져 있어요.");
}

function doPost(e) {
  let d;
  try { d = JSON.parse((e && e.postData && e.postData.contents) || "{}"); }
  catch (err) { return json_({ ok: false, error: "요청 형식이 올바르지 않아요." }); }

  const authErr = checkPw_(d.pw);
  if (authErr) return json_({ ok: false, auth: true, error: authErr });

  try {
    if (d.action === "check") return json_({ ok: true, regions: topRegions_(), site: SITE_URL });
    if (d.action === "photo") return json_(savePhoto_(d));
    if (d.action === "save")  return json_(saveListing_(d));
    return json_({ ok: false, error: "알 수 없는 요청이에요." });
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err).slice(0, 300) });
  }
}

/* ------------------------------------------------------------ 비밀번호 ---- */
function checkPw_(pw) {
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get("PW_FAIL") || 0);
  if (fails >= 5) return "비밀번호를 여러 번 틀려서 10분 동안 잠겼어요. 잠시 후 다시 해 주세요.";
  const real = PROPS.getProperty("REG_PW");
  if (!real) return "서버 설치가 끝나지 않았어요. Apps Script에서 '설치하기'를 먼저 실행해 주세요.";
  if (String(pw || "") !== real) {
    cache.put("PW_FAIL", String(fails + 1), 600);
    return "비밀번호가 맞지 않아요.";
  }
  return "";
}

/* ---------------------------------------------------------------- 사진 ---- */
function savePhoto_(d) {
  const b64 = String(d.data || "").replace(/^data:[^,]+,/, "");
  if (!b64) return { ok: false, error: "사진 데이터가 비어 있어요." };
  const bytes = Utilities.base64Decode(b64);
  if (bytes.length > MAX_PHOTO_BYTES) return { ok: false, error: "사진 용량이 너무 커요. 다시 골라 주세요." };
  // JPEG 머리글(FF D8) 확인: 등록 페이지가 항상 JPEG로 바꿔서 보냄
  if (!(bytes[0] === -1 && bytes[1] === -40)) return { ok: false, error: "사진 형식이 올바르지 않아요." };

  const today = Utilities.formatDate(new Date(), "Asia/Seoul", "yyyyMMdd");
  const cntKey = "PHOTO_CNT_" + today;
  const cnt = Number(PROPS.getProperty(cntKey) || 0);
  if (cnt >= DAILY_PHOTO_LIMIT) return { ok: false, error: "오늘 올릴 수 있는 사진 수를 넘었어요." };
  PROPS.setProperty(cntKey, String(cnt + 1));

  const name = today + "_" + Utilities.getUuid().slice(0, 8) + ".jpg";
  const file = photoFolder_().createFile(Utilities.newBlob(bytes, "image/jpeg", name));
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return { ok: true, id: file.getId() };
}

function photoFolder_() {
  const id = PROPS.getProperty("PHOTO_FOLDER_ID");
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
  const it = DriveApp.getFoldersByName(PHOTO_FOLDER_NAME);
  const folder = it.hasNext() ? it.next() : DriveApp.createFolder(PHOTO_FOLDER_NAME);
  PROPS.setProperty("PHOTO_FOLDER_ID", folder.getId());
  return folder;
}

/* ------------------------------------------------------------ 매물 저장 ---- */
function saveListing_(d) {
  const L = d.listing || {};
  const deals = (Array.isArray(L.deals) ? L.deals : []).filter(x => DEALS.indexOf(x) >= 0);
  if (!deals.length) return { ok: false, error: "거래유형을 골라 주세요." };
  if (!txt_(L.type)) return { ok: false, error: "매물종류를 골라 주세요." };
  if (!txt_(L.area)) return { ok: false, error: "지역을 입력해 주세요." };
  const needRent = deals.some(x => x === "월세" || x === "단기");
  if (needRent && !num_(L.rent) && !num_(L.dep)) return { ok: false, error: "보증금이나 월세를 입력해 주세요." };
  if (deals.indexOf("전세") >= 0 && !num_(L.jeon)) return { ok: false, error: "전세금을 입력해 주세요." };
  if (deals.indexOf("매매") >= 0 && !num_(L.sale)) return { ok: false, error: "매매가를 입력해 주세요." };

  const photoIds = (Array.isArray(d.photos) ? d.photos : [])
    .map(String).filter(x => /^[\w-]{20,}$/.test(x)).slice(0, 10);

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = listingSheet_();
    const H = ensureCols_(sh);
    const no = nextNo_(sh, H);
    const row = new Array(sh.getLastColumn()).fill("");
    const put = (name, v) => { if (H[name] != null) row[H[name]] = v; };

    put("타임스탬프", new Date());
    put("거래유형", deals.join(", "));
    put("매물종류", txt_(L.type));
    put("지역", txt_(L.area));
    put("보증금", num_(L.dep));
    put("월세", num_(L.rent));
    put("전세금", num_(L.jeon));
    put("매매가", num_(L.sale));
    put("관리비", num_(L.fee));
    put("전용면적", num_(L.exc));
    put("공급면적", num_(L.sup));
    put("층수", L.floor ? "'" + txt_(L.floor) : "");      // '3/5' 가 날짜로 바뀌지 않게 글자로 저장
    put("방향", txt_(L.dir));
    put("반려동물", txt_(L.pet));
    put("한줄특징", txt_(L.memo, 300));
    put("사진", photoIds.map(id => "https://drive.google.com/open?id=" + id).join(", "));
    put("상태", "진행중");
    put("매물번호", no);

    sh.appendRow(row);
    const r = sh.getLastRow();
    // 타임스탬프 칸을 구글폼과 같은 모양(2026. 11. 19 오전 7:15:33)으로 표시
    // (위 줄 서식을 복사하면 표(Table) 시트에서 빈칸으로 보이는 경우가 있어서 직접 지정)
    if (H["타임스탬프"] != null) sh.getRange(r, H["타임스탬프"] + 1).setNumberFormat("yyyy. M. d am/pm h:mm:ss");
    PROPS.setProperty("LAST_NO", String(no));
    return { ok: true, no: no, site: SITE_URL };
  } finally {
    lock.releaseLock();
  }
}

/* ------------------------------------------------------------ 시트 도구 ---- */
function listingSheet_() {
  if (!SHEET_ID) throw new Error("SHEET_ID 가 비어 있어요. 코드 위쪽 SHEET_ID 에 시트 주소 값을 넣어 주세요.");
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sh = ss.getSheets().find(s => s.getSheetId() === LISTING_SHEET_GID);
  if (!sh) throw new Error("매물 탭(gid " + LISTING_SHEET_GID + ")을 못 찾았어요.");
  return sh;
}

const norm_ = h => String(h).replace(/\([^)]*\)/g, "").replace(/（[^）]*）/g, "").replace(/\s/g, "");

/* 열 이름 → 0부터 시작하는 열 번호. 없는 열(상태·매물번호 등)은 맨 오른쪽에 만들어 줌 */
function ensureCols_(sh) {
  const lastCol = Math.max(sh.getLastColumn(), 1);
  const head = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(norm_);
  const H = {};
  COLS.forEach(c => { const i = head.indexOf(c); if (i >= 0) H[c] = i; });
  // 사이트가 같이 읽는 다른 이름도 인정
  const alias = { "전용면적": ["전용평수", "전용"], "공급면적": ["공급평수", "공급"], "층수": ["층"],
                  "한줄특징": ["특징", "메모"], "반려동물": ["반려동물여부", "펫"], "타임스탬프": ["Timestamp", "등록일시", "등록일"] };
  Object.keys(alias).forEach(c => {
    if (H[c] == null) { const i = head.findIndex(h => alias[c].indexOf(h) >= 0); if (i >= 0) H[c] = i; }
  });
  let add = lastCol;
  ["상태", "매물번호"].forEach(c => {
    if (H[c] == null) { sh.getRange(1, add + 1).setValue(c); H[c] = add; add++; }
  });
  return H;
}

/* 다음 매물번호 = (지금까지 가장 큰 번호, 마지막 줄 번호) 중 큰 값 + 1
   → 예전에 행 번호로 보이던 번호와 겹치지 않음 */
function nextNo_(sh, H, selfIncluded) {
  const last = sh.getLastRow();
  let max = Math.max(Number(PROPS.getProperty("LAST_NO") || 0), selfIncluded ? last - 1 : last);
  if (last > 1) {
    sh.getRange(2, H["매물번호"] + 1, last - 1, 1).getValues()
      .forEach(([v]) => { const n = Number(v); if (n > max) max = n; });
  }
  return max + 1;
}

function topRegions_() {
  const sh = listingSheet_();
  const H = ensureCols_(sh);
  const last = sh.getLastRow();
  if (last < 2 || H["지역"] == null) return [];
  const cnt = {};
  sh.getRange(2, H["지역"] + 1, last - 1, 1).getValues()
    .forEach(([v]) => { const k = String(v).trim(); if (k) cnt[k] = (cnt[k] || 0) + 1; });
  return Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a]).slice(0, 12);
}

/* --------------------------------------------- 구글폼으로 들어온 매물 처리 ---- */
function 폼제출(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = e && e.range ? e.range.getSheet() : listingSheet_();
    if (sh.getSheetId() !== LISTING_SHEET_GID) return;
    const H = ensureCols_(sh);
    const r = e && e.range ? e.range.getRow() : sh.getLastRow();
    const noCell = sh.getRange(r, H["매물번호"] + 1);
    if (!noCell.getValue()) { const no = nextNo_(sh, H, true); noCell.setValue(no); PROPS.setProperty("LAST_NO", String(no)); }
    const stCell = sh.getRange(r, H["상태"] + 1);
    if (!stCell.getValue()) stCell.setValue("진행중");
  } finally {
    lock.releaseLock();
  }
}

/* ---------------------------------------------------------------- 설치 ---- */
function 설치하기() {
  const sh = listingSheet_();
  const H = ensureCols_(sh);
  Logger.log("✅ 매물 탭 확인: " + sh.getName());

  // 매물번호가 비어 있는 기존 매물은 지금 사이트에 보이는 번호(행 번호)로 고정
  const last = sh.getLastRow();
  if (last > 1) {
    const rng = sh.getRange(2, H["매물번호"] + 1, last - 1, 1);
    const vals = rng.getValues();
    let filled = 0;
    vals.forEach((v, i) => { if (!v[0]) { v[0] = i + 2; filled++; } });
    rng.setValues(vals);
    Logger.log("✅ 기존 매물 " + filled + "개에 매물번호 고정 (지금 사이트 번호 그대로)");
  }

  Logger.log("✅ 사진 폴더: " + photoFolder_().getUrl());

  // 구글폼을 계속 써도 매물번호·상태가 자동으로 들어가게
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === "폼제출")
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("폼제출").forSpreadsheet(SHEET_ID).onFormSubmit().create();
  Logger.log("✅ 폼 제출 자동 처리 연결");

  if (!PROPS.getProperty("REG_PW")) PROPS.setProperty("REG_PW", newPw_());
  Logger.log("🔑 등록 비밀번호: " + PROPS.getProperty("REG_PW") + "  (등록 페이지에 처음 한 번 입력)");
  Logger.log("다음: 배포 → 새 배포 → 웹 앱(실행: 나, 액세스: 모든 사용자) → 주소를 register/index.html CONFIG.REGISTER_URL 에");
}

function 비밀번호_바꾸기() {
  PROPS.setProperty("REG_PW", newPw_());
  Logger.log("🔑 새 등록 비밀번호: " + PROPS.getProperty("REG_PW") + " (기존 휴대폰에서는 다시 입력해야 해요)");
}

function newPw_() {
  const A = "abcdefghjkmnpqrstuvwxyz3456789";   // 헷갈리는 글자(0·o·1·l·i·2) 제외
  let s = "";
  for (let i = 0; i < 8; i++) s += A[Math.floor(Math.random() * A.length)];
  return s;
}

/* ---------------------------------------------------------------- 도구 ---- */
function txt_(v, max) {
  return String(v == null ? "" : v).trim().replace(/^[=+\-@]/, "'$&").slice(0, max || 60);
}
function num_(v) {
  const n = parseFloat(String(v == null ? "" : v).replace(/,/g, "").replace(/[^0-9.]/g, ""));
  return isNaN(n) || n <= 0 ? "" : n;
}
function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
