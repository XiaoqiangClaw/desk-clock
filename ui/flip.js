(function () {
  'use strict';
  window.DeskClock = window.DeskClock || {};

  function reducedMotion() {
    try {
      return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) {
      return false;
    }
  }

  function el(className, parent) {
    var node = document.createElement('div');
    node.className = className;
    if (parent) parent.appendChild(node);
    return node;
  }

  function half(classNames, parent) {
    var node = el(classNames, parent);
    var face = el('flip-face', node);
    return { node: node, face: face };
  }

  function text(h, value) {
    if (h && h.face && h.face.textContent !== String(value)) {
      h.face.textContent = String(value);
    }
  }

  function FlipDigit(mountEl) {
    this.mount = mountEl;
    this.value = '';
    this.target = '';
    this.flipping = false;
    this.fallbackTimer = null;
    this.root = null;

    var root = el('flip', this.mount);
    this.root = root;

    var staticWrap = el('flip-static', root);
    this.staticTop = half('flip-top', staticWrap);
    this.staticBottom = half('flip-bottom', staticWrap);

    el('flip-hinge', root);

    this.animTop = half('flip-anim flip-top', root);
    this.animBottom = half('flip-anim flip-bottom', root);

    var self = this;
    this._onEnd = function (event) {
      if (event && event.target && event.target !== self.animBottom.node && event.target !== self.animTop.node) return;
      self.finish();
    };
    root.addEventListener('animationend', this._onEnd);
  }

  FlipDigit.prototype.applyNow = function (char) {
    this.cancelFallback();
    this.flipping = false;
    this.root.classList.remove('is-flipping');
    this.value = char;
    this.target = char;
    text(this.staticTop, char);
    text(this.staticBottom, char);
    text(this.animTop, char);
    text(this.animBottom, char);
  };

  FlipDigit.prototype.cancelFallback = function () {
    if (this.fallbackTimer !== null) {
      clearTimeout(this.fallbackTimer);
      this.fallbackTimer = null;
    }
  };

  FlipDigit.prototype.finish = function () {
    if (!this.flipping) return;
    this.cancelFallback();
    this.flipping = false;
    this.root.classList.remove('is-flipping');
    this.value = this.target;
    text(this.staticTop, this.value);
    text(this.staticBottom, this.value);
    text(this.animTop, this.value);
    text(this.animBottom, this.value);
  };

  FlipDigit.prototype.set = function (char, animate) {
    char = String(char === undefined || char === null ? ' ' : char).charAt(0) || ' ';

    if (this.flipping) {
      // Converge to the newest value without queueing another animation.
      this.target = char;
      text(this.animBottom, char);
      text(this.staticTop, char);  // will be revealed when the top leaf finishes
      return;
    }
    if (char === this.value) return;

    if (!animate || reducedMotion()) {
      this.applyNow(char);
      return;
    }

    var old = this.value;
    this.target = char;
    this.flipping = true;

    // Static upper half keeps showing the OLD digit until the flipping leaf
    // covers it; swapping it now would flash the new digit for one frame.
    text(this.animTop, old);
    text(this.animBottom, char);
    text(this.staticTop, old);
    text(this.staticBottom, old);

    var self = this;
    this.root.classList.remove('is-flipping');
    void this.root.offsetWidth;
    this.root.classList.add('is-flipping');

    this.cancelFallback();
    this.fallbackTimer = setTimeout(function () { self.finish(); }, 900);
  };

  window.DeskClock.FlipDigit = FlipDigit;
})();
