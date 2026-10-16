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
     两套渲染层（SG.Board2D 平面 DOM / SG.Board3D WebGL）暴露完全相同的
     接口，这里按当前视角把 SG.Board 路由到其中之一，engine 层完全无感。
     默认：桌面端 3D、小屏 2D；用户可手动切换并记住选择。 */
  var VIEW_KEY = 'sg_view_mode';
  var viewMode = '2d';

  var curState = null, curRoot = null;
  var lastFid = null, lastHereIdx = null;
  var glBroken = false;

  function use3D() {
    return !glBroken && viewMode === '3d' && SG.Board3D && SG.Board3D.available();
  }
  function R() { return use3D() ? SG.Board3D : SG.Board2D; }

  /* 把棋盘按当前渲染层重新挂载（首次进入 / 切换视角 / 读档后调用） */
  function remount() {
    if (!curState) return;
    var r = R();
    if (r === SG.Board3D && r.init(curState, curRoot) === false) {
      /* WebGL 初始化真的失败了：静默降级到 2D，不改写用户偏好 */
      glBroken = true;
      viewMode = '2d';
      document.body.classList.remove('view-3d');
      document.body.classList.add('view-2d');
      if ($('#btnView')) $('#btnView').textContent = '2D';
      SG.UI.toast('WebGL 初始化失败，已降级为 2D 视角', 'bad');
      r = SG.Board2D;
    }
    if (r === SG.Board2D) r.init(curState, curRoot);
    r.render();
    curState.factions.forEach(function (f) { r.setPiecePos(f.id, f.pos, true); });
    r.syncPieces();
    r.focusPiece(lastFid);
    r.markHere(lastHereIdx);
    SG.Board2D.hideTip();
  }

  SG.Board = {
    init: function (st, root) {
      curState = st;
      curRoot = root;
      SG.Board2D.setState(st);   // tipHTML 等公共逻辑需要读到当前状态
      remount();
    },
    render: function () { R().render(); },
    setPiecePos: function (fid, i, instant) { R().setPiecePos(fid, i, instant); },
    movePiece: function (fid, from, steps) { return R().movePiece(fid, from, steps); },
    teleportPiece: function (fid, i) { R().teleportPiece(fid, i); },
    focusPiece: function (fid) { lastFid = fid; R().focusPiece(fid); },
    syncPieces: function () { R().syncPieces(); },
    markHere: function (i) { lastHereIdx = i; R().markHere(i); },
    /* 以下都是 DOM 覆层，与渲染方式无关，统一走 2D 层实现 */
    setDice: function (v, h) { SG.Board2D.setDice(v, h); },
    rolling: function (on, h) { SG.Board2D.rolling(on, h); },
    setCenterInfo: function (html) { SG.Board2D.setCenterInfo(html); },
    setBoardActions: function (nodes) { SG.Board2D.setBoardActions(nodes); },
    hideTip: function () { SG.Board2D.hideTip(); },
    tipHTML: function (t) { return SG.Board2D.tipHTML(t); }
  };

  function applyView(mode) {
    viewMode = mode;
    document.body.classList.toggle('view-3d', mode === '3d');
    document.body.classList.toggle('view-2d', mode === '2d');
    var b = $('#btnView');
    if (b) b.textContent = (mode === '3d' ? '3D' : '2D');
    try { localStorage.setItem(VIEW_KEY, mode); } catch (e) { /* file:// 下可能被拒，忽略 */ }
  }

  /* 返回是否需要提示“已降级为 2D” */
  function initView() {
    var saved = null;
    try { saved = localStorage.getItem(VIEW_KEY); } catch (e) { /* ignore */ }
    var small = window.matchMedia('(max-width: 900px)').matches;
    var want = saved || (small ? '2d' : '3d');
    var fellBack = false;
    if (want === '3d' && !(SG.Board3D && SG.Board3D.available())) {
      want = '2d';
      fellBack = true;
    }
    applyView(want);
    return fellBack;
  }

  /* ---------------- 事件绑定 ---------------- */
  function boot() {
    var fellBack = initView();
    SG.UI.init();
    SG.UI.buildStartScreen();
    if (fellBack) SG.UI.toast('当前环境不支持 WebGL，已使用 2D 视角', 'bad');

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
      var to3d = viewMode !== '3d';
      if (to3d && !(SG.Board3D && SG.Board3D.available())) {
        SG.UI.toast('当前环境不支持 WebGL，无法切换到 3D', 'bad');
        return;
      }
      applyView(to3d ? '3d' : '2d');
      remount();
      SG.UI.toast(to3d ? '已切换到 3D 视角（拖拽旋转 / 滚轮缩放）' : '已切换到 2D 视角', 'good');
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
