/* =============================================================================
 * 와방 손님 사이트 서버 (Cloudflare Worker + 정적 파일)
 *  - GitHub 저장소에 올리면 Cloudflare가 자동으로 배포 (저장소는 비공개여도 됨)
 *  - AI 수집 로봇·자동 수집 도구는 화면 자체를 안 줌 (403)
 *  - 모든 응답에 '검색·AI 학습 금지' 헤더
 *  - 사이트에 올라가면 안 되는 파일(apps-script, worker, tools, *.src.html 등)은 .assetsignore 로 제외
 * ============================================================================= */
const AI_BOT = /GPTBot|ChatGPT-User|OAI-SearchBot|ClaudeBot|Claude-User|Claude-SearchBot|anthropic-ai|Google-Extended|GoogleOther|CCBot|PerplexityBot|Perplexity-User|Bytespider|Meta-External|Amazonbot|Applebot-Extended|cohere-ai|Diffbot|YouBot|Timpibot|ImagesiftBot|omgili|DataForSeoBot|HeadlessChrome|PhantomJS|python-requests|python-urllib|aiohttp|httpx|curl\/|wget|scrapy|Go-http-client|node-fetch|undici|axios|Java\/|okhttp|libwww|HTTrack/i;

const SEC_HEADERS = {
  "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet, noimageindex, noai, noimageai",
  "tdm-reservation": "1",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "SAMEORIGIN",            // 다른 사이트가 와방 화면을 통째로 끼워 넣지 못하게
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()"
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const ua = request.headers.get("User-Agent") || "";
    // robots.txt·AI 거부 선언 파일은 로봇도 읽을 수 있어야 '읽지 말라'는 걸 앎
    const isPolicy = url.pathname === "/robots.txt" || url.pathname.startsWith("/.well-known/");
    if (!isPolicy && (!ua || AI_BOT.test(ua))) {
      return new Response("Forbidden", { status: 403, headers: { ...SEC_HEADERS, "Cache-Control": "no-store" } });
    }
    const r = await env.ASSETS.fetch(request);
    const h = new Headers(r.headers);
    for (const [k, v] of Object.entries(SEC_HEADERS)) h.set(k, v);
    return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h });
  }
};
