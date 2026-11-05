import {
  carregarDados, Programacao, desenharCapa, paletaDe, formatarTempo, segParaHora,
  escapar, DIA,
} from "./motor.js";

const $ = (id) => document.getElementById(id);
const audio = $("audio");
const el = {
  play: $("botaoPlay"), playTxt: document.querySelector(".botao-play-texto"),
  titulo: $("faixaTitulo"), artista: $("faixaArtista"), genero: $("faixaGenero"),
  bloco: $("blocoNome"), blocoHora: $("blocoHora"), selo: $("seloTipo"),
  capa: $("capa"), capaImg: $("capaImg"), modelo: $("faixaModelo"), prompt: $("promptTexto"),
  fill: $("progressoFill"), decorrido: $("tempoDecorrido"), total: $("tempoTotal"),
  relogio: $("relogio"), proximas: $("listaProximas"), anteriores: $("listaAnteriores"),
  linha: $("linha24h"), agora: $("linhaAgora"), blocos: $("listaBlocos"), espectro: $("espectro"),
};

let prog, dados;
let tocando = false;
let chaveTela = null;      // item mostrado na tela
let chaveAudio = null;     // item carregado no <audio>
let dadosPendentes = null; // atualização da grade aguardando a troca de faixa
let analisador = null, ctxAudio = null;

const chave = (a) => `${a.data}#${a.indice}`;

function aviso(txt) {
  const d = document.createElement("div");
  d.className = "aviso"; d.textContent = txt;
  document.body.appendChild(d);
  setTimeout(() => d.remove(), 2600);
}

/* ---------- interface da faixa ---------- */
let digitacao = null;
function digitar(texto) {
  clearInterval(digitacao);
  el.prompt.textContent = "";
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) { el.prompt.textContent = texto; return; }
  let i = 0;
  digitacao = setInterval(() => {
    el.prompt.textContent = texto.slice(0, ++i);
    if (i >= texto.length) clearInterval(digitacao);
  }, 22);
}

function mostrarCapa(ref, genero) {
  if (ref.capa) {
    el.capaImg.src = ref.capa; el.capaImg.hidden = false;
  } else {
    el.capaImg.hidden = true;
    desenharCapa(el.capa, ref.id, genero);
  }
}

function mostrarItem(a) {
  const { item, bloco } = a;
  const ref = item.ref;
  const ehMusica = item.tipo === "musica";
  el.bloco.textContent = bloco.nome;
  el.blocoHora.textContent = bloco._livre ? "" : `${segParaHora(bloco._ini)} às ${segParaHora(bloco._fim)}`;
  el.titulo.textContent = ehMusica ? ref.titulo : (ref.nome || "Vinheta");
  el.artista.textContent = ehMusica ? (ref.artista || "Artista IA") : (prog.config.nome || "Rádio Prompt");
  el.genero.hidden = !ehMusica || !ref.genero;
  el.genero.textContent = ref.genero || "";
  el.selo.textContent = ehMusica ? "Música gerada por IA" : "Vinheta";
  el.modelo.textContent = ehMusica ? (ref.modelo || "IA") : "Rádio Prompt";
  mostrarCapa(ref, ehMusica ? ref.genero : "house");
  digitar(ehMusica ? (ref.prompt || "Prompt não informado para esta faixa.") : (prog.config.slogan || "Você está ouvindo a Rádio Prompt."));
  document.title = tocando
    ? `▶ ${el.titulo.textContent} · ${prog.config.nome || "Rádio Prompt"}`
    : `${prog.config.nome || "Rádio Prompt"} · música criada por IA, 24 horas no ar`;
  atualizarMediaSession(a);
  renderizarListas();
  renderizarGrade(a);
}

function miniCapa(ref) {
  const c = document.createElement("canvas");
  c.width = c.height = 88;
  desenharCapa(c, ref.id, ref.genero);
  return c;
}

function linhaLista(x) {
  const li = document.createElement("li");
  li.innerHTML = `<span class="hora">${segParaHora(x.inicio)}</span><span class="c"></span>
    <span class="t">${escapar(x.ref.titulo)}<small>${escapar(x.ref.artista || "Artista IA")}</small></span>
    <span class="g">${escapar(x.ref.genero || "")}</span>`;
  li.querySelector(".c").replaceWith(miniCapa(x.ref));
  return li;
}

function renderizarListas() {
  const prox = prog.proximas(4), ant = prog.anteriores(5);
  el.proximas.replaceChildren(...(prox.length ? prox.map(linhaLista) : [Object.assign(document.createElement("li"), { className: "vazio", textContent: "A programação aparece aqui." })]));
  el.anteriores.replaceChildren(...(ant.length ? ant.map(linhaLista) : [Object.assign(document.createElement("li"), { className: "vazio", textContent: "Você acabou de chegar. Fique por aqui." })]));
}

