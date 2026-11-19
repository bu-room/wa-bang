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
 *  - 등록한 매물 수정 (사진 빼기·추가·순서, 금액·글자, 상태 진행중/거래완료/숨김)
 *  - 비밀번호 5번 틀리면 10분 잠금
 * ============================================================================= */

const SHEET_ID          = "";            // 예: "1AbC...xyz" (시트 주소 /d/ 와 /edit 사이)
const LISTING_SHEET_GID = 2111395519;    // 손님에게 공개되는 매물 탭 (CSV 주소의 gid= 값)
const PHOTO_FOLDER_NAME = "와방 매물사진";
const SITE_URL          = "https://bu-room.github.io/wa-bang/";

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
    if (d.action === "list")  return json_(listListings_());
    if (d.action === "get")   return json_(getListing_(d.no));
    if (d.action === "update") return json_(updateListing_(d));
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
/* 입력값 확인 → 문제 있으면 오류 문구, 없으면 "" */
function dealsOf_(L) { return (Array.isArray(L.deals) ? L.deals : []).filter(x => DEALS.indexOf(x) >= 0); }
function typeOf_(L) { return Array.isArray(L.type) ? L.type.map(x => txt_(x)).filter(Boolean).join(", ") : txt_(L.type); }
function validate_(L) {
  const deals = dealsOf_(L);
  if (!deals.length) return "거래유형을 골라 주세요.";
  if (!typeOf_(L)) return "매물종류를 골라 주세요.";
  if (!txt_(L.area)) return "지역을 입력해 주세요.";
  const needRent = deals.some(x => x === "월세" || x === "단기");
  if (needRent && !num_(L.rent) && !num_(L.dep)) return "보증금이나 월세를 입력해 주세요.";
  if (deals.indexOf("전세") >= 0 && !num_(L.jeon)) return "전세금을 입력해 주세요.";
  if (deals.indexOf("매매") >= 0 && !num_(L.sale)) return "매매가를 입력해 주세요.";
  return "";
}
function photoIds_(d) {
  return (Array.isArray(d.photos) ? d.photos : []).map(String).filter(x => /^[\w-]{20,}$/.test(x)).slice(0, 10);
}
/* 매물 칸 값 (등록·수정 공통). 타임스탬프·매물번호는 여기서 안 건드림 */
function listingValues_(L, ids) {
  return {
    "거래유형": dealsOf_(L).join(", "),
    "매물종류": typeOf_(L),
    "지역": txt_(L.area),
    "보증금": num_(L.dep),
    "월세": num_(L.rent),
    "전세금": num_(L.jeon),
    "매매가": num_(L.sale),
    "관리비": fee_(L.fee),
    "전용면적": num_(L.exc),
    "공급면적": num_(L.sup),
    "층수": L.floor ? "'" + txt_(L.floor) : "",      // '3/5' 가 날짜로 바뀌지 않게 글자로 저장
    "방향": txt_(L.dir),
    "반려동물": txt_(L.pet),
    "한줄특징": txt_(L.memo, 300),
    "사진": ids.map(id => "https://drive.google.com/open?id=" + id).join(", ")
  };
}

