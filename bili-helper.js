#!/usr/bin/env node
/* B站评论抽奖 · 本地助手（零外部依赖，只用 Node 内置模块）
 *
 * 安全约定（重要）：
 *  1. 只监听 127.0.0.1，不外暴露端口；
 *  2. 登录 Cookie（SESSDATA 等）只保存在本进程内存中，不写磁盘、不打印日志；
 *  3. Cookie 仅用于请求 passport.bilibili.com / api.bilibili.com，绝不转发给任何第三方代理；
 *  4. 进程退出即失效，下次使用需重新扫码。
 *
 * 用法： node bili-helper.js          （默认端口 8787）
 *        BILI_HELPER_PORT=9000 node bili-helper.js
 *
 * 可调参数（环境变量）：
 *   BILI_MAIN_CONC   主楼分片并发数，默认 16（再高会让楼中楼接口被限流）
 *   BILI_CONC        楼中楼补拉并发数，默认 8
 *   BILI_RATE        总请求速率上限（次/秒），默认 150，仅作安全阀
 *   BILI_BLOCKS      主楼分片数上限，默认 600（分片越细负载均衡越好，但请求数也越多）
 *   BILI_DEBUG=1     打印分片游标推进过程，排查「卡在某个分片」时用
 */
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const QR = require(path.join(__dirname, 'qrlib', 'core', 'qrcode.js'));

const PORT = Number(process.env.BILI_HELPER_PORT) || 8787;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const LOCALE = JSON.stringify({ c_locale: { language: 'zh', script: 'Hans' }, always_translate: false });
const MAX_COMMENTS = 200000;     // 硬上限（防超大视频吃满内存；默认即"全量"，会被 warn 提示）
const MAX_PAGES = 20000;         // 页数上限，仅防死循环（20000 × 30 = 60 万条，正常视频到不了）

/* ---------------- Cookie 罐（仅内存） ---------------- */
const jar = new Map();
const cookieHeader = () => Array.from(jar).map(([k, v]) => k + '=' + v).join('; ');
function absorbSetCookie(res){
  let list = [];
  if (typeof res.headers.getSetCookie === 'function') list = res.headers.getSetCookie();
  else { const raw = res.headers.get('set-cookie'); if (raw) list = raw.split(/,(?=[^;]+=)/); }
  for (const c of list){
    const pair = String(c).split(';')[0];
    const i = pair.indexOf('=');
    if (i > 0){
      const k = pair.slice(0, i).trim(), v = pair.slice(i + 1).trim();
      if (k && v) jar.set(k, v);
    }
  }
}
/* 实测结论（2026-09）：
   - view 视频信息接口：需要 buvid（否则 15 位 aid 会被 -412 request was banned）
   - 评论接口：恰恰相反，带 buvid3/4 会被降级成「3 条预览」且没有游标，
     不带 Cookie 反而能拿到 20 条/页 + next_offset
   所以两类接口要用不同的 Cookie 集合。 */
const LOGIN_KEYS = ['SESSDATA', 'DedeUserID', 'DedeUserID__ckMd5', 'bili_jct', 'sid'];
const baseH = opt => {
  const noBuvid = opt && opt.noBuvid;
  let cookie = '';
  if (jar.size){
    const ks = noBuvid ? Array.from(jar.keys()).filter(k => LOGIN_KEYS.indexOf(k) >= 0) : Array.from(jar.keys());
    if (ks.length) cookie = ks.map(k => k + '=' + jar.get(k)).join('; ');
  }
  return {
    'User-Agent': UA,
    'Accept': 'application/json, text/plain, */*',
    'Origin': 'https://www.bilibili.com',
    'Referer': 'https://www.bilibili.com/',
    ...(cookie ? { Cookie: cookie } : {})
  };
};

