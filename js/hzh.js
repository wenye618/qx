/*
 * 华住会 APP 获取 Token & 签到 (2025 新版适配)
 * 仅 QX 测试，其他自测
 * ====================================
 * [rewrite_local]
 * ^https?://hweb-personalcenter\.huazhu\.com/login/autoLogin$ url script-request-header hzh.js
 *
 * [task_local]
 * 1 0 * * * hzh.js, tag=华住会, enabled=true
 *
 * [mitm]
 * hostname = hweb-personalcenter.huazhu.com
 * ====================================
 */

const $ = new Env("华住会签到");
const token_key = "HZH_Token";
const token = $.getdata(token_key);
let message = "";

!(async () => {
  if (typeof $request !== "undefined") {
    getToken();
    return;
  }
  await signin();
  await status();
  await notify();
})()
  .catch((e) => {
    $.logErr(e, "❌ 脚本执行异常");
    $.msg($.name, "", `❌ 失败: ${e}`);
  })
  .finally(() => {
    $.done();
  });

/* ========== Token 捕获 ========== */
function getToken() {
  if ($request && $request.method !== "OPTIONS") {
    let val = null;

    // 1) 优先从 Header 获取 User-Token（旧版）
    const headers = $request.headers || {};
    val = headers["user-token"] || headers["User-Token"] || headers["USER-TOKEN"];

    // 2) 若 Header 没有，从 Cookie 中解析 userToken（新版 APP 9.x）
    if (!val) {
      const cookie = headers["Cookie"] || headers["cookie"] || "";
      const m = cookie.match(/userToken=([^;\s]+)/);
      if (m) val = m[1];
    }

    // 3) 若仍没有，尝试从请求体或 URL 参数中提取（备用）
    if (!val && $request.body) {
      const m = $request.body.match(/userToken[=:]([^&\s]+)/);
      if (m) val = m[1];
    }

    if (val) {
      const ok = $.setdata(val, token_key);
      if (ok) {
        $.msg($.name, "", "🎉 获取 Token 成功，请手动运行一次签到任务测试");
        $.log(`[Token] 已保存: ${val.substring(0, 20)}...`);
      }
    } else {
      $.log("[Token] 未能从请求中提取到 Token，请检查抓包内容");
      $.msg($.name, "", "⚠️ 未提取到 Token，请确认登录请求头/Cookie 中是否包含 userToken");
    }
  }
}

/* ========== 签到 ========== */
function signin() {
  return new Promise((resolve) => {
    if (!token) {
      message += "❌ 未获取到 Token，请先打开华住会 APP 登录一次\n";
      resolve();
      return;
    }

    // 新版接口: GET /game/sign_in?date=<秒级时间戳>
    const ts = Math.floor(Date.now() / 1000);
    const url = `https://appgw.huazhu.com/game/sign_in?date=${ts}`;
    const headers = {
      "Client-Platform": "APP-IOS",
      "User-Agent": "HUAZHU/ios/iPhone/18.7.8/9.46.0/RNWEBVIEW",
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "zh-CN,zh-Hans;q=0.9",
      "Accept-Encoding": "gzip, deflate, br",
      Origin: "https://cdn.huazhu.com",
      Referer: "https://cdn.huazhu.com/",
      Connection: "keep-alive",
      Cookie: `userToken=${token}`,
    };

    const opts = {
      url,
      headers,
    };

    $.log(`[签到] 请求: ${url}`);
    $.get(opts, (err, resp, data) => {
      try {
        if (err) {
          message += `❌ 签到请求失败: ${err}\n`;
          $.log(`[签到] 网络错误: ${err}`);
          resolve();
          return;
        }
        $.log(`[签到] 响应: ${data}`);
        const result = JSON.parse(data);

        // 兼容多种返回结构
        const code = result?.businessCode ?? result?.code ?? result?.statusCode;
        const content = result?.content ?? result?.data ?? result?.result;

        if (code === "1000" || code === 1000 || code === 200) {
          if (content?.success === true || content?.signed === true) {
            message += `✅ 签到成功${content?.point ? "，获得积分: " + content.point : ""}\n`;
          } else if (content?.isSign === true || content?.isSigned === true || content?.alreadySign === true) {
            message += `⚠️ 今日已签到，请勿重复\n`;
          } else {
            message += `ℹ️ 签到结果: ${JSON.stringify(content)}\n`;
          }
        } else {
          const msg = result?.message ?? result?.msg ?? result?.errorMessage ?? JSON.stringify(result);
          message += `❌ 签到失败: ${msg}\n`;
        }
      } catch (e) {
        $.logErr(e, "❌ 解析签到响应失败");
        message += `❌ 解析签到响应失败: ${e.message}\n原始响应: ${data?.substring(0, 200)}\n`;
      } finally {
        resolve();
      }
    });
  });
}

