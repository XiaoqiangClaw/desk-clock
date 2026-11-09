(function () {
  'use strict';
  window.DeskClock = window.DeskClock || {};

  // Font stacks per choice (custom font wins when font === '__custom__').
  var STACKS = {
    '': null, // follow the style's recommended font
    sans: 'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", Roboto, sans-serif',
    serif: 'Georgia, "Times New Roman", "Songti SC", SimSun, serif',
    mono: '"Cascadia Mono", Consolas, "Courier New", "JetBrains Mono", ui-monospace, monospace',
    rounded: '"Segoe UI Rounded", "Hiragino Maru Gothic ProN", "Yuanti SC", "Microsoft YaHei", sans-serif'
  };

  function fontStack(state) {
    if (state.font === '__custom__') {
      var f = String(state.customFont || '').trim();
      // Guard: no quotes/braces/semicolons escaping the CSS value.
      if (f && !/[;{}<>]/.test(f)) return f;
      return null;
    }
    return STACKS[state.font] || null;
  }

  window.DeskClock.Fonts = { fontStack: fontStack, STACKS: STACKS };
})();
