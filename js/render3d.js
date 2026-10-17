/* =========================================================
   render3d.js —— WebGL 三维棋盘渲染层（three.js r147）
   ---------------------------------------------------------
   与 board.js 的 SG.Board2D 实现完全相同的接口，由 main.js
   依据当前视角在两者之间路由，engine / state / ai 完全无感。

   设计要点：
   · 只有地图进 WebGL：草地沙盘、石板路、路上的 40 个格子与建筑、路旁树木、棋子立牌。
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

  var MAP_W = SG.data.MAP_W, MAP_D = SG.data.MAP_D;   // 地图尺寸（世界单位，与 data.cities.js 一致）
  var TILE_W = 0.86;                  // 石板砖边长
  var ROAD_Y = 0.05;                  // 路面高度（地形沿路已凿平，路面略高于路基）
  var TEXW = 128;                     // 石板砖贴图分辨率
  var Z_SCALE = 1 / 65;               // tileZ(px) -> 世界高度
  var VIEW_PAD = 1.08;                // 取景留白系数（已含边缘格子自身的半宽）
  var FONT = '"Microsoft YaHei","PingFang SC","Hiragino Sans GB",sans-serif';

  /* 石板路：所有砖同色，靠轻度染色区分类型（类型主要看路上立的建筑/标志物） */
  var TYPE_TINT = {
    start:  '#c9a24d',
    city:   '#9c917d',
    pass:   '#8f97a2',
    event:  '#a08fb2',
    chance: '#8fae96',
    tavern: '#b09274',
    farm:   '#95a578'
  };

  /* 石板砖：统一灰色石料（类型只靠淡染色 + 路上建筑/标志物区分） */
  var STONE_TOP = '#8d877a';
  var STONE_SIDE = 0x585346;
  var TYPE_NAME = {
    start: '起点', city: '城池', pass: '关隘', event: '事件',
    chance: '机会', tavern: '招贤馆', farm: '农田'
  };

  /* ============ 立体地图（草地沙盘）参数 ============
     地图是一整片缓坡草地，40 个石板格沿一条闭合的巡游路网铺开
     （中原在中部拱行、江东在东、河北在北、巴蜀在西）；
     地形沿路被削平成路基，路外留出草地、土坡、小水塘与树木。
     全部纯代码生成，不加载任何高度图或贴图文件。 */
  var TERRAIN_W = MAP_W + 1.6;    // 沙盘比路网略大一圈
  var TERRAIN_D = MAP_D + 1.6;
  var TERRAIN_SEG = 150;          // 细分段数（三角形数 = 2*SEG*SEG）
  var GRASS_BASE = 0.10;          // 草地基准海拔
  var WATER_Y = 0.018;            // 低于此高度即被水面覆盖（小水塘；须低于路基）
  var ROAD_BED = 0.02;            // 路基：路走廊内的地形削平到这个高度
  var ROAD_FLAT = 0.45;           // 路基平整半径（要盖住路面半宽 0.43）
  var ROAD_HALF = 0.52;           // 路走廊半宽（含两侧短边坡）
  var RIM_IN = 0.88;              // 归一化半径：从这里开始向棋盘底板收边
  var RIM_OUT = 1.0;
  var RIM_LOW = 0.10;             // 收边后保留的高度比例

  /* 缓坡草地：土坡都放在路网外的草带里（中原拱圈内、北侧草带、南侧空地），
     且与格子保持 1.4 以上距离，免得草地漫过砖面 */
  var MOUNDS = [
    { x: -3.6, z: -3.6, r: 1.0, amp: 0.065 },
    { x:  0.0, z: -3.6, r: 1.0, amp: 0.065 },
    { x:  3.5, z: -3.6, r: 1.0, amp: 0.065 },
    { x: -1.3, z:  0.4, r: 1.1, amp: 0.075 },
    { x:  1.4, z: -0.3, r: 1.0, amp: 0.070 },
    { x: -2.1, z:  4.7, r: 1.1, amp: 0.080 },
    { x:  4.2, z:  5.2, r: 0.8, amp: 0.055 },
    { x: -4.3, z: -1.6, r: 0.9, amp: 0.060 },
    { x:  4.5, z: -2.4, r: 0.9, amp: 0.060 }
  ];
  /* 小水塘（原版地图上零星的水面），落在草带里、且避开土坡 */
  var PONDS = [
    { x: -1.6, z: 2.7, r: 0.85, amp: -0.140 },
    { x:  2.6, z: 4.6, r: 0.95, amp: -0.140 },
    { x: -0.6, z: 5.2, r: 0.80, amp: -0.120 }
  ];
  /* 路网折线（含 39→0 的闭合段），用于沿路削平路基 */
  var PATH_PTS = SG.data.pathPoints();
  /* 河流折线（与 2D 底图共用同一套坐标），河床下切到水面以下 */
  var RIVER_PTS = SG.data.riverPoints();
  var RIVER = { bed: 0.004, half: 0.32 };
  /* 一道低矮的东西向土脊，给北侧草带一点线性起伏 */
  var RIDGE = { amp: 0.05, width: 0.5,
    pts: [[-4.4, -3.7], [-1.5, -3.5], [1.5, -3.7], [4.4, -3.5]] };

  /* 海拔 → 草地色（水面另行按水深取色） */
  var LAND_STOPS = [
    [0.02, '#5c7742'], [0.08, '#69884a'], [0.12, '#76954f'],
    [0.17, '#8a9c55'], [0.23, '#9e9a5e']
  ];
  var C_WATER_SHALLOW = new THREE.Color('#5f96a8');
  var C_WATER_DEEP = new THREE.Color('#2f6478');
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
  var camYaw = 0, camPitch = 0.79, camDist = 16, camZoom = 1;   // 默认等角 45° 俯视

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
    return { x: (xy.x / 100 - 0.5) * MAP_W, z: (xy.y / 100 - 0.5) * MAP_D };
  }
  function mod(i) { return SG.util.mod(i, C.BOARD_N); }
  /* 台基高度：所有格子先垫起一个基础厚度（这样即使未被占领也看得出是立体的方块，
     并且高过路外的草地起伏，不会被土坡漫过），城池再按等级往上长，
     与 2D 版 tileZ() 的抬升值保持一致。 */
  function tileHeight(t) { return 0.20 + SG.Board2D.tileZ(t) * Z_SCALE; }
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

  /* 原始地形高度（未收边、未淹水、未削路） */
  function terrainHeight(x, z) {
    var h = GRASS_BASE, i, m, d, u;
    for (i = 0; i < MOUNDS.length; i++) {
      m = MOUNDS[i];
      d = Math.sqrt((x - m.x) * (x - m.x) + (z - m.z) * (z - m.z));
      h += m.amp * Math.exp(-(d * d) / (2 * m.r * m.r));
    }
    for (i = 0; i < PONDS.length; i++) {
      m = PONDS[i];
      d = Math.sqrt((x - m.x) * (x - m.x) + (z - m.z) * (z - m.z)) / m.r;
      if (d < 1) { u = 1 - d * d; h += m.amp * u * u; }   // 碗形水塘
    }
    /* 土脊：一条低矮的南北向起伏 */
    h += RIDGE.amp * Math.exp(-Math.pow(polyDist(x, z, RIDGE.pts), 2) / (2 * RIDGE.width * RIDGE.width));
    /* 河流：先把河床下切到水面以下，路面最后再压过（形成桥） */
    var drv = polyDist(x, z, RIVER_PTS);
    if (drv < RIVER.half) {
      var kr = 1 - smoothstep(RIVER.half * 0.5, RIVER.half, drv);
      h = h * (1 - kr) + RIVER.bed * kr;
    }
    /* 石板路：贴着路中线把地形削平到路基高度，两侧留出短边坡 */
    var dr = polyDist(x, z, PATH_PTS);
    if (dr < ROAD_HALF) {
      var k = 1 - smoothstep(ROAD_FLAT, ROAD_HALF, dr);   // 1 = 路心
      h = h * (1 - k) + ROAD_BED * k;
    }
    return h;
  }

  /* 顶点最终高度：低于水面则压平到水面，靠近沙盘边缘则向底板收边 */
  function terrainVertex(x, z) {
    var h = terrainHeight(x, z);
    if (h < WATER_Y) return { y: WATER_Y, water: true, h0: h };
    var u = Math.max(Math.abs(x) / (TERRAIN_W / 2), Math.abs(z) / (TERRAIN_D / 2));
    var f = 1 - (1 - RIM_LOW) * smoothstep(RIM_IN, RIM_OUT, u);
    return { y: h * f, water: false, h0: h };
  }

  /* 顶点颜色：水面按水深取蓝，草地按海拔取绿 */
  function terrainColor(t, x, z, out) {
    var i, a, b, k;
    if (t.water) {
      k = SG.util.clamp((WATER_Y - t.h0) / 0.03, 0, 1);
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
    return out;
  }

  function buildTerrain() {
    var geo = new THREE.PlaneGeometry(TERRAIN_W, TERRAIN_D, TERRAIN_SEG, TERRAIN_SEG);
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
      quad: new THREE.PlaneGeometry(1, 1),
      sphere: new THREE.SphereGeometry(0.5, 8, 6) // 圆冠树的树冠
    };
  }

  /* 建材共享：同材质只建一次（颜色固定，组成也固定） */
  function mat(kind, ownerColor) {
    var col = { wall: 0xa07440, roof: 0x4e3420, stone: 0x7d7568, rail: 0x8a6a3c,
      wood: 0x6a4a2b, gold: 0xc9a24d, thatch: 0xb08a48 }[kind];
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
  /* 城池：未占领只留一块空地；占领后按规模长成木构小屋群 + 栏杆高台 + 小红旗。
     规模 1~5 对应乡村 / 县城 / 郡城 / 都城 / 王城，房屋越多越大。 */
  function makeCity(t, ownerColor) {
    var g = new THREE.Group();
    var L = t.ownerId ? SG.util.clamp(t.level, 1, 5) : 0;
    var pw = 0.58 + 0.05 * L, pd = 0.46 + 0.04 * L;
    box(g, pw, 0.05, pd, 0, 0, 0, mat('stone'));                 // 高台地基
    if (!L) {
      box(g, 0.05, 0.16, 0.05, 0.14, 0.05, 0.10, mat('wood'));   // 空地界桩
      return g;
    }
    /* 台边栏杆 */
    var i, k;
    for (i = -1; i <= 1; i++) {
      for (k = 0; k < 4; k++) {
        var rx = k < 2 ? i * pw * 0.40 : (k === 2 ? -pw / 2 + 0.03 : pw / 2 - 0.03);
        var rz = k < 2 ? (k === 0 ? -pd / 2 + 0.03 : pd / 2 - 0.03) : i * pd * 0.40;
        box(g, 0.022, 0.09, 0.022, rx, 0.05, rz, mat('rail'));
      }
    }
    /* 房屋：乡村 1 座 → 王城 5 座 */
    var spots = [[0, -0.04], [-0.29, 0.10], [0.29, 0.10], [-0.20, -0.16], [0.20, -0.16]];
    for (i = 0; i < Math.min(L, spots.length); i++) {
      var hw = i === 0 ? 0.18 + 0.015 * L : 0.14;
      var hh = i === 0 ? 0.12 + 0.030 * L : 0.10;
      box(g, hw, hh, hw * 0.86, spots[i][0], 0.05, spots[i][1], mat('wall'));
      roof(g, hw * 1.5, 0.07, spots[i][0], 0.05 + hh, spots[i][1], mat('roof'));
      if (L >= 4 && i === 0) {                                   // 都城 / 王城的主楼加一层
        box(g, hw * 0.62, 0.07, hw * 0.52, spots[i][0], 0.12 + hh, spots[i][1], mat('wall'));
        roof(g, hw * 1.0, 0.05, spots[i][0], 0.19 + hh, spots[i][1], mat('roof'));
      }
    }
    box(g, 0.02, 0.22, 0.02, pw / 2 - 0.05, 0.05, -pd / 2 + 0.06, mat('wood'));
    var f = new THREE.Mesh(GEO.quad, flagMat(0xb0392e));          // 城头小红旗
    f.scale.set(0.09, 0.06, 1);
    f.position.set(pw / 2 - 0.005, 0.23, -pd / 2 + 0.06);
    g.add(f);
    return g;
  }

  /* 关隘：木构关门（两根门柱 + 门楣 + 檐顶），占领后挂势力旗 */
  function makePass(t, ownerColor) {
    var g = new THREE.Group();
    box(g, 0.54, 0.04, 0.32, 0, 0, 0, mat('stone'));
    box(g, 0.09, 0.26, 0.09, -0.20, 0.04, 0, mat('wood'));
    box(g, 0.09, 0.26, 0.09, 0.20, 0.04, 0, mat('wood'));
    box(g, 0.32, 0.09, 0.10, 0, 0.30, 0, mat('wood'));
    roof(g, 0.44, 0.09, 0, 0.39, 0, mat('roof'));
    if (t.ownerId) {
      var f = new THREE.Mesh(GEO.quad, flagMat(ownerColor));
      f.scale.set(0.12, 0.07, 1);
      f.position.set(0.27, 0.32, 0);
      g.add(f);
    }
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
    buildRoad();
    buildScenery();
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
    var ow = TERRAIN_W + 0.6, od = TERRAIN_D + 0.6;
    var lip = new THREE.Mesh(
      new THREE.BoxGeometry(ow, 0.2, od),
      new THREE.MeshLambertMaterial({ color: 0x120f0b })
    );
    lip.position.y = -0.5;
    scene.add(lip);

    var plate = new THREE.Mesh(
      new THREE.BoxGeometry(ow - 0.7, 0.4, od - 0.7),
      new THREE.MeshLambertMaterial({ color: 0x241f18 })
    );
    plate.position.y = -0.2;
    scene.add(plate);
  }

  /* ---------------- 石板路：沿路网铺一条比地块略宽的石板道 ---------------- */
  var SLAB_U = 0.5;               // 一块石板沿路方向的世界长度
  function roadTexture() {
    var cv = document.createElement('canvas');
    cv.width = cv.height = 128;
    var ctx = cv.getContext('2d');
    ctx.fillStyle = '#6f6a5d';
    ctx.fillRect(0, 0, 128, 128);
    ctx.strokeStyle = 'rgba(32,28,22,.6)';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(0.5, 0); ctx.lineTo(0.5, 128); ctx.stroke();      // 石板缝
    ctx.beginPath(); ctx.moveTo(64.5, 0); ctx.lineTo(64.5, 128); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, 20.5); ctx.lineTo(128, 20.5); ctx.stroke();    // 两道路沿
    ctx.beginPath(); ctx.moveTo(0, 106.5); ctx.lineTo(128, 106.5); ctx.stroke();
    for (var i = 0; i < 700; i++) {
      ctx.fillStyle = Math.random() < 0.5 ? 'rgba(255,255,255,.05)' : 'rgba(0,0,0,.07)';
      ctx.fillRect(Math.random() * 128, Math.random() * 128, 2, 2);
    }
    var tx = newTex(cv);
    tx.wrapS = tx.wrapT = THREE.RepeatWrapping;
    return tx;
  }

  function buildRoad() {
    var mat = new THREE.MeshLambertMaterial({ map: roadTexture() });
    var pts = PATH_PTS;
    for (var i = 0; i < pts.length - 1; i++) {
      var a = pts[i], b = pts[i + 1];
      var dx = b[0] - a[0], dz = b[1] - a[1];
      var len = Math.sqrt(dx * dx + dz * dz) + 0.14;
      var geo = new THREE.PlaneGeometry(len, 0.86, 1, 1);
      geo.rotateX(-Math.PI / 2);
      var uv = geo.attributes.uv;
      for (var k = 0; k < uv.count; k++) uv.setX(k, uv.getX(k) * (len / SLAB_U));
      var mesh = new THREE.Mesh(geo, mat);
      mesh.position.set((a[0] + b[0]) / 2, ROAD_Y, (a[1] + b[1]) / 2);
      mesh.rotation.y = -Math.atan2(dz, dx);
      scene.add(mesh);
    }
  }

  /* ---------------- 路旁装饰：圆冠树与旗杆 ---------------- */
  function freeSpot(x, z) {
    if (Math.abs(x) > TERRAIN_W / 2 - 0.35 || Math.abs(z) > TERRAIN_D / 2 - 0.35) return false;
    var i, w, dx, dz;
    for (i = 0; i < C.BOARD_N; i++) {
      w = tileWorld(i);
      dx = w.x - x; dz = w.z - z;
      if (dx * dx + dz * dz < 0.95 * 0.95) return false;    // 别压到格子/路面上
    }
    return !terrainVertex(x, z).water;
  }

  /* 每段路的左右两侧各试 3 个位置，交替种树 / 立旗杆，避开格子与水塘 */
  function buildScenery() {
    var trunkMat = new THREE.MeshLambertMaterial({ color: 0x6b4a2c });
    var leafMat = new THREE.MeshLambertMaterial({ color: 0x4d7a39 });
    var poleMat = new THREE.MeshLambertMaterial({ color: 0x6a4a2b });
    var flagRed = new THREE.MeshLambertMaterial({ color: 0xb0392e, side: THREE.DoubleSide });
    var pts = PATH_PTS, i, k, s;
    for (i = 0; i < pts.length - 1; i++) {
      var a = pts[i], b = pts[i + 1];
      var dx = b[0] - a[0], dz = b[1] - a[1];
      var L = Math.sqrt(dx * dx + dz * dz) || 1;
      var nx = -dz / L, nz = dx / L;                       // 路的法向
      for (k = 0; k < 3; k++) {
        var t = 0.18 + 0.32 * k;
        for (s = -1; s <= 1; s += 2) {
          var seed = i * 3 + k * 5 + (s > 0 ? 1 : 0);
          if (seed % 5 === 4) continue;                   // 留些空位，别铺太满
          var off = (seed % 3 === 1) ? 1.15 : 1.55;
          var qx = a[0] + dx * t + nx * s * off;
          var qz = a[1] + dz * t + nz * s * off;
          if (!freeSpot(qx, qz)) continue;
          var gy = terrainVertex(qx, qz).y;
          if (seed % 3 === 0) {
            /* 旗杆 */
            var pole = new THREE.Mesh(GEO.box, poleMat);
            pole.scale.set(0.03, 0.42, 0.03);
            pole.position.set(qx, gy + 0.21, qz);
            scene.add(pole);
            var fl = new THREE.Mesh(GEO.quad, flagRed);
            fl.scale.set(0.16, 0.10, 1);
            fl.position.set(qx + 0.08, gy + 0.35, qz);
            scene.add(fl);
          } else {
            /* 圆冠树：树干 + 球形树冠 */
            var trunk = new THREE.Mesh(GEO.box, trunkMat);
            trunk.scale.set(0.06, 0.16, 0.06);
            trunk.position.set(qx, gy + 0.08, qz);
            scene.add(trunk);
            var leaf = new THREE.Mesh(GEO.sphere, leafMat);
            var sc = 0.40 + (seed % 3) * 0.08;
            leaf.scale.set(sc, sc * 0.85, sc);
            leaf.position.set(qx, gy + 0.16 + sc * 0.42, qz);
            scene.add(leaf);
          }
        }
      }
    }
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

    /* 石板砖：统一石料 + 按类型轻度染色（类型主要看路上立的建筑/标志物） */
    ctx.fillStyle = STONE_TOP;
    roundRect(ctx, 0, 0, S, S, 14); ctx.fill();
    ctx.globalAlpha = 0.25;
    ctx.fillStyle = TYPE_TINT[t.type] || STONE_TOP;
    roundRect(ctx, 0, 0, S, S, 14); ctx.fill();
    ctx.globalAlpha = 1;
    /* 石板缝 */
    ctx.strokeStyle = 'rgba(40,34,26,.40)';
    ctx.lineWidth = 2;
    for (var sy = 32; sy < S - 8; sy += 32) {
      ctx.beginPath(); ctx.moveTo(10, sy + 0.5); ctx.lineTo(S - 10, sy + 0.5); ctx.stroke();
    }
    ctx.beginPath(); ctx.moveTo(S / 2 + 0.5, 8); ctx.lineTo(S / 2 + 0.5, S - 8); ctx.stroke();
    /* 上亮下暗，做出一点厚度感 */
    var g = ctx.createLinearGradient(0, 0, 0, S);
    g.addColorStop(0, 'rgba(255,255,255,.12)');
    g.addColorStop(1, 'rgba(0,0,0,.22)');
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
    ctx.strokeStyle = owner || 'rgba(56,48,36,.85)';
    roundRect(ctx, 4, 4, S - 8, S - 8, 12); ctx.stroke();
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
        new THREE.MeshLambertMaterial({ color: STONE_SIDE })   // 实际颜色在 refreshTiles 里按类型/归属再定
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

      /* 砖侧：统一石料 + 类型淡染，被占领再压一层势力色 */
      var base = new THREE.Color(STONE_SIDE);
      base.lerp(new THREE.Color(TYPE_TINT[t.type] || STONE_TOP), 0.20);
      if (t.ownerId) base.lerp(new THREE.Color(factionColor(state, t.ownerId)), 0.42);
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

  /* 相机距离自适应画布比例：按当前偏航/俯仰算出地图（含边缘格子）的外接取景框，
     横竖两个方向都刚好容下，避免大片留白 —— 地图填满画布，旋转时也不会跑出画面。 */
  function viewBox() {
    var cy = Math.abs(Math.cos(camYaw)), sy = Math.abs(Math.sin(camYaw));
    return {
      w: (MAP_W * cy + MAP_D * sy) * VIEW_PAD,
      d: (MAP_D * cy + MAP_W * sy) * VIEW_PAD
    };
  }
  function fitDistance() {
    var w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return camDist;
    var tan = Math.tan(camera.fov * Math.PI / 360);
    var vb = viewBox();
    /* 俯仰角越小，地面纵深在画面上被压缩得越厉害，这里按 sin 折算并给下限 */
    var sp = SG.util.clamp(Math.sin(camPitch), 0.5, 1);
    var dH = (vb.d * sp / 2) / tan;
    var dW = (vb.w / 2) / tan / (w / h);
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
      camDist = fitDistance();           // 转动后重新取景，保证地图始终在画面内
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