/* ========== 查询积分状态 ========== */
function status() {
  return new Promise((resolve) => {
    if (!token) {
      resolve();
      return;
    }

    // 注: 新版积分接口待抓包确认，此处沿用旧版地址
    const url = "https://appgw.huazhu.com/api/getPoint";
    const headers = {
      "Content-Type": "application/x-www-form-urlencoded",
      "Client-Platform": "APP-IOS",
      "User-Agent": "HUAZHU/ios/iPhone/18.7.8/9.46.0/RNWEBVIEW",
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "zh-CN,zh-Hans;q=0.9",
      "Accept-Encoding": "gzip, deflate, br",
      Origin: "https://cdn.huazhu.com",
      Referer: "https://cdn.huazhu.com/",
      Connection: "keep-alive",
      Cookie: `userToken=${token}`,
    };

    const opts = {
      url,
      headers,
      body: JSON.stringify({}),
    };

    $.log(`[积分] 请求: ${url}`);
    $.post(opts, (err, resp, data) => {
      try {
        if (err) {
          message += `❌ 积分查询失败: ${err}\n`;
          resolve();
          return;
        }
        $.log(`[积分] 响应: ${data}`);
        const result = JSON.parse(data);
        const code = result?.businessCode ?? result?.code ?? result?.statusCode;
        const content = result?.content ?? result?.data ?? result?.result;

        if (code === "1000" || code === 1000 || code === 200) {
          const point = content?.point ?? content?.totalPoint ?? content?.integral ?? "未知";
          message += `💰 当前积分: ${point}`;
        } else {
          const msg = result?.message ?? result?.msg ?? JSON.stringify(result);
          message += `⚠️ 积分查询失败: ${msg}`;
        }
      } catch (e) {
        $.logErr(e, "❌ 解析积分响应失败");
        message += `⚠️ 解析积分响应失败`;
      }
      resolve();
    });
  });
}

/* ========== 通知 ========== */
async function notify() {
  $.msg($.name, "", message || "无消息");
}