function saveListing_(d) {
  const L = d.listing || {};
  const bad = validate_(L);
  if (bad) return { ok: false, error: bad };
  const photoIds = photoIds_(d);

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = listingSheet_();
    const H = ensureCols_(sh);
    const no = nextNo_(sh, H);
    const row = new Array(sh.getLastColumn()).fill("");
    const put = (name, v) => { if (H[name] != null) row[H[name]] = v; };

    put("타임스탬프", new Date());
    const V = listingValues_(L, photoIds);
    Object.keys(V).forEach(k => put(k, V[k]));
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

/* ------------------------------------------------------------ 매물 수정 ---- */
const STATUS_LIST = ["진행중", "거래완료", "숨김"];   // '숨김' 등 그 외 값은 손님 화면에 안 보임

/* 사진 칸("주소, 주소") → 드라이브 파일 ID 목록 */
function idsFromCell_(v) {
  return String(v || "").split(",").map(s => s.trim()).filter(Boolean).map(u => {
    const m = u.match(/[?&]id=([\w-]+)/) || u.match(/\/d\/([\w-]+)/);
    return m ? m[1] : "";
  }).filter(Boolean);
}

/* 매물번호로 시트 줄 번호(1부터) 찾기 */
function findRow_(sh, H, no) {
  const last = sh.getLastRow();
  if (last < 2) return 0;
  const vals = sh.getRange(2, H["매물번호"] + 1, last - 1, 1).getValues();
  for (let i = vals.length - 1; i >= 0; i--) if (String(vals[i][0]).trim() === String(no).trim()) return i + 2;
  return 0;
}

/* 한 줄 → 수정 화면에 넣을 값 */
function rowToListing_(H, vals, disp) {
  const g = name => H[name] == null ? "" : vals[H[name]];
  const t = name => H[name] == null ? "" : String(disp[H[name]] || "").trim();
  const n = name => { const v = g(name); return typeof v === "number" ? String(v) : String(v || "").replace(/,/g, "").trim(); };
  const pet = t("반려동물");
  return {
    no: t("매물번호"),
    deals: DEALS.filter(x => t("거래유형").indexOf(x) >= 0),
    type: t("매물종류").split(",").map(s => s.trim()).filter(Boolean),
    area: t("지역"), dep: n("보증금"), rent: n("월세"), jeon: n("전세금"), sale: n("매매가"),
    fee: t("관리비").replace(/,/g, ""), exc: n("전용면적"), sup: n("공급면적"),
    floor: t("층수"), dir: t("방향"),
    pet: pet.indexOf("불가") >= 0 ? "불가" : pet.indexOf("협의") >= 0 ? "협의" : pet.indexOf("가능") >= 0 ? "가능" : "",
    memo: t("한줄특징"), status: t("상태"),
    photos: idsFromCell_(t("사진")),
    reg: t("타임스탬프")
  };
}

/* 수정할 매물 고르기 목록 (최근 등록이 위) */
function listListings_() {
  const sh = listingSheet_();
  const H = ensureCols_(sh);
  const last = sh.getLastRow();
  if (last < 2) return { ok: true, items: [] };
  const rng = sh.getRange(2, 1, last - 1, sh.getLastColumn());
  const vals = rng.getValues(), disp = rng.getDisplayValues();
  const items = [];
  for (let i = vals.length - 1; i >= 0 && items.length < 300; i--) {
    const x = rowToListing_(H, vals[i], disp[i]);
    if (!x.no) continue;
    items.push({ no: x.no, deals: x.deals, type: x.type.join(", "), area: x.area, dep: x.dep, rent: x.rent, jeon: x.jeon, sale: x.sale,
                 status: x.status, photo: x.photos[0] || "", memo: x.memo.slice(0, 40) });
  }
  return { ok: true, items: items };
}

function getListing_(no) {
  const sh = listingSheet_();
  const H = ensureCols_(sh);
  const r = findRow_(sh, H, no);
  if (!r) return { ok: false, error: "매물 #" + no + " 을(를) 시트에서 못 찾았어요." };
  const rng = sh.getRange(r, 1, 1, sh.getLastColumn());
  return { ok: true, listing: rowToListing_(H, rng.getValues()[0], rng.getDisplayValues()[0]) };
}

function updateListing_(d) {
  const L = d.listing || {};
  const bad = validate_(L);
  if (bad) return { ok: false, error: bad };
  const ids = photoIds_(d);
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = listingSheet_();
    const H = ensureCols_(sh);
    const r = findRow_(sh, H, d.no);
    if (!r) return { ok: false, error: "매물 #" + d.no + " 을(를) 시트에서 못 찾았어요. (시트에서 지워졌을 수 있어요)" };
    const V = listingValues_(L, ids);
    if (STATUS_LIST.indexOf(L.status) >= 0) V["상태"] = L.status;
    // 바꿀 칸만 하나씩 씀 → 타임스탬프·매물번호·그 밖의 열(수식 등)은 그대로
    Object.keys(V).forEach(k => { if (H[k] != null) sh.getRange(r, H[k] + 1).setValue(V[k]); });
    return { ok: true, no: d.no, site: SITE_URL };
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
/* 관리비: 숫자만 쓰면 숫자로, '8만 (인터넷 포함)' 처럼 쓰면 글자 그대로 */
function fee_(v) {
  const s = String(v == null ? "" : v).trim().replace(/,/g, "");
  if (!s) return "";
  return /^\d+(\.\d+)?$/.test(s) ? num_(s) : txt_(s, 40);
}
function num_(v) {
  const n = parseFloat(String(v == null ? "" : v).replace(/,/g, "").replace(/[^0-9.]/g, ""));
  return isNaN(n) || n <= 0 ? "" : n;
}
function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