/* ---------------- wbi 签名 ---------------- */
const md5 = s => crypto.createHash('md5').update(s, 'utf8').digest('hex');
const WBI_MIXIN = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
let MIXIN = null;
async function wbiKey(){
  if (MIXIN) return MIXIN;
  const j = await (await fetch('https://api.bilibili.com/x/web-interface/nav', { headers: baseH({ noBuvid: true }) })).json();
  const w = j.data && j.data.wbi_img;
  if (!w) throw new Error('获取签名密钥失败');
  const key = w.img_url.split('/').pop().split('.')[0] + w.sub_url.split('/').pop().split('.')[0];
  MIXIN = WBI_MIXIN.map(i => key[i]).join('').slice(0, 32);
  return MIXIN;
}
function sign(params, mixin){
  const p = Object.assign({ wts: Math.round(Date.now() / 1000) }, params);
  const clean = v => String(v).replace(/[!'()*]/g, '');
  const qs = Object.keys(p).sort().map(k => encodeURIComponent(k) + '=' + encodeURIComponent(clean(p[k]))).join('&');
  return qs + '&w_rid=' + md5(qs + mixin);
}
/* ---------------- 游标分片（并行提速的关键）----------------
   实测（2026-09）：cursor.pagination_reply.next_offset 是 protobuf 的 base64，
   结构 {1:1, 3:"", 6:{1:N}}，N 是单调递减的位置游标。
   服务端接受任意 N：给 N 就返回该位置之后的评论（实测 N-1 恰好跳过 1 条）。
   → 可以按 N 把区间切成多个块并行拉取，块内仍用真实 next 串行，块间无依赖。
   3283 条主楼实测：串行 259 条/秒 → 16 并发 2947 条/秒（11.4x），24 并发 4292 条/秒（16.6x），
   结果与串行逐条比对「缺 0 多 0」。
   注意：用「末条 rpid 造游标」仍然不行（会 -400 min_score must be <= max_score），
   只有 field6 里的这个整数 N 能用。offN() 读不到 N（B站改版）时自动回退串行，安全。 */
function pbVarintEnc(n){ const o = []; let v = n >>> 0; while(v >= 0x80){ o.push((v & 0x7f) | 0x80); v = Math.floor(v / 128); } o.push(v); return Buffer.from(o); }
function pbVarintDec(b, i){ let v = 0, s = 0, x; do{ x = b[i++]; v |= (x & 0x7f) << s; s += 7; }while(x & 0x80); return [v >>> 0, i]; }
function pbBytes(f, b){ return Buffer.concat([pbVarintEnc((f << 3) | 2), pbVarintEnc(b.length), b]); }
function pbInt(f, n){ return Buffer.concat([pbVarintEnc((f << 3) | 0), pbVarintEnc(n)]); }
function mkOffset(n){
  // N 必须落在 [1, 2^31)：0 会被服务端拒绝（-400），负数经 >>>0 会变成 40 亿、
  // 服务端会忽略游标直接返回第一页（曾导致分片重跑全量而卡死），这里统一夹住
  const v = Math.max(1, Math.min(2147483647, Math.floor(Number(n) || 0)));
  return Buffer.concat([pbInt(1, 1), pbBytes(3, Buffer.alloc(0)), pbBytes(6, pbInt(1, v))]).toString('base64');
}
function offN(s){
  try{
    const b = Buffer.from(String(s || ''), 'base64');
    let i = 0;
    while (i < b.length){
      const k = pbVarintDec(b, i); i = k[1];
      const f = k[0] >>> 3, w = k[0] & 7;
      if (w === 0){ i = pbVarintDec(b, i)[1]; }
      else if (w === 2){
        const l = pbVarintDec(b, i); i = l[1];
        const raw = b.slice(i, i + l[0]); i += l[0];
        if (f === 6 && raw[0] === 0x08) return pbVarintDec(raw, 1)[0] >>> 0;
      } else break;
    }
  }catch(e){}
  return null;                       // 结构变了 → 调用方回退串行
}

/* ---------------- 登录 ---------------- */
async function ensureBuvid(){
  if (jar.has('buvid3')) return;
  try{
    const j = await (await fetch('https://api.bilibili.com/x/frontend/finger/spi', { headers: baseH() })).json();
    absorbSetCookie({ headers: { getSetCookie: () => [] } });
    if (j.data && j.data.b_3){ jar.set('buvid3', j.data.b_3); if (j.data.b_4) jar.set('buvid4', j.data.b_4); }
  }catch(e){}
}
async function loginStatus(){
  if (!jar.has('SESSDATA')) return { logged: false };
  try{
    const j = await (await fetch('https://api.bilibili.com/x/web-interface/nav', { headers: baseH() })).json();
    const d = j.data || {};
    return { logged: !!d.isLogin, uname: d.uname || '', mid: d.mid || 0, face: d.face || '' };
  }catch(e){ return { logged: false, err: e.message }; }
}
async function qrGenerate(){
  await ensureBuvid();
  const r = await fetch('https://passport.bilibili.com/x/passport-login/web/qrcode/generate', { headers: baseH() });
  absorbSetCookie(r);
  const j = await r.json();
  if (j.code !== 0) throw new Error(j.message || '二维码生成失败');
  return { key: j.data.qrcode_key, url: j.data.url, svg: qrSvg(j.data.url) };
}
async function qrPoll(key){
  const r = await fetch('https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=' + encodeURIComponent(key), { headers: baseH() });
  absorbSetCookie(r);
  const j = await r.json();
  const d = j.data || {};
  // 成功时 B站 会把 Cookie 放在 Set-Cookie，同时 data.url 的查询串里也带一份，两处都吸收
  if (d.code === 0 && d.url){
    try{
      const u = new URL(d.url);
      ['DedeUserID', 'DedeUserID__ckMd5', 'SESSDATA', 'bili_jct', 'sid'].forEach(k => {
        const v = u.searchParams.get(k); if (v) jar.set(k, v);
      });
    }catch(e){}
  }
  const map = { 0: 'success', 86101: 'waiting', 86090: 'scanned', 86038: 'expired' };
  const state = map[d.code] || ('code:' + d.code);
  if (state === 'success') return Object.assign({ state }, await loginStatus());
  return { state, message: d.message || '' };
}
function logout(){ jar.clear(); MIXIN = null; }

/* ---------------- 评论抓取（带登录态） ---------------- */
/* 提速要点（2026-09 用 4403 条评论的视频实测，其中主楼 3235 条）：
   - 并行分片（最大头）：解析游标里的位置 N，按 N 切块后 16 并发拉取
     → 主楼 259 条/秒 → 2947 条/秒（11.4x）
   - ps=30：新版接口仍认 ps，但上限就是 30（ps=49/50 也只返回 30）→ 页数 163 → 109
   - 去掉固定 300ms 节流：连翻 109 页无一报错
   - 楼中楼补拉并发池（默认 8 并发）：79 个 root 从约 25s 降到约 3s
   出错时退避重试，兼顾速度与安全。 */
const PAGE_PS = 30;                                    // 主楼每页条数（接口上限 30）
const SUB_CONC = Number(process.env.BILI_CONC) || 8;   // 楼中楼补拉并发数
const MAIN_CONC = Number(process.env.BILI_MAIN_CONC) || 16;  // 主楼分片并发数（默认 16：实测再往上提会让楼中楼接口被限流）
const BLK_SPAN = 300;                                  // 每个分片的游标跨度（约 200 条），用于负载均衡
/* 全局限速（滑动窗口）：B站对评论接口有速率阈值，并发数越高越容易触发
   （实测 16 并发约 100 req/s 正常，20~24 并发后楼中楼接口会大量失败）。
   这里作为安全阀压住总速率，正常情况下不生效。可用 BILI_RATE 覆盖。 */
const RATE = Number(process.env.BILI_RATE) || 150;   // 每秒请求数上限
const REQ_GAP = 1000 / RATE;
let _slotAt = 0, _chain = Promise.resolve();
function throttle(){
  _chain = _chain.then(async () => {
    const now = Date.now();
    const at = Math.max(now, _slotAt + REQ_GAP);
    _slotAt = at;
    const wait = at - now;
    if (wait > 1) await sleep(wait);
  }).catch(() => {});
  return _chain;
}
const CACHE_TTL = 5 * 60 * 1000;                       // 同一视频 5 分钟内重复拉取直接命中缓存
const cache = new Map();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const DBG = !!process.env.BILI_DEBUG;                   // 打开后分片循环会打印游标推进过程（排障用）
/* 并发池：以 limit 并发对 items 执行 fn；单个失败不影响整体 */
async function mapLimit(items, limit, fn){
  const q = items.slice();
  const n = Math.max(1, Math.min(limit, q.length));
  const ws = [];
  for (let i = 0; i < n; i++) ws.push((async () => {
    while (q.length){ const it = q.shift(); try{ await fn(it); }catch(e){} }
  })());
  await Promise.all(ws);
}
/* 带超时 + 退避重试的 JSON 请求（避免单次卡死拖慢整轮） */
async function getJSON(url, headers, retry){
  let last;
  const n = retry == null ? 2 : retry;
  for (let i = 0; i <= n; i++){
    try{
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
      return await r.json();
    }catch(e){
      last = e;
      if (i < n) await sleep(400 * (i + 1));      // 400ms → 800ms → 放弃
    }
  }
  throw last;
}
async function fetchComments(aid, pages, mode, withSub, deep, onProg, cap){
  const t0 = Date.now();
  const CAP = Math.min(MAX_COMMENTS, Math.max(1, Number(cap) || MAX_COMMENTS));   // 条数上限（含楼中楼）
  const mixin = await wbiKey();
  const out = [];
  const all = !pages;
  let total = 0, warn = '', subCount = 0, guard = 0, usedParallel = false;
  const seenRpid = new Set();      // 已收录的 rpid，避免深层补拉时重复
  const roots = [];                // 需要补拉楼中楼的主楼

  /* 收录一页的评论（含主楼内嵌的子回复预览）
     必须按 rpid 去重：并行分片时相邻块边界会重叠十几条（保证不漏的代价），不去重会多算 */
  const absorb = reps => {
    for (const x of reps){
      const rk = x.rpid ? String(x.rpid) : '';
      if (rk && seenRpid.has(rk)) continue;
      if (rk) seenRpid.add(rk);
      out.push({
        mid: x.mid,
        uname: (x.member && x.member.uname) || ('UID ' + x.mid),
        msg: ((x.content && x.content.message) || '').replace(/\n/g, ' '),
        time: x.ctime, like: x.like
      });
      // 楼中楼：主楼响应里自带子评论预览，直接取，不需要额外请求
      let inline = 0;
      if (withSub && Array.isArray(x.replies)){
        for (const s of x.replies){
          if (s.rpid) seenRpid.add(String(s.rpid));
          out.push({
            mid: s.mid,
            uname: (s.member && s.member.uname) || ('UID ' + s.mid),
            msg: ((s.content && s.content.message) || '').replace(/\n/g, ' '),
            time: s.ctime, like: s.like, sub: true
          });
          subCount++; inline++;
        }
        // 子评论总数 > 内嵌预览数 → 记下来，稍后用楼中楼接口补拉
        if (deep && (x.rcount || 0) > inline) roots.push({ rpid: x.rpid, rcount: x.rcount });
      }
    }
  };
  const reqPage = async offset => {
    await throttle();
    return getJSON('https://api.bilibili.com/x/v2/reply/wbi/main?' + sign({
      oid: aid, type: 1, mode: mode || 2, ps: PAGE_PS,   // ps 仍生效，上限 30（ps=50 也只给 30）
      pagination_str: JSON.stringify({ offset }),
      plat: 1, web_location: 1315875,
      'x-bili-locale-json': LOCALE
    }, mixin), baseH({ noBuvid: true }));
  };

  /* 第 1 页：同时拿到总条数和游标起点 N0 */
  const first = await reqPage('');
  if (!first || first.code !== 0) throw new Error((first && first.message) || '评论拉取失败');
  const fcur = (first.data && first.data.cursor) || {};
  total = fcur.all_count || 0;
  absorb((first.data && first.data.replies) || []);
  guard = 1;
  const firstNext = (fcur.pagination_reply && fcur.pagination_reply.next_offset) || '';
  const firstEnd = !!fcur.is_end;
  const N0 = offN(firstNext);

  if (all && !firstEnd && N0 != null && N0 > 0){
    /* ---- 并行分片：按位置游标 N 把区间切成多个块，多块并发，块内用真实 next 串行 ---- */
    usedParallel = true;
    const MAXB = Math.max(1, Number(process.env.BILI_BLOCKS) || 600);   // 块数上限
    const B = Math.max(1, Math.min(MAXB, Math.ceil(N0 / BLK_SPAN)));
    const span = Math.max(1, Math.ceil(N0 / B));
    const queue = [];
    /* 块起点 hi 必须 >= 1，且覆盖范围要首尾相接（(lo, hi]，lo = 下一块的 hi）。
       B 被 600 截断时，B*span 会略大于 N0，末尾块的 hi 可能算成负数 —— 而负数经
       (n>>>0) 会变成 40 亿，服务端会忽略该游标直接返回「第一页」，导致该块从顶部
       重跑全量（表现为「最后一个分片卡死」）。所以 hi<=0 时直接不再生成块。 */
    for (let i = 0; i < B; i++){
      const hi = N0 - i * span;
      if (hi <= 0) break;
      queue.push({ hi, lo: Math.max(0, hi - span), head: i === 0 });
    }
    const NB = queue.length;
    let done = 0, failed = 0, stopped = false, lastTick = 0;
    const tick = () => {
      const now = Date.now();
      if (onProg && now - lastTick > 250){ lastTick = now; onProg({ phase: 'main', got: out.length, total, done, blocks: NB, conc: MAIN_CONC }); }
    };
    const runBlock = async blk => {
      let off = blk.head ? firstNext : mkOffset(blk.hi), g = 0;
      let prevN = blk.head ? N0 : blk.hi;      // 上一页的 N，用来确认游标真的在往前走
      const maxPages = Math.ceil(span / 20) + 6;   // 单块页数上限（N 每页至少减 30，正常远达不到）
      while (g++ < maxPages){
        if (stopped || out.length >= CAP) return;
        let j;
        try{ j = await reqPage(off); }catch(e){ failed++; return; }
        if (!j || j.code !== 0){ failed++; return; }
        const reps = (j.data && j.data.replies) || [];
        if (!reps.length) return;
        absorb(reps);
        const cur = (j.data && j.data.cursor) || {};
        const nx = (cur.pagination_reply && cur.pagination_reply.next_offset) || '';
        const nn = offN(nx);
        if (DBG && (g > 12 || blk.lo <= 0))
          console.error('[blk] hi=' + blk.hi + ' lo=' + blk.lo + ' g=' + g +
            ' nn=' + nn + ' reps=' + reps.length + ' isEnd=' + !!cur.is_end);
        // 到底 / 越过本块下界 → 结束本块
        if (cur.is_end || !nx || nn == null || nn <= blk.lo) return;
        // 游标没往前走（服务端忽略了合成游标、回到首页）→ 立刻停，绝不重跑全量
        if (nn >= prevN){ failed++; return; }
        prevN = nn;
        off = nx;
        tick();
      }
      if (DBG) console.error('[blk] hi=' + blk.hi + ' 达到单块页数上限 ' + maxPages + '，提前结束');
    };
    const worker = async () => {
      while (queue.length){
        if (stopped || out.length >= CAP){ stopped = true; return; }
        const blk = queue.shift();
        try{ await runBlock(blk); }catch(e){ failed++; }
        done++;
        if (onProg) onProg({ phase: 'main', got: out.length, total, done, blocks: NB, conc: MAIN_CONC });
      }
    };
    await Promise.all(Array.from({ length: Math.min(MAIN_CONC, NB) }, worker));
    guard += NB;
    if (stopped) warn = '已达条数上限 ' + CAP + ' 条（如需更多请在「拉取范围」里调大）';
    if (failed) warn = (warn ? warn + '；' : '') + failed + ' 个分片请求失败，可能漏掉少量评论，可重试';
  } else {
    /* ---- 串行兜底：游标结构解析不出（B站改版）或指定了页数 ---- */
    let offset = firstNext;
    while (true){
      if (!all && guard >= pages) break;
      if (out.length >= CAP){ warn = '已达条数上限 ' + CAP + ' 条（如需更多请在「拉取范围」里调大）'; break; }
      if (firstEnd || !offset || guard >= MAX_PAGES) break;
      let j;
      try{ j = await reqPage(offset); }
      catch(e){ warn = '第 ' + (guard + 1) + ' 页起网络失败（已保留前面 ' + out.length + ' 条）'; break; }
      if (!j || j.code !== 0){
        warn = '第 ' + (guard + 1) + ' 页起失败：' + (j && (j.message || j.code)) + '（已保留前面 ' + out.length + ' 条）';
        break;
      }
      const reps = (j.data && j.data.replies) || [];
      const cur = (j.data && j.data.cursor) || {};
      total = cur.all_count || total;
      absorb(reps);
      const nx = (cur.pagination_reply && cur.pagination_reply.next_offset) || '';
      if (cur.is_end || !reps.length || !nx || nx === offset || (++guard) >= MAX_PAGES){
        if (!reps.length && !out.length) warn = '该视频没有可拉取的评论（可能已关闭评论）';
        break;
      }
      offset = nx;
      if (onProg) onProg({ phase: 'main', page: guard, got: out.length, total });
    }
  }
  if (!out.length && !warn) warn = '该视频没有可拉取的评论（可能已关闭评论）';

  /* 补拉未被预览的深层楼中楼：主楼只内嵌前几条，剩下的用 /x/v2/reply/reply 按 root 取
     （该端点仍为旧的 pn/ps 分页，实测可用；wbi 版返回 HTML，不能用） */
  const tMain = Date.now();                // 主楼阶段结束时间，用于拆分耗时
  let subErr = 0, subGot = 0, subBlocked = false;   // 失败次数 / 原始命中条数 / 端点是否不可用
  if (withSub && deep && roots.length){
    const MAX_ROOTS = 1200;                // 超大视频的保护上限（并发后不再是瓶颈，可放宽）
    const todo = roots.slice(0, MAX_ROOTS);
    const skipped = roots.length - todo.length;
    const subUrl = (rt, pn) => 'https://api.bilibili.com/x/v2/reply/reply?oid=' + encodeURIComponent(aid) +
      '&type=1&root=' + encodeURIComponent(rt.rpid) + '&pn=' + pn + '&ps=20';
    /* ★ 楼中楼端点熔断 ★
       /x/v2/reply/reply 会返回 -412 request was banned：这是 B站的配额级限流
       （主楼刚跑完几千次高频请求后极易触发；实测加 wbi 签名 / buvid / b_lsid /
        x-bili-ticket / 完整 Referer 都无解，wbi/reply、wbi/sub、app 域名则全 404）。
       不熔断的话会对上千个 root 各重试 3 次且全败，表现为「补拉卡住、只拿到几条」。
       先探测 2 次，都命中端点级错误就整段跳过并明确告知 —— 过几分钟配额恢复后自动可用。 */
    const DEAD_CODES = new Set([-412, -403, -404]);   // -509/-799 等属限流，仍走正常重试
    subBlocked = await (async () => {
      let saw = 0;
      for (let i = 0; i < 2 && i < todo.length; i++){
        try{
          const j = await getJSON(subUrl(todo[i], 1), baseH({ noBuvid: true }), 0);   // retry=0，探测要快
          if (j && j.code === 0) return false;                  // 接口可用
          if (j && !DEAD_CODES.has(j.code)) return false;       // 限流类 → 交给正常流程
          saw++;
        }catch(e){ return false; }                              // 网络异常不算端点死
        if (i === 0) await sleep(800);
      }
      return saw >= 2;
    })();
    if (subBlocked){
      // -412 是配额级限流（主楼高频拉取后常见），不是接口废弃：过一会重试通常会恢复
      warn = (warn ? warn + '；' : '') +
        '楼中楼补拉接口当前被限流（-412），已跳过；本次只含主楼自带的子回复预览，过几分钟重试可补全';
    }
    if (!subBlocked){
      // 主楼刚跑完高频并发，立刻接着打楼中楼容易被限流 → 先缓一下（熔断时不必等）
      if (usedParallel) await sleep(1200);
      // 单个 root：按 pn 翻页取楼中楼（不得并发同一 root 的页，需顺序），失败即静默停止该 root
      const addReply = s => {
      const k = String(s.rpid || '');
      if (k && seenRpid.has(k)) return false;      // 内嵌预览里已有，跳过
      if (k) seenRpid.add(k);
      out.push({
        mid: s.mid,
        uname: (s.member && s.member.uname) || ('UID ' + s.mid),
        msg: ((s.content && s.content.message) || '').replace(/\n/g, ' '),
        time: s.ctime, like: s.like, sub: true
      });
      subCount++;
      return true;
    };
    let subDone = 0;
    const failedRoots = [];                 // 失败的 root，用于冷却后补一轮
    const fetchRoot = async rt => {
      let j;
      try{ await throttle(); j = await getJSON(subUrl(rt, 1), baseH({ noBuvid: true }), 2); }
      catch(e){ subErr++; failedRoots.push(rt); return; }
      if (!j || j.code !== 0){ subErr++; failedRoots.push(rt); return; }   // 被限流等：先记下，稍后重试
      let first = (j.data && j.data.replies) || [];
      first.forEach(addReply); subGot += first.length;
      if (first.length >= 20 && out.length < CAP){
        // 热门主楼可能有几十上百条子回复：pn 之间无依赖，并发翻页（单 root 内限 3 并发）
        const pages = Math.min(20, Math.ceil((rt.rcount || 0) / 20) + 1);
        const rest = [];
        for (let pn = 2; pn <= pages; pn++) rest.push(pn);
        await mapLimit(rest, 3, async pn => {
          if (out.length >= CAP) return;
          let r2;
          try{ await throttle(); r2 = await getJSON(subUrl(rt, pn), baseH({ noBuvid: true }), 2); }catch(e){ subErr++; return; }
          if (!r2 || r2.code !== 0){ subErr++; return; }
          const rr = (r2.data && r2.data.replies) || [];
          if (!rr.length) return;
          rr.forEach(addReply); subGot += rr.length;                // 重复由 seenRpid 兜底
        });
      }
      if (onProg) onProg({ phase: 'sub', done: ++subDone, total: todo.length, got: out.length });
    };
    await mapLimit(todo, SUB_CONC, fetchRoot);      // 8 并发：79 个 root 约 25s → 3s
    // 楼中楼接口偶发限流：失败不多时（小/中视频）冷却后补一轮很有效；
    // 大视频全量拉取后是配额级限流，重试也拿不到，就别白等了
    if (failedRoots.length > todo.length * 0.4 && failedRoots.length <= 150){
      const again = failedRoots.splice(0, failedRoots.length);
      await sleep(4000);
      await mapLimit(again, Math.max(2, Math.round(SUB_CONC / 2)), fetchRoot);
    }
      if (skipped) warn = (warn ? warn + '；' : '') + '有 ' + skipped + ' 条主楼的子评论未补拉（视频过大）';
      if (todo.length && failedRoots.length > todo.length * 0.3)
        warn = (warn ? warn + '；' : '') + '有 ' + failedRoots.length + ' 条主楼的子回复没拉到（主楼完整，不影响抽奖）';
    }
  }
  return { list: out, total, warn, mainCount: out.length - subCount, subCount,
    capped: out.length >= CAP, cap: CAP, elapsed: Date.now() - t0, pages: guard,
    mainMs: tMain - t0, subMs: Date.now() - tMain, roots: roots.length,
    subErr, subGot, subBlocked, parallel: !!usedParallel, conc: MAIN_CONC };
}

/* ---------------- 二维码 → SVG ---------------- */
function qrSvg(text){
  const q = QR.create(text, { errorCorrectionLevel: 'M' });
  const n = q.modules.size, d = q.modules.data;
  const scale = 6, quiet = 4, size = (n + quiet * 2) * scale;
  let rects = '';
  for (let y = 0; y < n; y++){
    for (let x = 0; x < n; x++){
      if (d[y * n + x]) rects += '<rect x="' + ((x + quiet) * scale) + '" y="' + ((y + quiet) * scale) + '" width="' + scale + '" height="' + scale + '"/>';
    }
  }
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '">' +
    '<rect width="' + size + '" height="' + size + '" fill="#fff"/><g fill="#000">' + rects + '</g></svg>';
}

/* ---------------- HTTP 服务 ---------------- */
function cors(res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
function send(res, code, obj){
  const body = JSON.stringify(obj);
  cors(res);                                   // 必须在 writeHead 之前设置，否则会 ERR_HTTP_HEADERS_SENT
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS'){ res.writeHead(204); res.end(); return; }
  const u = new URL(req.url, 'http://127.0.0.1');
  const p = u.pathname;
  try{
    if (p === '/api/health') return send(res, 200, { ok: true, port: PORT, logged: jar.has('SESSDATA') });
    if (p === '/api/status') return send(res, 200, await loginStatus());
    if (p === '/api/login/qrcode') return send(res, 200, await qrGenerate());
    if (p === '/api/login/poll') return send(res, 200, await qrPoll(u.searchParams.get('key') || ''));
    if (p === '/api/logout'){ logout(); return send(res, 200, { ok: true }); }
    // 视频信息解析（公开接口，未登录也可用）—— 避免走已失效的公共代理
    if (p === '/api/video'){
      const bvid = u.searchParams.get('bvid');
      const aid = u.searchParams.get('aid');
      if (!bvid && !aid) return send(res, 400, { error: '需要 bvid 或 aid' });
      const url = 'https://api.bilibili.com/x/web-interface/view?' +
        (bvid ? 'bvid=' + encodeURIComponent(bvid) : 'aid=' + encodeURIComponent(aid));
      const j = await (await fetch(url, { headers: baseH() })).json();
      if (j.code !== 0) return send(res, 502, { error: j.message || '视频信息获取失败' });
      const d = j.data;
      return send(res, 200, { ok: true, aid: d.aid, bvid: d.bvid, title: d.title,
        up: (d.owner && d.owner.name) || '', upMid: (d.owner && d.owner.mid) || 0,
        reply: (d.stat && d.stat.reply) || 0 });
    }
    // 诊断：不要求登录，返回接口原始响应，用于定位“拉不到评论”的原因
    if (p === '/api/diag'){
      const raw = u.searchParams.get('aid') || '';
      const aid = raw;
      if (!aid) return send(res, 400, { error: '缺少 aid' });
      const out = { aid: aid, logged: jar.has('SESSDATA'), hasCookie: jar.size > 0, cookieKeys: Array.from(jar.keys()) };
      // 1) 视频信息
      try{
        const j = await (await fetch('https://api.bilibili.com/x/web-interface/view?aid=' + encodeURIComponent(aid), { headers: baseH() })).json();
        out.view = { code: j.code, message: j.message || '', aid: j.data && j.data.aid, bvid: j.data && j.data.bvid, title: j.data && j.data.title };
      }catch(e){ out.view = { err: e.message }; }
      // 2) 评论第一页（原始）
      try{
        const mixin = await wbiKey();
        const qs = sign({ oid: aid, type: 1, mode: 2, pagination_str: JSON.stringify({ offset: '' }),
          plat: 1, web_location: 1315875, 'x-bili-locale-json': LOCALE }, mixin);
        const r = await fetch('https://api.bilibili.com/x/v2/reply/wbi/main?' + qs, { headers: baseH({ noBuvid: true }) });
        const j = await r.json();
        const reps = (j.data && j.data.replies) || [];
        const cur = (j.data && j.data.cursor) || {};
        out.comment = { code: j.code, message: j.message || '', count: reps.length,
          is_end: cur.is_end, all_count: cur.all_count,
          dataKeys: j.data ? Object.keys(j.data) : [],
          cursor: cur,
          lastRpid: reps.length ? reps[reps.length - 1].rpid : null,
          sample: reps.length ? { uname: reps[0].member.uname, msg: (reps[0].content.message || '').slice(0, 30) } : null };
        // 3) 用接口返回的真实游标试翻第 2 页
        try{
          const nx = (cur.pagination_reply && cur.pagination_reply.next_offset) || '';
          if (!nx){ out.page2 = { skipped: '第一页未返回 next_offset' }; }
          else {
            const q2 = sign({ oid: aid, type: 1, mode: 2, pagination_str: JSON.stringify({ offset: nx }),
              plat: 1, web_location: 1315875, 'x-bili-locale-json': LOCALE }, mixin);
            const j2 = await (await fetch('https://api.bilibili.com/x/v2/reply/wbi/main?' + q2, { headers: baseH({ noBuvid: true }) })).json();
            const r2 = (j2.data && j2.data.replies) || [];
            out.page2 = { code: j2.code, message: j2.message || '', count: r2.length,
              is_end: j2.data && j2.data.cursor && j2.data.cursor.is_end,
              firstUnames: r2.slice(0, 3).map(x => x.member.uname) };
          }
        }catch(e){ out.page2_err = e.message; }
      }catch(e){ out.comment = { err: e.message }; }
      return send(res, 200, out);
    }

    // SSE 流式拉取：过程中持续推送进度，大视频能实时看到条数增长，不用干等
    if (p === '/api/comments/stream'){
      const aid = u.searchParams.get('aid') || '';
      if (!aid || !/^\d+$/.test(aid)){ res.writeHead(400); res.end('bad aid'); return; }
      const pages = Number(u.searchParams.get('pages') || 0);
      const mode = Number(u.searchParams.get('mode') || 2);
      const withSub = u.searchParams.get('sub') !== '0';
      const deep = u.searchParams.get('deep') !== '0';
      const cap = u.searchParams.get('cap') || '';
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      const ev = o => res.write('data: ' + JSON.stringify(o) + '\n\n');
      const ckey = [aid, pages, mode, withSub ? 1 : 0, deep ? 1 : 0, cap].join('|');
      const hit = cache.get(ckey);
      if (hit && Date.now() - hit.t < CACHE_TTL && u.searchParams.get('nocache') !== '1'){
        ev({ type: 'progress', phase: 'done', got: hit.data.count, total: hit.data.total });
        ev({ type: 'done', data: Object.assign({ ok: true, cached: true }, hit.data) });
        res.end(); return;
      }
      try{
        const st = await loginStatus();
        const r = await fetchComments(aid, pages, mode, withSub, deep, pr => ev(Object.assign({ type: 'progress' }, pr)), cap);
        const data = { total: r.total, count: r.list.length, mainCount: r.mainCount, subCount: r.subCount,
        capped: r.capped, cap: r.cap, warn: r.warn || '', logged: !!st.logged, elapsed: r.elapsed,
        subBlocked: !!r.subBlocked, subErr: r.subErr || 0,
        pages: r.pages, mainMs: r.mainMs, subMs: r.subMs, roots: r.roots, parallel: !!r.parallel, conc: r.conc || 0, list: r.list };
      cache.set(ckey, { t: Date.now(), data });
        if (cache.size > 20) cache.delete(cache.keys().next().value);
        ev({ type: 'done', data: Object.assign({ ok: true, cached: false }, data) });
      }catch(e){
        ev({ type: 'error', error: (e && e.message) || String(e) });
      }
      res.end(); return;
    }

    if (p === '/api/comments'){
      const st = await loginStatus();      // 已登录则带 Cookie（更稳、更少风控），未登录则匿名拉（通常也够用）
      const aid = u.searchParams.get('aid') || '';
      if (!aid || !/^\d+$/.test(aid)) return send(res, 400, { error: '缺少或非法的 aid：' + aid });
      const pages = Number(u.searchParams.get('pages') || 0);
      const mode = Number(u.searchParams.get('mode') || 2);
      const withSub = u.searchParams.get('sub') !== '0';    // 默认包含楼中楼
      const deep = u.searchParams.get('deep') !== '0';      // 默认补拉未预览的深层楼中楼
      const cap = u.searchParams.get('cap') || '';          // 条数上限（含楼中楼），留空=全量
      const ckey = [aid, pages, mode, withSub ? 1 : 0, deep ? 1 : 0, cap].join('|');
      const hit = cache.get(ckey);
      if (hit && Date.now() - hit.t < CACHE_TTL && u.searchParams.get('nocache') !== '1'){
        return send(res, 200, Object.assign({ ok: true, cached: true }, hit.data));
      }
      const r = await fetchComments(aid, pages, mode, withSub, deep, null, cap);
      const data = { total: r.total, count: r.list.length, mainCount: r.mainCount, subCount: r.subCount,
        capped: r.capped, cap: r.cap, warn: r.warn || '', logged: !!st.logged, elapsed: r.elapsed,
        subBlocked: !!r.subBlocked, subErr: r.subErr || 0,
        pages: r.pages, mainMs: r.mainMs, subMs: r.subMs, roots: r.roots, parallel: !!r.parallel, conc: r.conc || 0, list: r.list };
      cache.set(ckey, { t: Date.now(), data });            // 重复拉取（换抽取数量重试等）直接命中
      if (cache.size > 20) cache.delete(cache.keys().next().value);
      return send(res, 200, Object.assign({ ok: true, cached: false }, data));
    }
    send(res, 404, { error: 'not found' });
  }catch(e){
    send(res, 500, { error: (e && e.message) || String(e) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  B站评论抽奖 · 本地助手已启动');
  console.log('  地址： http://127.0.0.1:' + PORT);
  console.log('  Cookie 仅存于本进程内存，退出即失效，不会写到磁盘或发给第三方');
  console.log('  在抽奖工具里选 B站模板 → 点「扫码登录」即可');
  console.log('  按 Ctrl+C 停止');
  console.log('');
});
