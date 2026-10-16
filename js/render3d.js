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

  /* ============ 立体地图（地形沙盘）参数 ============
     棋盘外环 40 格照旧，外环以内 9x9 的空地做成程序化地形浮雕：
     山脉/丘陵走向对着四条边对应的地域（上=巴蜀、左=河北、右=江东、下=中原），
     低于 WATER_Y 的地方"淹"成水面（长江/黄河/江东水乡）。
     全部纯代码生成，不加载任何高度图或贴图文件。 */
  var TERRAIN_SIZE = 9.0;         // 沙盘边长（世界单位，正好铺满外环以内）
  var TERRAIN_SEG = 120;          // 细分段数（三角形数 = 2*SEG*SEG）
  var TERRAIN_BASE = 0.105;       // 平原基准海拔
  var WATER_Y = 0.075;            // 水面高度：地形低于此值即被水面覆盖
  var RIM_IN = 3.90;              // 从这个半径开始向棋盘底板收边
  var RIM_OUT = 4.50;             // 沙盘边缘（此处高度压到贴近底板）
  var RIM_LOW = 0.10;             // 收边后保留的高度比例

  /* 山脉/丘陵：中心走向折线 + 振幅 + 半宽（半宽收窄到 0.6~0.85，
     起伏只集中在各自那一条带上，中间与东侧留出平川）。
     取各条山脊的最大值而非累加，避免山脊交叠处堆得过高。 */
  var RIDGES = [
    { amp: 0.30, width: 0.62,                       // 巴蜀山地（远端）
      pts: [[-3.6, -2.4], [-2.2, -3.3], [-0.4, -3.0], [1.2, -3.5], [2.4, -3.05]] },
    { amp: 0.19, width: 0.70,                       // 河北丘陵（左侧）
      pts: [[-2.2, 2.8], [-3.2, 1.0], [-2.8, -0.8], [-3.4, -2.2]] },
    { amp: 0.055, width: 0.85,                      // 中原土丘
      pts: [[-1.3, 1.3], [0.5, 0.8]] }
  ];

  /* 江东水乡：东侧整片压低成低洼水网（x 两端都收口，避免水贴到棋盘边缘） */
  var EAST_DIP = { amp: 0.038, x0: 0.8, x1: 3.0, x2: 3.7, x3: 4.2, z0: 3.4, z1: 4.4 };
  /* 湖底凹地：叠在低洼之上，形成更深的几片水 */
  var BASINS = [
    { x: 2.6, z: 0.4, r: 1.7, amp: -0.030 },
    { x: 3.2, z: -1.7, r: 1.2, amp: -0.026 }
  ];
  var RIVER = { a: [-1.7, 2.3], b: [3.6, 3.1], bed: 0.030, half: 0.50 };

  /* 高度 → 地表色（水面另行按水深取色） */
  var LAND_STOPS = [
    [0.02, '#4a5240'], [0.10, '#55603c'], [0.16, '#616b41'],
    [0.24, '#7c7146'], [0.32, '#8d7c58'], [0.42, '#a89e86']
  ];
  var C_WATER_SHALLOW = new THREE.Color('#46768a');
  var C_WATER_DEEP = new THREE.Color('#22485c');
  /* 地域染色：让四条边各有各的地貌气质 */
  var REGION_TINTS = [
    { test: function (x, z) { return z < -1.4; }, color: new THREE.Color('#8a6b4a'), k: 0.16 }, // 巴蜀：土黄
    { test: function (x, z) { return x < -1.4; }, color: new THREE.Color('#46583a'), k: 0.14 }, // 河北：青绿
    { test: function (x, z) { return x > 1.4; },  color: new THREE.Color('#3a5a4c'), k: 0.16 }, // 江东：水绿
    { test: function (x, z) { return z > 1.4; },  color: new THREE.Color('#6d6238'), k: 0.16 }  // 中原：黄土
  ];
  var _tmpColor = new THREE.Color();

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
  var canvas, renderer, scene, camera, raf = null, labelBox = null;
  var _proj = new THREE.Vector3();
  var _box3 = new THREE.Box3();
  var state = null;
  var tiles = [];                      // index -> { mesh, top, tex, canvas, ctx }
  var pieces = {};                     // factionId -> { sprite, cur, target, off, tex }
  var hoverFrame, hereFrame;
  var hovered = -1, activeFid = null, hereIdx = -1;
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

  /* ---------------- 立体地形（程序化 heightmap） ----------------
     世界坐标约定与格子一致：x 向右为江东、x 向左为河北、
     z 向镜头（屏幕下方）为中原、z 远离镜头（屏幕上方）为巴蜀。
  ---------------------------------------------------------------- */
  function smoothstep(e0, e1, x) {
    var t = SG.util.clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
  }

  /* 点到线段的距离 */
  function segDist(px, pz, a, b) {
    var vx = b[0] - a[0], vz = b[1] - a[1];
    var wx = px - a[0], wz = pz - a[1];
    var L2 = vx * vx + vz * vz;
    var t = L2 ? SG.util.clamp((wx * vx + wz * vz) / L2, 0, 1) : 0;
    var dx = wx - t * vx, dz = wz - t * vz;
    return Math.sqrt(dx * dx + dz * dz);
  }

  /* 点到折线（山脊走向线）的最短距离 */
  function polyDist(x, z, pts) {
    var best = Infinity;
    for (var i = 0; i < pts.length - 1; i++) {
      var d = segDist(x, z, pts[i], pts[i + 1]);
      if (d < best) best = d;
    }
    return best;
  }

  /* 原始地形高度（未收边、未淹水） */
  function terrainHeight(x, z) {
    var h = TERRAIN_BASE, i;
    var relief = 0;
    for (i = 0; i < RIDGES.length; i++) {
      var r = RIDGES[i];
      var d = polyDist(x, z, r.pts);
      var v = r.amp * Math.exp(-(d * d) / (2 * r.width * r.width));
      if (v > relief) relief = v;   // 取最大值，山脊交叠处不会叠加过高
    }
    h += relief;

    for (i = 0; i < BASINS.length; i++) {
      var b = BASINS[i];
      var dx = x - b.x, dz = z - b.z;
      var u = Math.sqrt(dx * dx + dz * dz) / b.r;
      if (u < 1) { var w = 1 - u * u; h += b.amp * w * w; }   // 碗形凹陷
    }

    /* 江东水乡：东侧整片压低成低洼水网 */
    var sx = smoothstep(EAST_DIP.x0, EAST_DIP.x1, x) * (1 - smoothstep(EAST_DIP.x2, EAST_DIP.x3, x));
    var sz = 1 - smoothstep(EAST_DIP.z0, EAST_DIP.z1, Math.abs(z));
    h -= EAST_DIP.amp * sx * sz;

    /* 黄河：靠近河道中心线时把地面压到河床高度 */
    var dr = segDist(x, z, RIVER.a, RIVER.b);
    var rw = 1 - smoothstep(0, RIVER.half, dr);
    h = h * (1 - rw) + RIVER.bed * rw;
    return h;
  }

  /* 顶点最终高度：低于水面则压平到水面，靠近棋盘边缘则向底板收边 */
  function terrainVertex(x, z) {
    var h = terrainHeight(x, z);
    if (h < WATER_Y) return { y: WATER_Y, water: true, h0: h };
    var u = Math.max(Math.abs(x), Math.abs(z));
    var f = 1 - (1 - RIM_LOW) * smoothstep(RIM_IN, RIM_OUT, u);
    return { y: h * f, water: false, h0: h };
  }

  /* 顶点颜色：水面按水深取蓝，陆地按海拔取色再按地域染色 */
  function terrainColor(t, x, z, out) {
    var i, a, b, k;
    if (t.water) {
      k = SG.util.clamp((WATER_Y - t.h0) / 0.045, 0, 1);
      return out.copy(C_WATER_SHALLOW).lerp(C_WATER_DEEP, k);
    }
    out.set(LAND_STOPS[0][1]);
    for (i = 1; i < LAND_STOPS.length; i++) {
      if (t.y <= LAND_STOPS[i][0]) {
        a = LAND_STOPS[i - 1]; b = LAND_STOPS[i];
        k = SG.util.clamp((t.y - a[0]) / (b[0] - a[0]), 0, 1);
        out.set(a[1]).lerp(_tmpColor.set(b[1]), k);
        break;
      }
      out.set(LAND_STOPS[i][1]);
    }
    for (i = 0; i < REGION_TINTS.length; i++) {
      if (REGION_TINTS[i].test(x, z)) { out.lerp(REGION_TINTS[i].color, REGION_TINTS[i].k); break; }
    }
    return out;
  }

  function buildTerrain() {
    var geo = new THREE.PlaneGeometry(TERRAIN_SIZE, TERRAIN_SIZE, TERRAIN_SEG, TERRAIN_SEG);
    var pos = geo.attributes.position;
    var colors = new Float32Array(pos.count * 3);
    var col = new THREE.Color();
    /* PlaneGeometry 在局部 XY 平面：局部 x = 世界 x，局部 y = -世界 z，局部 z 稍后旋转成世界 y */
    for (var i = 0; i < pos.count; i++) {
      var wx = pos.getX(i), wz = -pos.getY(i);
      var t = terrainVertex(wx, wz);
      pos.setZ(i, t.y);
      terrainColor(t, wx, wz, col);
      colors[i * 3] = col.r;
      colors[i * 3 + 1] = col.g;
      colors[i * 3 + 2] = col.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    geo.rotateX(-Math.PI / 2);   // 让局部 z（高度）变成世界 y
    var mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
    scene.add(mesh);
  }

  /* ============ 城池建筑 ============
     《富甲天下2》的地图上每座城池都立着建筑，规模从「乡村」一路长到「王城」。
     这里用 Box / Cylinder / Cone 程序化拼微缩建筑：等级越高体量越大、构件越多，
     占领后染上势力色；其余格子各给一个小标志物。全部纯代码生成，无外部模型。 */
  var CITY_TIER = ['乡村', '县城', '郡城', '都城', '王城'];
  var BUILD_OFF_Z = -0.14;    // 建筑立在格面靠里的半幅，给近处的名字让位
  var GEO = null;
  var matCache = {};

  function buildGeos() {
    GEO = {
      box: new THREE.BoxGeometry(1, 1, 1),
      pyr: new THREE.ConeGeometry(0.5, 1, 4),     // 四棱锥：中式四坡顶
      quad: new THREE.PlaneGeometry(1, 1)
    };
  }

  /* 建材共享：同材质只建一次（颜色固定，组成也固定） */
  function mat(kind, ownerColor) {
    var col = { wall: 0x8f8266, roof: 0x7b4636, stone: 0x6d6558,
      wood: 0x6a4a2b, gold: 0xc9a24d, thatch: 0xa08a4e }[kind];
    if (kind === 'owner') col = ownerColor;
    var key = kind + '|' + col;
    if (!matCache[key]) matCache[key] = new THREE.MeshLambertMaterial({ color: col });
    return matCache[key];
  }
  function flagMat(color) {
    var key = 'flag|' + color;
    if (!matCache[key]) {
      matCache[key] = new THREE.MeshLambertMaterial({ color: color, side: THREE.DoubleSide });
    }
    return matCache[key];
  }

  /* 长方体（底面贴地，方便往上层叠） */
  function box(g, w, h, d, x, y, z, material) {
    var m = new THREE.Mesh(GEO.box, material);
    m.scale.set(w, h, d);
    m.position.set(x, y + h / 2, z);
    g.add(m);
    return m;
  }
  /* 四坡屋顶 */
  function roof(g, w, h, x, y, z, material) {
    var m = new THREE.Mesh(GEO.pyr, material);
    m.scale.set(w, h, w);
    m.position.set(x, y + h / 2, z);
    m.rotation.y = Math.PI / 4;
    g.add(m);
    return m;
  }
  /* 旗杆 + 势力色旗面 */
  function banner(g, poleH, x, y, z, color) {
    box(g, 0.02, poleH, 0.02, x, y, z, mat('wood'));
    var f = new THREE.Mesh(GEO.quad, flagMat(color));
    f.scale.set(0.11, 0.07, 1);
    f.position.set(x + 0.055, y + poleH - 0.04, z);
    g.add(f);
  }

  /* 城池：未占领只留一块空地地基；占领后按规模等级长成城堡 */
  function makeCity(t, ownerColor) {
    var g = new THREE.Group();
    var L = t.ownerId ? SG.util.clamp(t.level, 1, 5) : 0;
    if (!L) {
      box(g, 0.50, 0.045, 0.40, 0, 0, 0, mat('stone'));
      box(g, 0.05, 0.20, 0.05, 0.15, 0.045, 0.10, mat('wood'));
      return g;
    }
    var r = 0.20 + 0.016 * L;                 // 城墙半径
    var wh = 0.055 + 0.022 * L;               // 城墙高
    var kh = 0.05 + 0.05 * L;                 // 主楼高
    var w = mat('wall'), rf = L >= 4 ? mat('owner', ownerColor) : mat('roof');
    box(g, r * 2, wh, 0.045, 0, 0, -r, w);
    box(g, r * 2, wh, 0.045, 0, 0, r, w);
    box(g, 0.045, wh, r * 2, -r, 0, 0, w);
    box(g, 0.045, wh, r * 2, r, 0, 0, w);
    /* 角楼数量随规模增加（王城再加一座中段楼） */
    var towers = [[-r, -r], [r, -r], [-r, r], [r, r], [0, -r], [0, r]];
    for (var i = 0; i < Math.min(L, towers.length); i++) {
      var c = towers[i];
      box(g, 0.10, wh * 2.2, 0.10, c[0], 0, c[1], w);
      roof(g, 0.155, 0.075, c[0], wh * 2.2, c[1], rf);
    }
    /* 主楼；郡城以上再加一层 */
    box(g, 0.17, kh, 0.17, 0, 0, 0.01, w);
    roof(g, 0.26, 0.10, 0, kh, 0.01, rf);
    if (L >= 3) {
      box(g, 0.11, kh * 0.5, 0.11, 0, kh + 0.10, 0.01, w);
      roof(g, 0.17, 0.07, 0, kh * 1.5 + 0.10, 0.01, rf);
    }
    banner(g, 0.20 + 0.04 * L, 0.13, kh, -0.07, ownerColor);
    return g;
  }

  /* 关隘：未占领是残关＋横梁；占领后是关楼 */
  function makePass(t, ownerColor) {
    var g = new THREE.Group();
    if (!t.ownerId) {
      box(g, 0.09, 0.16, 0.09, -0.18, 0, 0, mat('stone'));
      box(g, 0.09, 0.16, 0.09, 0.18, 0, 0, mat('stone'));
      box(g, 0.46, 0.05, 0.09, 0, 0.16, 0, mat('stone'));
      return g;
    }
    box(g, 0.10, 0.30, 0.10, -0.20, 0, 0, mat('stone'));
    box(g, 0.10, 0.30, 0.10, 0.20, 0, 0, mat('stone'));
    roof(g, 0.16, 0.07, -0.20, 0.30, 0, mat('roof'));
    roof(g, 0.16, 0.07, 0.20, 0.30, 0, mat('roof'));
    box(g, 0.26, 0.18, 0.07, 0, 0, -0.03, mat('stone'));
    roof(g, 0.32, 0.08, 0, 0.18, -0.03, mat('roof'));
    banner(g, 0.18, 0, 0.26, -0.12, ownerColor);
    return g;
  }

  /* 农田：谷仓 + 两垄田 */
  function makeFarm() {
    var g = new THREE.Group();
    box(g, 0.20, 0.12, 0.20, -0.10, 0, -0.06, mat('thatch'));
    roof(g, 0.26, 0.09, -0.10, 0.12, -0.06, mat('roof'));
    box(g, 0.28, 0.02, 0.04, 0.11, 0, 0.12, mat('wood'));
    box(g, 0.28, 0.02, 0.04, 0.11, 0, 0.22, mat('wood'));
    return g;
  }

  /* 招贤馆：小楼 + 酒旗 */
  function makeTavern() {
    var g = new THREE.Group();
    box(g, 0.22, 0.14, 0.16, -0.04, 0, 0, mat('wood'));
    roof(g, 0.30, 0.10, -0.04, 0.14, 0, mat('roof'));
    box(g, 0.02, 0.26, 0.02, 0.16, 0, -0.10, mat('wood'));
    var f = new THREE.Mesh(GEO.quad, flagMat(0xc9a24d));
    f.scale.set(0.10, 0.09, 1);
    f.position.set(0.215, 0.20, -0.10);
    g.add(f);
    return g;
  }

  /* 事件 / 机会：木牌（颜色区分） */
  function makeSign(color) {
    var g = new THREE.Group();
    box(g, 0.03, 0.20, 0.03, 0, 0, 0, mat('wood'));
    var head = new THREE.Mesh(GEO.box, flagMat(color));
    head.scale.set(0.20, 0.14, 0.03);
    head.position.set(0, 0.27, 0);
    head.rotation.z = 0.06;
    g.add(head);
    return g;
  }

  /* 起点：大旗 */
  function makeStart() {
    var g = new THREE.Group();
    box(g, 0.05, 0.36, 0.05, -0.06, 0, 0, mat('wood'));
    box(g, 0.34, 0.05, 0.26, 0, 0, 0, mat('stone'));
    var f = new THREE.Mesh(GEO.quad, flagMat(0xb0392e));
    f.scale.set(0.20, 0.13, 1);
    f.position.set(0.04, 0.32, 0);
    g.add(f);
    return g;
  }

  function makeBuilding(t, ownerColor) {
    switch (t.type) {
      case 'city': return makeCity(t, ownerColor);
      case 'pass': return makePass(t, ownerColor);
      case 'farm': return makeFarm();
      case 'tavern': return makeTavern();
      case 'event': return makeSign(0xc9a24d);
      case 'chance': return makeSign(0x7fb0c9);
      case 'start': return makeStart();
      default: return new THREE.Group();
    }
  }

  function setup() {
    canvas = SG.$('#glCanvas');
    if (!canvas) return false;
    labelBox = SG.$('#tileLabels');
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

    buildGeos();
    buildBase();
    buildTerrain();
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

    /* 城池 / 关隘：上半天画一片地砖，像城内的院落（3D 建筑就立在这片地上）。
       格名与规模改由浮在建筑上方的名牌（DOM）显示，不会被建筑挡住。 */
    if (t.type === 'city' || t.type === 'pass') {
      ctx.strokeStyle = 'rgba(233,220,196,.10)';
      ctx.lineWidth = 1;
      for (var gy = 14; gy < 80; gy += 13) {
        ctx.beginPath(); ctx.moveTo(12, gy); ctx.lineTo(S - 12, gy); ctx.stroke();
      }
      for (var gx = 12; gx < S - 10; gx += 13) {
        ctx.beginPath(); ctx.moveTo(gx, 10); ctx.lineTo(gx, 78); ctx.stroke();
      }
    }
  }

  /* ---------------- 城池名牌（DOM 覆层，浮在建筑上方） ---------------- */
  function labelHTML(t) {
    var sub = '', i;
    if (t.ownerId) {
      sub = t.type === 'city' ? CITY_TIER[SG.util.clamp(t.level, 1, 5) - 1] : TYPE_NAME[t.type];
      for (i = 0; i < t.buildings.length; i++) sub += ' ' + SG.BUILD[t.buildings[i]].icon;
    } else if (t.type === 'city' || t.type === 'pass') {
      sub = '$' + SG.util.num(t.price);
    } else if (t.type === 'farm') {
      sub = '领粮';
    } else if (t.type === 'tavern') {
      sub = '可招募';
    } else if (t.type === 'start') {
      sub = '俸禄 300';
    }
    return '<b>' + t.name + '</b>' + (sub ? '<i>' + sub + '</i>' : '');
  }

  /* 名牌显示策略：与往常一样只在需要时出现，避免 40 块牌子挤成一片
     —— 悬浮中的格子、当前所在格一定显示；镜头拉近到格子够大时全显示。 */
  function updateLabels() {
    var w = canvas.clientWidth, h = canvas.clientHeight, i, rec, vis;
    if (!w || !h) return;
    var dist = camera.position.length();
    var pxUnit = h / (2 * Math.tan(camera.fov * Math.PI / 360) * dist);
    var showAll = pxUnit * TILE_W >= 58;         // 放大到每格约 58px 以上才全部铺开
    for (i = 0; i < C.BOARD_N; i++) {
      rec = tiles[i];
      if (!rec || !rec.label) continue;
      vis = showAll || rec.i === hovered || rec.i === hereIdx;
      _proj.copy(rec.labelPos).project(camera);
      if (!vis || _proj.z > 1 || _proj.x < -1.3 || _proj.x > 1.3 || _proj.y < -1.3 || _proj.y > 1.3) {
        if (rec.label.style.display !== 'none') rec.label.style.display = 'none';
        continue;
      }
      rec.label.style.display = '';
      rec.label.style.transform = 'translate(-50%,-100%) translate(' +
        Math.round((_proj.x * 0.5 + 0.5) * w) + 'px,' + Math.round((-_proj.y * 0.5 + 0.5) * h) + 'px)';
      rec.label.style.zIndex = String(500 - Math.round(_proj.z * 100));
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

      /* 建筑挂在格子顶上，归属/规模变化时才重建 */
      rec.bld = new THREE.Group();
      rec.bld.position.set(w.x, 0, w.z + BUILD_OFF_Z);
      rec.bldSig = '';
      rec.bldH = 0.3;
      rec.labelPos = new THREE.Vector3(w.x, 0.6, w.z);
      scene.add(rec.bld);

      /* 名牌：DOM 覆层，飘在建筑上方 */
      if (labelBox) {
        rec.label = document.createElement('div');
        rec.label.className = 'tile-label';
        labelBox.appendChild(rec.label);
      }

      tiles[t.i] = rec;
    });
  }

  /* 建筑：只在「类型 + 归属 + 规模 + 建筑数」变化时重建，避免每帧重建网格 */
  function refreshBuilding(rec, t, topY) {
    rec.bld.position.y = topY + 0.004;
    var sig = t.type + '|' + (t.ownerId || 0) + '|' + (t.ownerId ? t.level : 0) + '|' + t.buildings.length;
    if (sig !== rec.bldSig) {
      rec.bldSig = sig;
      for (var i = rec.bld.children.length - 1; i >= 0; i--) rec.bld.remove(rec.bld.children[i]);
      var color = t.ownerId ? new THREE.Color(factionColor(state, t.ownerId)).getHex() : 0xffffff;
      rec.bld.add(makeBuilding(t, color));
      /* 量出建筑实际高度：名牌要飘在它上面，才不会被自己或邻格的建筑挡住 */
      _box3.setFromObject(rec.bld);
      rec.bldH = Math.max(0.14, _box3.max.y - rec.bld.position.y);
    }
    rec.labelPos.set(rec.bld.position.x, rec.bld.position.y + rec.bldH + 0.13, rec.bld.position.z);
    if (rec.label) {
      rec.label.innerHTML = labelHTML(t);
      rec.label.style.borderColor = t.ownerId ? factionColor(state, t.ownerId) : 'rgba(217,178,106,.45)';
    }
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

      refreshBuilding(rec, t, h);
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
    camera.updateMatrixWorld();
    updateLabels();
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
      if (rec.bld) scene.remove(rec.bld);
      if (rec.label && rec.label.parentNode) rec.label.parentNode.removeChild(rec.label);
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
      hereIdx = -1;
      hereFrame.visible = false;
      return;
    }
    hereIdx = mod(index);
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
