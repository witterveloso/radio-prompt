import {
  carregarDados, Programacao, desenharCapa, formatarTempo, segParaHora, horaParaSeg,
  escapar, normalizarGenero, paletaDe, DIA,
} from "./motor.js";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clonar = (o) => JSON.parse(JSON.stringify(o));
const ARQ_DADOS = { config: "data/config.json", musicas: "data/musicas.json", vinhetas: "data/vinhetas.json", grade: "data/grade.json" };
const MODELOS = ["Suno", "Udio", "ElevenLabs Music", "Stable Audio", "MusicGen", "Mureka", "Outro"];

let original = null;              // como está publicado
let estado = null;                // como está sendo editado
const arquivosNovos = new Map();  // caminho no repositório -> File
const arquivosExcluir = new Set();
const urlsLocais = new Map();     // caminho -> objectURL para pré-escuta

/* ---------- utilidades ---------- */
function toast(txt, ms = 2600) {
  const d = document.createElement("div");
  d.className = "toast"; d.textContent = txt;
  document.body.appendChild(d);
  setTimeout(() => d.remove(), ms);
}

function slug(txt) {
  return String(txt || "faixa").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "faixa";
}

function idUnico(base, lista) {
  let id = slug(base), n = 2;
  const usados = new Set(lista.map((x) => x.id));
  while (usados.has(id)) id = `${slug(base)}-${n++}`;
  return id;
}

function extensao(file) {
  const m = /\.([a-z0-9]+)$/i.exec(file.name);
  return m ? m[1].toLowerCase() : "mp3";
}

function tituloDoArquivo(nome) {
  return nome.replace(/\.[^.]+$/, "").replace(/[_]+/g, " ").replace(/\s+/g, " ").trim()
    .replace(/^./, (c) => c.toUpperCase());
}

function lerDuracao(file) {
  return new Promise((res) => {
    const a = new Audio();
    a.preload = "metadata";
    a.src = URL.createObjectURL(file);
    a.onloadedmetadata = () => res(Math.round(a.duration * 100) / 100);
    a.onerror = () => res(0);
  });
}

function urlDe(caminho) {
  return urlsLocais.get(caminho) || caminho;
}

function guardarArquivo(caminho, file) {
  arquivosNovos.set(caminho, file);
  arquivosExcluir.delete(caminho);
  urlsLocais.set(caminho, URL.createObjectURL(file));
}

function descartarArquivo(caminho) {
  if (!caminho) return;
  if (arquivosNovos.has(caminho)) arquivosNovos.delete(caminho);
  else arquivosExcluir.add(caminho);
}

function generosConhecidos() {
  const s = new Set();
  estado.musicas.forEach((m) => m.genero && s.add(m.genero.trim().toLowerCase()));
  estado.grade.forEach((b) => (b.generos || []).forEach((g) => s.add(g.trim().toLowerCase())));
  return [...s].sort();
}

function contagemPorGenero() {
  const c = {};
  estado.musicas.filter((m) => m.ativa !== false).forEach((m) => {
    const g = normalizarGenero(m.genero);
    c[g] = (c[g] || 0) + 1;
  });
  return c;
}

/* ---------- pendências ---------- */
function pendencias() {
  const lista = [];
  for (const [k, caminho] of Object.entries(ARQ_DADOS)) {
    if (JSON.stringify(estado[k]) !== JSON.stringify(original[k])) lista.push({ tipo: "dados", caminho });
  }
  arquivosNovos.forEach((f, caminho) => lista.push({ tipo: "enviar", caminho, tamanho: f.size }));
  arquivosExcluir.forEach((caminho) => lista.push({ tipo: "excluir", caminho }));
  return lista;
}

function atualizarPendentes() {
  const p = pendencias();
  const badge = $("#pendentes");
  badge.hidden = !p.length;
  badge.textContent = `${p.length} ${p.length === 1 ? "alteração" : "alterações"} não publicadas`;
  $("#listaPendentes").innerHTML = p.length
    ? p.map((x) => `<li>${x.tipo === "enviar" ? "＋ enviar" : x.tipo === "excluir" ? "－ excluir" : "✎ atualizar"} ${escapar(x.caminho)}${x.tamanho ? ` (${(x.tamanho / 1048576).toFixed(1)} MB)` : ""}</li>`).join("")
    : `<li>Nada pendente. Tudo publicado.</li>`;
}

function mudou() {
  atualizarPendentes();
}

/* ---------- abas ---------- */
function irPara(aba) {
  $$(".aba").forEach((b) => b.classList.toggle("ativa", b.dataset.aba === aba));
  $$(".painel").forEach((p) => p.classList.toggle("ativo", p.id === `aba-${aba}`));
  if (aba === "simulador") simular();
  if (aba === "grade") renderizarGrade();
  if (aba === "publicar") atualizarPendentes();
}
$$(".aba").forEach((b) => b.addEventListener("click", () => irPara(b.dataset.aba)));
$$("[data-ir]").forEach((b) => b.addEventListener("click", () => irPara(b.dataset.ir)));

