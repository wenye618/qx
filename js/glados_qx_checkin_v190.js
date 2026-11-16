/******************************
脚本功能：GLaDOS 自动签到（单账号 · 抓包强化版）
Version  : v1.9.0-capture-fix
更新时间：2026-11-16
Platform : Quantumult X / Loon / Surge

【为什么 v1.8 点「签到」没弹出抓包提醒】
GLaDOS 控制台是单页应用（SPA，页面里只有 <div id="root"> + webpack bundle）。
在控制台内部点「签到」，只是前端路由切换（history.pushState），
不会向 /console/account 发新的 HTTP 请求 → rewrite 规则根本没被触发 → 没有提醒。

v1.8 的 rewrite 只挂了 ^https://xxx/console/account$，只有「手动输入地址栏回车」
或「刷新页面」才会命中。点导航链接不会。

v1.9.0 修复：
1) rewrite 同时挂到控制台每次进入都会调用的 API：
     /api/user/status   （应用启动即拉，最可靠）
     /api/user/points   （签到页挂载即拉）
     /api/user/iqi
     /api/user/checkin/challenge
   这样只要打开控制台任意页面，就一定能抓到 Cookie。
2) 抓包改为幂等：Cookie/域名/UA 没变化时静默跳过，不再重复弹窗。
   只有首次抓包或 Cookie 变更才提醒。
3) 命中时在 QX 日志打印 [CAPTURE] 前缀，方便确认规则到底有没有生效。
4) 检测到域名是 glados.vip / glados.network 时提示 SNI 阻断风险。

【签到得分构成（官方 breakdown 字段）】
  base 保底 / level 套餐 / streak 连签 / cable 光缆指数
  lucky 随机幸运 / site 域名加成 / exitIp 出口 IP / freeCap 免费封顶

【Turnstile 说明】
服务端下发 turnstile 时 QX 无法通过人机校验。v1.9 检测到就直接跳过不提交
（提交必失败且浪费一次机会），并通知当天手动网页签到。连签天数不受影响。

使用说明：
1. QX 开启 MITM，安装并信任证书
2. 浏览器登录 GLaDOS，进入控制台任意页面（点导航即可，不用手动敲地址）
3. 看到「GLaDOS 抓包 · 已保存」通知即成功
4. 定时任务自动签到

[rewrite_local]
^https://(glados\.cloud|glados\.rocks|glados\.one|glados\.vip|glados\.network|glados\.space|railgun\.info)/(console/account|console/checkin|api/user/status|api/user/points|api/user/iqi|api/user/checkin/challenge)$ url script-request-header glados_qx_checkin_v190.js

[task_local]
5 0 * * * glados_qx_checkin_v190.js, tag=GLaDOS 签到, enabled=true

[MITM]
hostname = %APPEND% glados.cloud, glados.rocks, glados.one, glados.vip, glados.network, glados.space, railgun.info
*******************************/

// ========== 三端适配层 ==========
var isQX = typeof $task !== "undefined";
var isLoon = typeof $loon !== "undefined";
var isSurge = typeof $httpClient !== "undefined" && !isLoon;

var $http = {
  fetch: function (opts) {
    if (isQX) return $task.fetch(opts);
    return new Promise(function (resolve, reject) {
      var method = (opts.method || "GET").toUpperCase();
      var handler = function (err, resp, data) {
        if (err) reject(err);
        else resolve({ statusCode: resp.statusCode, headers: resp.headers, body: data });
      };
      if (method === "POST") $httpClient.post(opts, handler);
      else $httpClient.get(opts, handler);
    });
  }
};

var $store = {
  read: function (key) { return isQX ? $prefs.valueForKey(key) : $persistentStore.read(key); },
  write: function (val, key) { return isQX ? $prefs.setValueForKey(val, key) : $persistentStore.write(val, key); }
};

var notifyFn = isQX
  ? function (t, s, b) { $notify(t, s, b); }
  : function (t, s, b) { $notification.post(t, s, b); };