function renderizarGrade(a) {
  const blocos = prog.grade.length ? prog.grade : [];
  el.linha.querySelectorAll(".seg").forEach((s) => s.remove());
  blocos.forEach((b) => {
    const s = document.createElement("div");
    s.className = "seg";
    const dur = (b._fim - b._ini + DIA) % DIA || DIA;
    s.style.width = `${(dur / DIA) * 100}%`;
    const [, c1, c2] = paletaDe((b.generos || [])[0], b.id);
    s.style.background = `linear-gradient(90deg, ${c1}55, ${c2}55)`;
    s.title = `${b.nome} (${b.inicio} às ${b.fim})`;
    el.linha.insertBefore(s, el.agora);
  });
  el.blocos.innerHTML = blocos.map((b) => `
    <li class="${a && a.bloco.id === b.id ? "atual" : ""}">
      <span class="h">${escapar(b.inicio)} às ${escapar(b.fim)}</span>
      <h3>${escapar(b.nome)}</h3>
      <p>${escapar(b.descricao || "")}</p>
      <div class="gs">${(b.generos || []).map((g) => `<span class="tag">${escapar(g)}</span>`).join("")}</div>
    </li>`).join("") || `<li><h3>Programação livre</h3><p>Todas as músicas em rotação aleatória.</p></li>`;
}

/* ---------- áudio ---------- */
function prepararAnalisador() {
  if (ctxAudio) return;
  try {
    ctxAudio = new (window.AudioContext || window.webkitAudioContext)();
    const fonte = ctxAudio.createMediaElementSource(audio);
    analisador = ctxAudio.createAnalyser();
    analisador.fftSize = 128;
    fonte.connect(analisador);
    analisador.connect(ctxAudio.destination);
  } catch (e) {
    console.warn("Visualizador indisponível", e);
  }
}

function carregarNoAudio(a) {
  chaveAudio = chave(a);
  audio.src = a.item.ref.arquivo;
  const pular = () => {
    const atual = prog.noAr();
    if (atual && chave(atual) === chaveAudio) {
      try { audio.currentTime = atual.offset; } catch (e) {}
    }
  };
  audio.addEventListener("loadedmetadata", pular, { once: true });
  const p = audio.play();
  if (p) p.catch((e) => {
    if (e.name === "NotAllowedError") { pararUI(); aviso("Toque em Ouvir ao vivo para começar."); }
  });
}

function sintonizar() {
  const a = prog.noAr();
  if (!a) { aviso("A programação ainda não tem músicas."); return; }
  prepararAnalisador();
  if (ctxAudio && ctxAudio.state === "suspended") ctxAudio.resume();
  tocando = true;
  document.body.classList.add("tocando");
  el.playTxt.textContent = "Pausar";
  el.play.setAttribute("aria-label", "Pausar");
  carregarNoAudio(a);
  mostrarItem(a);
}

function pararUI() {
  tocando = false;
  chaveAudio = null;
  document.body.classList.remove("tocando");
  el.playTxt.textContent = "Ouvir ao vivo";
  el.play.setAttribute("aria-label", "Ouvir ao vivo");
}

function pausar() {
  audio.pause();
  pararUI();
  document.title = `${prog.config.nome || "Rádio Prompt"} · música criada por IA, 24 horas no ar`;
}

audio.addEventListener("ended", () => { if (tocando) tick(true); });
audio.addEventListener("error", () => {
  if (!tocando) return;
  console.warn("Falha ao carregar", audio.src);
  setTimeout(() => tocando && tick(true), 3000); // tenta de novo no próximo tique
});

/* ---------- relógio principal ---------- */
function tick(forcar = false) {
  const agora = prog.agoraMs();
  const a = prog.noAr(agora);
  const { seg } = prog.partesNoFuso(agora);
  el.relogio.textContent = `${segParaHora(seg)} · horário de Brasília`;
  el.agora.style.left = `${(seg / DIA) * 100}%`;
  if (!a) return;

  const k = chave(a);
  if (k !== chaveTela) {
    if (dadosPendentes) { aplicarDados(dadosPendentes); dadosPendentes = null; return tick(true); }
    chaveTela = k;
    mostrarItem(a);
  }

  const dur = a.item.fim - a.item.inicio;
  el.fill.style.width = `${Math.min(100, (a.offset / dur) * 100)}%`;
  el.decorrido.textContent = formatarTempo(a.offset);
  el.total.textContent = formatarTempo(dur);

  if (tocando) {
    if (k !== chaveAudio || forcar && audio.ended) {
      carregarNoAudio(a);
    } else if (!audio.paused && audio.readyState >= 2) {
      const desvio = audio.currentTime - a.offset;
      if (Math.abs(desvio) > 4 && a.restante > 3) {
        try { audio.currentTime = a.offset; } catch (e) {}
      }
    }
  }
}

