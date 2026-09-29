/**
 * QX 节点带宽测速（半自动 · v2）
 * ------------------------------------------------------------------
 * 用途：测「当前生效节点」的下载带宽，用于给策略组排候选顺序。
 *
 * v2 改动（相对 v1）：
 * 1. 修复「无有效内容」弹窗：event-interaction 脚本触发后，QX 会读取
 *    $done() 的参数作为弹窗内容。v1 的 $done() 不带参数 → 弹窗为空。
 *    v2 将测速结论写进 $done()，弹窗直接显示中文结果。
 * 2. 通知与弹窗文案改为纯中文、带「优秀/良好/够用/偏慢」分级。
 * 3. 修掉「body 缺失被兜底成满字节」的隐患：收到字节数明显小于期望时，
 *    明确标注「数据不完整，读数不可信」，不再假装测满。
 *
 * 【重要局限，先读】
 * 1. QX 脚本 API 无法枚举/切换节点，只能测「当前生效节点」，须人工逐个切。
 * 2. $task.fetch() 仅支持 text body，下载大二进制读数可能有偏差，
 *    建议与 Safari 测速站（fast.com）交叉验证一次。
 *
 * 【用法】
 * 1. 把本文件放到：我的 iPhone > Quantumult X > Scripts
 * 2. QX 策略页把目标组锁定到某节点
 * 3. 手动触发脚本（event-interaction），看弹窗 + 通知里的中文结论
 * 4. 记录，换下一节点，重复
 *
 * 【task_local 参考行】
 * event-interaction QX节点带宽测速.js, tag=带宽测速, enabled=true
 */

var TEST_URL = 'https://speed.cloudflare.com/__down?bytes=5000000';
var TOTAL_BYTES = 5000000;   // 与 TEST_URL 的 bytes 参数一致
var ROUNDS = 3;              // 测 3 轮取中位数
var TIMEOUT_MS = 60000;      // 单轮超时 60 秒

// ---- 带宽分级（中文，一眼看懂） ----
function grade(mbps) {
  if (mbps >= 15) return '优秀';
  if (mbps >= 8) return '良好';
  if (mbps >= 4) return '够用';
  return '偏慢';
}

// ---- 单轮测速 ----
function onceRound() {
  return new Promise(function (resolve) {
    var t0 = Date.now();
    $task.fetch({ url: TEST_URL, timeout: TIMEOUT_MS }).then(
      function (resp) {
        var ms = Date.now() - t0;
        var got = (resp && resp.body && resp.body.length) ? resp.body.length : 0;
        var mbps = (got * 8) / 1e6 / (ms / 1000);
        var incomplete = (got < TOTAL_BYTES * 0.8);   // 收到不足 80% 视为不完整
        resolve({ ok: true, ms: ms, got: got, mbps: mbps, incomplete: incomplete });
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
  var okList = rs.filter(function (x) { return x.ok; });
  if (!okList.length) {
    var errTitle = '节点带宽测速 · 失败';
    var errMsg = '未能测出带宽。\n请检查：节点是否可用、测速源是否可达。';
    $notify(errTitle, '测速失败', errMsg);
    $done({ title: errTitle, message: errMsg });
    return;
  }

  var mbpsList = okList.map(function (x) { return x.mbps; });
  var medMbps = median(mbpsList);
  var g = grade(medMbps);
  var anyIncomplete = okList.some(function (x) { return x.incomplete; });

  var title = '中位 ' + medMbps.toFixed(1) + ' Mbps（' + g + '）';
  var roundsLine = okList.map(function (x) { return x.mbps.toFixed(1); }).join(' / ');
  var msLine = okList.map(function (x) { return x.ms; }).join(' / ');
  var warnLine = anyIncomplete ? '\n⚠ 数据不完整，读数不可信' : '';

  var msg = '各轮: ' + roundsLine + ' Mbps\n' +
            '耗时: ' + msLine + ' ms' + warnLine;

  $notify('节点带宽测速', title, msg);
  console.log('[带宽测速] ' + title + ' | 各轮 ' + roundsLine + ' | 耗时 ' + msLine + warnLine);

  // 关键：把结果写进 $done()，弹窗才会显示内容，不再「无有效内容」
  $done({ title: title, message: msg });
}

run(ROUNDS, []);