/* ========== Env 工具类 (Quantumult X / Surge / Loon / Node.js 兼容) ========== */
function Env(t, e) {
  class s {
    constructor(t) {
      this.env = t;
    }
    send(t, e = "GET") {
      t = "string" == typeof t ? { url: t } : t;
      let s = this.get;
      return (
        "POST" === e && (s = this.post),
        new Promise((e, a) => {
          s.call(this, t, (t, s, r) => {
            t ? a(t) : e(s);
          });
        })
      );
    }
    get(t) {
      return this.send.call(this.env, t);
    }
    post(t) {
      return this.send.call(this.env, t, "POST");
    }
  }
  return new (class {
    constructor(t, e) {
      (this.name = t),
        (this.http = new s(this)),
        (this.data = null),
        (this.dataFile = "box.dat"),
        (this.logs = []),
        (this.isMute = !1),
        (this.isNeedRewrite = !1),
        (this.logSeparator = "\n"),
        (this.encoding = "utf-8"),
        (this.startTime = new Date().getTime()),
        Object.assign(this, e),
        this.log("", `🔔${this.name}, 开始!`);
    }
    getEnv() {
      return "undefined" != typeof $environment && $environment["surge-version"]
        ? "Surge"
        : "undefined" != typeof $environment && $environment["stash-version"]
        ? "Stash"
        : "undefined" != typeof module && module.exports
        ? "Node.js"
        : "undefined" != typeof $task
        ? "Quantumult X"
        : "undefined" != typeof $loon
        ? "Loon"
        : "undefined" != typeof $rocket
        ? "Shadowrocket"
        : void 0;
    }
    isNode() {
      return "Node.js" === this.getEnv();
    }
    isQuanX() {
      return "Quantumult X" === this.getEnv();
    }
    isSurge() {
      return "Surge" === this.getEnv();
    }
    isLoon() {
      return "Loon" === this.getEnv();
    }
    isShadowrocket() {
      return "Shadowrocket" === this.getEnv();
    }
    isStash() {
      return "Stash" === this.getEnv();
    }
    toObj(t, e = null) {
      try {
        return JSON.parse(t);
      } catch {
        return e;
      }
    }
    toStr(t, e = null) {
      try {
        return JSON.stringify(t);
      } catch {
        return e;
      }
    }
    getjson(t, e) {
      let s = e;
      const a = this.getdata(t);
      if (a)
        try {
          s = JSON.parse(this.getdata(t));
        } catch {}
      return s;
    }
    setjson(t, e) {
      try {
        return this.setdata(JSON.stringify(t), e);
      } catch {
        return !1;
      }
    }
    getScript(t) {
      return new Promise((e) => {
        this.get({ url: t }, (t, s, a) => e(a));
      });
    }
    runScript(t, e) {
      return new Promise((s) => {
        let a = this.getdata("@chavy_boxjs_userCfgs.httpapi");
        a = a ? a.replace(/\n/g, "").trim() : a;
        let r = this.getdata("@chavy_boxjs_userCfgs.httpapi_timeout");
        (r = r ? 1 * r : 20), (r = e && e.timeout ? e.timeout : r);
        const [i, o] = a.split("@"),
          n = {
            url: `http://${o}/v1/scripting/evaluate`,
            body: { script_text: t, mock_type: "cron", timeout: r },
            headers: { "X-Key": i, Accept: "*/*" },
            timeout: r,
          };
        this.post(n, (t, e, a) => s(a));
      }).catch((t) => this.logErr(t));
    }
    loaddata() {
      if (!this.isNode()) return {};
      {
        (this.fs = this.fs ? this.fs : require("fs")),
          (this.path = this.path ? this.path : require("path"));
        const t = this.path.resolve(this.dataFile),
          e = this.path.resolve(process.cwd(), this.dataFile),
          s = this.fs.existsSync(t),
          a = !s && this.fs.existsSync(e);
        if (!s && !a) return {};
        {
          const a = s ? t : e;
          try {
            return JSON.parse(this.fs.readFileSync(a));
          } catch (t) {
            return {};
          }
        }
      }
    }
    writedata() {
      if (this.isNode()) {
        (this.fs = this.fs ? this.fs : require("fs")),
          (this.path = this.path ? this.path : require("path"));
        const t = this.path.resolve(this.dataFile),
          e = this.path.resolve(process.cwd(), this.dataFile),
          s = this.fs.existsSync(t),
          a = !s && this.fs.existsSync(e),
          r = JSON.stringify(this.data);
        s
          ? this.fs.writeFileSync(t, r)
          : a
          ? this.fs.writeFileSync(e, r)
          : this.fs.writeFileSync(t, r);
      }
    }
    lodash_get(t, e, s) {
      const a = e.replace(/\[(\d+)\]/g, ".$1").split(".");
      let r = t;
      for (const t of a) if (((r = Object(r)[t]), void 0 === r)) return s;
      return r;
    }
    lodash_set(t, e, s) {
      return Object(t) !== t
        ? t
        : (Array.isArray(e) || (e = e.toString().match(/[^\[\].]+/g) || []),
          (e
            .slice(0, -1)
            .reduce(
              (t, s, a) =>
                Object(t[s]) === t[s]
                  ? t[s]
                  : (t[s] = Math.abs(e[a + 1]) >> 0 == +e[a + 1] ? [] : {}),
              t
            )[e[e.length - 1]] = s),
          t);
    }
    getdata(t) {
      let e = this.getval(t);
      if (/^@/.test(t)) {
        const [, s, a] = /^@(.*?)\.(.*?)$/.exec(t),
          r = s ? this.getval(s) : "";
        if (r)
          try {
            const t = JSON.parse(r);
            e = t ? this.lodash_get(t, a, "") : e;
          } catch (t) {
            e = "";
          }
      }
      return e;
    }
    setdata(t, e) {
      let s = !1;
      if (/^@/.test(e)) {
        const [, a, r] = /^@(.*?)\.(.*?)$/.exec(e),
          i = this.getval(a),
          o = a ? ("null" === i ? null : i || "{}") : "{}";
        try {
          const e = JSON.parse(o);
          this.lodash_set(e, r, t), (s = this.setval(JSON.stringify(e), a));
        } catch (e) {
          const a = {};
          this.lodash_set(a, r, t), (s = this.setval(JSON.stringify(a), a));
        }
      } else s = this.setval(t, e);
      return s;
    }
    getval(t) {
      return this.isSurge() || this.isLoon() || this.isShadowrocket()
        ? $persistentStore.read(t)
        : this.isQuanX()
        ? $prefs.valueForKey(t)
        : this.isStash()
        ? (this.getdata = this.getdata.bind(this), this.loaddata()[t])
        : this.isNode()
        ? ((this.data = this.loaddata()), this.data[t])
        : (this.data && this.data[t]) || null;
    }
    setval(t, e) {
      return this.isSurge() || this.isLoon() || this.isShadowrocket()
        ? $persistentStore.write(t, e)
        : this.isQuanX()
        ? $prefs.setValueForKey(t, e)
        : this.isStash()
        ? (this.setdata = this.setdata.bind(this), this.writedata(), this.loaddata()[e] = t, this.writedata(), !0)
        : this.isNode()
        ? ((this.data = this.loaddata()), (this.data[e] = t), this.writedata(), !0)
        : (this.data && this.data[e]) || null;
    }
    initGotEnv(t) {
      (this.got = this.got ? this.got : require("got")),
        (this.cktough = this.cktough ? this.cktough : require("tough-cookie")),
        (this.ckjar = this.ckjar ? this.ckjar : new this.cktough.CookieJar()),
        t &&
          ((t.headers = t.headers ? t.headers : {}),
          void 0 === t.headers.Cookie && void 0 === t.cookieJar && (t.cookieJar = this.ckjar));
    }
    get(t, e = () => {}) {
      if (
        (t.headers && (delete t.headers["Content-Type"], delete t.headers["Content-Length"]),
        this.isSurge() || this.isLoon() || this.isShadowrocket())
      )
        this.isSurge() &&
          this.isNeedRewrite &&
          ((t.headers = t.headers || {}), Object.assign(t.headers, { "X-Surge-Skip-Scripting": !1 })),
          $httpClient.get(t, (t, s, a) => {
            !t && s && ((s.body = a), (s.statusCode = s.status)), e(t, s, a);
          });
      else if (this.isQuanX())
        this.isNeedRewrite && (t.opts = t.opts || {}), Object.assign(t.opts, { hints: !1 }),
          $task.fetch(t).then(
            (t) => {
              const { statusCode: s, statusCode: a, headers: r, body: i } = t;
              e(null, { status: s, statusCode: a, headers: r, body: i }, i);
            },
            (t) => e(t)
          );
      else if (this.isNode()) {
        let s = require("iconv-lite");
        this.initGotEnv(t),
          this.got(t).on("redirect", (t, e) => {
            try {
              if (t.headers["set-cookie"]) {
                const s = t.headers["set-cookie"].map(this.cktough.Cookie.parse).toString();
                s && this.ckjar.setCookieSync(s, null), (e.cookieJar = this.ckjar);
              }
            } catch (t) {
              this.logErr(t);
            }
          })
          .then(
            (t) => {
              const { statusCode: a, statusCode: r, headers: i, rawBody: o } = t,
                n = s.decode(o, this.encoding);
              e(null, { status: a, statusCode: r, headers: i, rawBody: o, body: n }, n);
            },
            (t) => {
              const { message: a, response: r } = t;
              e(a, r, r && s.decode(r.rawBody, this.encoding));
            }
          );
      }
    }
    post(t, e = () => {}) {
      const s = t.method ? t.method.toLocaleLowerCase() : "post";
      if (
        (t.body &&
          t.headers &&
          !t.headers["Content-Type"] &&
          (t.headers["Content-Type"] = "application/x-www-form-urlencoded"),
        t.headers && delete t.headers["Content-Length"],
        this.isSurge() || this.isLoon() || this.isShadowrocket())
      )
        this.isSurge() &&
          this.isNeedRewrite &&
          ((t.headers = t.headers || {}), Object.assign(t.headers, { "X-Surge-Skip-Scripting": !1 })),
          $httpClient[s](t, (t, s, a) => {
            !t && s && ((s.body = a), (s.statusCode = s.status)), e(t, s, a);
          });
      else if (this.isQuanX())
        (t.method = s),
          this.isNeedRewrite && (t.opts = t.opts || {}), Object.assign(t.opts, { hints: !1 }),
          $task.fetch(t).then(
            (t) => {
              const { statusCode: s, statusCode: a, headers: r, body: i } = t;
              e(null, { status: s, statusCode: a, headers: r, body: i }, i);
            },
            (t) => e(t)
          );
      else if (this.isNode()) {
        let a = require("iconv-lite");
        this.initGotEnv(t);
        const { url: r, ...i } = t;
        this.got[s](r, i).then(
          (t) => {
            const { statusCode: s, statusCode: r, headers: i, rawBody: o } = t,
              n = a.decode(o, this.encoding);
            e(null, { status: s, statusCode: r, headers: i, rawBody: o, body: n }, n);
          },
          (t) => {
            const { message: s, response: r } = t;
            e(s, r, r && a.decode(r.rawBody, this.encoding));
          }
        );
      }
    }
    time(t, e = null) {
      const s = e ? new Date(e) : new Date();
      let a = {
        "M+": s.getMonth() + 1,
        "d+": s.getDate(),
        "H+": s.getHours(),
        "m+": s.getMinutes(),
        "s+": s.getSeconds(),
        "q+": Math.floor((s.getMonth() + 3) / 3),
        S: s.getMilliseconds(),
      };
      /(y+)/.test(t) &&
        (t = t.replace(RegExp.$1, (s.getFullYear() + "").substr(4 - RegExp.$1.length)));
      for (let e in a)
        new RegExp("(" + e + ")").test(t) &&
          (t = t.replace(
            RegExp.$1,
            1 == RegExp.$1.length ? a[e] : ("00" + a[e]).substr(("" + a[e]).length)
          ));
      return t;
    }
    msg(e = t, s = "", a = "", r) {
      const i = (t) => {
        if (!t) return t;
        if ("string" == typeof t) return this.isLoon() ? t : this.isQuanX() ? { "open-url": t } : this.isSurge() || this.isShadowrocket() || this.isStash() ? { url: t } : void 0;
        if ("object" == typeof t) {
          if (this.isLoon()) {
            let e = t.openUrl || t.url || t["open-url"],
              s = t.mediaUrl || t["media-url"];
            return { openUrl: e, mediaUrl: s };
          }
          if (this.isQuanX()) {
            let e = t["open-url"] || t.url || t.openUrl,
              s = t["media-url"] || t.mediaUrl,
              a = t["auto-dismiss"] || t.autoDismiss,
              r = t["update-pasteboard"] || t.updatePasteboard;
            return { "open-url": e, "media-url": s, "auto-dismiss": a, "update-pasteboard": r };
          }
          if (this.isSurge() || this.isShadowrocket() || this.isStash()) {
            let e = t.url || t.openUrl || t["open-url"];
            return { url: e };
          }
        }
      };
      if ((this.isMute || (this.isSurge() || this.isLoon() || this.isShadowrocket() || this.isStash() ? $notification.post(e, s, a, i(r)) : this.isQuanX() && $notify(e, s, a, i(r))), !this.isMute)) {
        let t = ["", "==============📣系统通知📣=============="];
        t.push(e), s && t.push(s), a && t.push(a), console.log(t.join("\n")), (this.logs = this.logs.concat(t));
      }
    }
    log(...t) {
      t.length > 0 && (this.logs = [...this.logs, ...t]), console.log(t.join(this.logSeparator));
    }
    logErr(t, e) {
      const s = !this.isSurge() && !this.isQuanX() && !this.isLoon() && !this.isShadowrocket() && !this.isStash();
      s ? this.log("", `❗️${this.name}, 错误!`, e.stack) : this.log("", `❗️${this.name}, 错误!`, t);
    }
    wait(t) {
      return new Promise((e) => setTimeout(e, t));
    }
    done(t = {}) {
      const e = new Date().getTime(),
        s = (e - this.startTime) / 1e3;
      if ((this.log("", `🔔${this.name}, 结束! 🕛 ${s} 秒`), this.isNode() && process.exit(1), this.isQuanX())) $done(t);
      else if (this.isSurge() || this.isLoon() || this.isShadowrocket() || this.isStash()) $done(t);
    }
  })(t, e);
}
