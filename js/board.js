/* =========================================================
   board.js —— 棋盘构建 / 格子渲染 / 棋子步进动画 / 悬浮提示
   ========================================================= */
(function () {
  'use strict';
  var SG = window.SG = window.SG || {};
  var util = SG.util, C = SG.CONST, el = SG.el;

  var boardEl, tooltipEl;
  var tileEls = {};      // index -> element
  var pieceEls = {};     // factionId -> element
  var state = null;

  /* tooltip、状态等与渲染方式无关的部分由 2D / 3D 两个渲染层共用，
     因此这里用惰性查询，保证 3D 模式下未 init 也能正常弹提示。 */
  function tipEl() { return tooltipEl || (tooltipEl = SG.$('#tooltip')); }

  /* 百分比定位（每格 = 100/11 %）*/
  var CELL = 100 / C.BOARD_W;
  function pct(n) { return (n * CELL) + '%'; }

  /* ---- 格子台基高度（px）----
     城池按等级长高形成错落地基，关隘略低，其余类型只有薄台基。
     2D 平面视角用不到，仅供 3D 渲染层（render3d.js）换算方块厚度。 */
  function tileZ(t) {
    if (t.type === 'city') return t.ownerId ? 6 + 7 * (Math.max(1, t.level) - 1) : 3;
    if (t.type === 'pass') return t.ownerId ? 6 : 3;
    return 2;
  }

  /* ---------------- 2D 地图底纹 ----------------
     平面视角也用同一套路网坐标画一张底图（草地 + 石板路），
     这样 2D 下也能看出这是一张「地图」而不是空方格板。
     画在 canvas 上再转 dataURL，不引入任何图片文件。 */
  function buildMapBackdrop() {
    if (!boardEl) return;
    var D = SG.data;
    var W = 640, H = Math.round(640 * D.MAP_D / D.MAP_W);
    var cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    var ctx = cv.getContext('2d');
    var g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#5f7c46');
    g.addColorStop(0.55, '#6d8a4b');
    g.addColorStop(1, '#5a7542');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    for (var n = 0; n < 1400; n++) {
      ctx.fillStyle = Math.random() < 0.5 ? 'rgba(255,255,255,.045)' : 'rgba(0,0,0,.05)';
      ctx.fillRect(Math.random() * W, Math.random() * H, 2, 2);
    }
    /* 河流：先画水带，后面的石板路会盖过去（形成过河的桥） */
    var rp = D.riverPoints();
    ctx.lineWidth = 0.47 / D.MAP_W * W;
    ctx.strokeStyle = '#3f7f96';
    ctx.beginPath();
    rp.forEach(function (p, i) {
      var q = map(p);
      if (i === 0) ctx.moveTo(q[0], q[1]); else ctx.lineTo(q[0], q[1]);
    });
    ctx.stroke();

    /* 石板路：先描深色路肩，再铺路面 */
    var pts = D.pathPoints();
    function map(p) {
      return [(p[0] / D.MAP_W + 0.5) * W, (p[1] / D.MAP_D + 0.5) * H];
    }
    var roadW = 0.86 / D.MAP_W * W;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    [[roadW + 10, 'rgba(28,24,18,.5)'], [roadW, '#6f6a5d']].forEach(function (st) {
      ctx.lineWidth = st[0];
      ctx.strokeStyle = st[1];
      ctx.beginPath();
      pts.forEach(function (p, i) {
        var q = map(p);
        if (i === 0) ctx.moveTo(q[0], q[1]); else ctx.lineTo(q[0], q[1]);
      });
      ctx.stroke();
    });
    boardEl.style.backgroundImage = 'url(' + cv.toDataURL('image/png') + ')';
    boardEl.style.backgroundSize = '100% 100%';
  }

  /* ---------------- 构建 ---------------- */
  function init(st, root) {
    state = st;
    boardEl = root || SG.$('#board');
    tooltipEl = SG.$('#tooltip');
    buildMapBackdrop();

    /* 清掉旧棋子/旧格子，保留中央区 */
    SG.$$('.tile', boardEl).forEach(function (n) { n.remove(); });
    SG.$$('.piece', boardEl).forEach(function (n) { n.remove(); });
    tileEls = {}; pieceEls = {};

    /* 格子 */
    state.tiles.forEach(function (t) {
      var xy = SG.data.tileXY(t.i);
      var node = el('div', {
        class: 'tile type-' + t.type + (t.region ? ' region-' + t.region : ''),
        style: { left: pct(xy.x), top: pct(xy.y) },
        dataset: { index: String(t.i) }
      }, [
        el('div', { class: 'tile-inner' }, [
          el('div', { class: 'tile-icon', text: SG.data.TILE_ICON[t.type] || '·' }),
          el('div', { class: 'tile-name', text: t.name }),
          el('div', { class: 'tile-sub' })
        ]),
        el('div', { class: 'tile-flag hidden' }),
        el('div', { class: 'tile-lv hidden' }),
        el('div', { class: 'tile-builds' })
      ]);
      node.addEventListener('mouseenter', function (e) { showTip(t, e); });
      node.addEventListener('mousemove', moveTip);
      node.addEventListener('mouseleave', hideTip);
      boardEl.appendChild(node);
      tileEls[t.i] = node;
    });

    /* 棋子 */
    state.factions.forEach(function (f) {
      var node = el('div', {
        class: 'piece',
        style: { '--pc': f.color },
        dataset: { faction: f.id }
      }, [
        el('div', { class: 'piece-dot', text: f.name.charAt(0) })
      ]);
      boardEl.appendChild(node);
      pieceEls[f.id] = node;
    });

    render();
    state.factions.forEach(function (f) { setPiecePos(f.id, f.pos, true); });
  }

  /* ---------------- 渲染 ---------------- */
  function render() {
    state.tiles.forEach(function (t) {
      var node = tileEls[t.i];
      if (!node) return;

      var sub = node.querySelector('.tile-sub');
      var flag = node.querySelector('.tile-flag');
      var lv = node.querySelector('.tile-lv');
      var builds = node.querySelector('.tile-builds');

      node.classList.toggle('owned', !!t.ownerId);
      if (t.ownerId) {
        node.style.setProperty('--owner', SG.State.faction(state, t.ownerId).color);
      } else {
        node.style.removeProperty('--owner');
      }

      /* 副标题：城池显示价格，其余显示类型说明 */
      if (t.type === 'city' || t.type === 'pass') {
        sub.textContent = t.ownerId ? '' : ('$' + util.num(t.price));
      } else if (t.type === 'farm') {
        sub.textContent = '领粮';
      } else {
        sub.textContent = '';
      }

      /* 归属标记 */
      if (t.ownerId) {
        flag.classList.remove('hidden');
        flag.style.background = SG.State.faction(state, t.ownerId).color;
        if (t.type === 'city') {
          lv.classList.remove('hidden');
          lv.textContent = 'Lv' + t.level;
        } else {
          lv.classList.add('hidden');
        }
        builds.textContent = t.buildings.map(function (b) { return SG.BUILD[b].icon; }).join('');
      } else {
        flag.classList.add('hidden');
        lv.classList.add('hidden');
        builds.textContent = '';
      }
    });
  }

  /* 高亮当前所在格 */
  var lastHere = null;
  function markHere(index) {
    if (lastHere !== null && tileEls[lastHere]) tileEls[lastHere].classList.remove('here');
    lastHere = index;
    if (index !== null && tileEls[index]) tileEls[index].classList.add('here');
  }

  /* ---------------- 棋子定位 ---------------- */
  function setPiecePos(fid, index, instant) {
    var node = pieceEls[fid];
    if (!node) return;
    var xy = SG.data.tileXY(index);
    if (instant) node.style.transition = 'none';
    node.style.left = pct(xy.x);
    node.style.top = pct(xy.y);
    if (instant) {
      // 强制回流后再恢复过渡，避免首帧动画
      void node.offsetWidth;
      node.style.transition = '';
    }
  }

  /* 高亮当前行动势力的棋子 */
  function focusPiece(fid) {
    Object.keys(pieceEls).forEach(function (k) {
      pieceEls[k].classList.toggle('active', k === fid);
    });
  }

  /* 隐藏已出局势力的棋子 */
  function syncPieces() {
    state.factions.forEach(function (f) {
      var node = pieceEls[f.id];
      if (!node) return;
      node.classList.toggle('hidden', !f.alive);
      node.querySelector('.piece-dot').style.opacity = f.alive ? '1' : '.25';
    });
  }

  /* ---------------- 步进动画 ----------------
     返回 Promise，resolve 为 { end, path }：path 为途经格子索引
     （含终点，不含起点）
  ---------------------------------------------- */
  function movePiece(fid, from, steps) {
    var dir = steps >= 0 ? 1 : -1;
    var n = Math.abs(steps);
    var cur = SG.util.mod(from, C.BOARD_N);
    var path = [];
    return new Promise(function (resolve) {
      var i = 0;
      function step() {
        if (i >= n) { resolve({ end: cur, path: path }); return; }
        cur = SG.util.mod(cur + dir, C.BOARD_N);
        path.push(cur);
        setPiecePos(fid, cur);
        markHere(cur);
        i++;
        setTimeout(step, C.MOVE_STEP_MS);
      }
      if (n === 0) { resolve({ end: cur, path: path }); return; }
      step();
    });
  }

  /* 直接把棋子瞬移到某格 */
  function teleportPiece(fid, index) {
    setPiecePos(fid, index);
    markHere(index);
  }

  /* ---------------- 骰子 ---------------- */
  /* 3D 立方体朝向表：把目标点数转到正面（正面为 1） */
  var DICE_ROT = {
    1: 'rotateX(0deg) rotateY(0deg)',
    2: 'rotateX(0deg) rotateY(-90deg)',
    3: 'rotateX(-90deg) rotateY(0deg)',
    4: 'rotateX(90deg) rotateY(0deg)',
    5: 'rotateX(0deg) rotateY(90deg)',
    6: 'rotateX(0deg) rotateY(180deg)'
  };
  var DICE_BASE = 'rotateX(-24deg) rotateY(-30deg)';

  function setDice(value, hint) {
    var face = SG.$('#diceFace');     // 2D 视角的平面骰子
    var cube = SG.$('#diceCube');     // 3D 视角的立方体骰子
    var h = SG.$('#diceHint');
    var shown = (value === null || value === undefined) ? null : String(value);
    if (face) face.textContent = shown === null ? '–' : shown;
    if (cube) {
      cube.style.transform = shown === null
        ? DICE_BASE
        : (DICE_BASE + ' ' + (DICE_ROT[shown] || DICE_ROT[1]));
    }
    if (h && hint !== undefined) h.textContent = hint;
  }
  function rolling(on, hint) {
    var face = SG.$('#diceFace');
    var cube = SG.$('#diceCube');
    var h = SG.$('#diceHint');
    if (face) face.classList.toggle('rolling', !!on);
    if (cube) cube.classList.toggle('rolling', !!on);
    if (h && hint) h.textContent = hint;
  }

  /* ---------------- 悬浮提示 ---------------- */
  function tipHTML(t) {
    var rows = [];
    var regName = t.region ? SG.data.REGIONS[t.region].name + ' · ' : '';
    var typeName = {
      start: '起点', city: '城池', pass: '关隘', event: '事件', chance: '机会', tavern: '招贤馆', farm: '农田'
    }[t.type] || t.type;

    rows.push('<div class="tt-title">' + t.name + '　<span style="color:#a2967e;font-size:11px">' + regName + typeName + '</span></div>');

    if (t.type === 'city' || t.type === 'pass') {
      rows.push('<div class="tt-row">售价 <b>' + util.num(t.price) + '</b> 金　基础收益 <b>' + util.num(t.income) + '</b></div>');
      if (t.ownerId) {
        var f = SG.State.faction(state, t.ownerId);
        rows.push('<div class="tt-row">归属 <b style="color:' + f.color + '">' + f.name + '</b>' +
          (t.type === 'city' ? '　等级 <b>Lv' + t.level + '</b>' : '') + '</div>');
        var inc = SG.State.cityIncome(state, t);
        rows.push('<div class="tt-row">每回合 <b>' + util.num(inc.gold) + '</b> 金' +
          (inc.food ? ' / <b>' + util.num(inc.food) + '</b> 粮' : '') +
          (inc.troops ? ' / <b>' + util.num(inc.troops) + '</b> 兵' : '') + '</div>');
        rows.push('<div class="tt-row">过路费 <b>' + util.num(SG.State.tollOf(state, t)) + '</b> 金</div>');
        if (t.buildings.length) {
          rows.push('<div class="tt-row">建筑 ' + t.buildings.map(function (b) {
            return SG.BUILD[b].icon + SG.BUILD[b].name;
          }).join('、') + '</div>');
        }
        if (t.garrison.generalId) {
          var g = SG.State.general(state, t.garrison.generalId);
          rows.push('<div class="tt-row">守将 <b>' + g.name + '</b>　驻军 <b>' + util.num(t.garrison.troops) + '</b></div>');
        } else if (t.type === 'city') {
          rows.push('<div class="tt-row" style="color:#c9483a">无将驻守，易遭攻取</div>');
        }
        rows.push('<div class="tt-row">防御力 <b>' + util.num(SG.State.defenseOf(state, t)) + '</b></div>');
      } else {
        rows.push('<div class="tt-row" style="color:#6fae5a">尚未被占领，落脚可购入</div>');
      }
    } else if (t.type === 'farm') {
      rows.push('<div class="tt-row">落脚可获 <b>200</b> 粮</div>');
    } else if (t.type === 'tavern') {
      rows.push('<div class="tt-row">落脚可招募在野名将（看相性）</div>');
    } else if (t.type === 'event' || t.type === 'chance') {
      rows.push('<div class="tt-row">落脚抽取一张' + (t.type === 'event' ? '事件' : '机会') + '卡</div>');
    } else if (t.type === 'start') {
      rows.push('<div class="tt-row">经过或落脚领取俸禄 <b>300</b> 金</div>');
    }
    if (t.region) {
      rows.push('<div class="tt-row">同地域占 <b>3</b> 城以上享联片加成 +' +
        Math.round(SG.data.REGIONS[t.region].bonus * 100) + '%</div>');
    }
    return rows.join('');
  }

  function showTip(t, e) {
    var node = tipEl();
    if (!node) return;
    node.innerHTML = tipHTML(t);
    node.classList.remove('hidden');
    moveTip(e);
  }
  function moveTip(e) {
    var node = tipEl();
    if (!node || node.classList.contains('hidden')) return;
    var x = e.clientX + 16, y = e.clientY + 16;
    var r = node.getBoundingClientRect();
    if (x + r.width > window.innerWidth - 10) x = e.clientX - r.width - 12;
    if (y + r.height > window.innerHeight - 10) y = window.innerHeight - r.height - 10;
    node.style.left = Math.max(6, x) + 'px';
    node.style.top = Math.max(6, y) + 'px';
  }
  function hideTip() { var node = tipEl(); if (node) node.classList.add('hidden'); }

  /* ---------------- 中央信息区 ---------------- */
  function setCenterInfo(html) {
    var n = SG.$('#centerInfo');
    if (n) n.innerHTML = html || '';
  }

  /* 棋盘中央按钮组 */
  function setBoardActions(nodes) {
    var box = SG.$('#boardActions');
    if (!box) return;
    SG.clear(box);
    (nodes || []).forEach(function (n) { box.appendChild(n); });
  }

  /* 供 3D 渲染层（render3d.js）复用的公共部分 + 2D 渲染层本体。
     两者实现完全相同的接口，由 main.js 依据当前视角在二者之间路由。 */
  SG.Board2D = {
    init: init,
    render: render,
    setPiecePos: setPiecePos,
    movePiece: movePiece,
    teleportPiece: teleportPiece,
    focusPiece: focusPiece,
    syncPieces: syncPieces,
    markHere: markHere,
    setDice: setDice,
    rolling: rolling,
    setCenterInfo: setCenterInfo,
    setBoardActions: setBoardActions,
    hideTip: hideTip,
    showTip: showTip,
    moveTip: moveTip,
    tipHTML: tipHTML,
    setState: function (st) { state = st; },
    tileZ: tileZ
  };

})();
