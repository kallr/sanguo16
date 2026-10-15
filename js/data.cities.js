/* =========================================================
   data.cities.js —— 棋盘格子表
   棋盘为 11x11 外环，共 40 格，按顺时针从底部左端(起点)起编号。
   坐标 x/y 由 board.js 依据索引推算（见 data.tileXY），无需手工维护。
   走向：index 0 → (0,10)，沿底边向右 → 右边向上 → 顶边向左 → 左边向下
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

  /* 由索引推算棋盘坐标（11x11 外环） */
  SG.data.tileXY = function (i) {
    var last = SG.CONST.BOARD_W - 1; // 10
    if (i <= last)        return { x: i,                    y: last };              // 底边 0-10：左→右
    if (i <= 2 * last)    return { x: last,                 y: last - (i - last) }; // 右边 11-20：下→上
    if (i <= 3 * last)    return { x: last - (i - 2 * last), y: 0 };                // 顶边 21-30：右→左
    return { x: 0, y: i - 3 * last };                                              // 左边 31-39：上→下
  };

})();
