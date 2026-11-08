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
        if (self.running) {
          self._resumeOnVisible = true;
          self.stop();
        }
      } else if (self._resumeOnVisible) {
        self._resumeOnVisible = false;
        self.start();
      }
    };
  }

  Engine.prototype.buildParts = function (now) {
    var h = now.getHours();
    if (this.hour12) {
      h = h % 12;
      if (h === 0) h = 12;
    }
    var m = now.getMinutes();
    var s = now.getSeconds();

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

  Engine.prototype.emit = function (now) {
    this.onTick({ parts: this.buildParts(now), now: now });
  };

  // Align to absolute epoch boundaries so timer drift never accumulates.
  // Wake ALIGN_GUARD ms early to absorb scheduler jitter, then verify crossing.
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

    // If we woke before the true boundary (early guard), wait out the remainder.
    if (Date.now() < this.target) {
      var remain = this.target - Date.now();
      var self = this;
      this.timer = setTimeout(function () { self.tick(); }, Math.max(1, remain));
      return;
    }

    this.emit(new Date());
    this.schedule();
  };

  Engine.prototype.start = function () {
    if (this.running) return;
    if (!this._listenerAdded) {
      document.addEventListener('visibilitychange', this._onVisibility);
      this._listenerAdded = true;
    }
    this.running = true;
    this.emit(new Date());
    this.schedule();
  };

  Engine.prototype.stop = function () {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  };

  Engine.prototype.setOptions = function (patch) {
    if (patch && typeof patch === 'object') {
      if (patch.showSeconds !== undefined) this.showSeconds = !!patch.showSeconds;
      if (patch.hour12 !== undefined) this.hour12 = !!patch.hour12;
      if (patch.animate !== undefined) this.animate = !!patch.animate;
      if (typeof patch.onTick === 'function') this.onTick = patch.onTick;
    }
    if (!this.running) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.emit(new Date());
    this.schedule();
  };

  window.DeskClock.Engine = Engine;
})();