// ========== SHA-256（纯 JS，QX 无 crypto.subtle） ==========
var SHA256 = (function () {
  var K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  function utf8Bytes(str) {
    var out = [], i, c, c2, cp;
    for (i = 0; i < str.length; i++) {
      c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
        c2 = str.charCodeAt(i + 1);
        if (c2 >= 0xdc00 && c2 <= 0xdfff) {
          cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
          i++;
          out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
        } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }

  function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }

  return function sha256Hex(message) {
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var bytes = utf8Bytes(String(message));
    var len = bytes.length;
    var bitLo = (len * 8) >>> 0;
    var bitHi = Math.floor(len * 8 / 0x100000000) >>> 0;

    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    bytes.push((bitHi >>> 24) & 255, (bitHi >>> 16) & 255, (bitHi >>> 8) & 255, bitHi & 255);
    bytes.push((bitLo >>> 24) & 255, (bitLo >>> 16) & 255, (bitLo >>> 8) & 255, bitLo & 255);

    var w = new Array(64);
    for (var off = 0; off < bytes.length; off += 64) {
      var i;
      for (i = 0; i < 16; i++) {
        w[i] = ((bytes[off + i * 4] << 24) | (bytes[off + i * 4 + 1] << 16) |
          (bytes[off + i * 4 + 2] << 8) | bytes[off + i * 4 + 3]) | 0;
      }
      for (i = 16; i < 64; i++) {
        var s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        var s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }

      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (i = 0; i < 64; i++) {
        var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        var ch = (e & f) ^ (~e & g);
        var t1 = (h + S1 + ch + K[i] + w[i]) | 0;
        var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + maj) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0;
        d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }

    var hex = "";
    for (var j = 0; j < 8; j++) hex += ("00000000" + ((H[j] >>> 0).toString(16))).slice(-8);
    return hex;
  };
})();

// ========== 配置 ==========
var SCRIPT_NAME = "GLaDOS";
var SCRIPT_VERSION = "v1.9.0-capture-fix";

var KEY_COOKIE = "GLaDOS_Cookie";
var KEY_UA = "GLaDOS_UA";
var KEY_HOST = "GLaDOS_Host";

var PROOF_SALT = "glados-observe-v1";
var CHALLENGE_MIN_WAIT_MS = 2700;
var DEFAULT_TTL_MS = 300000;
var TS_RETRY_COUNT = 2;
var TS_RETRY_GAP_MS = 3000;

var DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// SNI 阻断风险域名（直连 TLS 会被掐断，必须走代理）
var SNI_BLOCKED_HOSTS = ["glados.vip", "glados.network"];

var isGetHeader = typeof $request !== "undefined";

// ========== 工具 ==========
function safeJsonParse(str) {
  try { return JSON.parse(str); } catch (_) { return null; }
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function buildProof(nonce) {
  return SHA256(String(nonce) + "." + PROOF_SALT);
}

function normalizeCookie(rawCookie) {
  var cookie = String(rawCookie || "").trim();
  while (cookie.length >= 2 && cookie[0] === cookie[cookie.length - 1] &&
    (cookie[0] === "\"" || cookie[0] === "'")) {
    cookie = cookie.slice(1, -1).trim();
  }
  if (/^cookie:/i.test(cookie)) cookie = cookie.slice(7).trim();
  while (cookie.length >= 2 && cookie[0] === cookie[cookie.length - 1] &&
    (cookie[0] === "\"" || cookie[0] === "'")) {
    cookie = cookie.slice(1, -1).trim();
  }
  return cookie;
}

function getHeader(headers, name) {
  var target = String(name || "").toLowerCase();
  var source = headers || {};
  for (var key in source) {
    if (Object.prototype.hasOwnProperty.call(source, key) &&
      String(key).toLowerCase() === target) return source[key];
  }
  return "";
}

function parseSessionPrefixes(cookie) {
  var found = {};
  var parts = String(cookie || "").split(";");
  for (var i = 0; i < parts.length; i++) {
    var key = parts[i].trim().split("=", 1)[0].trim();
    var match = key.match(/^([A-Za-z0-9_.-]+):sess(\.sig)?$/);
    if (!match) continue;
    if (!found[match[1]]) found[match[1]] = { sess: false, sig: false };
    found[match[1]][match[2] ? "sig" : "sess"] = true;
  }
  return found;
}

function validateCookie(cookie) {
  var normalized = normalizeCookie(cookie);
  if (!normalized) return { valid: false, message: "Cookie 为空" };
  var groups = parseSessionPrefixes(normalized);
  var prefixes = Object.keys(groups);
  for (var i = 0; i < prefixes.length; i++) {
    var fields = groups[prefixes[i]];
    if (fields.sess && fields.sig) return { valid: true, prefix: prefixes[i] };
  }
  return { valid: false, message: "Cookie 缺少成对的 <前缀>:sess 与 <前缀>:sess.sig" };
}

function clientHintHeaders(ua) {
  var m = String(ua || "").match(/Chrome\/(\d+)/);
  var major = m ? m[1] : "126";
  var isMobile = /iPhone|iPad|Android/.test(ua);
  var platform = /iPhone|iPad/.test(ua) ? "\"iOS\""
    : /Android/.test(ua) ? "\"Android\""
      : /Macintosh/.test(ua) ? "\"macOS\""
        : "\"Windows\"";
  return {
    "sec-ch-ua": "\"Chromium\";v=\"" + major + "\", \"Google Chrome\";v=\"" + major + "\", \"Not-A.Brand\";v=\"99\"",
    "sec-ch-ua-mobile": isMobile ? "?1" : "?0",
    "sec-ch-ua-platform": platform
  };
}

function getPlatform() {
  if (isQX) return "Quantumult X";
  if (isLoon) return "Loon";
  if (isSurge) return "Surge";
  return "Unknown";
}

function isSniBlockedHost(host) {
  for (var i = 0; i < SNI_BLOCKED_HOSTS.length; i++) {
    if (String(host).indexOf(SNI_BLOCKED_HOSTS[i]) !== -1) return true;
  }
  return false;
}

// ========== Logger ==========
var Logger = {
  scriptStart: function (version, platform, requestType) {
    var now = new Date();
    var pad = function (n) { return String(n).padStart(2, "0"); };
    var time = now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate()) +
      " " + pad(now.getHours()) + ":" + pad(now.getMinutes()) + ":" + pad(now.getSeconds());
    console.log("🚀 Script Start");
    console.log("Time     : " + time);
    console.log("Version  : " + version + " | " + platform + " | " + requestType);
    console.log("------------------------------------");
  },
  field: function (label, value) {
    var key = (label + "              ").substring(0, 14);
    console.log(key + ": " + value);
  },
  status: function (icon, text) { this.field("Status", icon + " " + text); },
  separator: function () { console.log("------------------------------------"); }
};

