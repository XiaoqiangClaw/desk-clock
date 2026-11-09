(function () {
  'use strict';
  window.DeskClock = window.DeskClock || {};

  var ALIGN_GUARD = 20;

  function pad2(n) {
    return n < 10 ? '0' + String(n) : String(n);
  }

  function Engine(opts) {
    opts = opts || {};
    this.onTick = typeof opts.onTick === 'function' ? opts.onTick : function () {};
    // v0.4: 可选的「墙上时间」provider，用于多时区窗口。默认本机时间。
    this.now = typeof opts.now === 'function' ? opts.now : function () { return new Date(); };
    this.showSeconds = opts.showSeconds === undefined ? true : !!opts.showSeconds;
    this.hour12 = !!opts.hour12;
    this.animate = opts.animate === undefined ? true : !!opts.animate;

    this.running = false;
    this.timer = null;
    this.target = 0;
    this._resumeOnVisible = false;
    this._listenerAdded = false;

    var self = this;
    this._onVisibility = function () {
      if (document.hidden) {
        if (self.running) { self._resumeOnVisible = true; self.stop(); }
      } else if (self._resumeOnVisible) {
        self._resumeOnVisible = false; self.start();
      }
    };
  }

  Engine.prototype.buildParts = function (now) {
    var h = now.getHours();
    if (this.hour12) { h = h % 12; if (h === 0) h = 12; }
    var m = now.getMinutes();
    var s = now.getSeconds();

    // 分隔符 ":" 始终生成为 sep 槽位；是否显示由 CSS 的 data-show-sep
    // 控制（隐藏时把两个点设为透明，但槽位仍占位 → 保留时分秒间距）。
    var str = pad2(h) + ':' + pad2(m) + (this.showSeconds ? ':' + pad2(s) : '');
    var parts = [];
    var dIdx = 0;
    var sepIdx = 0;
    var i, ch;
    for (i = 0; i < str.length; i++) {
      ch = str.charAt(i);
      if (ch === ':') {
        parts.push({ type: 'sep', value: ':', key: 'sep' + sepIdx });
        sepIdx++;
      } else {
        parts.push({ type: 'digit', value: ch, key: 'd' + dIdx });
        dIdx++;
      }
    }
    return parts;
  };

  Engine.prototype.emit = function () {
    var now = this.now();
    this.onTick({ parts: this.buildParts(now), now: now });
  };

  // Align to absolute epoch boundaries so timer drift never accumulates.
  // 多时区 provider 只是对同一 epoch 做平移，边界对齐仍然正确。
  Engine.prototype.schedule = function () {
    if (!this.running) return;
    var t = Date.now();
    var interval = this.showSeconds ? 1000 : 60000;
    var boundary = Math.floor(t / interval) * interval + interval;
    this.target = boundary;
    var wake = boundary - ALIGN_GUARD;
    var delay = Math.max(0, wake - Date.now());

    var self = this;
    this.timer = setTimeout(function () { self.tick(); }, delay);
  };

  Engine.prototype.tick = function () {
    if (!this.running) return;
    if (Date.now() < this.target) {
      var remain = this.target - Date.now();
      var self = this;
      this.timer = setTimeout(function () { self.tick(); }, Math.max(1, remain));
      return;
    }
    this.emit();
    this.schedule();
  };

  Engine.prototype.start = function () {
    if (this.running) return;
    if (!this._listenerAdded) {
      document.addEventListener('visibilitychange', this._onVisibility);
      this._listenerAdded = true;
    }
    this.running = true;
    this.emit();
    this.schedule();
  };

  Engine.prototype.stop = function () {
    this.running = false;
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
  };

  Engine.prototype.setOptions = function (patch) {
    if (patch && typeof patch === 'object') {
      if (patch.showSeconds !== undefined) this.showSeconds = !!patch.showSeconds;
      if (patch.hour12 !== undefined) this.hour12 = !!patch.hour12;
      if (patch.animate !== undefined) this.animate = !!patch.animate;
      if (typeof patch.now === 'function') this.now = patch.now;
      if (typeof patch.onTick === 'function') this.onTick = patch.onTick;
    }
    if (!this.running) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.emit();
    this.schedule();
  };

  window.DeskClock.Engine = Engine;
})();
