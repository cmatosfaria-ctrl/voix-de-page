// Page scanning on the device: find the page in a photo, let the reader adjust
// its four corners, then flatten it and even out shadows before OCR.
window.Scan = (() => {
const MAX_SRC = 3200;   // longest side kept from the photo
const OUT_W = 2400;     // width of the flattened page sent to Tesseract

function loadImage(file){
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file); const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); res(img); };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error("image")); };
    img.src = url;
  });
}
function toCanvas(src, rot = 0){
  const sw = src.naturalWidth || src.width, sh = src.naturalHeight || src.height;
  const k = Math.min(1, MAX_SRC / Math.max(sw, sh));
  const w = Math.round(sw*k), h = Math.round(sh*k);
  const c = document.createElement("canvas");
  [c.width, c.height] = rot % 2 ? [h, w] : [w, h];
  const g = c.getContext("2d");
  g.translate(c.width/2, c.height/2); g.rotate(rot * Math.PI/2); g.drawImage(src, -w/2, -h/2, w, h);
  return c;
}
function grayOf(c){
  const {data} = c.getContext("2d").getImageData(0, 0, c.width, c.height);
  const g = new Float32Array(c.width * c.height);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = 0.299*data[j] + 0.587*data[j+1] + 0.114*data[j+2];
  return g;
}
// Box blur through an integral image; r is the half window.
function boxBlur(a, w, h, r){
  const W = w + 1, I = new Float64Array(W * (h + 1));
  for (let y = 0; y < h; y++){
    let row = 0;
    for (let x = 0; x < w; x++){ row += a[y*w + x]; I[(y+1)*W + x + 1] = I[y*W + x + 1] + row; }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++){
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++){
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      out[y*w + x] = (I[y1*W + x1] - I[y0*W + x1] - I[y1*W + x0] + I[y0*W + x0]) / ((y1 - y0) * (x1 - x0));
    }
  }
  return out;
}
function shrink(g, w, h, size){
  const k = size / Math.max(w, h), sw = Math.max(1, Math.round(w*k)), sh = Math.max(1, Math.round(h*k));
  const out = new Float32Array(sw * sh), cnt = new Float32Array(sw * sh);
  for (let y = 0; y < h; y++){
    const sy = Math.min(sh - 1, Math.floor(y * k));
    for (let x = 0; x < w; x++){ const i = sy*sw + Math.min(sw - 1, Math.floor(x * k)); out[i] += g[y*w + x]; cnt[i]++; }
  }
  for (let i = 0; i < out.length; i++) out[i] /= cnt[i] || 1;
  return {g:out, w:sw, h:sh, k};
}
// The page is brighter than what surrounds it at the scale of a few centimetres,
// even under a shadow: keep pixels clearly brighter than their neighbourhood,
// take the largest connected patch and read its four extreme corners.
function detect(c){
  const full = grayOf(c);
  const s = shrink(full, c.width, c.height, 400);
  const mean = boxBlur(s.g, s.w, s.h, Math.round(s.w / 8));
  const n = s.w * s.h, mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) mask[i] = s.g[i] > mean[i] * 1.12 ? 1 : 0;
  const lab = new Int32Array(n), stack = new Int32Array(n);
  let best = 0, bestLab = 0, cur = 0;
  for (let i0 = 0; i0 < n; i0++){
    if (!mask[i0] || lab[i0]) continue;
    cur++; let sp = 0, size = 0; stack[sp++] = i0; lab[i0] = cur;
    while (sp){
      const i = stack[--sp]; size++;
      const x = i % s.w;
      const nb = [x > 0 ? i-1 : -1, x < s.w-1 ? i+1 : -1, i - s.w, i + s.w];
      for (const j of nb) if (j >= 0 && j < n && mask[j] && !lab[j]){ lab[j] = cur; stack[sp++] = j; }
    }
    if (size > best){ best = size; bestLab = cur; }
  }
  const whole = inset(c);
  if (!bestLab) return {quad:whole, found:false};
  let tl = [0,0,Infinity], tr = [0,0,-Infinity], br = [0,0,-Infinity], bl = [0,0,Infinity];
  for (let i = 0; i < n; i++){
    if (lab[i] !== bestLab) continue;
    const x = i % s.w, y = (i / s.w) | 0;
    if (x + y < tl[2]) tl = [x, y, x + y];
    if (x + y > br[2]) br = [x, y, x + y];
    if (x - y > tr[2]) tr = [x, y, x - y];
    if (x - y < bl[2]) bl = [x, y, x - y];
  }
  const quad = [tl, tr, br, bl].map(([x, y]) => [(x + .5) / s.k, (y + .5) / s.k]);
  const area = Math.abs(polyArea(quad)) / (c.width * c.height);
  if (area < 0.2 || !convex(quad)) return {quad:whole, found:false};
  return {quad, found:true};
}
// Whole photo, pulled in a little so the corner handles stay reachable.
function inset(c){ const mx = c.width*0.02, my = c.height*0.02; return [[mx,my],[c.width-mx,my],[c.width-mx,c.height-my],[mx,c.height-my]]; }
function polyArea(q){ let a = 0; for (let i = 0; i < 4; i++){ const [x1,y1] = q[i], [x2,y2] = q[(i+1)%4]; a += x1*y2 - x2*y1; } return a/2; }
function convex(q){
  let sign = 0;
  for (let i = 0; i < 4; i++){
    const [ax,ay] = q[i], [bx,by] = q[(i+1)%4], [cx,cy] = q[(i+2)%4];
    const z = Math.sign((bx-ax)*(cy-by) - (by-ay)*(cx-bx));
    if (!z) continue; if (!sign) sign = z; else if (z !== sign) return false;
  }
  return true;
}
// Homography from the output rectangle to the photo (8 unknowns, Gaussian elimination).
function homography(src, dst){
  const A = [];
  for (let i = 0; i < 4; i++){
    const [x, y] = src[i], [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u*x, -u*y, u]);
    A.push([0, 0, 0, x, y, 1, -v*x, -v*y, v]);
  }
  for (let c = 0; c < 8; c++){
    let p = c; for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < 8; r++){
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 9; k++) A[r][k] -= f * A[c][k];
    }
  }
  return A.map((row, i) => row[8] / row[i]).concat(1);
}
// Flatten the page, then divide by a blurred "paper" background so shadows and
// uneven light disappear, and stretch so the ink is dark.
function rectify(c, quad){
  const d = (a, b) => Math.hypot(a[0]-b[0], a[1]-b[1]);
  const qw = (d(quad[0], quad[1]) + d(quad[3], quad[2])) / 2, qh = (d(quad[0], quad[3]) + d(quad[1], quad[2])) / 2;
  const k = OUT_W / qw, W = Math.round(qw * k), H = Math.round(qh * k);
  const m = Math.round(W * 0.015);            // drop the page edge itself
  const ow = W - 2*m, oh = H - 2*m;
  const M = homography([[0,0],[W,0],[W,H],[0,H]], quad);
  const g = grayOf(c), sw = c.width, sh = c.height;
  const out = new Float32Array(ow * oh);
  for (let y = 0; y < oh; y++){
    const Y = y + m;
    for (let x = 0; x < ow; x++){
      const X = x + m, den = M[6]*X + M[7]*Y + 1;
      let sx = (M[0]*X + M[1]*Y + M[2]) / den, sy = (M[3]*X + M[4]*Y + M[5]) / den;
      sx = Math.min(sw - 1.001, Math.max(0, sx)); sy = Math.min(sh - 1.001, Math.max(0, sy));
      const x0 = sx | 0, y0 = sy | 0, fx = sx - x0, fy = sy - y0, i = y0*sw + x0;
      out[y*ow + x] = g[i]*(1-fx)*(1-fy) + g[i+1]*fx*(1-fy) + g[i+sw]*(1-fx)*fy + g[i+sw+1]*fx*fy;
    }
  }
  const r = Math.max(15, Math.round(ow / 40));
  let bg = boxBlur(out, ow, oh, r);
  const lifted = new Float32Array(out.length);
  for (let i = 0; i < out.length; i++) lifted[i] = Math.max(out[i], bg[i]);
  const bg2 = boxBlur(lifted, ow, oh, r);
  const hist = new Uint32Array(256);
  for (let i = 0; i < out.length; i++){
    const v = Math.min(255, out[i] / Math.max(1, Math.max(bg[i], bg2[i])) * 255);
    out[i] = v; hist[v | 0]++;
  }
  let lo = 0, acc = 0; while (lo < 200 && (acc += hist[lo]) < out.length * 0.02) lo++;
  const res = document.createElement("canvas"); res.width = ow; res.height = oh;
  const ctx = res.getContext("2d"), img = ctx.createImageData(ow, oh);
  for (let i = 0, j = 0; i < out.length; i++, j += 4){
    const v = Math.max(0, Math.min(255, (out[i] - lo) / (250 - lo) * 255));
    img.data[j] = img.data[j+1] = img.data[j+2] = v; img.data[j+3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return res;
}

// Corner editor. Resolves with {canvas, quad} or null when the reader cancels.
function adjust(img, {index, total}){
  return new Promise(resolve => {
    let rot = 0, src = toCanvas(img, rot), {quad, found} = detect(src);
    const bg = document.getElementById("cropBg"), view = document.getElementById("cropView");
    const ctx = view.getContext("2d");
    document.getElementById("cropTitle").textContent = total > 1 ? `Page ${index} sur ${total} : ajustez les coins` : "Ajustez les coins de la page";
    const hint = document.getElementById("cropHint");
    let scale = 1, drag = -1;
    function layout(){
      const box = view.parentElement.getBoundingClientRect();
      scale = Math.min(box.width / src.width, box.height / src.height);
      const dpr = window.devicePixelRatio || 1;
      view.style.width = src.width*scale + "px"; view.style.height = src.height*scale + "px";
      view.width = Math.round(src.width*scale*dpr); view.height = Math.round(src.height*scale*dpr);
      ctx.setTransform(dpr*scale, 0, 0, dpr*scale, 0, 0);
      draw();
    }
    function draw(){
      ctx.drawImage(src, 0, 0);
      ctx.save();
      ctx.fillStyle = "rgba(0,0,0,.45)";
      ctx.beginPath(); ctx.rect(0, 0, src.width, src.height);
      ctx.moveTo(...quad[0]); [1,2,3].forEach(i => ctx.lineTo(...quad[i])); ctx.closePath();
      ctx.fill("evenodd");
      ctx.strokeStyle = "#ffe27a"; ctx.lineWidth = 3/scale;
      ctx.beginPath(); ctx.moveTo(...quad[0]); [1,2,3].forEach(i => ctx.lineTo(...quad[i])); ctx.closePath(); ctx.stroke();
      quad.forEach(([x, y], i) => {
        ctx.beginPath(); ctx.arc(x, y, 16/scale, 0, 7);
        ctx.fillStyle = i === drag ? "#ffe27a" : "rgba(255,226,122,.35)"; ctx.fill();
        ctx.lineWidth = 3/scale; ctx.stroke();
      });
      ctx.restore();
      hint.textContent = found ? "Page trouvée. Faites glisser les coins si besoin." : "Toute la photo sera lue. Faites glisser les coins sur les bords de la page si elle est de biais.";
    }
    const pos = e => { const r = view.getBoundingClientRect(); return [(e.clientX - r.left)/scale, (e.clientY - r.top)/scale]; };
    view.onpointerdown = e => {
      const [x, y] = pos(e); let bestD = 48/scale;
      quad.forEach(([qx, qy], i) => { const dd = Math.hypot(qx-x, qy-y); if (dd < bestD){ bestD = dd; drag = i; } });
      if (drag >= 0){ view.setPointerCapture(e.pointerId); draw(); }
    };
    view.onpointermove = e => {
      if (drag < 0) return;
      const [x, y] = pos(e);
      quad[drag] = [Math.max(0, Math.min(src.width, x)), Math.max(0, Math.min(src.height, y))]; found = true; draw();
    };
    view.onpointerup = view.onpointercancel = () => { drag = -1; draw(); };
    const done = val => { bg.hidden = true; window.removeEventListener("resize", layout); resolve(val); };
    document.getElementById("cropRotate").onclick = () => { rot = (rot + 1) % 4; src = toCanvas(img, rot); ({quad, found} = detect(src)); layout(); };
    document.getElementById("cropAll").onclick = () => { quad = inset(src); found = true; draw(); };
    document.getElementById("cropCancel").onclick = () => done(null);
    document.getElementById("cropOk").onclick = () => {
      if (!convex(quad)){ hint.textContent = "Les coins se croisent : remettez-les dans l'ordre autour de la page."; return; }
      done({canvas: rectify(src, quad), quad});
    };
    bg.hidden = false; window.addEventListener("resize", layout);
    requestAnimationFrame(layout);
  });
}

return {loadImage, toCanvas, detect, rectify, adjust};
})();