/* ---------- modal genérico ---------- */
function abrirModal(titulo, html, aoSalvar) {
  const modal = $("#modal");
  $("#modalTitulo").textContent = titulo;
  $("#modalCampos").innerHTML = html;
  const form = $("#formModal");
  const handler = async (e) => {
    if (e.submitter && e.submitter.value === "cancelar") return;
    e.preventDefault();
    const btn = $("#modalSalvar");
    btn.disabled = true;
    try {
      const ok = await aoSalvar(new FormData(form), form);
      if (ok !== false) { modal.close(); form.removeEventListener("submit", handler); }
    } finally { btn.disabled = false; }
  };
  form.addEventListener("submit", handler);
  modal.addEventListener("close", () => form.removeEventListener("submit", handler), { once: true });
  modal.showModal();
}

function datalist(id, itens) {
  return `<datalist id="${id}">${itens.map((x) => `<option value="${escapar(x)}">`).join("")}</datalist>`;
}

/* ---------- músicas ---------- */
function capaEl(m) {
  if (m.capa) {
    const img = document.createElement("img");
    img.className = "capa"; img.src = urlDe(m.capa); img.alt = "";
    return img;
  }
  const c = document.createElement("canvas");
  c.width = c.height = 88;
  desenharCapa(c, m.id, m.genero);
  return c;
}

function renderizarMusicas() {
  const busca = normalizarGenero($("#buscaMusica").value);
  const fg = $("#filtroGenero").value;
  const sel = $("#filtroGenero");
  const generos = generosConhecidos();
  const atual = sel.value;
  sel.innerHTML = `<option value="">Todos os gêneros</option>` + generos.map((g) => `<option>${escapar(g)}</option>`).join("") + `<option value="__sem">Sem gênero</option>`;
  sel.value = atual;

  const ativas = estado.musicas.filter((m) => m.ativa !== false);
  const horas = ativas.reduce((s, m) => s + Number(m.duracao || 0), 0) / 3600;
  $("#resumoMusicas").textContent = `${estado.musicas.length} faixas cadastradas, ${ativas.length} no ar, ${horas.toFixed(1)} horas de música.`;

  const lista = estado.musicas
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => !fg || (fg === "__sem" ? !m.genero : normalizarGenero(m.genero) === normalizarGenero(fg)))
    .filter(({ m }) => !busca || normalizarGenero(`${m.titulo} ${m.artista} ${m.prompt}`).includes(busca))
    .reverse();

  const tb = $("#tabelaMusicas");
  if (!lista.length) { tb.innerHTML = `<tr><td colspan="7" class="vazio">Nenhuma música por aqui. Clique em Nova música ou arraste seus MP3.</td></tr>`; return; }
  tb.innerHTML = "";
  for (const { m, i } of lista) {
    const tr = document.createElement("tr");
    const nova = arquivosNovos.has(m.arquivo);
    tr.innerHTML = `
      <td class="c"></td>
      <td class="t"><b>${escapar(m.titulo)}${nova ? `<span class="novo">novo</span>` : ""}</b><span>${escapar(m.artista || "Artista não informado")}</span><div class="p" title="${escapar(m.prompt || "")}">${escapar(m.prompt || "sem prompt")}</div></td>
      <td>${m.genero ? `<span class="tag">${escapar(m.genero)}</span>` : `<span class="tag zero">sem gênero</span>`}</td>
      <td class="mono">${formatarTempo(m.duracao)}</td>
      <td>${escapar(m.modelo || "")}</td>
      <td><label class="chave"><input type="checkbox" ${m.ativa !== false ? "checked" : ""} data-ativa="${i}"><span></span></label></td>
      <td class="td-acoes">
        <button class="btn mini" data-ouvir="${i}">Ouvir</button>
        <button class="btn mini" data-editar="${i}">Editar</button>
        <button class="btn mini perigo" data-excluir="${i}">Excluir</button>
      </td>`;
    tr.querySelector(".c").appendChild(capaEl(m));
    tb.appendChild(tr);
  }
}

