(() => {
const $ = id => document.getElementById(id);
const LANGS = {fr:"Français",de:"Deutsch",en:"English",es:"Español",it:"Italiano",pt:"Português"};
// ISO 639-1 → Tesseract traineddata names shipped in /lang
const TESS = {fr:"fra",de:"deu",en:"eng",es:"spa",it:"ita",pt:"por"};
const store = {
  get(k, d){ try { const v = localStorage.getItem("vdp:"+k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v){ try { localStorage.setItem("vdp:"+k, JSON.stringify(v)); } catch {} }
};

const EXAMPLE = {
  id:"exemple", example:true, title:"Exemple : lettre bilingue", created:Date.now(),
  blocks:[
    {type:"heading", lang:"fr", text:"Chère Anna,"},
    {type:"text", lang:"fr", text:"Merci pour ton livre ! Je l'ai photographié page par page pour l'écouter dans le train. La voix suit chaque mot, et je peux toucher une phrase pour reprendre la lecture à cet endroit."},
    {type:"text", lang:"de", text:"Liebe Grüße aus Basel. Morgen fahre ich weiter nach Zürich, und ich freue mich schon auf das nächste Kapitel."},
    {type:"text", lang:"fr", text:"Quand un texte change de langue, l'application change de voix toute seule. Et tout se passe sur la tablette, même sans internet."}
  ]
};

let docs = store.get("docs", []);
let cur = null;           // current doc
let sents = [];           // [{text, lang, el, words}]
let idx = 0, playing = false, gen = 0;
let rate = store.get("rate", 1);
let size = store.get("size", 1.3);
let voicePref = store.get("voices", {});
let follow = store.get("follow", true);
let online = store.get("online", false);
let theme = store.get("theme", "");
let ocrLangs = store.get("ocrLangs", ["fr","de"]);
let wakeLock = null;

document.documentElement.style.setProperty("--size", size+"rem");
if (theme) document.documentElement.setAttribute("data-theme", theme);
$("themeSel").value = theme;
$("optFollow").checked = follow;
$("optOnline").checked = online;

/* ---------- Voices ---------- */
const synth = window.speechSynthesis;
let voices = [];
function loadVoices(){ voices = synth ? synth.getVoices() : []; renderVoiceFields(); updateVoiceBtn(); }
if (synth){ loadVoices(); synth.onvoiceschanged = loadVoices; }
function score(v){
  const n = v.name.toLowerCase(); let s = 0;
  if (/natural|neural|premium|enhanced|amélior|siri/.test(n)) s += 5;
  if (v.localService) s += 3;
  if (v.default) s += 1;
  return s;
}
function voicesFor(lang){
  return voices.filter(v => v.lang.toLowerCase().replace("_","-").startsWith(lang) && (online || v.localService))
    .sort((a,b)=>score(b)-score(a));
}
function voiceFor(lang){
  const list = voicesFor(lang);
  return list.find(v => v.voiceURI === voicePref[lang]) || list[0] || null;
}
function docLangs(){
  const set = new Set((cur?.blocks||[]).map(b=>b.lang).filter(Boolean));
  ocrLangs.forEach(l => set.add(l));
  return [...set];
}
function renderVoiceFields(){
  const box = $("voiceFields"); box.textContent = "";
  docLangs().forEach(lang => {
    const list = voicesFor(lang);
    const f = document.createElement("div"); f.className = "field";
    const lab = document.createElement("label"); lab.className = "label"; lab.htmlFor = "voice-"+lang;
    lab.textContent = "Voix " + (LANGS[lang] || lang.toUpperCase());
    const sel = document.createElement("select"); sel.id = "voice-"+lang;
    if (!list.length){ sel.add(new Option(online ? "Aucune voix installée pour cette langue" : "Aucune voix hors ligne : installez-en une dans les réglages", "")); sel.disabled = true; }
    list.forEach(v => sel.add(new Option(v.name + (v.localService ? "" : " (en ligne)"), v.voiceURI)));
    const chosen = voiceFor(lang); if (chosen) sel.value = chosen.voiceURI;
    sel.onchange = () => { voicePref[lang] = sel.value; store.set("voices", voicePref); updateVoiceBtn(); if (playing) speakFrom(idx); };
    const test = document.createElement("button"); test.className = "btn"; test.textContent = "Écouter un essai";
    test.disabled = !list.length;
    test.onclick = () => {
      stop();
      const u = new SpeechSynthesisUtterance({fr:"Bonjour, voici ma voix.", de:"Guten Tag, so klinge ich.", es:"Hola, esta es mi voz.", it:"Ciao, questa è la mia voce.", pt:"Olá, esta é a minha voz."}[lang] || "Hello, this is my voice.");
      u.lang = lang; const v = voiceFor(lang); if (v){ u.voice = v; u.lang = v.lang; } u.rate = rate; synth.speak(u);
    };
    f.append(lab, sel, test); box.append(f);
  });
}
function updateVoiceBtn(){
  const lang = sents[idx]?.lang || cur?.blocks?.[0]?.lang || "fr";
  const v = voiceFor(lang);
  $("voiceBtn").textContent = v ? v.name.replace(/\s*\(.*\)$/,"").split(" ").slice(0,2).join(" ") : "Voix";
}

/* ---------- Text model ---------- */
function splitSentences(text, lang){
  if (window.Intl && Intl.Segmenter){
    return [...new Intl.Segmenter(lang, {granularity:"sentence"}).segment(text)].map(s=>s.segment).filter(s=>s.trim());
  }
  return text.match(/[^.!?…]+[.!?…]+["»)\]]*\s*|[^.!?…]+$/g) || [text];
}
function render(){
  const art = $("text"); art.textContent = ""; sents = [];
  $("example").hidden = !cur?.example;
  $("docTitle").textContent = cur ? cur.title : "Voix de page";
  if (!cur) return;
  let lastLang = null;
  cur.blocks.forEach(b => {
    const el = document.createElement(b.type === "heading" ? "h3" : "p");
    if (b.lang && lastLang !== null && b.lang !== lastLang){
      const tag = document.createElement("span"); tag.className = "lang"; tag.textContent = b.lang.toUpperCase(); el.append(tag);
    }
    lastLang = b.lang;
    if (b.conf != null && b.conf < 70) el.title = "Reconnaissance incertaine : touchez le crayon pour corriger";
    splitSentences(b.text, b.lang || "fr").forEach(t => {
      const sp = document.createElement("span"); sp.textContent = t;
      sp.className = "s" + (b.conf != null && b.conf < 70 ? " low" : ""); const i = sents.length; sp.dataset.i = i;
      sents.push({text:t, lang:b.lang || "fr", el:sp});
      el.append(sp);
    });
    art.append(el);
  });
  idx = Math.min(store.get("pos:"+cur.id, 0), Math.max(0, sents.length-1));
  mark(idx, false); renderVoiceFields(); updateVoiceBtn();
}
$("text").addEventListener("click", e => {
  const s = e.target.closest(".s"); if (!s) return;
  speakFrom(+s.dataset.i);
});

function wrapWords(s){
  if (s.words) return;
  s.el.textContent = ""; s.words = [];
  const re = /\S+/g; let m, last = 0;
  while ((m = re.exec(s.text))){
    if (m.index > last) s.el.append(s.text.slice(last, m.index));
    const w = document.createElement("span"); w.className = "w"; w.textContent = m[0];
    s.el.append(w); s.words.push({start:m.index, end:m.index+m[0].length, el:w});
    last = m.index + m[0].length;
  }
  if (last < s.text.length) s.el.append(s.text.slice(last));
}
function hlWord(s, charIndex){
  s.words?.forEach(w => w.el.classList.toggle("hl", charIndex >= w.start && charIndex < w.end));
}
function mark(i, scroll = true){
  document.querySelectorAll(".s.cur").forEach(e => e.classList.remove("cur"));
  document.querySelectorAll(".w.hl").forEach(e => e.classList.remove("hl"));
  const s = sents[i]; if (!s) { progress(); return; }
  s.el.classList.add("cur");
  if (scroll && follow){
    const box = $("scroll").getBoundingClientRect(), r = s.el.getBoundingClientRect();
    if (r.top < box.top + 40 || r.bottom > box.bottom - 60) s.el.scrollIntoView({block:"center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"});
  }
  progress();
}
function words(t){ return (t.match(/\S+/g)||[]).length; }
function progress(){
  const n = sents.length;
  $("barFill").style.width = n ? (idx/n*100)+"%" : "0";
  const left = sents.slice(idx).reduce((a,s)=>a+words(s.text),0);
  const min = Math.round(left / (160*rate));
  $("meta").textContent = n ? `${idx+1} / ${n} · ${min < 1 ? "< 1" : min} min` : "Rien à lire";
  if (cur) store.set("pos:"+cur.id, idx);
}

/* ---------- Playback ---------- */
function setPlayIcon(){
  $("playIco").innerHTML = playing ? '<path d="M6 4h4v16H6zM14 4h4v16h-4z"/>' : '<path d="M7 4v16l13-8z"/>';
  $("play").setAttribute("aria-label", playing ? "Pause" : "Lire");
}
async function keepAwake(on){
  try {
    if (on && navigator.wakeLock && !wakeLock) wakeLock = await navigator.wakeLock.request("screen");
    if (!on && wakeLock){ await wakeLock.release(); wakeLock = null; }
  } catch { wakeLock = null; }
}
function speakFrom(i){
  if (!synth){ status("La synthèse vocale n'est pas disponible dans ce navigateur. Essayez Chrome ou Safari.", true); return; }
  if (!sents.length) return;
  idx = Math.max(0, Math.min(i, sents.length-1));
  const my = ++gen; synth.cancel();
  playing = true; setPlayIcon(); keepAwake(true);
  const s = sents[idx]; wrapWords(s); mark(idx);
  const u = new SpeechSynthesisUtterance(s.text);
  u.lang = s.lang; const v = voiceFor(s.lang); if (v){ u.voice = v; u.lang = v.lang; }
  u.rate = rate;
  u.onboundary = e => { if (my === gen && e.name !== "sentence") hlWord(s, e.charIndex); };
  u.onend = () => {
    if (my !== gen) return;
    if (idx + 1 < sents.length) speakFrom(idx + 1);
    else { playing = false; setPlayIcon(); keepAwake(false); mark(idx, false); $("barFill").style.width = "100%"; }
  };
  u.onerror = e => { if (my !== gen || e.error === "interrupted" || e.error === "canceled") return; playing = false; setPlayIcon(); status("La voix s'est arrêtée (" + e.error + "). Touchez Lire pour reprendre.", true); };
  synth.speak(u);
  updateVoiceBtn();
}
function stop(){ gen++; if (synth) synth.cancel(); playing = false; setPlayIcon(); keepAwake(false); }
$("play").onclick = () => playing ? stop() : speakFrom(idx);
$("prev").onclick = () => playing ? speakFrom(idx-1) : (idx = Math.max(0, idx-1), mark(idx));
$("next").onclick = () => playing ? speakFrom(idx+1) : (idx = Math.min(sents.length-1, idx+1), mark(idx));
$("bar").onclick = e => { const r = e.currentTarget.getBoundingClientRect(); const i = Math.floor((e.clientX - r.left) / r.width * sents.length); playing ? speakFrom(i) : (idx = Math.max(0,Math.min(sents.length-1,i)), mark(idx)); };
document.addEventListener("keydown", e => {
  if (e.target.matches("textarea,input,select")) return;
  if (e.code === "Space"){ e.preventDefault(); $("play").click(); }
  if (e.code === "ArrowRight") $("next").click();
  if (e.code === "ArrowLeft") $("prev").click();
});
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && playing) keepAwake(true); });

/* ---------- Settings ---------- */
const fmtRate = r => "×" + r.toFixed(1).replace(".", ",");
function applyRate(){
  $("rateBtn").textContent = fmtRate(rate); $("rateVal").textContent = fmtRate(rate);
  $("wpm").textContent = "≈ " + Math.round(160*rate) + " mots/min"; $("rate").value = rate; progress();
}
applyRate();
$("rate").oninput = () => { rate = +$("rate").value; store.set("rate", rate); applyRate(); };
$("rate").onchange = () => { if (playing) speakFrom(idx); };
const RATES = [0.8,1,1.2,1.5,1.8,2.2];
$("rateBtn").onclick = () => { rate = RATES.find(r => r > rate + 0.01) || RATES[0]; store.set("rate", rate); applyRate(); if (playing) speakFrom(idx); };
const openSheet = () => { renderVoiceFields(); $("sheetBg").hidden = false; };
$("voiceBtn").onclick = openSheet; $("settingsBtn").onclick = openSheet;
$("sheetClose").onclick = () => $("sheetBg").hidden = true;
$("sheetBg").onclick = e => { if (e.target === $("sheetBg")) $("sheetBg").hidden = true; };
$("optFollow").onchange = () => { follow = $("optFollow").checked; store.set("follow", follow); };
$("optOnline").onchange = () => { online = $("optOnline").checked; store.set("online", online); renderVoiceFields(); updateVoiceBtn(); };
$("themeSel").onchange = () => { theme = $("themeSel").value; store.set("theme", theme); theme ? document.documentElement.setAttribute("data-theme", theme) : document.documentElement.removeAttribute("data-theme"); };
$("bigger").onclick = () => { size = Math.min(2.4, size + 0.1); store.set("size", size); document.documentElement.style.setProperty("--size", size+"rem"); };
$("smaller").onclick = () => { size = Math.max(0.9, size - 0.1); store.set("size", size); document.documentElement.style.setProperty("--size", size+"rem"); };
$("openRail").onclick = () => { $("rail").classList.add("open"); $("closeRail").hidden = false; };
const closeRail = () => { $("rail").classList.remove("open"); $("closeRail").hidden = true; };
$("closeRail").onclick = closeRail;

function renderOcrLangs(){
  const box = $("ocrLangs"); box.textContent = "";
  Object.entries(LANGS).forEach(([code, name]) => {
    const lab = document.createElement("label"); lab.className = "chip";
    const cb = document.createElement("input"); cb.type = "checkbox"; cb.id = "ocr-"+code; cb.checked = ocrLangs.includes(code);
    cb.onchange = () => {
      ocrLangs = Object.keys(LANGS).filter(c => $("ocr-"+c).checked);
      if (!ocrLangs.length){ ocrLangs = [code]; cb.checked = true; }
      store.set("ocrLangs", ocrLangs); resetWorker();
    };
    lab.append(cb, name); box.append(lab);
  });
}
renderOcrLangs();

/* ---------- Library ---------- */
function allDocs(){ return [...docs].sort((a,b)=>b.created-a.created).concat(EXAMPLE); }
function renderLib(){
  const ul = $("lib"); ul.textContent = "";
  allDocs().forEach(d => {
    const li = document.createElement("li"); if (cur && d.id === cur.id) li.className = "on";
    const b = document.createElement("button"); b.className = "open";
    const t = document.createElement("span"); t.className = "t"; t.textContent = d.title;
    const langs = [...new Set(d.blocks.map(x=>x.lang).filter(Boolean))].map(l=>l.toUpperCase()).join(" · ");
    const m = document.createElement("span"); m.className = "m";
    m.textContent = (d.example ? "Exemple" : new Date(d.created).toLocaleDateString("fr-FR",{day:"numeric",month:"short"})) + (langs ? " · " + langs : "") + " · " + d.blocks.reduce((a,x)=>a+words(x.text),0) + " mots";
    b.append(t, m); b.onclick = () => { openDoc(d); closeRail(); };
    li.append(b);
    if (!d.example){
      const del = document.createElement("button"); del.className = "del"; del.setAttribute("aria-label", "Supprimer " + d.title); del.textContent = "✕";
      del.onclick = () => {
        if (del.dataset.armed){ docs = docs.filter(x => x.id !== d.id); store.set("docs", docs); if (cur?.id === d.id) openDoc(allDocs()[0]); else renderLib(); }
        else { del.dataset.armed = 1; del.textContent = "Supprimer ?"; setTimeout(()=>{ if (del.isConnected){ delete del.dataset.armed; del.textContent = "✕"; } }, 3000); }
      };
      li.append(del);
    }
    ul.append(li);
  });
}
function openDoc(d){ stop(); cur = d; status(""); $("thumbs").hidden = true; $("pasteBox").hidden = true; editing = null; render(); renderLib(); $("scroll").scrollTop = 0; }
function saveDoc(d){ docs.push(d); store.set("docs", docs); openDoc(d); }

function status(msg, isErr = false, pct = null){
  const box = $("statusBox"); box.textContent = "";
  if (!msg) return;
  const d = document.createElement("div"); d.className = "status" + (isErr ? " err" : "");
  if (pct !== null){ const sp = document.createElement("span"); sp.className = "spin"; d.append(sp); }
  const t = document.createElement("span"); t.textContent = msg; d.append(t);
  if (pct !== null){ const p = document.createElement("span"); p.className = "prog"; const i = document.createElement("i"); i.style.width = Math.round(pct*100)+"%"; p.append(i); d.append(p); }
  box.append(d);
}

/* ---------- Paste and edit ---------- */
let editing = null; // doc being corrected
function textToBlocks(raw){
  return raw.split(/\n\s*\n/).map(p => p.replace(/\s*\n\s*/g," ").trim()).filter(Boolean)
    .map(p => ({type:"text", lang:guessLang(p), text:p}));
}
$("pasteBtn").onclick = () => {
  stop(); closeRail(); editing = null;
  $("pasteLabel").textContent = "Votre texte"; $("pasteOk").textContent = "Ajouter à la bibliothèque";
  $("pasteBox").hidden = false; $("text").textContent = ""; $("example").hidden = true; $("docTitle").textContent = "Nouveau texte";
  $("pasteText").value = ""; $("pasteText").focus();
};
$("editBtn").onclick = () => {
  if (!cur || cur.example) return;
  stop(); editing = cur;
  $("pasteLabel").textContent = "Corrigez le texte (une ligne vide sépare les paragraphes)"; $("pasteOk").textContent = "Enregistrer";
  $("pasteText").value = cur.blocks.map(b => b.text).join("\n\n");
  $("pasteBox").hidden = false; $("text").textContent = ""; $("example").hidden = true; $("pasteText").focus();
};
$("pasteCancel").onclick = () => { openDoc(editing || cur || EXAMPLE); };
$("pasteOk").onclick = () => {
  const raw = $("pasteText").value.trim(); if (!raw) return;
  if (editing){
    editing.blocks = textToBlocks(raw); store.set("docs", docs); store.set("pos:"+editing.id, 0); openDoc(editing);
  } else {
    saveDoc({id:"d"+Date.now(), title: raw.split(/\s+/).slice(0,6).join(" ") + "…", created:Date.now(), blocks:textToBlocks(raw)});
  }
};
const STOP = {
  fr:["le","la","les","et","est","des","une","que","pas","je","du","dans","pour","il","qui","au"],
  de:["der","die","und","das","ist","nicht","ich","ein","zu","mit","den","sie","es","auf","sich","dem"],
  en:["the","and","is","of","to","not","you","that","it","with","in","for","was","on","are","this"],
  es:["el","los","y","es","que","una","por","con","no","las","del","se","en","lo","su","para"],
  it:["il","che","e","di","non","una","per","sono","gli","con","del","della","un","si","è","le"],
  pt:["o","os","e","é","que","uma","não","com","do","da","em","um","para","se","dos","as"]
};
function guessLang(t, allowed = null){
  const tokens = t.toLowerCase().replace(/[^\p{L}\s']/gu, " ").split(/\s+/);
  const best = Object.entries(STOP).filter(([l]) => !allowed || allowed.includes(l))
    .map(([l, ws]) => [l, tokens.filter(x => ws.includes(x)).length])
    .sort((a,b)=>b[1]-a[1]);
  if (!best.length) return "fr";
  if (best[0][1] === 0) return (allowed && allowed[0]) || "fr";
  return best[0][0];
}

/* ---------- Photo → text, on the device (Tesseract) ---------- */
let workerP = null, workerLangs = "", onProgress = null;
function resetWorker(){ if (workerP){ const p = workerP; workerP = null; p.then(w => w.terminate()).catch(()=>{}); } }
function getWorker(){
  const langs = ocrLangs.map(l => TESS[l]).join("+");
  if (workerP && workerLangs === langs) return workerP;
  resetWorker(); workerLangs = langs;
  const base = new URL(".", location.href).href;
  workerP = Tesseract.createWorker(langs, 1, {
    workerPath: base + "vendor/tesseract/worker.min.js",
    corePath: base + "vendor/core/",
    langPath: base + "lang",
    workerBlobURL: false,
    logger: m => onProgress && onProgress(m)
  });
  workerP.catch(() => { workerP = null; });
  return workerP;
}
function cleanLines(lines){
  let out = "";
  lines.map(l => l.replace(/\s+/g, " ").trim()).filter(Boolean).forEach(l => {
    if (!out) out = l;
    else if (/[A-Za-zÀ-ÿß]-$/.test(out) && /^[a-zà-ÿß]/.test(l)) out = out.slice(0, -1) + l; // recoller « mot- / coupé »
    else out += " " + l;
  });
  return out;
}
function toBlocks(data){
  const blocks = [];
  (data.blocks || []).forEach(b => (b.paragraphs || []).forEach(p => {
    const text = cleanLines((p.lines || []).map(l => l.text));
    const letters = (text.match(/\p{L}/gu) || []).length;
    if (letters < 3 || p.confidence < 35) return;            // bruit, taches, bords de page
    if (/^\d{1,4}$/.test(text.trim())) return;               // numéro de page
    const conf = Math.round(p.confidence);
    const prev = blocks[blocks.length - 1];
    // Tesseract sometimes cuts a paragraph mid-sentence: glue it back.
    if (prev && prev.type === "text" && !/[.!?:»"…]$/.test(prev.text) && (/^[a-zà-ÿß,;]/.test(text) || prev.text.length > 30)){
      prev.text = cleanLines([prev.text, text]); prev.conf = Math.min(prev.conf, conf); return;
    }
    const short = text.length < 70 && !/[.!?:;,]$/.test(text);
    blocks.push({type: short && blocks.length === 0 ? "heading" : "text", text, conf});
  }));
  // Split paragraphs where the language changes, so each part gets the right voice.
  const out = [];
  blocks.forEach(b => {
    if (b.type === "heading" || ocrLangs.length === 1){ out.push({...b, lang: guessLang(b.text, ocrLangs)}); return; }
    let run = null;
    splitSentences(b.text, ocrLangs[0]).forEach(s => {
      const lang = words(s) >= 4 ? guessLang(s, ocrLangs) : (run ? run.lang : guessLang(b.text, ocrLangs));
      if (run && run.lang === lang) run.text += (run.text.endsWith(" ") ? "" : " ") + s;
      else { run = {type:"text", lang, text:s, conf:b.conf}; out.push(run); }
    });
  });
  out.forEach(b => b.text = b.text.trim());
  return out;
}
async function handleFiles(files){
  files = [...files].filter(f => f.type.startsWith("image/") || /\.(heic|jpe?g|png|webp)$/i.test(f.name));
  if (!files.length) return;
  closeRail(); stop();
  if (!window.Tesseract){ status("Le module de lecture n'a pas pu se charger. Rechargez la page une fois avec internet.", true); return; }
  $("pasteBox").hidden = true; $("text").textContent = ""; $("example").hidden = true;
  $("docTitle").textContent = "Lecture des photos…";
  const th = $("thumbs"); th.textContent = ""; th.hidden = false;
  const blocks = []; let skipped = 0;
  for (let i = 0; i < files.length; i++){
    const label = `Page ${i+1} sur ${files.length}`;
    onProgress = m => {
      if (m.status === "recognizing text") status(`${label} : lecture du texte…`, false, m.progress);
      else if (/loading|initializ/.test(m.status)) status(`${label} : préparation (${ocrLangs.map(l=>LANGS[l]).join(", ")})…`, false, m.progress || 0);
    };
    try {
      const img = await Scan.loadImage(files[i]);
      status(`${label} : ajustez les coins de la page.`);
      const picked = await Scan.adjust(img, {index:i+1, total:files.length});
      if (!picked){ skipped++; continue; }
      const canvas = picked.canvas;
      status(`${label} : préparation…`, false, 0);
      const im = new Image(); im.src = canvas.toDataURL("image/jpeg", 0.3); im.alt = "Page " + (i+1); th.append(im);
      const w = await getWorker();
      const {data} = await w.recognize(canvas, {}, {text:true, blocks:true});
      const found = toBlocks(data);
      if (!found.length && data.text?.trim()) found.push({type:"text", lang:guessLang(data.text, ocrLangs), text:cleanLines(data.text.split("\n")), conf:Math.round(data.confidence)});
      blocks.push(...found);
    } catch (e) {
      console.error(e);
      status(`La lecture de la page ${i+1} a échoué. Essayez une photo plus nette.`, true);
    }
  }
  onProgress = null;
  if (skipped === files.length){ openDoc(cur || EXAMPLE); return; }
  if (!blocks.length){ status("Aucun texte trouvé. Prenez la photo bien à plat, avec une bonne lumière, et vérifiez les langues choisies.", true); $("docTitle").textContent = cur ? cur.title : "Voix de page"; return; }
  const first = blocks.find(b => b.type === "heading") || blocks[0];
  const title = first.text.split(/\s+/).slice(0, 6).join(" ") + (words(first.text) > 6 ? "…" : "");
  saveDoc({id:"d"+Date.now(), title, created:Date.now(), blocks});
  const unsure = blocks.filter(b => b.conf < 70).length;
  status(unsure ? `Prêt. ${unsure} passage${unsure>1?"s":""} souligné${unsure>1?"s":""} en vague ${unsure>1?"sont":"est"} incertain${unsure>1?"s":""} : touchez le crayon pour corriger.` : "Prêt. Touchez Lire, ou touchez une phrase pour commencer là.");
}
$("camIn").onchange = e => { handleFiles(e.target.files); e.target.value = ""; };
$("fileIn").onchange = e => { handleFiles(e.target.files); e.target.value = ""; };
document.addEventListener("dragover", e => e.preventDefault());
document.addEventListener("drop", e => { e.preventDefault(); handleFiles(e.dataTransfer.files); });
document.addEventListener("paste", e => { const f = [...(e.clipboardData?.files||[])]; if (f.length) handleFiles(f); });

/* ---------- Offline and install ---------- */
function setOffline(ok, txt){ $("offDot").classList.toggle("ok", ok); $("offTxt").textContent = txt; }
if ("serviceWorker" in navigator){
  navigator.serviceWorker.register("sw.js").then(reg => {
    const done = () => setOffline(true, "Prêt hors ligne");
    if (reg.active && !reg.installing) done();
    navigator.serviceWorker.addEventListener("message", e => { if (e.data === "cached") done(); });
    (reg.installing || reg.waiting)?.addEventListener("statechange", ev => { if (ev.target.state === "activated") done(); });
  }).catch(() => setOffline(false, "Mode hors ligne indisponible dans ce navigateur"));
} else setOffline(false, "Mode hors ligne indisponible dans ce navigateur");
let installEvt = null;
window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); installEvt = e; $("installBtn").style.display = "inline-flex"; });
$("installBtn").onclick = async () => { if (!installEvt) return; installEvt.prompt(); await installEvt.userChoice; installEvt = null; $("installBtn").style.display = "none"; };

if (!synth) status("La synthèse vocale n'est pas disponible dans ce navigateur. Essayez Chrome ou Safari.", true);
openDoc(allDocs()[0]);
})();