// ========== 网络 ==========
function request(url, method, cookie, host, body, ua) {
  var headers = {
    "Content-Type": "application/json;charset=UTF-8",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Origin": "https://" + host,
    "Referer": "https://" + host + "/console/checkin",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "User-Agent": ua || DEFAULT_UA,
    "Cookie": cookie
  };
  var hints = clientHintHeaders(ua || DEFAULT_UA);
  for (var k in hints) headers[k] = hints[k];

  var opts = { url: url, method: method, headers: headers };
  if (body !== undefined) opts.body = typeof body === "string" ? body : JSON.stringify(body);

  return $http.fetch(opts).then(
    function (resp) {
      return { statusCode: resp.statusCode, data: safeJsonParse(resp.body || ""), raw: resp.body || "" };
    },
    function (reason) {
      return { statusCode: 0, data: null, raw: "", error: reason ? String(reason) : "Network error" };
    }
  );
}

// ========== API ==========
function getStatus(cookie, host, ua) {
  return request("https://" + host + "/api/user/status", "GET", cookie, host, undefined, ua)
    .then(function (resp) {
      if (resp.error || !resp.data) return { email: "unknown", leftDays: "N/A", leftDaysNum: NaN, vip: 0 };
      var d = resp.data.data || {};
      var num = (d.leftDays === undefined || d.leftDays === null) ? NaN : parseFloat(d.leftDays);
      return {
        email: d.email || "unknown",
        leftDays: isFinite(num) ? parseInt(num, 10) + " 天" : "N/A",
        leftDaysNum: num,
        vip: d.vip === undefined ? 0 : d.vip
      };
    });
}

function getPoints(cookie, host, ua) {
  return request("https://" + host + "/api/user/points", "GET", cookie, host, undefined, ua)
    .then(function (resp) {
      if (resp.error || !resp.data) return { points: "N/A", pointsNum: 0, streak: 0 };
      var d = resp.data;
      var p = d.points;
      if (p === undefined || p === null) p = d.data && d.data.points;
      var n = parseInt(parseFloat(p), 10);
      if (isNaN(n)) n = 0;
      return {
        points: "" + n,
        pointsNum: n,
        streak: (d.streak === undefined || d.streak === null) ? 0 : parseInt(d.streak, 10)
      };
    });
}

function getIQI(cookie, host, ua) {
  return request("https://" + host + "/api/user/iqi", "GET", cookie, host, undefined, ua)
    .then(function (resp) {
      if (resp.error || !resp.data || resp.data.code !== 0) return { score: null };
      var q = resp.data.quality || {};
      return { score: (q.score === undefined ? null : q.score) };
    });
}