/* ---------- visualizador ---------- */
function desenharEspectro() {
  const c = el.espectro, g = c.getContext("2d");
  const W = c.width, H = c.height;
  const dadosFreq = new Uint8Array(64);
  const t0 = performance.now();
  function quadro(t) {
    g.clearRect(0, 0, W, H);
    const barras = 48, larg = W / barras;
    if (analisador && tocando) analisador.getByteFrequencyData(dadosFreq);
    for (let i = 0; i < barras; i++) {
      let v;
      if (analisador && tocando) v = dadosFreq[Math.floor((i / barras) * 46)] / 255;
      else v = 0.06 + 0.05 * Math.sin((t - t0) / 700 + i * 0.45);
      const h = Math.max(3, v * H);
      const grad = g.createLinearGradient(0, H, 0, H - h);
      grad.addColorStop(0, "#b9a6ff");
      grad.addColorStop(1, "#ff5a1f");
      g.fillStyle = grad;
      g.fillRect(i * larg + 2, H - h, larg - 4, h);
    }
    requestAnimationFrame(quadro);
  }
  requestAnimationFrame(quadro);
}

/* ---------- media session (tela bloqueada, fones) ---------- */
function atualizarMediaSession(a) {
  if (!("mediaSession" in navigator)) return;
  const ref = a.item.ref;
  let arte = [];
  try { arte = [{ src: ref.capa || el.capa.toDataURL("image/png"), sizes: "720x720", type: "image/png" }]; } catch (e) {}
  navigator.mediaSession.metadata = new MediaMetadata({
    title: a.item.tipo === "musica" ? ref.titulo : (ref.nome || "Vinheta"),
    artist: a.item.tipo === "musica" ? (ref.artista || "Artista IA") : (prog.config.nome || "Rádio Prompt"),
    album: `${prog.config.nome || "Rádio Prompt"} · ${a.bloco.nome}`,
    artwork: arte,
  });
  navigator.mediaSession.setActionHandler("play", sintonizar);
  navigator.mediaSession.setActionHandler("pause", pausar);
}

/* ---------- dados ---------- */
function aplicarDados(d) {
  dados = d;
  prog.atualizar(d);
  chaveTela = null;
  if (tocando) chaveAudio = null;
}

async function recarregar() {
  const novo = await carregarDados();
  if (JSON.stringify(novo) === JSON.stringify(dados)) return;
  if (tocando) dadosPendentes = novo; else { aplicarDados(novo); tick(); }
}

function rodape(config) {
  $("rodapeNome").textContent = config.nome || "Rádio Prompt";
  $("rodapeSlogan").textContent = config.slogan || "";
  const links = [];
  if (config.instagram) links.push(`<a href="https://instagram.com/${escapar(config.instagram.replace("@", ""))}" target="_blank" rel="noopener">Instagram</a>`);
  if (config.whatsapp) links.push(`<a href="https://wa.me/${escapar(config.whatsapp.replace(/\D/g, ""))}" target="_blank" rel="noopener">WhatsApp</a>`);
  if (config.email) links.push(`<a href="mailto:${escapar(config.email)}">E-mail</a>`);
  $("rodapeLinks").innerHTML = links.join("");
}

/* ---------- início ---------- */
async function iniciar() {
  dados = await carregarDados();
  prog = new Programacao(dados);
  rodape(prog.config);
  prog.sincronizarRelogio().then(() => tick());
  el.play.disabled = false;
  el.play.addEventListener("click", () => (tocando ? pausar() : sintonizar()));
  $("volume").addEventListener("input", (e) => { audio.volume = Number(e.target.value); });
  audio.volume = Number($("volume").value);
  $("botaoCompartilhar").addEventListener("click", async () => {
    const url = location.href.split("#")[0];
    const texto = `Estou ouvindo ${prog.config.nome || "a Rádio Prompt"}: música 100% criada por IA, ao vivo.`;
    if (navigator.share) { try { await navigator.share({ title: prog.config.nome, text: texto, url }); } catch (e) {} }
    else { try { await navigator.clipboard.writeText(url); aviso("Link copiado."); } catch (e) { aviso(url); } }
  });
  document.addEventListener("keydown", (e) => {
    if (e.code === "Space" && !["INPUT", "TEXTAREA", "BUTTON"].includes(document.activeElement.tagName)) {
      e.preventDefault(); tocando ? pausar() : sintonizar();
    }
  });
  desenharEspectro();
  tick();
  setInterval(tick, 500);
  setInterval(recarregar, 10 * 60 * 1000);
}

iniciar();
