/* =========================================================
   data.cities.js —— 棋盘格子表
   地图是《富甲天下2》那种「路网铺满地图」的形状：5 列 x 8 行的
   蛇形石板路，共 40 格，格序沿路推进（奇数行反向），
   最后一格在西侧，与索引 0 之间由一条西侧回路闭合。
   坐标 x/y 由索引推算（见 data.tileXY），无需手工维护。
   ========================================================= */
(function () {
  'use strict';
  var SG = window.SG = window.SG || {};
  SG.data = SG.data || {};

  /* 地域：中原 / 河北 / 江东 / 巴蜀 */
  SG.data.REGIONS = {
    zhongyuan: { key: 'zhongyuan', name: '中原', color: '#b5473f', bonus: 0.15 },
    hebei:     { key: 'hebei',     name: '河北', color: '#4a7ab5', bonus: 0.15 },
    jiangdong: { key: 'jiangdong', name: '江东', color: '#3f8f6f', bonus: 0.15 },
    bashu:     { key: 'bashu',     name: '巴蜀', color: '#8a6bbf', bonus: 0.15 }
  };

  function T(i, name, type, region, price, income) {
    return { i: i, name: name, type: type, region: region || null, price: price || 0, income: income || 0 };
  }

  /* 40 格布局 */
  SG.data.TILES = [
    /* ---- 底边（中原）0-10 ---- */
    T(0,  '起点',   'start',  null,       0,   0),
    T(1,  '洛阳',   'city',   'zhongyuan', 800, 120),
    T(2,  '虎牢关', 'pass',   'zhongyuan', 520, 60),
    T(3,  '陈留',   'city',   'zhongyuan', 450, 70),
    T(4,  '许昌',   'city',   'zhongyuan', 620, 92),
    T(5,  '事件',   'event',  null,       0,   0),
    T(6,  '濮阳',   'city',   'zhongyuan', 400, 60),
    T(7,  '农田',   'farm',   null,       0,   0),
    T(8,  '汝南',   'city',   'zhongyuan', 380, 55),
    T(9,  '宛城',   'city',   'zhongyuan', 480, 75),
    T(10, '机会',   'chance', null,       0,   0),

    /* ---- 右边（江东）11-19 ---- */
    T(11, '合肥',   'city',   'jiangdong', 520, 78),
    T(12, '柴桑',   'city',   'jiangdong', 500, 75),
    T(13, '濡须口', 'pass',   'jiangdong', 520, 60),
    T(14, '庐江',   'city',   'jiangdong', 440, 66),
    T(15, '建业',   'city',   'jiangdong', 780, 120),
    T(16, '事件',   'event',  null,       0,   0),
    T(17, '吴郡',   'city',   'jiangdong', 560, 85),
    T(18, '农田',   'farm',   null,       0,   0),
    T(19, '会稽',   'city',   'jiangdong', 480, 70),

    /* ---- 顶边（巴蜀）20-30 ---- */
    T(20, '机会',   'chance', null,       0,   0),
    T(21, '汉中',   'city',   'bashu',     520, 80),
    T(22, '梓潼',   'city',   'bashu',     400, 60),
    T(23, '事件',   'event',  null,       0,   0),
    T(24, '成都',   'city',   'bashu',     820, 130),
    T(25, '农田',   'farm',   null,       0,   0),
    T(26, '永安',   'city',   'bashu',     450, 65),
    T(27, '江州',   'city',   'bashu',     430, 64),
    T(28, '雒城',   'city',   'bashu',     420, 62),
    T(29, '事件',   'event',  null,       0,   0),
    T(30, '招贤馆', 'tavern', null,       0,   0),

    /* ---- 左边（河北）31-39 ---- */
    T(31, '邺城',   'city',   'hebei',     700, 105),
    T(32, '平原',   'city',   'hebei',     420, 62),
    T(33, '农田',   'farm',   null,       0,   0),
    T(34, '南皮',   'city',   'hebei',     480, 72),
    T(35, '晋阳',   'city',   'hebei',     520, 78),
    T(36, '事件',   'event',  null,       0,   0),
    T(37, '蓟城',   'city',   'hebei',     560, 82),
    T(38, '招贤馆', 'tavern', null,       0,   0),
    T(39, '易京',   'city',   'hebei',     440, 66)
  ];

  /* 类型 → 显示图标 */
  SG.data.TILE_ICON = {
    start:  '🚩',
    city:   '🏯',
    pass:   '⛩️',
    event:  '📜',
    chance: '❓',
    tavern: '🍶',
    farm:   '🌾'
  };

  /* ---- 地图尺寸与路网（2D 与 3D 两个渲染层共用同一套坐标） ---- */
  SG.data.MAP_W = 10.6;           // 地图宽（世界单位，渲染层用；2D 只用它的比例）
  SG.data.MAP_D = 9.4;            // 地图深（世界单位）
  SG.data.PATH_COLS = 10;         // 蛇形路网的列数
  SG.data.PATH_ROWS = 4;          // 行数（10 x 4 = 40 格）
  SG.data.COL_X = [5, 15, 25, 35, 45, 55, 65, 75, 85, 95];   // 每列中心（% 横向）
  SG.data.ROW_Y = [14, 38, 62, 86];                          // 每行中心（% 纵向，向下为正）

  /* 由索引推算格子坐标（%）：蛇形推进，奇数行反向 */
  SG.data.tileXY = function (i) {
    var n = SG.util.mod(i, SG.CONST.BOARD_N);
    var r = Math.floor(n / SG.data.PATH_COLS);
    var c = n % SG.data.PATH_COLS;
    if (r % 2 === 1) c = SG.data.PATH_COLS - 1 - c;   // 奇数行自右向左
    return { x: SG.data.COL_X[c], y: SG.data.ROW_Y[r] };
  };

  /* 路径闭合：最后一格(西侧)回到起点，形成棋盘外圈的那段回路 */
  SG.data.pathPoints = function () {
    var pts = [], i;
    for (i = 0; i < SG.CONST.BOARD_N; i++) {
      var xy = SG.data.tileXY(i);
      pts.push([(xy.x / 100 - 0.5) * SG.data.MAP_W, (xy.y / 100 - 0.5) * SG.data.MAP_D]);
    }
    pts.push(pts[0].slice());        // 39 → 0 的回路
    return pts;
  };

  /* 河流走向（世界坐标，3D 沙盘与 2D 底图共用）：自西向东蜿蜒在中部草带里 */
  SG.data.riverPoints = function () {
    return [[-5.2, 0.25], [-3.6, -0.15], [-1.8, 0.30], [0.2, -0.35],
      [2.2, 0.15], [4.2, -0.25], [5.2, 0.10]];
  };

})();
