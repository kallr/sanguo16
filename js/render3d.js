/* =========================================================
   render3d.js —— WebGL 三维棋盘渲染层（three.js r147）
   ---------------------------------------------------------
   与 board.js 的 SG.Board2D 实现完全相同的接口，由 main.js
   依据当前视角在两者之间路由，engine / state / ai 完全无感。

   设计要点：
   · 只有棋盘几何体进 WebGL：底座、40 个格子方块、棋子立牌。
     中央操作面板 / 弹窗 / 战斗演出 / 侧栏 / tooltip 仍是 DOM 覆层。
   · file:// 下不能用外部图片贴图（会被 CORS 阻断），所有贴图都用
     CanvasTexture 现场绘制（格子顶面 + 棋子令牌）。
   · 悬浮提示沿用 Board2D 的 tipHTML / showTip / hideTip，
     这里只负责用 Raycaster 把命中的格子喂过去。
   ========================================================= */
(function () {
  'use strict';
  var SG = window.SG;
  var C = SG.CONST;
  var THREE = window.THREE;

  var SPAN = C.BOARD_W;               // 棋盘 11 格
  var CELL = 1;                       // 每格 1 世界单位
  var HALF = (SPAN - 1) / 2;          // 格心偏移基数（=5）
  var TILE_W = 0.86;                  // 方块边长（留出缝隙露出底座网格）
  var TEXW = 128;                     // 格子顶面贴图分辨率
  var Z_SCALE = 1 / 65;               // tileZ(px) -> 世界高度
  var VIEW_W = 13.6, VIEW_H = 11.7;   // 期望棋盘占据的画面对应世界范围
  var FONT = '"Microsoft YaHei","PingFang SC","Hiragino Sans GB",sans-serif';

  var TYPE_BG = {
    start:  '#3a2c14',
    city:   '#292019',
    pass:   '#1d2329',
    event:  '#2a1f2c',
    chance: '#1f2a22',
    tavern: '#2e2118',
    farm:   '#1e2a1a'
  };
  var TYPE_BODY = {
    start:  0x3a2c14,
    city:   0x241d16,
    pass:   0x1b2126,
    event:  0x271d29,
    chance: 0x1c2620,
    tavern: 0x2a1e15,
    farm:   0x1b2618
  };
  var TYPE_NAME = {
    start: '起点', city: '城池', pass: '关隘', event: '事件',
    chance: '机会', tavern: '招贤馆', farm: '农田'
  };

  /* ---------------- WebGL 能力检测 ---------------- */
  var _av = null;
  function available() {
    if (_av !== null) return _av;
    if (!THREE) { _av = false; return _av; }
    try {
      var c = document.createElement('canvas');
      _av = !!(window.WebGLRenderingContext &&
        (c.getContext('webgl') || c.getContext('experimental-webgl')));
    } catch (e) { _av = false; }
    return _av;
  }

  /* 先占位，保证 SG.Board3D 在任何情况下都存在 */
  SG.Board3D = { available: available };
  if (!available()) return;

  /* ---------------- 运行态 ---------------- */
  var ready = false;
  var canvas, renderer, scene, camera, raf = null;
  var state = null;
  var tiles = [];                      // index -> { mesh, top, tex, canvas, ctx }
  var pieces = {};                     // factionId -> { sprite, cur, target, off, tex }
  var hoverFrame, hereFrame;
  var hovered = -1, activeFid = null;
  var ray = new THREE.Raycaster();
  var ndc = new THREE.Vector2();
  var drag = null;
  var camYaw = 0, camPitch = 0.86, camDist = 16, camZoom = 1;

  /* ---------------- 小工具 ---------------- */
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function tileWorld(i) {
    var xy = SG.data.tileXY(i);
    return { x: (xy.x - HALF) * CELL, z: (xy.y - HALF) * CELL };
  }
  function mod(i) { return SG.util.mod(i, C.BOARD_N); }
  /* 台基高度：所有格子先垫起一个基础厚度（这样即使未被占领也看得出是立体的方块），
     城池再按等级往上长，与 2D 版 tileZ() 的抬升值保持一致。 */
  function tileHeight(t) { return 0.13 + SG.Board2D.tileZ(t) * Z_SCALE; }
  function factionColor(st, id) {
    var f = st.factions.filter(function (x) { return x.id === id; })[0];
    return f ? f.color : '#8a6bbf';
  }
  function newTex(cv) {
    var tx = new THREE.CanvasTexture(cv);
    tx.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return tx;
  }

  /* ---------------- 场景搭建 ---------------- */
  function setup() {
    canvas = SG.$('#glCanvas');
    if (!canvas) return false;
    try {
      renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });
    } catch (e) { return false; }
    if (!renderer || !renderer.getContext()) return false;
    renderer.setClearColor(0x000000, 0);

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(40, 1, 0.1, 200);

    /* 灯光：环境光打底 + 主光造出立体感 */
    scene.add(new THREE.AmbientLight(0xffffff, 0.78));
    var key = new THREE.DirectionalLight(0xffeecb, 0.85);
    key.position.set(7, 14, 9);
    scene.add(key);
    var fill = new THREE.DirectionalLight(0x88a2d0, 0.35);
    fill.position.set(-9, 7, -8);
    scene.add(fill);

    buildBase();
    buildFrames();

    /* 交互：拖拽环绕、滚轮缩放、悬浮高亮 */
    canvas.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('resize', resize);

    ready = true;
    resize();
    loop();
    return true;
  }

  function buildBase() {
    var outer = SPAN * CELL + 1.6;
    var lip = new THREE.Mesh(
      new THREE.BoxGeometry(outer, 0.2, outer),
      new THREE.MeshLambertMaterial({ color: 0x120f0b })
    );
    lip.position.y = -0.5;
    scene.add(lip);

    var plate = new THREE.Mesh(
      new THREE.BoxGeometry(outer - 0.7, 0.4, outer - 0.7),
      new THREE.MeshLambertMaterial({ color: 0x1b1610 })
    );
    plate.position.y = -0.2;
    scene.add(plate);

    /* 底座顶面的网格线（CanvasTexture 现场绘制，径向渐变 + 11x11 金线） */
    var cv = document.createElement('canvas');
    cv.width = cv.height = 1024;
    var ctx = cv.getContext('2d');
    var g = ctx.createRadialGradient(512, 470, 40, 512, 512, 560);
    g.addColorStop(0, 'rgba(36,29,21,.95)');
    g.addColorStop(0.62, 'rgba(25,20,16,.95)');
    g.addColorStop(1, 'rgba(16,13,10,.95)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 1024, 1024);
    ctx.strokeStyle = 'rgba(217,178,106,.10)';
    ctx.lineWidth = 2;
    for (var k = 0; k <= SPAN; k++) {
      var p = Math.round(k * 1024 / SPAN) + 0.5;
      ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, 1024); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(1024, p); ctx.stroke();
    }
    var grid = new THREE.Mesh(
      new THREE.PlaneGeometry(SPAN * CELL, SPAN * CELL),
      new THREE.MeshBasicMaterial({ map: newTex(cv), transparent: true })
    );
    grid.rotation.x = -Math.PI / 2;
    grid.position.y = 0.004;
    scene.add(grid);
  }

  /* 高亮框：悬浮（金）与当前所在格（脉冲）共用一个白色描边贴图，靠颜色区分 */
  function frameTexture() {
    var cv = document.createElement('canvas');
    cv.width = cv.height = 128;
    var ctx = cv.getContext('2d');
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 9;
    roundRect(ctx, 8, 8, 112, 112, 16);
    ctx.stroke();
    return newTex(cv);
  }

  function buildFrames() {
    var tex = frameTexture();
    hoverFrame = new THREE.Mesh(
      new THREE.PlaneGeometry(TILE_W + 0.1, TILE_W + 0.1),
      new THREE.MeshBasicMaterial({
        map: tex, color: 0xffe9b0, transparent: true, opacity: 0.85, depthWrite: false
      })
    );
    hoverFrame.rotation.x = -Math.PI / 2;
    hoverFrame.visible = false;
    scene.add(hoverFrame);

    hereFrame = new THREE.Mesh(
      new THREE.PlaneGeometry(TILE_W + 0.06, TILE_W + 0.06),
      new THREE.MeshBasicMaterial({
        map: tex, color: 0xd9b26a, transparent: true, opacity: 0.6, depthWrite: false
      })
    );
    hereFrame.rotation.x = -Math.PI / 2;
    hereFrame.visible = false;
    scene.add(hereFrame);
  }

  /* ---------------- 格子 ---------------- */
  function drawTile(t, rec) {
    var ctx = rec.ctx, S = TEXW;
    ctx.clearRect(0, 0, S, S);

    ctx.fillStyle = TYPE_BG[t.type] || '#262019';
    roundRect(ctx, 0, 0, S, S, 14); ctx.fill();

    var g = ctx.createLinearGradient(0, 0, 0, S);
    g.addColorStop(0, 'rgba(255,255,255,.10)');
    g.addColorStop(1, 'rgba(0,0,0,.24)');
    ctx.fillStyle = g;
    roundRect(ctx, 0, 0, S, S, 14); ctx.fill();

    /* 地域色条（贴图左缘 = 镜头左缘） */
    if (t.region) {
      ctx.fillStyle = SG.data.REGIONS[t.region].color;
      roundRect(ctx, 6, 16, 7, S - 32, 3); ctx.fill();
    }

    /* 边框：被占领则用势力色 */
    var owner = t.ownerId ? factionColor(state, t.ownerId) : null;
    ctx.lineWidth = owner ? 5 : 2;
    ctx.strokeStyle = owner || 'rgba(69,55,35,.9)';
    roundRect(ctx, 4, 4, S - 8, S - 8, 12); ctx.stroke();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    var icon = SG.data.TILE_ICON[t.type] || '·';
    ctx.font = '30px ' + FONT;
    ctx.fillStyle = 'rgba(233,220,196,.95)';
    ctx.fillText(icon, S / 2 + 4, 38);

    ctx.font = 'bold 25px ' + FONT;
    ctx.fillStyle = '#e9dcc4';
    ctx.fillText(t.name, S / 2 + 4, 74);

    var sub = '';
    if (t.type === 'city' || t.type === 'pass') {
      sub = t.ownerId ? '' : ('$' + SG.util.num(t.price));
    } else if (t.type === 'farm') {
      sub = '领粮';
    }
    if (!sub && t.ownerId) sub = TYPE_NAME[t.type];
    if (sub) {
      ctx.font = '17px ' + FONT;
      ctx.fillStyle = '#a2967e';
      ctx.fillText(sub, S / 2 + 4, 103);
    }

    /* 归属旗标 + 等级 + 建筑 */
    if (t.ownerId) {
      ctx.fillStyle = owner;
      ctx.beginPath();
      ctx.arc(S - 20, 20, 7, 0, Math.PI * 2);
      ctx.fill();
      if (t.type === 'city') {
        ctx.font = 'bold 17px ' + FONT;
        ctx.fillStyle = '#d9b26a';
        ctx.fillText('Lv' + t.level, S - 26, S - 22);
      }
      if (t.buildings.length) {
        ctx.textAlign = 'left';
        ctx.font = '17px ' + FONT;
        ctx.fillStyle = 'rgba(233,220,196,.8)';
        ctx.fillText(t.buildings.map(function (b) { return SG.BUILD[b].icon; }).join(''), 16, S - 22);
      }
    }
  }

  function buildTiles() {
    state.tiles.forEach(function (t) {
      var w = tileWorld(t.i);
      var rec = {};
      rec.canvas = document.createElement('canvas');
      rec.canvas.width = rec.canvas.height = TEXW;
      rec.ctx = rec.canvas.getContext('2d');
      rec.tex = newTex(rec.canvas);

      rec.mesh = new THREE.Mesh(
        new THREE.BoxGeometry(TILE_W, 1, TILE_W),
        new THREE.MeshLambertMaterial({ color: TYPE_BODY[t.type] || 0x262019 })
      );
      rec.mesh.position.set(w.x, 0, w.z);
      rec.mesh.userData.index = t.i;
      scene.add(rec.mesh);

      rec.top = new THREE.Mesh(
        new THREE.PlaneGeometry(TILE_W, TILE_W),
        new THREE.MeshBasicMaterial({ map: rec.tex })
      );
      rec.top.rotation.x = -Math.PI / 2;
      rec.top.position.set(w.x, 0, w.z);
      scene.add(rec.top);

      tiles[t.i] = rec;
    });
  }

  /* 格子高度 / 归属配色 / 顶面文字，随状态刷新 */
  function refreshTiles() {
    state.tiles.forEach(function (t) {
      var rec = tiles[t.i];
      if (!rec) return;
      var h = tileHeight(t);
      rec.mesh.scale.y = h;
      rec.mesh.position.y = h / 2;
      rec.top.position.y = h + 0.004;

      var base = new THREE.Color(TYPE_BODY[t.type] || 0x262019);
      if (t.ownerId) base.lerp(new THREE.Color(factionColor(state, t.ownerId)), 0.55);
      base.multiplyScalar(t.ownerId ? 0.72 : 0.9);
      rec.mesh.material.color.copy(base);

      drawTile(t, rec);
      rec.tex.needsUpdate = true;
    });
  }

  /* ---------------- 棋子（Sprite 令牌） ---------------- */
  function drawToken(ctx, f) {
    var W = 128, H = 160;
    ctx.clearRect(0, 0, W, H);
    var g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.14, f.color);
    g.addColorStop(1, '#000000');
    ctx.fillStyle = f.color;
    roundRect(ctx, 6, 6, W - 12, H - 12, 26); ctx.fill();
    ctx.fillStyle = g;
    ctx.globalAlpha = 0.45;
    roundRect(ctx, 6, 6, W - 12, H - 12, 26); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = 'rgba(255,255,255,.85)';
    ctx.lineWidth = 5;
    roundRect(ctx, 6, 6, W - 12, H - 12, 26); ctx.stroke();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 64px ' + FONT;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(f.name.charAt(0), W / 2, H / 2 + 4);
  }

  function buildPieces() {
    var list = state.factions;
    list.forEach(function (f, k) {
      var cv = document.createElement('canvas');
      cv.width = 128; cv.height = 160;
      drawToken(cv.getContext('2d'), f);
      var tex = newTex(cv);
      var sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: tex, transparent: true, depthWrite: false
      }));
      /* center 锚在底边，棋子正好“站”在台基上 */
      sprite.center.set(0.5, 0);
      sprite.scale.set(0.78, 0.975, 1);
      var ang = (k / Math.max(1, list.length)) * Math.PI * 2;
      var off = { x: Math.cos(ang) * 0.17, z: Math.sin(ang) * 0.17 };
      sprite.userData.off = off;
      scene.add(sprite);
      pieces[f.id] = {
        sprite: sprite, tex: tex,
        off: off,
        cur: new THREE.Vector3(), target: new THREE.Vector3()
      };
      sprite.visible = !!f.alive;
    });
  }

  /* ---------------- 渲染循环 ---------------- */
  function updateCamera() {
    var cp = Math.cos(camPitch);
    camera.position.set(
      Math.sin(camYaw) * cp * camDist,
      Math.sin(camPitch) * camDist,
      Math.cos(camYaw) * cp * camDist
    );
    camera.lookAt(0, 0.5, 0);
  }

  function loop() {
    if (!ready) return;
    raf = requestAnimationFrame(loop);
    /* 2D 视角下画布被隐藏，跳过渲染避免空耗 */
    if (!canvas.clientWidth) return;
    var now = performance.now() / 1000;

    Object.keys(pieces).forEach(function (fid) {
      var p = pieces[fid];
      /* 位移插值：每格移动走的是 engine 的步进 Promise，这里只做匀速滑行 */
      p.cur.lerp(p.target, 0.24);
      var bob = (fid === activeFid && p.sprite.visible) ? 0.05 * Math.sin(now * 5) : 0;
      p.sprite.position.set(p.cur.x, p.cur.y + bob, p.cur.z);
    });

    if (hereFrame.visible) {
      hereFrame.material.opacity = 0.28 + 0.34 * (0.5 + 0.5 * Math.sin(now * 4));
    }

    updateCamera();
    renderer.render(scene, camera);
  }

  /* 相机距离自适应画布比例：横竖两个方向都刚好容下棋盘，避免大片留白 */
  function fitDistance() {
    var w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return camDist;
    var tan = Math.tan(camera.fov * Math.PI / 360);
    var dH = (VIEW_H / 2) / tan;
    var dW = (VIEW_W / 2) / tan / (w / h);
    return Math.max(dH, dW) * camZoom;
  }

  function resize() {
    var w = canvas.clientWidth || window.innerWidth;
    var h = canvas.clientHeight || window.innerHeight;
    if (!w || !h) return;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    camDist = fitDistance();
  }

  /* ---------------- 交互 ---------------- */
  function onDown(e) {
    drag = { x: e.clientX, y: e.clientY };
    clearHover();
  }
  function onMove(e) {
    if (drag) {
      camYaw -= (e.clientX - drag.x) * 0.006;
      camPitch = SG.util.clamp(camPitch + (e.clientY - drag.y) * 0.004, 0.3, 1.35);
      drag = { x: e.clientX, y: e.clientY };
      return;
    }
    if (!canvas.clientWidth) return;
    /* 用命中测试判断指针是否真的落在画布上（中央面板等覆层之下仍能拾取格子） */
    if (document.elementFromPoint(e.clientX, e.clientY) !== canvas) { clearHover(); return; }
    var t = pick(e);
    if (t) {
      if (t.i !== hovered) {
        hovered = t.i;
        placeFrame(hoverFrame, t.i, 0.006);
        hoverFrame.visible = true;
      }
      SG.Board2D.showTip(t, e);
    } else {
      clearHover();
    }
  }
  function clearHover() {
    if (hovered === -1) return;
    hovered = -1;
    hoverFrame.visible = false;
    SG.Board2D.hideTip();
  }
  function onUp() { drag = null; }
  function onLeave() { clearHover(); }
  function onWheel(e) {
    e.preventDefault();
    camZoom = SG.util.clamp(camZoom * (1 + e.deltaY * 0.0012), 0.6, 2.2);
    camDist = fitDistance();
  }

  function pick(e) {
    var r = canvas.getBoundingClientRect();
    ndc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    ndc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    ray.setFromCamera(ndc, camera);
    var hits = ray.intersectObjects(tileBodies(), false);
    if (!hits.length) return null;
    var idx = hits[0].object.userData.index;
    return state.tiles[idx] || null;
  }
  function tileBodies() {
    var arr = [];
    for (var i = 0; i < C.BOARD_N; i++) if (tiles[i]) arr.push(tiles[i].mesh);
    return arr;
  }
  function placeFrame(mesh, index, lift) {
    var t = state.tiles[mod(index)];
    var w = tileWorld(mod(index));
    mesh.position.set(w.x, tileHeight(t) + lift, w.z);
  }

  /* ---------------- 清场 ---------------- */
  function clearBoard() {
    tiles.forEach(function (rec) {
      if (!rec) return;
      scene.remove(rec.mesh); scene.remove(rec.top);
      rec.mesh.geometry.dispose(); rec.mesh.material.dispose();
      rec.top.geometry.dispose(); rec.top.material.dispose();
      rec.tex.dispose();
    });
    tiles = [];
    Object.keys(pieces).forEach(function (fid) {
      var p = pieces[fid];
      scene.remove(p.sprite);
      p.sprite.material.dispose();
      p.tex.dispose();
    });
    pieces = {};
    hovered = -1;
    activeFid = null;
    hoverFrame.visible = false;
    hereFrame.visible = false;
  }

  /* ---------------- 对外接口（与 SG.Board2D 一致） ---------------- */
  function init(st) {
    state = st;
    if (!ready && !setup()) return false;
    resize();
    clearBoard();
    buildTiles();
    buildPieces();
    refreshTiles();
    state.factions.forEach(function (f) { setPiecePos(f.id, f.pos, true); });
    return true;
  }

  function render() { refreshTiles(); }

  function setPiecePos(fid, index, instant) {
    var p = pieces[fid];
    if (!p) return;
    var i = mod(index);
    var t = state.tiles[i];
    var w = tileWorld(i);
    p.target.set(w.x + p.off.x, tileHeight(t) + 0.05, w.z + p.off.z);
    if (instant) {
      p.cur.copy(p.target);
      p.sprite.position.copy(p.target);
    }
  }

  function movePiece(fid, from, steps) {
    var dir = steps >= 0 ? 1 : -1;
    var n = Math.abs(steps);
    var cur = mod(from);
    var path = [];
    return new Promise(function (resolve) {
      var i = 0;
      function step() {
        if (i >= n) { resolve({ end: cur, path: path }); return; }
        cur = mod(cur + dir);
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

  function teleportPiece(fid, index) { setPiecePos(fid, index); markHere(index); }

  function focusPiece(fid) { activeFid = fid; }

  function syncPieces() {
    state.factions.forEach(function (f) {
      var p = pieces[f.id];
      if (p) p.sprite.visible = !!f.alive;
    });
  }

  function markHere(index) {
    if (index === null || index === undefined) {
      hereFrame.visible = false;
      return;
    }
    placeFrame(hereFrame, index, 0.006);
    hereFrame.visible = true;
  }

  SG.Board3D = {
    available: available,
    init: init,
    render: render,
    setPiecePos: setPiecePos,
    movePiece: movePiece,
    teleportPiece: teleportPiece,
    focusPiece: focusPiece,
    syncPieces: syncPieces,
    markHere: markHere,
    /* 骰子 / 中央信息区 / 提示气泡都是 DOM 覆层，直接复用 2D 层的实现 */
    setDice: function (v, h) { SG.Board2D.setDice(v, h); },
    rolling: function (on, h) { SG.Board2D.rolling(on, h); },
    setCenterInfo: function (html) { SG.Board2D.setCenterInfo(html); },
    setBoardActions: function (nodes) { SG.Board2D.setBoardActions(nodes); },
    hideTip: function () { SG.Board2D.hideTip(); },
    tipHTML: function (t) { return SG.Board2D.tipHTML(t); }
  };

})();