$("#tabelaMusicas").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.ouvir !== undefined) ouvir(estado.musicas[b.dataset.ouvir].arquivo, b);
  if (b.dataset.editar !== undefined) editarMusica(Number(b.dataset.editar));
  if (b.dataset.excluir !== undefined) {
    const m = estado.musicas[b.dataset.excluir];
    if (!confirm(`Excluir "${m.titulo}"? O arquivo de áudio também será removido do repositório quando você publicar.`)) return;
    descartarArquivo(m.arquivo);
    if (m.capa) descartarArquivo(m.capa);
    estado.musicas.splice(Number(b.dataset.excluir), 1);
    renderizarMusicas(); mudou();
  }
});
$("#tabelaMusicas").addEventListener("change", (e) => {
  const i = e.target.dataset.ativa;
  if (i === undefined) return;
  estado.musicas[i].ativa = e.target.checked;
  renderizarMusicas(); mudou();
});
$("#buscaMusica").addEventListener("input", renderizarMusicas);
$("#filtroGenero").addEventListener("change", renderizarMusicas);

const previa = $("#previa");
let botaoOuvindo = null;
function ouvir(caminho, botao) {
  if (botaoOuvindo === botao && !previa.paused) { previa.pause(); botao.textContent = "Ouvir"; botaoOuvindo = null; return; }
  if (botaoOuvindo) botaoOuvindo.textContent = "Ouvir";
  previa.src = urlDe(caminho);
  previa.play().catch(() => toast("Não consegui tocar esse arquivo. Se acabou de publicar, aguarde o GitHub atualizar."));
  botao.textContent = "Parar";
  botaoOuvindo = botao;
}
previa.addEventListener("ended", () => { if (botaoOuvindo) botaoOuvindo.textContent = "Ouvir"; botaoOuvindo = null; });

function camposMusica(m = {}) {
  const novo = !m.id;
  return `
    <label>Arquivo de áudio ${novo ? "(obrigatório)" : "(envie outro só se quiser trocar)"}<input type="file" name="arquivo" accept="audio/*" ${novo ? "required" : ""}></label>
    <div class="duas">
      <label>Título<input name="titulo" value="${escapar(m.titulo || "")}" required></label>
      <label>Artista (persona de IA)<input name="artista" value="${escapar(m.artista || "")}" placeholder="Ex.: Nuvem Neural"></label>
    </div>
    <div class="duas">
      <label>Gênero<input name="genero" list="dlGeneros" value="${escapar(m.genero || "")}" required placeholder="lofi, pop, sertanejo..."></label>
      <label>Modelo de IA usado<input name="modelo" list="dlModelos" value="${escapar(m.modelo || "Suno")}"></label>
    </div>
    <label>Prompt que gerou a música (aparece para o ouvinte)<textarea name="prompt" placeholder="Ex.: samba rock instrumental, guitarra suingada, metais, clima de churrasco de domingo">${escapar(m.prompt || "")}</textarea></label>
    <label>Capa (opcional, JPG ou PNG quadrado. Sem capa, a rádio cria uma arte automática)<input type="file" name="capa" accept="image/*"></label>
    <label class="check"><input type="checkbox" name="ativa" ${m.ativa !== false ? "checked" : ""}> No ar (entra na programação)</label>
    ${datalist("dlGeneros", generosConhecidos())}${datalist("dlModelos", MODELOS)}`;
}

async function salvarMusica(fd, existente) {
  const arquivo = fd.get("arquivo");
  const capa = fd.get("capa");
  const m = existente || {};
  if (!existente) {
    m.id = idUnico(fd.get("titulo"), estado.musicas);
    m.adicionadaEm = new Date().toISOString().slice(0, 10);
  }
  if (arquivo && arquivo.size) {
    const duracao = await lerDuracao(arquivo);
    if (!duracao) { toast("Não consegui ler esse áudio. Use MP3, M4A, OGG ou WAV."); return false; }
    if (arquivo.size > 95 * 1048576) { toast("Arquivo maior que 95 MB. O GitHub não aceita. Converta para MP3."); return false; }
    if (m.arquivo) descartarArquivo(m.arquivo);
    m.arquivo = `audio/musicas/${m.id}.${extensao(arquivo)}`;
    m.duracao = duracao;
    guardarArquivo(m.arquivo, arquivo);
  }
  if (capa && capa.size) {
    if (m.capa) descartarArquivo(m.capa);
    m.capa = `audio/capas/${m.id}.${extensao(capa)}`;
    guardarArquivo(m.capa, capa);
  }
  m.titulo = String(fd.get("titulo")).trim();
  m.artista = String(fd.get("artista")).trim();
  m.genero = String(fd.get("genero")).trim().toLowerCase();
  m.modelo = String(fd.get("modelo")).trim();
  m.prompt = String(fd.get("prompt")).trim();
  m.ativa = fd.get("ativa") === "on";
  if (!existente) estado.musicas.push(m);
  renderizarMusicas(); mudou();
  toast(existente ? "Música atualizada." : "Música adicionada. Publique para colocar no ar.");
}