function getChallenge(cookie, host, ua) {
  return request("https://" + host + "/api/user/checkin/challenge", "GET", cookie, host, undefined, ua)
    .then(function (resp) {
      if (resp.error) return { error: "network", message: resp.error };
      if (!resp.data) return { error: "empty", message: resp.raw };
      var d = resp.data;
      if (d.code !== 0) return { error: "code-" + d.code, message: d.message || "" };
      if (typeof d.nonce !== "string" || !d.nonce) return { error: "nonce-missing" };
      return {
        nonce: d.nonce,
        ttl: (typeof d.ttl === "number" && d.ttl > 0) ? d.ttl : DEFAULT_TTL_MS,
        turnstile: d.turnstile || null
      };
    });
}

function checkin(cookie, host, ua) {
  var attempt = 0;

  function tryOnce() {
    attempt++;
    return getChallenge(cookie, host, ua).then(function (ch) {
      if (ch.error) {
        return { status: "签到失败", code: -2, message: "challenge 获取失败: " + (ch.message || ch.error), tsBlocked: false };
      }

      if (ch.turnstile) {
        if (attempt <= TS_RETRY_COUNT) {
          console.log("           ⚠️ challenge 要求 Turnstile（第 " + attempt + " 次），" +
            (TS_RETRY_GAP_MS / 1000) + "s 后换新 challenge 重试");
          return sleep(TS_RETRY_GAP_MS).then(tryOnce);
        }
        return {
          status: "需人工验证",
          code: -3,
          message: "服务端要求 Cloudflare Turnstile 人机校验，脚本无法通过",
          tsBlocked: true
        };
      }

      var issuedAt = Date.now();
      var wait = Math.max(CHALLENGE_MIN_WAIT_MS - (Date.now() - issuedAt), 0) +
        Math.floor(Math.random() * 300);

      return sleep(wait).then(function () {
        if (Date.now() - issuedAt >= ch.ttl) {
          return { status: "签到失败", code: -2, message: "challenge 已过期(ttl=" + ch.ttl + ")", tsBlocked: false };
        }
        var proof = buildProof(ch.nonce);
        var payload = { token: host, nonce: ch.nonce, proof: proof, tsState: "off" };
        console.log("           proof=" + proof.slice(0, 16) + "... waited " + (Date.now() - issuedAt) + "ms");
        return request("https://" + host + "/api/user/checkin", "POST", cookie, host, payload, ua)
          .then(function (resp) { return interpret(resp, true); });
      });
    });
  }

  return tryOnce();
}

function interpret(resp, usedProof) {
  if (resp.error) return { status: "签到失败", code: -2, message: resp.error, usedProof: usedProof, tsBlocked: false };
  if (!resp.data) return { status: "签到失败", code: -2, message: resp.raw, usedProof: usedProof, tsBlocked: false };

  var d = resp.data;
  var msg = d.message || "";
  var reason = d.reason || "";

  if (reason === "turnstile") {
    return { status: "需人工验证", code: -3, message: msg, usedProof: usedProof, tsBlocked: true };
  }
  if (d.code === 4 && reason === "device-mismatch") {
    return {
      status: "设备校验失败", code: -4,
      message: "浏览器退出登录后重新登录，再重新抓包", usedProof: usedProof, tsBlocked: false
    };
  }
  if (d.code === 0 || /got\s+\d+\s+points?/i.test(msg)) {
    return {
      status: "签到成功", code: 0, message: msg,
      points: (d.points === undefined ? "0" : String(d.points)),
      usedProof: usedProof, tsBlocked: false,
      breakdown: (!d.repeated && d.breakdown) ? d.breakdown : null
    };
  }
  if (d.code === 1 || /repeat|already|重复|已签到/i.test(msg)) {
    return { status: "重复签到", code: 1, message: msg, points: "0", usedProof: usedProof, tsBlocked: false };
  }
  if (["没有权限", "未登录", "unauthorized", "forbidden"].some(function (k) {
    return String(msg).toLowerCase().indexOf(k.toLowerCase()) !== -1;
  })) {
    return { status: "鉴权失败", code: -5, message: "Cookie 已失效，请重新抓包", usedProof: usedProof, tsBlocked: false };
  }
  return { status: "签到失败", code: (d.code === undefined ? -2 : d.code), message: msg, usedProof: usedProof, tsBlocked: false };
}

