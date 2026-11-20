/* =============================================================================
 * 와방 문지기 (Cloudflare Worker)
 * -----------------------------------------------------------------------------
 * 손님 사이트 ──▶ 문지기(이 코드) ──▶ 매물등록 Apps Script ──▶ 구글 시트
 *
 *  - 구글 시트 주소·Apps Script 주소·열쇠는 이 문지기 안에만 있음 (손님 사이트 코드에 없음)
 *  - 사람 확인(Cloudflare Turnstile)을 통과해야 30분짜리 입장권을 줌
 *  - 입장권이 있어야 매물을 줌
 *      · 목록: 카드·필터에 필요한 정보 + 대표사진 1장만
 *      · 상세: 매물을 하나 열 때마다 그 매물만 (나머지 사진·공급면적·방향)
 *  - 같은 IP·같은 입장권이 짧은 시간에 너무 많이 요청하면 거절, 심하면 1시간 차단 + 메일 알림
 *
 * 설정 (Cloudflare → Workers → 이 Worker → 설정 → 변수 및 비밀). 모두 '비밀(Secret)'로 넣기
 *   GAS_URL          매물등록 Apps Script 웹앱 주소 (…/exec)
 *   GAS_KEY          매물등록 Apps Script '설치하기' 로그의 WORKER_KEY
 *   TURNSTILE_SECRET Turnstile 위젯의 '비밀 키'
 *   SESSION_SECRET   아무 긴 무작위 글자 (입장권 서명용, 40자 이상)
 *   ALLOWED_ORIGINS  손님 사이트 주소들, 쉼표로 (예: https://skylee-lang.github.io,https://bu-room.github.io)
 *
 * ※ 요청 수 제한은 서버 메모리로 셉니다. Cloudflare 무료 Worker는 서버가 여러 대라 '대략적인' 제한이에요.
 *    가장 강한 벽은 사람 확인(Turnstile) + 입장권 + 목록/상세 분리입니다.
 * ============================================================================= */

const SESSION_MIN = 30;          // 입장권 유효 시간(분)
const DATA_CACHE_SEC = 60;       // 시트 매물을 문지기에 잠깐 저장하는 시간(초) → 등록 후 최대 1분 뒤 반영
const BLOCK_SEC = 3600;          // 차단 시간(초)

// [횟수, 초] : 이 시간 안에 이 횟수를 넘으면 거절(429). 2배를 넘으면 1시간 차단 + 알림
const LIMIT = {
  session: [10, 600],   // IP당 입장권 발급 (10분에 10번)
  list:    [20, 60],    // IP당 목록 (1분에 20번)
  item:    [40, 60],    // IP당 상세 (1분에 40번)
  regions: [30, 60],    // IP당 동네 버튼
  tList:   [15, SESSION_MIN * 60],   // 입장권 하나로 목록 15번
  tItem:   [120, SESSION_MIN * 60]   // 입장권 하나로 상세 120번
};

const AI_BOT = /GPTBot|ChatGPT-User|OAI-SearchBot|ClaudeBot|Claude-User|Claude-SearchBot|anthropic-ai|Google-Extended|CCBot|PerplexityBot|Perplexity-User|Bytespider|Meta-External|Amazonbot|cohere-ai|Diffbot|YouBot|Timpibot|ImagesiftBot|HeadlessChrome|python-requests|python-urllib|curl\/|wget|scrapy|Go-http-client|node-fetch|axios/i;