function editarMusica(i) {
  const m = estado.musicas[i];
  abrirModal("Editar música", camposMusica(m), (fd) => salvarMusica(fd, m));
}
$("#novaMusica").addEventListener("click", () => abrirModal("Nova música", camposMusica(), (fd) => salvarMusica(fd, null)));

async function adicionarVarias(files) {
  const lista = [...files].filter((f) => f.type.startsWith("audio/") || /\.(mp3|m4a|ogg|wav|aac)$/i.test(f.name));
  if (!lista.length) { toast("Nenhum arquivo de áudio encontrado."); return; }
  const generoPadrao = $("#filtroGenero").value && $("#filtroGenero").value !== "__sem" ? $("#filtroGenero").value : "";
  let n = 0;
  for (const f of lista) {
    const duracao = await lerDuracao(f);
    if (!duracao || f.size > 95 * 1048576) continue;
    const titulo = tituloDoArquivo(f.name);
    const id = idUnico(titulo, estado.musicas);
    const caminho = `audio/musicas/${id}.${extensao(f)}`;
    guardarArquivo(caminho, f);
    estado.musicas.push({ id, titulo, artista: "", genero: generoPadrao, modelo: "Suno", prompt: "", arquivo: caminho, duracao, ativa: true, adicionadaEm: new Date().toISOString().slice(0, 10) });
    n++;
  }
  renderizarMusicas(); mudou();
  toast(`${n} ${n === 1 ? "música adicionada" : "músicas adicionadas"}. Complete gênero e prompt em Editar.`, 4000);
}
$("#multiplas").addEventListener("change", (e) => { adicionarVarias(e.target.files); e.target.value = ""; });
const area = $("#areaSoltar");
["dragenter", "dragover"].forEach((ev) => area.addEventListener(ev, (e) => { e.preventDefault(); area.classList.add("sobre"); }));
["dragleave", "drop"].forEach((ev) => area.addEventListener(ev, (e) => { e.preventDefault(); area.classList.remove("sobre"); }));
area.addEventListener("drop", (e) => adicionarVarias(e.dataTransfer.files));

/* ---------- vinhetas ---------- */
function renderizarVinhetas() {
  const tb = $("#tabelaVinhetas");
  if (!estado.vinhetas.length) { tb.innerHTML = `<tr><td colspan="5" class="vazio">Sem vinhetas. A rádio toca só músicas.</td></tr>`; return; }
  tb.innerHTML = estado.vinhetas.map((v, i) => `
    <tr>
      <td><b>${escapar(v.nome)}</b>${arquivosNovos.has(v.arquivo) ? `<span class="novo">novo</span>` : ""}</td>
      <td><span class="tag">${v.tipo === "abertura" ? "abertura de bloco" : "identificação"}</span></td>
      <td class="mono">${formatarTempo(v.duracao)}</td>
      <td><label class="chave"><input type="checkbox" ${v.ativa !== false ? "checked" : ""} data-vativa="${i}"><span></span></label></td>
      <td class="td-acoes">
        <button class="btn mini" data-vouvir="${i}">Ouvir</button>
        <button class="btn mini" data-veditar="${i}">Editar</button>
        <button class="btn mini perigo" data-vexcluir="${i}">Excluir</button>
      </td>
    </tr>`).join("");
}

function camposVinheta(v = {}) {
  return `
    <label>Arquivo de áudio ${v.id ? "(envie outro só se quiser trocar)" : "(obrigatório)"}<input type="file" name="arquivo" accept="audio/*" ${v.id ? "" : "required"}></label>
    <label>Nome<input name="nome" value="${escapar(v.nome || "")}" required placeholder="Ex.: Você está ouvindo a Rádio Prompt"></label>
    <label>Tipo<select name="tipo">
      <option value="identificacao" ${v.tipo !== "abertura" ? "selected" : ""}>Identificação (toca a cada N músicas)</option>
      <option value="abertura" ${v.tipo === "abertura" ? "selected" : ""}>Abertura de bloco (toca quando muda o programa)</option>
    </select></label>
    <label class="check"><input type="checkbox" name="ativa" ${v.ativa !== false ? "checked" : ""}> No ar</label>`;
}

async function salvarVinheta(fd, existente) {
  const v = existente || { id: idUnico(fd.get("nome"), estado.vinhetas) };
  const arquivo = fd.get("arquivo");
  if (arquivo && arquivo.size) {
    const duracao = await lerDuracao(arquivo);
    if (!duracao) { toast("Não consegui ler esse áudio."); return false; }
    if (v.arquivo) descartarArquivo(v.arquivo);
    v.arquivo = `audio/vinhetas/${v.id}.${extensao(arquivo)}`;
    v.duracao = duracao;
    guardarArquivo(v.arquivo, arquivo);
  }
  v.nome = String(fd.get("nome")).trim();
  v.tipo = fd.get("tipo");
  v.ativa = fd.get("ativa") === "on";
  if (!existente) estado.vinhetas.push(v);
  renderizarVinhetas(); mudou();
}

