/* =========================================================
   main.js —— 启动、开局配置、存读档、导入导出、主菜单
   ========================================================= */
(function () {
  'use strict';
  var SG = window.SG;
  var $ = SG.$;

  /* ---------------- 开局 / 读档 ---------------- */
  function newGame(cfg) {
    var st = SG.State.create(cfg);
    SG.UI.hideStart();
    SG.Board.setDice(null, '准备开始');
    SG.Engine.init(st, { onEnd: onGameEnd });
    SG.Engine.start();
  }

  function loadGame(st) {
    SG.UI.hideStart();
    SG.Board.setDice(null, '存档已载入');
    SG.Engine.init(st, { onEnd: onGameEnd });
    SG.Engine.continueGame();
    SG.UI.toast('存档已载入，继续征战', 'good');
  }

  function onGameEnd() {
    SG.Engine.stop();
    SG.UI.showStart();
  }

  /* ---------------- 2D / 3D 视角 ----------------
     默认：桌面端 3D、小屏 2D；用户可手动切换并记住选择。
     切换只改 body 上的类名，渲染层与逻辑层完全不受影响。 */
  var VIEW_KEY = 'sg_view_mode';

  function applyView(mode) {
    document.body.classList.toggle('view-3d', mode === '3d');
    document.body.classList.toggle('view-2d', mode === '2d');
    var b = $('#btnView');
    if (b) b.textContent = (mode === '3d' ? '3D' : '2D');
    try { localStorage.setItem(VIEW_KEY, mode); } catch (e) { /* file:// 下可能被拒，忽略 */ }
  }

  function initView() {
    var saved = null;
    try { saved = localStorage.getItem(VIEW_KEY); } catch (e) { /* ignore */ }
    var small = window.matchMedia('(max-width: 900px)').matches;
    applyView(saved || (small ? '2d' : '3d'));
  }

  /* ---------------- 事件绑定 ---------------- */
  function boot() {
    initView();
    SG.UI.init();
    SG.UI.buildStartScreen();

    $('#btnStart').addEventListener('click', function () {
      var s = SG.UI.startSel;
      newGame({
        scenarioId: s.scenario,
        playerFactionId: s.faction,
        aiCount: s.ai,
        pace: s.pace
      });
    });

    $('#btnLoadGame').addEventListener('click', function () {
      var st = SG.State.load();
      if (!st) {
        SG.UI.toast('没有找到可用存档', 'bad');
        SG.UI.buildStartScreen();
        return;
      }
      loadGame(st);
    });

    $('#btnView').addEventListener('click', function () {
      var is3d = document.body.classList.contains('view-3d');
      applyView(is3d ? '2d' : '3d');
      SG.UI.toast(is3d ? '已切换到 2D 视角' : '已切换到 3D 视角', 'good');
    });

    $('#btnHelp').addEventListener('click', function () {
      SG.UI.info('玩法说明', SG.UI.helpHTML());
    });

    $('#btnSave').addEventListener('click', function () {
      var st = SG.Engine.getState();
      if (!st) return;
      var r = SG.State.save(st);
      SG.UI.toast(r.ok ? '进度已保存到浏览器本地' : '本地存储不可用，已暂存于内存', r.ok ? 'good' : 'gold');
    });

    $('#btnExport').addEventListener('click', function () {
      var st = SG.Engine.getState();
      if (!st) return;
      SG.UI.textBoxDialog('导出存档', '复制以下文本并妥善保存，可在任何设备导入续玩。全选复制即可。', SG.State.toJSON(st), true);
    });

    $('#btnImport').addEventListener('click', function () {
      SG.UI.textBoxDialog('导入存档', '粘贴此前导出的存档文本，然后点击「确定导入」。', '', false).then(function (text) {
        if (!text) return;
        var st = null;
        try { st = JSON.parse(text); } catch (e) { st = null; }
        if (!st || !st.tiles || !st.factions) { SG.UI.toast('存档文本无效，请检查后重试', 'bad'); return; }
        SG.Engine.stop();
        loadGame(st);
      });
    });

    $('#btnMenu').addEventListener('click', function () {
      SG.UI.confirm('返回主菜单', '当前进度会自动保存，确定返回主菜单吗？', '返回主菜单', '继续游戏').then(function (ok) {
        if (!ok) return;
        var st = SG.Engine.getState();
        if (st) SG.State.save(st);
        SG.Engine.stop();
        SG.UI.showStart();
      });
    });

    /* 空格键掷骰 / 快捷结束回合 */
    document.addEventListener('keydown', function (e) {
      if (e.code !== 'Space') return;
      var st = SG.Engine.getState();
      if (!st || st.over) return;
      var btns = SG.$$('#boardActions .btn');
      if (btns.length === 1) { e.preventDefault(); btns[0].click(); }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})();
