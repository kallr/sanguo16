/* =========================================================
   core.js —— 全局命名空间、工具函数、事件总线、动作队列
   （classic script，无模块，保证 file:// 双击可运行）
   ========================================================= */
(function () {
  'use strict';

  var SG = window.SG = window.SG || {};

  /* ---------------- 常量 ---------------- */
  SG.CONST = {
    BOARD_N: 40,            // 棋盘沿一条闭合路网铺开，共 40 格
    MAX_LEVEL: 5,           // 城池最高等级
    MAX_BUILDINGS: 4,       // 每城建筑槽位（市集/农田/练兵场/护城河 各一）
    TOLL_RATE: 1.2,         // 过路费 = 城池收益 * 等级 * TOLL_RATE
    TROOP_FOOD_COST: 10,    // 每 10 名士兵每回合消耗 1 粮
    SOLDIER_VALUE: 3,       // 结算资产时每名士兵折算金
    CITY_VALUE_RATE: 1.4,   // 结算资产时城池估值倍率
    MOVE_STEP_MS: 130,      // 棋子每走一格耗时
    DICE_MS: 520,           // 骰子动画耗时
    AI_THINK_MS: 420,       // AI 决策思考延时
    SAVE_KEY: 'sg_sanguo_save_v1',
    SETTINGS_KEY: 'sg_sanguo_settings_v1'
  };

  /* 回合阶段枚举 */
  SG.PHASE = {
    IDLE: 'IDLE',
    TURN_START: 'TURN_START',
    ROLL: 'ROLL',
    MOVE: 'MOVE',
    LAND: 'LAND',
    ACTION: 'ACTION',
    END: 'END',
    GAME_OVER: 'GAME_OVER'
  };

  /* 格子类型 */
  SG.TYPE = {
    START: 'start',
    CITY: 'city',
    PASS: 'pass',
    EVENT: 'event',
    CHANCE: 'chance',
    TAVERN: 'tavern',
    FARM: 'farm'
  };

  /* 建筑类型 */
  SG.BUILD = {
    market: { key: 'market', name: '市集', icon: '🏪', desc: '每座 +30% 金收益' },
    farm:   { key: 'farm',   name: '农田', icon: '🌾', desc: '每座 +60 粮收益' },
    drill:  { key: 'drill',  name: '练兵场', icon: '⚔️', desc: '每座 +30 兵员补充，+25% 守城' },
    moat:   { key: 'moat',   name: '护城河', icon: '🛡️', desc: '+35% 守城防御' }
  };
  SG.BUILD_LIST = ['market', 'farm', 'drill', 'moat'];

  /* ---------------- 工具函数 ---------------- */
  var util = SG.util = {
    clamp: function (v, a, b) { return v < a ? a : (v > b ? b : v); },

    randInt: function (min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; },

    rand: function (min, max) { return Math.random() * (max - min) + min; },

    /* 概率命中：p 为 0~1 */
    chance: function (p) { return Math.random() < p; },

    pick: function (arr) { return arr[Math.floor(Math.random() * arr.length)]; },

    shuffle: function (arr) {
      var a = arr.slice();
      for (var i = a.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var t = a[i]; a[i] = a[j]; a[j] = t;
      }
      return a;
    },

    /* 按 weight 字段加权随机 */
    weightedPick: function (arr) {
      var total = 0, i;
      for (i = 0; i < arr.length; i++) total += (arr[i].weight || 1);
      var r = Math.random() * total;
      for (i = 0; i < arr.length; i++) {
        r -= (arr[i].weight || 1);
        if (r <= 0) return arr[i];
      }
      return arr[arr.length - 1];
    },

    /* 从数组中随机取 n 个不重复元素 */
    sample: function (arr, n) {
      return util.shuffle(arr).slice(0, n);
    },

    /* 千分位数字 */
    num: function (v) {
      v = Math.round(v || 0);
      return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    },

    /* 取模（保证非负） */
    mod: function (n, m) { return ((n % m) + m) % m; },

    delay: function (ms) {
      return new Promise(function (res) { setTimeout(res, ms); });
    },

    /* 深拷贝（纯数据对象） */
    clone: function (o) { return JSON.parse(JSON.stringify(o)); },

    /* 取对象若干数值字段之和 */
    sum: function (arr, fn) {
      var t = 0;
      for (var i = 0; i < arr.length; i++) t += fn(arr[i]);
      return t;
    }
  };

  /* ---------------- 事件总线 ---------------- */
  var handlers = {};
  SG.bus = {
    on: function (evt, fn) {
      (handlers[evt] = handlers[evt] || []).push(fn);
      return fn;
    },
    off: function (evt, fn) {
      var list = handlers[evt];
      if (!list) return;
      var i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    emit: function (evt, payload) {
      var list = handlers[evt];
      if (!list) return;
      for (var i = 0; i < list.length; i++) {
        try { list[i](payload); } catch (e) { console.error('[bus] ' + evt, e); }
      }
    }
  };

  /* ---------------- Promise 动作队列（busy 锁） ----------------
     所有会改变状态并需要播放动画的操作都走这里串行执行，
     彻底杜绝“连点骰子/按钮”造成的过程交错。
  ------------------------------------------------------------- */
  var chain = Promise.resolve();
  var busyCount = 0;

  SG.queue = {
    get busy() { return busyCount > 0; },

    /* 把一个异步动作排进队列；返回该动作自身的 Promise */
    run: function (fn) {
      busyCount++;
      SG.bus.emit('busy', true);
      var result = chain.then(function () {
        return fn();
      }).catch(function (err) {
        console.error('[queue] 动作执行出错：', err);
      });
      chain = result.then(function () {
        busyCount = Math.max(0, busyCount - 1);
        if (busyCount === 0) SG.bus.emit('busy', false);
      });
      return result;
    },

    /* 队列空闲时执行 */
    idle: function (fn) { return chain.then(fn); }
  };

  /* ---------------- DOM 小工具 ---------------- */
  SG.$ = function (sel, root) { return (root || document).querySelector(sel); };
  SG.$$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  /* 设置样式：支持 CSS 自定义属性（--x），Object.assign 无法设置它们 */
  function applyStyle(node, obj) {
    Object.keys(obj).forEach(function (p) {
      if (p.indexOf('--') === 0) node.style.setProperty(p, obj[p]);
      else node.style[p] = obj[p];
    });
  }

  /* 创建元素：el('div', {class:'x', text:'hi'}, [childEl...]) */
  SG.el = function (tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined) return;
        if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k === 'style' && typeof v === 'object') applyStyle(node, v);
        else if (k === 'dataset') Object.assign(node.dataset, v);
        else if (k.indexOf('on') === 0 && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v);
      });
    }
    (children || []).forEach(function (c) {
      if (c === null || c === undefined) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  };

  SG.clear = function (node) { while (node.firstChild) node.removeChild(node.firstChild); return node; };

})();