$("#novaVinheta").addEventListener("click", () => abrirModal("Nova vinheta", camposVinheta(), (fd) => salvarVinheta(fd, null)));
$("#tabelaVinhetas").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.vouvir !== undefined) ouvir(estado.vinhetas[b.dataset.vouvir].arquivo, b);
  if (b.dataset.veditar !== undefined) { const v = estado.vinhetas[b.dataset.veditar]; abrirModal("Editar vinheta", camposVinheta(v), (fd) => salvarVinheta(fd, v)); }
  if (b.dataset.vexcluir !== undefined) {
    const v = estado.vinhetas[b.dataset.vexcluir];
    if (!confirm(`Excluir a vinheta "${v.nome}"?`)) return;
    descartarArquivo(v.arquivo);
    estado.vinhetas.splice(Number(b.dataset.vexcluir), 1);
    renderizarVinhetas(); mudou();
  }
});
$("#tabelaVinhetas").addEventListener("change", (e) => {
  const i = e.target.dataset.vativa;
  if (i === undefined) return;
  estado.vinhetas[i].ativa = e.target.checked; mudou();
});

/* ---------- grade ---------- */
function validarHora(h) { return /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/.test(h); }

function analisarGrade() {
  const alertas = [];
  const cobertura = new Uint8Array(1440);
  for (const b of estado.grade) {
    if (!validarHora(b.inicio) || !validarHora(b.fim)) { alertas.push(`O bloco "${b.nome}" tem horário inválido. Use o formato 06:00.`); continue; }
    let ini = horaParaSeg(b.inicio) / 60, fim = (horaParaSeg(b.fim) || DIA) / 60;
    if (fim <= ini) fim += 1440;
    for (let t = ini; t < fim; t++) cobertura[t % 1440]++;
  }
  const faixas = (cond) => {
    const out = []; let ini = null;
    for (let t = 0; t <= 1440; t++) {
      const v = t < 1440 && cond(cobertura[t]);
      if (v && ini === null) ini = t;
      if (!v && ini !== null) { out.push(`${segParaHora(ini * 60)} às ${t === 1440 ? "24:00" : segParaHora(t * 60)}`); ini = null; }
    }
    return out;
  };
  const buracos = faixas((v) => v === 0);
  const sobrepostos = faixas((v) => v > 1);
  if (buracos.length) alertas.push(`Horários sem bloco (tocam todas as músicas): ${buracos.join(", ")}.`);
  if (sobrepostos.length) alertas.push(`Blocos sobrepostos (vale o que começa primeiro): ${sobrepostos.join(", ")}.`);
  const cont = contagemPorGenero();
  for (const b of estado.grade) {
    const total = (b.generos || []).reduce((s, g) => s + (cont[normalizarGenero(g)] || 0), 0);
    if (!total) alertas.push(`O bloco "${b.nome}" não tem nenhuma música dos gêneros escolhidos. Ele vai tocar a rádio inteira.`);
    else if (total < 4) alertas.push(`O bloco "${b.nome}" tem só ${total} música(s). Vai repetir bastante.`);
  }
  return alertas;
}

function renderizarPreviaGrade() {
  const prev = $("#previaGrade");
  prev.innerHTML = [...estado.grade]
    .filter((b) => validarHora(b.inicio) && validarHora(b.fim))
    .sort((a, b) => horaParaSeg(a.inicio) - horaParaSeg(b.inicio))
    .map((b) => {
      const dur = ((horaParaSeg(b.fim) || DIA) - horaParaSeg(b.inicio) + DIA) % DIA || DIA;
      const [, c1, c2] = paletaDe((b.generos || [])[0], b.id);
      return `<div style="width:${(dur / DIA) * 100}%;background:linear-gradient(90deg,${c1}66,${c2}66)" title="${escapar(b.nome)}">${escapar(b.nome)}</div>`;
    }).join("");
  const alertas = analisarGrade();
  $("#alertasGrade").innerHTML = alertas.length
    ? alertas.map((a) => `<div class="alerta">${escapar(a)}</div>`).join("")
    : `<div class="alerta ok">Grade cobrindo as 24 horas, sem conflitos.</div>`;
  const cont = contagemPorGenero();
  $("#generosDisponiveis").innerHTML = Object.keys(cont).length
    ? Object.entries(cont).sort().map(([g, n]) => `<span class="tag">${escapar(g || "sem gênero")} · ${n}</span>`).join(" ")
    : "nenhum ainda";
}

