/**
 * QX 节点带宽测速（半自动）
 * ------------------------------------------------------------------
 * 用途：测「当前生效节点」的下载带宽，用于给策略组（如 X 专用组）排候选顺序。
 *
 * 【重要局限，先读】
 * 1. QX 脚本 API 无法枚举节点、无法切换节点、无法指定某个节点发起请求。
 *    因此本脚本只能测「当前生效策略所指向的那个节点」，必须人工逐个切换。
 * 2. 官方注明 $task.fetch() 只支持 text body，下载大二进制文件的读数可能有偏差，
 *    请用「锁定同一节点 + Safari 测速站」交叉验证一次，确认偏差方向。
 *
 * 【用法】
 * 1. 把本文件放到 iPhone 的： 我的 iPhone > Quantumult X > Scripts
 * 2. 在 QX 策略页，把「自动选择」组的当前节点手动锁定到目标节点（如 SG-X5-2）
 * 3. 手动触发脚本（推荐用 event-interaction，见下方 task_local 行），读通知里的 Mbps
 * 4. 记录结果，换下一个节点，重复
 *
 * 【task_local 参考行（用前先确认路径与文件名一致）】
 * event-interaction QX节点带宽测速.js, tag=带宽测速, enabled=true
 *
 * 【测速源】
 * 默认用 Cloudflare 的指定字节端点。若不可达可换：
 *   https://speed.cloudflare.com/__down?bytes=5000000
 *   https://cachefly.cachefly.net/1mb.test      （1MB，注意同步改 TOTAL_BYTES）
 */

const TEST_URL = 'https://speed.cloudflare.com/__down?bytes=5000000';
const TOTAL_BYTES = 5000000;   // 与 TEST_URL 的 bytes 参数保持一致
const ROUNDS = 3;              // 测 3 轮取中位数，降低单次波动
const TIMEOUT_MS = 60000;      // 单轮超时 60 秒

// ---- 单轮测速 ----
function onceRound() {
  return new Promise(function (resolve) {
    var t0 = Date.now();
    $task.fetch({ url: TEST_URL, timeout: TIMEOUT_MS }).then(
      function (resp) {
        var ms = Date.now() - t0;
        var got = (resp && resp.body && resp.body.length) ? resp.body.length : TOTAL_BYTES;
        // 两个读数：按实际收到字节 / 按期望字节（用于判断 body 是否被截断）
        var mbpsGot = (got * 8) / 1e6 / (ms / 1000);
        var mbpsExp = (TOTAL_BYTES * 8) / 1e6 / (ms / 1000);
        resolve({ ok: true, ms: ms, got: got, mbpsGot: mbpsGot, mbpsExp: mbpsExp });
      },
      function (reason) {
        var e = (reason && (reason.error || reason.statusCode)) || 'unknown';
        resolve({ ok: false, err: String(e) });
      }
    );
  });
}

// ---- 连续 ROUNDS 轮 ----
function run(n, acc) {
  if (n <= 0) { report(acc); return; }
  onceRound().then(function (r) {
    if (r.ok) acc.push(r);
    run(n - 1, acc);
  });
}

function median(arr) {
  var s = arr.slice().sort(function (a, b) { return a - b; });
  var m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function report(rs) {
  if (!rs.length) {
    $notify('节点带宽测速', '全部失败', '检查节点是否可用 / 测速源是否可达');
    $done();
    return;
  }
  var gotList = rs.map(function (x) { return x.mbpsGot; });
  var expList = rs.map(function (x) { return x.mbpsExp; });
  var medGot = median(gotList);
  var medExp = median(expList);
  var trunc = (rs[0].got < TOTAL_BYTES) ? '是' : '否';
  var title = '中位 ' + medGot.toFixed(1) + ' Mbps';
  var msg = '各轮: ' + gotList.map(function (v) { return v.toFixed(1); }).join(' / ') +
            ' Mbps\n耗时: ' + rs.map(function (x) { return x.ms; }).join(' / ') + ' ms' +
            '\n(按期望字节算: ' + medExp.toFixed(1) + ' Mbps, body 被截断: ' + trunc + ')';
  $notify('节点带宽测速', title, msg);
  console.log('[带宽测速] 中位 ' + medGot.toFixed(1) + ' Mbps | 各轮 ' +
              gotList.map(function (v) { return v.toFixed(1); }).join('/') +
              ' | 截断 ' + trunc);
  $done();
}

run(ROUNDS, []);