const LIST_HIDE = ["공급면적", "방향"];   // 목록에서는 빼고, 상세에서만 주는 열

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const allowed = String(env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim().replace(/\/+$/, "")).filter(Boolean);
    const okOrigin = allowed.includes(origin);
    const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";
    const res = (status, body) => json(status, body, okOrigin ? origin : "");

    if (url.pathname === "/" && request.method === "GET") return new Response("ok", { headers: { "Cache-Control": "no-store" } });
    if (request.method === "OPTIONS") {
      return new Response(null, { status: okOrigin ? 204 : 403, headers: okOrigin ? cors(origin) : {} });
    }
    // AI 수집 로봇·자동화 도구는 바로 거절 (User-Agent 기준 — 이름을 숨기는 로봇은 아래 Turnstile·입장권이 막음)
    if (AI_BOT.test(request.headers.get("User-Agent") || "")) return res(403, { ok: false, error: "forbidden" });
    // 손님 사이트(허용된 주소)에서 온 요청만 받음
    if (!okOrigin) return res(403, { ok: false, error: "forbidden" });
    if (isBlocked(ip)) return res(429, { ok: false, error: "blocked" });

    try {
      /* ---------- 입장권 발급 (사람 확인) ---------- */
      if (url.pathname === "/session" && request.method === "POST") {
        if (overLimit(ip, "session", LIMIT.session, env, ctx)) return res(429, { ok: false, error: "too many" });
        let body = {};
        try { body = JSON.parse(await request.text()); } catch (e) {}
        const t = String(body.t || "");
        if (!t || t.length > 4096) return res(400, { ok: false, error: "no token" });
        const v = await verifyTurnstile(t, ip, env);
        const hosts = allowed.map(o => { try { return new URL(o).hostname; } catch (e) { return ""; } });
        if (!v.success || (v.hostname && !hosts.includes(v.hostname))) {
          overLimit(ip, "session", LIMIT.session, env, ctx);   // 실패는 두 번 셈
          return res(403, { ok: false, error: "human check failed" });
        }
        const exp = Math.floor(Date.now() / 1000) + SESSION_MIN * 60;
        const token = await sign({ e: exp, n: randomId() }, env.SESSION_SECRET);
        return res(200, { ok: true, token, exp });
      }

      /* ---------- 동네 버튼 (챗봇용, 동네 이름만) ---------- */
      if (url.pathname === "/regions" && request.method === "GET") {
        if (overLimit(ip, "regions", LIMIT.regions, env, ctx)) return res(429, { ok: false, error: "too many" });
        const d = await getData(env, ctx);
        return res(200, { ok: true, regions: d.regions });
      }

      /* ---------- 여기부터는 입장권 필요 ---------- */
      if (request.method !== "GET" || (url.pathname !== "/list" && url.pathname !== "/item")) {
        return res(404, { ok: false, error: "not found" });
      }
      const ses = await verify(url.searchParams.get("s") || "", env.SESSION_SECRET);
      if (!ses || ses.e * 1000 < Date.now()) return res(401, { ok: false, error: "session" });

      if (url.pathname === "/list") {
        if (overLimit(ip, "list", LIMIT.list, env, ctx) || overLimit("t:" + ses.n, "tList", LIMIT.tList, env, ctx, ip)) {
          return res(429, { ok: false, error: "too many" });
        }
        const d = await getData(env, ctx);
        return res(200, { ok: true, cols: d.listCols, rows: d.listRows });
      }

      // /item?id=매물번호
      const id = String(url.searchParams.get("id") || "");
      if (!/^[\w-]{1,20}$/.test(id)) return res(400, { ok: false, error: "bad id" });
      if (overLimit(ip, "item", LIMIT.item, env, ctx) || overLimit("t:" + ses.n, "tItem", LIMIT.tItem, env, ctx, ip)) {
        return res(429, { ok: false, error: "too many" });
      }
      const d = await getData(env, ctx);
      const row = d.byId.get(id);
      if (!row) return res(404, { ok: false, error: "not found" });
      return res(200, { ok: true, cols: d.cols, row });
    } catch (e) {
      console.log("[와방 문지기] 오류", String(e && e.stack || e));
      return res(502, { ok: false, error: "server" });
    }
  }
};

/* ============================================================ 매물 데이터 ==== */
let DATA = null, DATA_AT = 0, INFLIGHT = null;

async function getData(env, ctx) {
  if (DATA && Date.now() - DATA_AT < DATA_CACHE_SEC * 1000) return DATA;
  if (INFLIGHT) return INFLIGHT;
  INFLIGHT = (async () => {
    try {
      const r = await fetch(env.GAS_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ action: "public", key: env.GAS_KEY }),
        redirect: "follow"
      });
      const j = await r.json();
      if (!j.ok || !Array.isArray(j.cols) || !Array.isArray(j.rows)) throw new Error("GAS: " + (j.error || r.status));
      DATA = prepare(j.cols, j.rows);
      DATA_AT = Date.now();
      return DATA;
    } catch (e) {
      if (DATA) return DATA;   // 시트가 잠깐 안 되면 마지막 목록으로 버팀
      throw e;
    } finally {
      INFLIGHT = null;
    }
  })();
  return INFLIGHT;
}