function chipsGeneros(b) {
  const cont = contagemPorGenero();
  return (b.generos || []).map((g) => {
    const n = cont[normalizarGenero(g)] || 0;
    return `<span class="tag ${n ? "" : "zero"}">${escapar(g)} · ${n}</span>`;
  }).join("");
}

function renderizarGrade() {
  const cont = $("#listaGrade");
  cont.innerHTML = estado.grade.map((b, i) => `
    <div class="bloco-edit" data-i="${i}">
      <label>Nome do bloco<input data-campo="nome" value="${escapar(b.nome)}"></label>
      <label>Início<input data-campo="inicio" value="${escapar(b.inicio)}" placeholder="06:00" maxlength="5"></label>
      <label>Fim<input data-campo="fim" value="${escapar(b.fim)}" placeholder="10:00" maxlength="5"></label>
      <label>Gêneros (separe por vírgula)<input data-campo="generos" list="dlGenerosGrade" value="${escapar((b.generos || []).join(", "))}"><div class="gs">${chipsGeneros(b)}</div></label>
      <button class="btn mini perigo" data-remover="${i}">Remover</button>
      <textarea data-campo="descricao" placeholder="Descrição que aparece no site">${escapar(b.descricao || "")}</textarea>
    </div>`).join("") + datalist("dlGenerosGrade", generosConhecidos());
  renderizarPreviaGrade();
}

$("#listaGrade").addEventListener("input", (e) => {
  const campo = e.target.dataset.campo;
  if (!campo) return;
  const caixa = e.target.closest(".bloco-edit");
  const b = estado.grade[caixa.dataset.i];
  if (campo === "generos") {
    b.generos = e.target.value.split(",").map((g) => g.trim().toLowerCase()).filter(Boolean);
    caixa.querySelector(".gs").innerHTML = chipsGeneros(b);
  } else b[campo] = e.target.value;
  if (campo === "nome" && !original.grade.some((x) => x.id === b.id)) b.id = idUnico(b.nome, estado.grade.filter((x) => x !== b));
  renderizarPreviaGrade(); mudou();
});
$("#listaGrade").addEventListener("click", (e) => {
  const i = e.target.dataset.remover;
  if (i === undefined) return;
  if (!confirm(`Remover o bloco "${estado.grade[i].nome}"?`)) return;
  estado.grade.splice(Number(i), 1);
  renderizarGrade(); mudou();
});
$("#novoBloco").addEventListener("click", () => {
  const ultimo = estado.grade[estado.grade.length - 1];
  estado.grade.push({ id: idUnico("novo-bloco", estado.grade), nome: "Novo bloco", inicio: ultimo ? ultimo.fim : "00:00", fim: "24:00", generos: [], descricao: "" });
  renderizarGrade(); mudou();
});

/* ---------- simulador ---------- */
function hojeNoFuso() {
  const p = new Programacao(estado);
  return p.partesNoFuso(Date.now());
}

function simular() {
  const dataEl = $("#simData"), horaEl = $("#simHora");
  if (!dataEl.value) { const h = hojeNoFuso(); dataEl.value = h.data; horaEl.value = segParaHora(h.seg); }
  const p = new Programacao(estado);
  const linha = p.linhaDoDia(dataEl.value);
  const seg = horaParaSeg(horaEl.value || "00:00");
  const tocadas = {};
  linha.forEach((x) => { if (x.tipo === "musica") tocadas[x.ref.id] = (tocadas[x.ref.id] || 0) + 1; });
  const maxRep = Math.max(0, ...Object.values(tocadas));
  const distintas = Object.keys(tocadas).length;
  $("#simStats").innerHTML = `
    <div><b>${linha.filter((x) => x.tipo === "musica").length}</b><span>músicas tocadas no dia</span></div>
    <div><b>${distintas}</b><span>faixas diferentes no dia</span></div>
    <div><b>${maxRep}x</b><span>maior repetição de uma faixa</span></div>
    <div><b>${linha.filter((x) => x.tipo === "vinheta").length}</b><span>vinhetas no dia</span></div>`;
  let ini = linha.findIndex((x) => x.fim > seg);
  if (ini < 0) ini = 0;
  const agora = p.noAr();
  const nomeBloco = (id) => (p.grade.find((b) => b.id === id) || { nome: "Programação livre" }).nome;
  $("#simTabela").innerHTML = linha.slice(ini, ini + 60).map((x, k) => {
    const atual = agora && agora.data === dataEl.value && agora.indice === ini + k;
    return `<tr class="${x.tipo === "vinheta" ? "linha-vinheta" : ""} ${atual ? "linha-atual" : ""}">
      <td class="mono">${segParaHora(x.inicio)}${atual ? " · agora" : ""}</td>
      <td>${x.tipo === "musica" ? "música" : "vinheta"}</td>
      <td>${escapar(x.ref.titulo || x.ref.nome)}${x.ref.artista ? ` <span class="dica">· ${escapar(x.ref.artista)}</span>` : ""}</td>
      <td>${escapar(nomeBloco(x.blocoId))}</td>
      <td class="mono">${formatarTempo(x.ref.duracao)}</td></tr>`;
  }).join("") || `<tr><td colspan="5" class="vazio">Cadastre músicas para ver a programação.</td></tr>`;
}
$("#simData").addEventListener("change", simular);
$("#simHora").addEventListener("change", simular);
$("#simAgora").addEventListener("click", () => { $("#simData").value = ""; simular(); });

