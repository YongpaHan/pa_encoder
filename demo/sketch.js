// src/sketch.js (temporary test sketch)
const c = document.createElement("canvas");
c.width = 640;
c.height = 360;
document.body.appendChild(c);

const ctx = c.getContext("2d");

let x = 0;
function loop(t) {
  // rAF timestamp 기반 애니메이션(virtual time에서 결정적으로 진행됨)
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, c.width, c.height);

  ctx.fillStyle = "#111";
  ctx.font = "18px system-ui";
  ctx.fillText(`t=${Math.round(t)}ms`, 16, 28);

  x = (t * 0.12) % (c.width - 40);
  ctx.beginPath();
  ctx.arc(20 + x, c.height / 2, 18, 0, Math.PI * 2);
  ctx.fill();

  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
