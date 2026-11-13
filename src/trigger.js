// 트리거 띠: 마우스가 올라오면 패널을 펼친다
(function () {
  'use strict';
  function open() { window.jj.expand(); }
  document.addEventListener('mouseenter', open);
  document.addEventListener('mousemove', open);
  document.addEventListener('mousedown', function () {
    window.jj.expand();
    window.jj.focus();
  });
})();