/* ---------- configurações ---------- */
function renderizarConfig() {
  const f = $("#formConfig");
  for (const el of f.elements) {
    if (!el.name) continue;
    if (el.type === "checkbox") el.checked = estado.config[el.name] !== false;
    else el.value = estado.config[el.name] ?? "";
  }
}
$("#formConfig").addEventListener("input", (e) => {
  const el = e.target;
  if (!el.name) return;
  estado.config[el.name] = el.type === "checkbox" ? el.checked : el.type === "number" ? Number(el.value) : el.value;
  mudou();
});

/* ---------- GitHub ---------- */
const CHAVE_GH = "radioPrompt.github";
function lerGithub() {
  try { return JSON.parse(localStorage.getItem(CHAVE_GH)) || {}; } catch (e) { return {}; }
}
function salvarGithub(cfg) {
  try { localStorage.setItem(CHAVE_GH, JSON.stringify(cfg)); } catch (e) {}
}
function preencherGithub() {
  const cfg = lerGithub();
  const f = $("#formGithub");
  if (!cfg.dono || !cfg.repo) {
    // em GitHub Pages, deduz usuário e repositório pelo endereço
    const m = /^([^.]+)\.github\.io$/.exec(location.hostname);
    if (m) { cfg.dono = cfg.dono || m[1]; cfg.repo = cfg.repo || location.pathname.split("/").filter(Boolean)[0] || `${m[1]}.github.io`; }
  }
  for (const k of ["dono", "repo", "branch", "token"]) if (cfg[k]) f.elements[k].value = cfg[k];
}
$("#formGithub").addEventListener("input", () => {
  const f = $("#formGithub");
  salvarGithub({ dono: f.dono.value.trim(), repo: f.repo.value.trim(), branch: f.branch.value.trim() || "main", token: f.token.value.trim() });
});
$("#esquecerToken").addEventListener("click", () => {
  const cfg = lerGithub(); delete cfg.token; salvarGithub(cfg);
  $("#formGithub").token.value = ""; toast("Token apagado deste navegador.");
});

function log(txt) {
  const el = $("#logPublicar");
  el.textContent += `${new Date().toLocaleTimeString("pt-BR")}  ${txt}\n`;
  el.scrollTop = el.scrollHeight;
}