function prepare(cols, rows) {
  const ix = name => cols.indexOf(name);
  const iNo = ix("매물번호"), iPhoto = ix("사진"), iArea = ix("지역");
  const keep = cols.map((c, i) => LIST_HIDE.includes(c) ? -1 : i).filter(i => i >= 0);
  const byId = new Map();
  const listRows = rows.map(r => {
    if (iNo >= 0) byId.set(String(r[iNo]).trim(), r);
    return keep.map(i => i === iPhoto ? String(r[i] || "").split(",")[0].trim() : r[i]);   // 대표사진 1장만
  });
  // 동네 버튼: '지역'의 마지막 낱말(예: '강남구 역삼동' → '역삼동') 많은 순 6개
  const cnt = {};
  if (iArea >= 0) rows.forEach(r => {
    const parts = String(r[iArea] || "").trim().split(/\s+/), d = parts[parts.length - 1];
    if (d) cnt[d] = (cnt[d] || 0) + 1;
  });
  const regions = Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([d]) => d);
  return { cols, byId, listCols: keep.map(i => cols[i]), listRows, regions };
}

/* ======================================================== 사람 확인 ========== */
async function verifyTurnstile(token, ip, env) {
  const fd = new FormData();
  fd.append("secret", env.TURNSTILE_SECRET);
  fd.append("response", token);
  fd.append("remoteip", ip);
  const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: fd });
  return r.json();
}

/* ========================================================== 입장권 ========== */
const enc = new TextEncoder();
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const KEYS = new Map();
async function hmacKey(secret) {
  if (!secret || secret.length < 20) throw new Error("SESSION_SECRET 이 비었거나 너무 짧아요");
  if (!KEYS.has(secret)) {
    KEYS.set(secret, await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]));
  }
  return KEYS.get(secret);
}
async function sign(payload, secret) {
  const p = b64u(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(p));
  return p + "." + b64u(sig);
}
async function verify(token, secret) {
  const [p, s] = String(token).split(".");
  if (!p || !s || token.length > 300) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), unb64u(s), enc.encode(p));
    if (!ok) return null;
    const v = JSON.parse(new TextDecoder().decode(unb64u(p)));
    return v && typeof v.e === "number" && typeof v.n === "string" ? v : null;
  } catch (e) { return null; }
}
function randomId() {
  return b64u(crypto.getRandomValues(new Uint8Array(12)));
}

/* ====================================================== 요청 수 제한 ========= */
const COUNTERS = new Map();   // key → { n, reset }
const BLOCKED = new Map();    // ip → 풀리는 시각
const ALERTED = new Map();    // ip → 알림 보낸 시각

function isBlocked(ip) {
  const until = BLOCKED.get(ip);
  if (!until) return false;
  if (until < Date.now()) { BLOCKED.delete(ip); return false; }
  return true;
}

/* 한도를 넘으면 true. 한도의 2배를 넘으면 1시간 차단 + 메일 알림 */
function overLimit(key, kind, [max, sec], env, ctx, ipForBlock) {
  const now = Date.now(), k = kind + "|" + key;
  let c = COUNTERS.get(k);
  if (!c || c.reset <= now) { c = { n: 0, reset: now + sec * 1000 }; COUNTERS.set(k, c); }
  c.n++;
  if (COUNTERS.size > 20000) for (const [kk, v] of COUNTERS) if (v.reset <= now) COUNTERS.delete(kk);
  if (c.n > max * 2) {
    const ip = ipForBlock || key;
    BLOCKED.set(ip, now + BLOCK_SEC * 1000);
    sendAlert(ip, `${kind} ${c.n}회 / ${sec}초`, env, ctx);
  }
  return c.n > max;
}

function sendAlert(ip, reason, env, ctx) {
  const last = ALERTED.get(ip) || 0;
  if (Date.now() - last < 6 * 3600 * 1000) return;
  ALERTED.set(ip, Date.now());
  const p = fetch(env.GAS_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ action: "alert", key: env.GAS_KEY, ip, reason }),
    redirect: "follow"
  }).catch(() => {});
  if (ctx && ctx.waitUntil) ctx.waitUntil(p);
}

/* ============================================================== 응답 ========= */
function cors(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}
function json(status, body, origin) {
  const h = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };
  if (origin) Object.assign(h, cors(origin));
  return new Response(JSON.stringify(body), { status, headers: h });
}