// ========== 结算面板解析 ==========
function parseBreakdown(bd) {
  if (!bd) return null;
  var num = function (v) { return (v === undefined || v === null) ? 0 : (Number(v) || 0); };
  var items = [
    { label: "Base", value: num(bd.base) },
    { label: "Plan", value: num(bd.level) },
    { label: "Streak", value: num(bd.streak) },
    { label: "Cable", value: num(bd.cable) },
    { label: "Lucky", value: num(bd.lucky) },
    { label: "Site", value: num(bd.site) },
    { label: "ExitIP", value: num(bd.exitIp) }
  ];
  var sum = 0;
  for (var i = 0; i < items.length; i++) sum += items[i].value;
  var credited = num(bd.points);
  var freeCap = num(bd.freeCap);
  return {
    items: items, sum: sum, credited: credited, freeCap: freeCap,
    capped: freeCap > 0 && credited <= freeCap && sum > credited,
    mismatch: Math.abs(sum - credited) > 0.001,
    cableScore: (bd.cableScore === undefined || bd.cableScore === null) ? null : bd.cableScore
  };
}

// ========== 抓包保存（单账号 · 幂等） ==========
if (isGetHeader) {
  var hdrs = $request.headers || {};
  var reqUrl = String(($request && $request.url) || "");
  var ck = normalizeCookie(getHeader(hdrs, "Cookie"));
  var uaCap = String(getHeader(hdrs, "User-Agent") || DEFAULT_UA).trim();
  var hostCap = (function () {
    var h = hdrs.Host || hdrs.host;
    if (h) return String(h).split(":")[0];
    var m = reqUrl.match(/^https?:\/\/([^/]+)/);
    return m ? String(m[1]).split(":")[0] : "";
  })();

  console.log("[CAPTURE] 命中 rewrite");
  console.log("           URL  = " + reqUrl);
  console.log("           Host = " + (hostCap || "(空)"));

  if (!ck) {
    console.log("[CAPTURE] 该请求没有 Cookie 头（可能是未登录状态或 API 不需要鉴权）");
    $done({});
  } else if (!hostCap) {
    console.log("[CAPTURE] 无法识别域名");
    $done({});
  } else {
    var v = validateCookie(ck);
    if (!v.valid) {
      console.log("[CAPTURE] Cookie 格式无效: " + v.message);
      Logger.field("CookieRaw", ck.slice(0, 60) + "...");
      notifyFn("GLaDOS 抓包失败", "Cookie 格式无效", v.message);
      $done({});
    } else {
      var oldCookie = normalizeCookie($store.read(KEY_COOKIE) || "");
      var oldUA = String($store.read(KEY_UA) || "");
      var oldHost = String($store.read(KEY_HOST) || "");

      var changed = (oldCookie !== ck) || (oldUA !== uaCap) || (oldHost !== hostCap);
      var isFirst = !oldCookie || !oldHost;

      if (!changed) {
        console.log("[CAPTURE] Cookie 未变化，静默跳过（不弹窗）");
        $done({});
      } else {
        $store.write(ck, KEY_COOKIE);
        $store.write(uaCap, KEY_UA);
        $store.write(hostCap, KEY_HOST);

        console.log("[CAPTURE] ✅ 已写入存储");
        Logger.field("Host", hostCap);
        Logger.field("Cookie", ck.slice(0, 28) + "...(" + ck.length + " 字符)");
        Logger.field("UA", uaCap.slice(0, 40) + "...");
        Logger.field("Prefix", v.prefix + ":sess");

        if (isSniBlockedHost(hostCap)) {
          console.log("           ⚠️ 该域名存在 SNI 阻断风险，直连可能超时，签到请走代理");
        }

        notifyFn(
          isFirst ? "GLaDOS 抓包 · 已保存" : "GLaDOS 抓包 · 已更新",
          hostCap,
          "Cookie " + ck.length + " 字符 · " + v.prefix + ":sess"
        );
        $done({});
      }
    }
  }
} else {
  // ========== 定时签到（单账号） ==========
  var delay = Math.floor(Math.random() * 11);

  setTimeout(function () {
    Logger.scriptStart(SCRIPT_VERSION, getPlatform(), "Cron");

    var cookie = normalizeCookie($store.read(KEY_COOKIE) || "");
    var ua = String($store.read(KEY_UA) || DEFAULT_UA).trim() || DEFAULT_UA;
    var host = String($store.read(KEY_HOST) || "").trim();

    if (!cookie || !host) {
      Logger.status("⚠️", "无 Cookie，请先抓包");
      console.log("           抓包方法：登录控制台后进入任意页面（点导航即可）");
      notifyFn("GLaDOS 签到", "无 Cookie", "打开控制台任意页面即可自动抓包");
      $done();
      return;
    }
    var vd = validateCookie(cookie);
    if (!vd.valid) {
      Logger.status("❌", "Cookie 无效");
      Logger.field("Reason", vd.message);
      notifyFn("GLaDOS 签到", "Cookie 无效", vd.message);
      $done();
      return;
    }

    Logger.field("Host", host);
    if (isSniBlockedHost(host)) {
      console.log("           ⚠️ " + host + " 存在 SNI 阻断风险，需走代理才能连通");
    }
    console.log("------------------------------------");

    var st, pts, iqi, res, after, bd;

    getStatus(cookie, host, ua).then(function (s) {
      st = s;
      Logger.field("Email", st.email);
      Logger.field("Plan", "vip " + st.vip + " · 剩余 " + st.leftDays);
      return getIQI(cookie, host, ua);
    }).then(function (q) {
      iqi = q;
      return getPoints(cookie, host, ua);
    }).then(function (p) {
      pts = p;
      Logger.field("Before", "积分 " + pts.points + " · 连续 " + pts.streak + " 天 · IQI " +
        (iqi.score === null ? "N/A" : iqi.score));
      return checkin(cookie, host, ua);
    }).then(function (r) {
      res = r;
      bd = parseBreakdown(r.breakdown);
      return getPoints(cookie, host, ua);
    }).then(function (p2) {
      after = p2;

      var icon = res.code === 0 ? "✅" : res.code === 1 ? "🔁" : res.code === -3 ? "🛡️" : "❌";
      Logger.status(icon, res.status);

      if (res.code === 0 || res.code === 1) {
        Logger.field("Challenge", res.usedProof ? "✅ nonce/proof 已提交" : "⚠️ 旧接口");
      }
      if (res.points && res.points !== "0") Logger.field("Points", "+" + res.points);

      if (bd) {
        var parts = [];
        for (var i = 0; i < bd.items.length; i++) {
          if (bd.items[i].value > 0) parts.push(bd.items[i].label + "+" + bd.items[i].value);
        }
        Logger.field("Settlement", parts.join(" ") || "全部为 0");
        var note = bd.capped
          ? " ⚠️ 被 freeCap 截断（少 " + (bd.sum - bd.credited) + "）"
          : (bd.mismatch ? " ⚠️ 不一致（差 " + (bd.sum - bd.credited) + "）" : " ✓");
        Logger.field("Sum", "逐项 " + bd.sum + " | 实得 " + bd.credited + note);
        if (bd.freeCap > 0) Logger.field("FreeCap", "⚠️ 单次封顶 " + bd.freeCap + " 分，任意付款解除");
        if (bd.items[6].value <= 0) console.log("           ExitIP +0：签到未走 GLaDOS 节点，走代理可 +1");
      }

      Logger.field("Days left", st.leftDays);
      var delta = (after.pointsNum || 0) - (pts.pointsNum || 0);
      Logger.field("Balance", after.points +
        (delta !== 0 ? " (" + (delta > 0 ? "+" : "") + delta + ")" : " (签到前 " + pts.points + ")"));
      if (res.message) Logger.field("Message", res.message);
      Logger.separator();

      if (res.tsBlocked) {
        console.log("           ▸ 今日请手动签到：https://" + host + "/console/checkin");
        console.log("           ▸ 或换域名（glados.rocks 不走 Cloudflare，延迟最低）重登后重新抓包");
        notifyFn("🛡️ GLaDOS 需人工验证",
          "今日签到被 Cloudflare 拦截",
          "手动打开 " + host + "/console/checkin 签到（连签天数不受影响）");
      } else if (res.code === 0) {
        notifyFn("✅ GLaDOS 签到成功",
          "+" + (res.points || "0") + " 分 · 连续 " + after.streak + " 天",
          "余额 " + after.points + " · 剩余 " + st.leftDays);
      } else if (res.code === 1) {
        notifyFn("🔁 GLaDOS 今日已签到", "余额 " + after.points, "剩余 " + st.leftDays);
      } else {
        notifyFn("❌ GLaDOS 签到失败", res.status, res.message || "查看 QX 日志");
      }
      $done();
    }).catch(function (e) {
      Logger.status("❌", "异常: " + (e && e.message ? e.message : e));
      notifyFn("❌ GLaDOS 签到异常", "脚本异常", String(e && e.message ? e.message : e));
      $done();
    });
  }, delay * 1000);
}