async function gh(caminho, opcoes = {}) {
  const cfg = lerGithub();
  if (!cfg.dono || !cfg.repo || !cfg.token) throw new Error("Preencha usuário, repositório e token.");
  const r = await fetch(`https://api.github.com/repos/${cfg.dono}/${cfg.repo}${caminho}`, {
    ...opcoes,
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: opcoes.raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(opcoes.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  if (!r.ok) {
    let msg = `${r.status}`;
    try { msg += ` ${(await r.json()).message}`; } catch (e) {}
    if (r.status === 401) msg += " (token inválido ou expirado)";
    if (r.status === 403) msg += " (o token não tem permissão de escrita em Contents neste repositório)";
    if (r.status === 404) msg += " (repositório não encontrado ou o token não tem acesso a ele)";
    if (r.status === 409) msg += " (repositório vazio: crie com um README primeiro)";
    throw new Error(msg);
  }
  return opcoes.raw ? r.text() : r.status === 204 ? null : r.json();
}

$("#testarGithub").addEventListener("click", async () => {
  try {
    const repo = await gh("");
    const pode = repo.permissions && repo.permissions.push;
    log(`Conectado a ${repo.full_name}. ${pode ? "Permissão de escrita confirmada." : "Atenção: sem permissão de escrita."}`);
    toast(pode ? "Conexão funcionando." : "Conectou, mas sem permissão de escrita.");
  } catch (e) { log(`Erro: ${e.message}`); toast("Falhou. Veja o registro abaixo."); }
});

function base64DeBytes(bytes) {
  let bin = "";
  const passo = 0x8000;
  for (let i = 0; i < bytes.length; i += passo) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + passo));
  return btoa(bin);
}

async function publicar() {
  const p = pendencias();
  if (!p.length) { toast("Nada para publicar."); return; }
  const cfg = lerGithub();
  const btn = $("#publicarAgora");
  btn.disabled = true;
  $("#logPublicar").textContent = "";
  try {
    const branch = cfg.branch || "main";
    log(`Lendo a branch ${branch}...`);
    const ref = await gh(`/git/ref/heads/${encodeURIComponent(branch)}`);
    const commitBase = await gh(`/git/commits/${ref.object.sha}`);
    const arvore = [];

    for (const [caminho, file] of arquivosNovos) {
      log(`Enviando ${caminho} (${(file.size / 1048576).toFixed(1)} MB)...`);
      const conteudo = base64DeBytes(new Uint8Array(await file.arrayBuffer()));
      const blob = await gh("/git/blobs", { method: "POST", body: JSON.stringify({ content: conteudo, encoding: "base64" }) });
      arvore.push({ path: caminho, mode: "100644", type: "blob", sha: blob.sha });
    }
    for (const [k, caminho] of Object.entries(ARQ_DADOS)) {
      if (JSON.stringify(estado[k]) === JSON.stringify(original[k])) continue;
      log(`Atualizando ${caminho}...`);
      const texto = JSON.stringify(estado[k], null, 2) + "\n";
      const blob = await gh("/git/blobs", { method: "POST", body: JSON.stringify({ content: base64DeBytes(new TextEncoder().encode(texto)), encoding: "base64" }) });
      arvore.push({ path: caminho, mode: "100644", type: "blob", sha: blob.sha });
    }
    for (const caminho of arquivosExcluir) {
      log(`Removendo ${caminho}...`);
      arvore.push({ path: caminho, mode: "100644", type: "blob", sha: null });
    }

    const novaArvore = await gh("/git/trees", { method: "POST", body: JSON.stringify({ base_tree: commitBase.tree.sha, tree: arvore }) });
    const resumo = [];
    const nNovas = [...arquivosNovos.keys()].filter((c) => c.startsWith("audio/musicas/")).length;
    if (nNovas) resumo.push(`${nNovas} música(s) nova(s)`);
    if (JSON.stringify(estado.grade) !== JSON.stringify(original.grade)) resumo.push("grade");
    if (arquivosExcluir.size) resumo.push(`${arquivosExcluir.size} arquivo(s) removido(s)`);
    const commit = await gh("/git/commits", { method: "POST", body: JSON.stringify({ message: `Estúdio Rádio Prompt: ${resumo.join(", ") || "atualização da programação"}`, tree: novaArvore.sha, parents: [ref.object.sha] }) });
    await gh(`/git/refs/heads/${encodeURIComponent(branch)}`, { method: "PATCH", body: JSON.stringify({ sha: commit.sha }) });

    original = clonar(estado);
    arquivosNovos.clear();
    arquivosExcluir.clear();
    log("Publicado. O GitHub Pages atualiza a rádio em 1 a 2 minutos e os ouvintes recebem a nova grade em até 10 minutos.");
    toast("Publicado com sucesso.");
    renderizarMusicas(); renderizarVinhetas(); atualizarPendentes();
  } catch (e) {
    log(`Erro: ${e.message}`);
    toast("A publicação falhou. Nada foi alterado no ar.", 4000);
  } finally { btn.disabled = false; }
}
$("#publicarAgora").addEventListener("click", publicar);

$("#baixarDados").addEventListener("click", () => {
  for (const [k, caminho] of Object.entries(ARQ_DADOS)) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(estado[k], null, 2)], { type: "application/json" }));
    a.download = caminho.split("/").pop();
    a.click();
  }
  if (arquivosNovos.size) toast("Lembre de enviar também os arquivos de áudio novos para a pasta audio/.", 4000);
});

window.addEventListener("beforeunload", (e) => {
  if (estado && pendencias().length) { e.preventDefault(); e.returnValue = ""; }
});

/* ---------- início ---------- */
async function carregarDoGithub() {
  const cfg = lerGithub();
  if (!cfg.token || !cfg.dono || !cfg.repo) return null;
  try {
    const branch = encodeURIComponent(cfg.branch || "main");
    const pares = await Promise.all(Object.entries(ARQ_DADOS).map(async ([k, c]) => [k, JSON.parse(await gh(`/contents/${c}?ref=${branch}`, { raw: true }))]));
    return Object.fromEntries(pares);
  } catch (e) {
    console.warn("Carregando dados do site em vez do GitHub", e);
    return null;
  }
}

async function iniciar() {
  preencherGithub();
  const dados = (await carregarDoGithub()) || (await carregarDados());
  original = clonar({ config: dados.config || {}, musicas: dados.musicas || [], vinhetas: dados.vinhetas || [], grade: dados.grade || [] });
  estado = clonar(original);
  renderizarMusicas();
  renderizarVinhetas();
  renderizarGrade();
  renderizarConfig();
  atualizarPendentes();
}
iniciar();
