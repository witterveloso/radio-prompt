import {
  carregarDados, Programacao, desenharCapa, formatarTempo, segParaHora, horaParaSeg,
  escapar, normalizarGenero, paletaDe, DIA,
} from "./motor.js";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clonar = (o) => JSON.parse(JSON.stringify(o));
const ARQ_DADOS = {
  config: "data/config.json",
  musicas: "data/musicas.json",
  vinhetas: "data/vinhetas.json",
  grade: "data/grade.json",
  programas: "data/programas.json",
};
const MODELOS = ["Suno", "Udio", "ElevenLabs Music", "Stable Audio", "MusicGen", "Mureka", "Outro"];
const DIAS_NOMES = ["dom", "seg", "ter", "qua", "qui", "sex", "sab"];
const DIAS_LABELS = { dom: "Dom", seg: "Seg", ter: "Ter", qua: "Qua", qui: "Qui", sex: "Sex", sab: "Sáb" };

let original = null;
let estado = null;
const arquivosNovos = new Map();
const arquivosExcluir = new Set();
const urlsLocais = new Map();

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
  if (!caminho || caminho.startsWith("http")) return; // R2 URLs não ficam no GitHub
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

/* ---------- Cloudflare R2 / SigV4 ---------- */
const CHAVE_R2 = "radioPrompt.r2";
function lerR2() { try { return JSON.parse(localStorage.getItem(CHAVE_R2)) || {}; } catch (e) { return {}; } }
function salvarR2(cfg) { try { localStorage.setItem(CHAVE_R2, JSON.stringify(cfg)); } catch (e) {} }

function preencherFormR2() {
  const r2 = lerR2();
  const f = $("#formR2");
  for (const k of ["accountId", "bucket", "accessKeyId", "secretAccessKey", "publicUrl"]) {
    if (r2[k]) f.elements[k].value = r2[k];
  }
}

$("#formR2").addEventListener("input", () => {
  const f = $("#formR2");
  salvarR2({
    accountId: f.elements.accountId.value.trim(),
    bucket: f.elements.bucket.value.trim(),
    accessKeyId: f.elements.accessKeyId.value.trim(),
    secretAccessKey: f.elements.secretAccessKey.value.trim(),
    publicUrl: f.elements.publicUrl.value.trim(),
  });
});

$("#esquecerR2").addEventListener("click", () => {
  localStorage.removeItem(CHAVE_R2);
  $("#formR2").reset();
  toast("Credenciais do R2 apagadas deste navegador.");
});

async function sha256Hex(data) {
  const buf = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacSha256(key, msg) {
  const keyBuf = typeof key === "string" ? new TextEncoder().encode(key) : key;
  const msgBuf = typeof msg === "string" ? new TextEncoder().encode(msg) : msg;
  const ck = await crypto.subtle.importKey("raw", keyBuf, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", ck, msgBuf));
}

async function hmacSha256Hex(key, msg) {
  const sig = await hmacSha256(key, msg);
  return Array.from(sig).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function assinarR2(method, url, body) {
  const r2 = lerR2();
  if (!r2.accountId || !r2.bucket || !r2.accessKeyId || !r2.secretAccessKey) {
    throw new Error("R2 não configurado. Preencha as credenciais em Configurações.");
  }
  const urlObj = new URL(url);
  const now = new Date();
  const dateStamp = now.toISOString().slice(0, 10).replace(/-/g, "");
  const timeStamp = now.toISOString().replace(/[-:.]/g, "").slice(0, 15) + "Z";
  const bodyHash = body ? await sha256Hex(body) : "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const headers = {
    host: urlObj.hostname,
    "x-amz-content-sha256": bodyHash,
    "x-amz-date": timeStamp,
  };
  if (body && body.byteLength) headers["content-length"] = String(body.byteLength);
  const sortedKeys = Object.keys(headers).sort();
  const canonicalHeaders = sortedKeys.map((k) => `${k}:${headers[k]}`).join("\n") + "\n";
  const signedHeaders = sortedKeys.join(";");
  const qs = [...urlObj.searchParams.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  const canonicalRequest = [method, urlObj.pathname, qs, canonicalHeaders, signedHeaders, bodyHash].join("\n");
  const region = "auto", service = "s3";
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", timeStamp, scope, await sha256Hex(canonicalRequest)].join("\n");
  const kDate = await hmacSha256(`AWS4${r2.secretAccessKey}`, dateStamp);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  const kSign = await hmacSha256(kService, "aws4_request");
  const sig = await hmacSha256Hex(kSign, stringToSign);
  return {
    ...headers,
    Authorization: `AWS4-HMAC-SHA256 Credential=${r2.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${sig}`,
  };
}

function r2Endpoint(key = "") {
  const r2 = lerR2();
  return `https://${r2.accountId}.r2.cloudflarestorage.com/${r2.bucket}${key ? "/" + key : ""}`;
}

function r2PublicoUrl(key) {
  const r2 = lerR2();
  if (!r2.publicUrl) return r2Endpoint(key);
  return r2.publicUrl.replace(/\/$/, "") + "/" + key;
}

async function subirParaR2(file, key) {
  const url = r2Endpoint(key);
  const body = new Uint8Array(await file.arrayBuffer());
  const headers = await assinarR2("PUT", url, body);
  headers["Content-Type"] = file.type || "audio/mpeg";
  const resp = await fetch(url, { method: "PUT", headers, body });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`R2 ${resp.status}: ${txt.slice(0, 300)}`);
  }
  return r2PublicoUrl(key);
}

async function listarR2(prefix = "") {
  const r2 = lerR2();
  if (!r2.accountId || !r2.bucket) throw new Error("R2 não configurado.");
  const url = new URL(r2Endpoint());
  url.searchParams.set("list-type", "2");
  url.searchParams.set("max-keys", "1000");
  if (prefix) url.searchParams.set("prefix", prefix);
  const headers = await assinarR2("GET", url.toString(), null);
  const resp = await fetch(url.toString(), { headers });
  if (!resp.ok) throw new Error(`R2 ${resp.status}`);
  const xml = await resp.text();
  return [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
}

$("#testarR2").addEventListener("click", async () => {
  try {
    const keys = await listarR2("audio/");
    toast(`R2 conectado. ${keys.length} arquivo(s) em audio/.`);
  } catch (e) {
    toast("R2: " + e.message, 5000);
  }
});

/* Importar músicas listando R2 */
$("#importarR2").addEventListener("click", async () => {
  const r2 = lerR2();
  if (!r2.accountId || !r2.bucket) {
    toast("Configure o R2 em Configurações primeiro.");
    return;
  }
  try {
    const keys = await listarR2("audio/musicas/");
    const mp3s = keys.filter((k) => /\.(mp3|m4a|ogg|wav|aac)$/i.test(k));
    if (!mp3s.length) { toast("Nenhum MP3 encontrado em audio/musicas/ no R2."); return; }
    const jaExistentes = new Set(estado.musicas.map((m) => {
      if (m.arquivo && m.arquivo.startsWith("http")) {
        const u = new URL(m.arquivo);
        return u.pathname.replace(/^\/[^/]+\//, ""); // remove bucket prefix
      }
      return m.arquivo;
    }));
    let n = 0;
    for (const key of mp3s) {
      if (jaExistentes.has(key)) continue;
      const pubUrl = r2PublicoUrl(key);
      const titulo = tituloDoArquivo(key.replace(/^audio\/musicas\//, ""));
      const id = idUnico(titulo, estado.musicas);
      estado.musicas.push({ id, titulo, artista: "", genero: "", modelo: "Suno", prompt: "", arquivo: pubUrl, duracao: 0, ativa: true, adicionadaEm: new Date().toISOString().slice(0, 10) });
      n++;
    }
    if (n) { renderizarMusicas(); mudou(); toast(`${n} música(s) importada(s) do R2. Complete duração, gênero e prompt em Editar.`, 5000); }
    else toast("Todas as músicas do R2 já estão cadastradas.");
  } catch (e) {
    toast("Erro ao listar R2: " + e.message, 5000);
  }
});

/* upload de áudio: R2 se configurado, senão GitHub */
async function enviarAudio(file, caminhoGithub) {
  const r2 = lerR2();
  if (r2.accountId && r2.bucket && r2.accessKeyId && r2.secretAccessKey) {
    const key = caminhoGithub; // ex: audio/musicas/nome.mp3
    return { tipo: "r2", url: await subirParaR2(file, key) };
  }
  if (file.size > 95 * 1048576) throw new Error("Arquivo maior que 95 MB. Configure o R2 ou converta para MP3.");
  guardarArquivo(caminhoGithub, file);
  return { tipo: "github", url: caminhoGithub };
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

function mudou() { atualizarPendentes(); }

/* ---------- abas ---------- */
function irPara(aba) {
  $$(".aba").forEach((b) => b.classList.toggle("ativa", b.dataset.aba === aba));
  $$(".painel").forEach((p) => p.classList.toggle("ativo", p.id === `aba-${aba}`));
  if (aba === "simulador") simular();
  if (aba === "grade") renderizarGrade();
  if (aba === "programas") renderizarProgramas();
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
    const noR2 = m.arquivo && m.arquivo.startsWith("http");
    tr.innerHTML = `
      <td class="c"></td>
      <td class="t"><b>${escapar(m.titulo)}${nova ? `<span class="novo">novo</span>` : ""}${noR2 ? `<span class="novo" style="color:var(--lilas);border-color:#b9a6ff55">R2</span>` : ""}</b><span>${escapar(m.artista || "Artista não informado")}</span><div class="p" title="${escapar(m.prompt || "")}">${escapar(m.prompt || "sem prompt")}</div></td>
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
    if (!confirm(`Excluir "${m.titulo}"?`)) return;
    if (!m.arquivo?.startsWith("http")) descartarArquivo(m.arquivo);
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
  previa.play().catch(() => toast("Não consegui tocar esse arquivo."));
  botao.textContent = "Parar";
  botaoOuvindo = botao;
}
previa.addEventListener("ended", () => { if (botaoOuvindo) botaoOuvindo.textContent = "Ouvir"; botaoOuvindo = null; });

function camposMusica(m = {}) {
  const novo = !m.id;
  const usaR2 = lerR2().accountId;
  return `
    <label>Arquivo de áudio ${novo ? "(obrigatório)" : "(envie outro só se quiser trocar)"}${usaR2 ? " · será enviado ao R2" : ""}<input type="file" name="arquivo" accept="audio/*" ${novo ? "required" : ""}></label>
    <div class="duas">
      <label>Título<input name="titulo" value="${escapar(m.titulo || "")}" required></label>
      <label>Artista (persona de IA)<input name="artista" value="${escapar(m.artista || "")}" placeholder="Ex.: Nuvem Neural"></label>
    </div>
    <div class="duas">
      <label>Gênero<input name="genero" list="dlGeneros" value="${escapar(m.genero || "")}" required placeholder="lofi, pop, sertanejo..."></label>
      <label>Modelo de IA usado<input name="modelo" list="dlModelos" value="${escapar(m.modelo || "Suno")}"></label>
    </div>
    <label>Prompt que gerou a música (aparece para o ouvinte)<textarea name="prompt" placeholder="Ex.: samba rock instrumental, guitarra suingada">${escapar(m.prompt || "")}</textarea></label>
    <label>Capa (opcional, JPG ou PNG quadrado)<input type="file" name="capa" accept="image/*"></label>
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
    const caminhoGithub = `audio/musicas/${m.id}.${extensao(arquivo)}`;
    const btn = $("#modalSalvar");
    btn.textContent = "Enviando...";
    try {
      const r = await enviarAudio(arquivo, caminhoGithub);
      if (m.arquivo && !m.arquivo.startsWith("http")) descartarArquivo(m.arquivo);
      m.arquivo = r.url;
      m.duracao = duracao;
    } catch (e) {
      toast(e.message, 5000); return false;
    } finally { btn.textContent = "Salvar"; }
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
    if (!duracao) continue;
    const titulo = tituloDoArquivo(f.name);
    const id = idUnico(titulo, estado.musicas);
    const caminho = `audio/musicas/${id}.${extensao(f)}`;
    try {
      const r = await enviarAudio(f, caminho);
      estado.musicas.push({ id, titulo, artista: "", genero: generoPadrao, modelo: "Suno", prompt: "", arquivo: r.url, duracao, ativa: true, adicionadaEm: new Date().toISOString().slice(0, 10) });
      n++;
    } catch (e) {
      toast(`Erro em ${f.name}: ${e.message}`, 5000);
    }
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

/* ---------- programas ---------- */
function renderizarProgramas() {
  const cont = $("#listaProgramas");
  if (!estado.programas.length) {
    cont.innerHTML = `<div style="padding:32px;text-align:center;color:var(--suave)">Nenhum programa cadastrado. Clique em Novo programa.</div>`;
    return;
  }
  cont.innerHTML = estado.programas.map((p, pi) => {
    const eps = (p.episodios || []);
    const epsHtml = eps.length
      ? `<div class="programa-episodios">
          <div class="tabela-wrap" style="border:0;border-radius:0">
            <table class="tabela">
              <thead><tr><th>Episódio</th><th>Duração</th><th>No ar</th><th></th></tr></thead>
              <tbody>${eps.map((ep, ei) => `
                <tr>
                  <td><b>${escapar(ep.titulo)}</b>${ep.arquivo?.startsWith("http") ? `<span class="novo" style="color:var(--lilas);border-color:#b9a6ff55">R2</span>` : (arquivosNovos.has(ep.arquivo) ? `<span class="novo">novo</span>` : "")}</td>
                  <td class="mono">${formatarTempo(ep.duracao)}</td>
                  <td><label class="chave"><input type="checkbox" ${ep.ativa !== false ? "checked" : ""} data-ep-ativa="${pi}-${ei}"><span></span></label></td>
                  <td class="td-acoes">
                    <button class="btn mini" data-ep-ouvir="${pi}-${ei}">Ouvir</button>
                    <button class="btn mini" data-ep-editar="${pi}-${ei}">Editar</button>
                    <button class="btn mini perigo" data-ep-excluir="${pi}-${ei}">Excluir</button>
                  </td>
                </tr>`).join("")}
              </tbody>
            </table>
          </div>
          <div class="ep-acoes-linha"><button class="btn fantasma mini" data-novo-ep="${pi}">+ Novo episódio</button></div>
        </div>`
      : `<div class="programa-episodios"><div class="ep-acoes-linha" style="color:var(--suave);font-size:.85rem">Sem episódios ainda. <button class="btn fantasma mini" data-novo-ep="${pi}" style="margin-left:8px">+ Adicionar episódio</button></div></div>`;
    return `<div class="programa-card" data-pi="${pi}">
      <div class="programa-cabecalho">
        <div class="programa-info">
          <strong>${escapar(p.nome)}</strong>
          <span>${escapar(p.apresentador || "")}</span>
          ${p.descricao ? `<div class="dica" style="margin-top:4px">${escapar(p.descricao)}</div>` : ""}
        </div>
        <div class="programa-acoes">
          <span class="tag">${eps.length} ep.</span>
          <label class="chave"><input type="checkbox" ${p.ativa !== false ? "checked" : ""} data-p-ativa="${pi}"><span></span></label>
          <button class="btn mini" data-p-editar="${pi}">Editar</button>
          <button class="btn mini perigo" data-p-excluir="${pi}">Excluir</button>
        </div>
      </div>
      ${epsHtml}
    </div>`;
  }).join("");
}

function camposPrograma(p = {}) {
  return `
    <label>Nome do programa<input name="nome" value="${escapar(p.nome || "")}" required></label>
    <label>Apresentador / Host<input name="apresentador" value="${escapar(p.apresentador || "")}"></label>
    <label>Descrição<textarea name="descricao">${escapar(p.descricao || "")}</textarea></label>
    <label class="check"><input type="checkbox" name="ativa" ${p.ativa !== false ? "checked" : ""}> No ar</label>`;
}

function camposEpisodio(ep = {}) {
  const usaR2 = lerR2().accountId;
  return `
    <label>Arquivo de áudio ${ep.id ? "(opcional: envie outro para trocar)" : "(obrigatório)"}${usaR2 ? " · será enviado ao R2" : ""}<input type="file" name="arquivo" accept="audio/*" ${ep.id ? "" : "required"}></label>
    <label>Título<input name="titulo" value="${escapar(ep.titulo || "")}" required></label>
    <label class="check"><input type="checkbox" name="ativa" ${ep.ativa !== false ? "checked" : ""}> No ar</label>`;
}

async function salvarPrograma(fd, existente) {
  const p = existente || { id: idUnico(fd.get("nome"), estado.programas), episodios: [] };
  p.nome = String(fd.get("nome")).trim();
  p.apresentador = String(fd.get("apresentador")).trim();
  p.descricao = String(fd.get("descricao")).trim();
  p.ativa = fd.get("ativa") === "on";
  if (!existente) estado.programas.push(p);
  renderizarProgramas(); mudou();
}

async function salvarEpisodio(fd, programa, existente) {
  const ep = existente || { id: idUnico(fd.get("titulo"), programa.episodios || []) };
  const arquivo = fd.get("arquivo");
  if (arquivo && arquivo.size) {
    const duracao = await lerDuracao(arquivo);
    if (!duracao) { toast("Não consegui ler esse áudio."); return false; }
    const caminho = `audio/programas/${programa.id}/${ep.id}.${extensao(arquivo)}`;
    const btn = $("#modalSalvar");
    btn.textContent = "Enviando...";
    try {
      const r = await enviarAudio(arquivo, caminho);
      if (ep.arquivo && !ep.arquivo.startsWith("http")) descartarArquivo(ep.arquivo);
      ep.arquivo = r.url;
      ep.duracao = duracao;
    } catch (e) {
      toast(e.message, 5000); return false;
    } finally { btn.textContent = "Salvar"; }
  }
  ep.titulo = String(fd.get("titulo")).trim();
  ep.ativa = fd.get("ativa") === "on";
  if (!ep.adicionadoEm) ep.adicionadoEm = new Date().toISOString().slice(0, 10);
  if (!existente) {
    if (!programa.episodios) programa.episodios = [];
    programa.episodios.push(ep);
  }
  renderizarProgramas(); mudou();
}

$("#novoPrograma").addEventListener("click", () => abrirModal("Novo programa", camposPrograma(), (fd) => salvarPrograma(fd, null)));

$("#listaProgramas").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  const pi = b.dataset.pEditar !== undefined ? Number(b.dataset.pEditar)
    : b.dataset.pExcluir !== undefined ? Number(b.dataset.pExcluir)
    : b.dataset.novoEp !== undefined ? Number(b.dataset.novoEp) : null;

  if (b.dataset.pEditar !== undefined) {
    const p = estado.programas[pi];
    abrirModal("Editar programa", camposPrograma(p), (fd) => salvarPrograma(fd, p));
    return;
  }
  if (b.dataset.pExcluir !== undefined) {
    const p = estado.programas[pi];
    if (!confirm(`Excluir o programa "${p.nome}" e todos os episódios?`)) return;
    estado.programas.splice(pi, 1);
    renderizarProgramas(); mudou();
    return;
  }
  if (b.dataset.novoEp !== undefined) {
    const p = estado.programas[pi];
    abrirModal(`Novo episódio: ${p.nome}`, camposEpisodio(), (fd) => salvarEpisodio(fd, p, null));
    return;
  }

  // episode actions: data-ep-ouvir, data-ep-editar, data-ep-excluir
  const epKey = b.dataset.epOuvir || b.dataset.epEditar || b.dataset.epExcluir;
  if (!epKey) return;
  const [ePi, eEi] = epKey.split("-").map(Number);
  const prog = estado.programas[ePi];
  const ep = prog.episodios[eEi];

  if (b.dataset.epOuvir !== undefined) { ouvir(ep.arquivo, b); return; }
  if (b.dataset.epEditar !== undefined) {
    abrirModal(`Editar episódio: ${prog.nome}`, camposEpisodio(ep), (fd) => salvarEpisodio(fd, prog, ep));
    return;
  }
  if (b.dataset.epExcluir !== undefined) {
    if (!confirm(`Excluir o episódio "${ep.titulo}"?`)) return;
    if (!ep.arquivo?.startsWith("http")) descartarArquivo(ep.arquivo);
    prog.episodios.splice(eEi, 1);
    renderizarProgramas(); mudou();
  }
});

$("#listaProgramas").addEventListener("change", (e) => {
  const pi = e.target.dataset.pAtiva;
  if (pi !== undefined) { estado.programas[Number(pi)].ativa = e.target.checked; mudou(); return; }
  const epKey = e.target.dataset.epAtiva;
  if (epKey) {
    const [ePi, eEi] = epKey.split("-").map(Number);
    estado.programas[ePi].episodios[eEi].ativa = e.target.checked; mudou();
  }
});

/* ---------- grade ---------- */
function validarHora(h) { return /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/.test(h); }

function diasSemanaHtml(selecionados = []) {
  return `<div class="dias-semana">${DIAS_NOMES.map((d) => `<label><input type="checkbox" data-dia="${d}" ${selecionados.includes(d) ? "checked" : ""}> ${DIAS_LABELS[d]}</label>`).join("")}</div>`;
}

function analisarGrade() {
  const alertas = [];
  const cobertura = new Uint8Array(1440);
  for (const b of estado.grade) {
    if (!b.diasDaSemana || !b.diasDaSemana.length) {
      if (!validarHora(b.inicio) || !validarHora(b.fim)) { alertas.push(`O bloco "${b.nome}" tem horário inválido.`); continue; }
      let ini = horaParaSeg(b.inicio) / 60, fim = (horaParaSeg(b.fim) || DIA) / 60;
      if (fim <= ini) fim += 1440;
      for (let t = ini; t < fim; t++) cobertura[t % 1440]++;
    }
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
  if (buracos.length) alertas.push(`Horários sem bloco (toca tudo): ${buracos.join(", ")}.`);
  if (sobrepostos.length) alertas.push(`Blocos sobrepostos: ${sobrepostos.join(", ")}.`);
  const cont = contagemPorGenero();
  for (const b of estado.grade) {
    if (b.tipo === "programa") continue;
    const total = (b.generos || []).reduce((s, g) => s + (cont[normalizarGenero(g)] || 0), 0);
    if (!total) alertas.push(`Bloco "${b.nome}" não tem músicas dos gêneros escolhidos.`);
    else if (total < 4) alertas.push(`Bloco "${b.nome}" tem só ${total} música(s). Vai repetir bastante.`);
  }
  return alertas;
}

function renderizarPreviaGrade() {
  const prev = $("#previaGrade");
  prev.innerHTML = [...estado.grade]
    .filter((b) => !b.diasDaSemana?.length && validarHora(b.inicio) && validarHora(b.fim))
    .sort((a, b) => horaParaSeg(a.inicio) - horaParaSeg(b.inicio))
    .map((b) => {
      const dur = ((horaParaSeg(b.fim) || DIA) - horaParaSeg(b.inicio) + DIA) % DIA || DIA;
      const corBase = b.tipo === "programa" ? ["#1b1828", "#b9a6ff", "#6b5bff", "#f4f1ff"] : paletaDe((b.generos || [])[0], b.id);
      const [, c1, c2] = corBase;
      return `<div style="width:${(dur / DIA) * 100}%;background:linear-gradient(90deg,${c1}66,${c2}66)" title="${escapar(b.nome)}">${escapar(b.nome)}</div>`;
    }).join("");
  const alertas = analisarGrade();
  $("#alertasGrade").innerHTML = alertas.length
    ? alertas.map((a) => `<div class="alerta">${escapar(a)}</div>`).join("")
    : `<div class="alerta ok">Grade configurada.</div>`;
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

function programasOptions(selecionado) {
  return estado.programas.map((p) => `<option value="${escapar(p.id)}" ${p.id === selecionado ? "selected" : ""}>${escapar(p.nome)}</option>`).join("");
}

function renderizarGrade() {
  const cont = $("#listaGrade");
  cont.innerHTML = estado.grade.map((b, i) => {
    const ePrograma = b.tipo === "programa";
    return `
    <div class="bloco-edit" data-i="${i}">
      <label>Nome do bloco<input data-campo="nome" value="${escapar(b.nome)}"></label>
      <label>Início<input data-campo="inicio" value="${escapar(b.inicio)}" placeholder="06:00" maxlength="5"></label>
      <label>Fim<input data-campo="fim" value="${escapar(b.fim)}" placeholder="10:00" maxlength="5"></label>
      <label>Tipo<select data-campo="tipo" class="bloco-tipo">
        <option value="" ${!ePrograma ? "selected" : ""}>Musical</option>
        <option value="programa" ${ePrograma ? "selected" : ""}>Programa</option>
      </select></label>
      <button class="btn mini perigo" data-remover="${i}" style="align-self:start">Remover</button>
      ${ePrograma
        ? `<label style="grid-column:1/-2">Programa<select data-campo="programaId">${programasOptions(b.programaId)}</select></label>`
        : `<label style="grid-column:1/-2">Gêneros (separe por vírgula)<input data-campo="generos" list="dlGenerosGrade" value="${escapar((b.generos || []).join(", "))}"><div class="gs">${chipsGeneros(b)}</div></label>`
      }
      <label style="grid-column:1/-1">Dias da semana (vazio = todos os dias)
        ${diasSemanaHtml(b.diasDaSemana || [])}
      </label>
      <textarea data-campo="descricao" style="grid-column:1/-1" placeholder="Descrição">${escapar(b.descricao || "")}</textarea>
    </div>`;
  }).join("") + datalist("dlGenerosGrade", generosConhecidos());
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
  } else if (campo === "tipo") {
    b.tipo = e.target.value || undefined;
    if (b.tipo === "programa") { b.generos = []; } else { delete b.programaId; }
    renderizarGrade(); return;
  } else {
    b[campo] = e.target.value;
  }
  if (campo === "nome" && !original.grade.some((x) => x.id === b.id)) b.id = idUnico(b.nome, estado.grade.filter((x) => x !== b));
  renderizarPreviaGrade(); mudou();
});

$("#listaGrade").addEventListener("change", (e) => {
  if (e.target.dataset.dia !== undefined) {
    const caixa = e.target.closest(".bloco-edit");
    const b = estado.grade[caixa.dataset.i];
    const checked = $$("[data-dia]", caixa).filter((cb) => cb.checked).map((cb) => cb.dataset.dia);
    b.diasDaSemana = checked;
    renderizarPreviaGrade(); mudou();
  }
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
  estado.grade.push({ id: idUnico("novo-bloco", estado.grade), nome: "Novo bloco", inicio: ultimo ? ultimo.fim : "00:00", fim: "24:00", generos: [], diasDaSemana: [], descricao: "" });
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
    <div><b>${linha.filter((x) => x.tipo === "musica").length}</b><span>músicas/episódios no dia</span></div>
    <div><b>${distintas}</b><span>faixas diferentes</span></div>
    <div><b>${maxRep}x</b><span>maior repetição</span></div>
    <div><b>${linha.filter((x) => x.tipo === "vinheta").length}</b><span>vinhetas</span></div>`;
  let ini = linha.findIndex((x) => x.fim > seg);
  if (ini < 0) ini = 0;
  const agora = p.noAr();
  const nomeBloco = (id) => (p.grade.find((b) => b.id === id) || { nome: "Programação livre" }).nome;
  $("#simTabela").innerHTML = linha.slice(ini, ini + 60).map((x, k) => {
    const atual = agora && agora.data === dataEl.value && agora.indice === ini + k;
    return `<tr class="${x.tipo === "vinheta" ? "linha-vinheta" : ""} ${atual ? "linha-atual" : ""}">
      <td class="mono">${segParaHora(x.inicio)}${atual ? " · agora" : ""}</td>
      <td>${x.tipo === "musica" ? (x.ref._episodio ? "episódio" : "música") : "vinheta"}</td>
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
function lerGithub() { try { return JSON.parse(localStorage.getItem(CHAVE_GH)) || {}; } catch (e) { return {}; } }
function salvarGithub(cfg) { try { localStorage.setItem(CHAVE_GH, JSON.stringify(cfg)); } catch (e) {} }
function preencherGithub() {
  const cfg = lerGithub();
  const f = $("#formGithub");
  if (!cfg.dono || !cfg.repo) {
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
    if (r.status === 403) msg += " (token sem permissão de escrita)";
    if (r.status === 404) msg += " (repositório não encontrado)";
    if (r.status === 409) msg += " (repositório vazio: crie com um README)";
    throw new Error(msg);
  }
  return opcoes.raw ? r.text() : r.status === 204 ? null : r.json();
}

$("#testarGithub").addEventListener("click", async () => {
  try {
    const repo = await gh("");
    const pode = repo.permissions && repo.permissions.push;
    log(`Conectado a ${repo.full_name}. ${pode ? "Permissão de escrita confirmada." : "Sem permissão de escrita."}`);
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
    if (JSON.stringify(estado.musicas) !== JSON.stringify(original.musicas)) resumo.push("músicas");
    if (JSON.stringify(estado.programas) !== JSON.stringify(original.programas)) resumo.push("programas");
    if (JSON.stringify(estado.grade) !== JSON.stringify(original.grade)) resumo.push("grade");
    if (arquivosExcluir.size) resumo.push(`${arquivosExcluir.size} arquivo(s) removido(s)`);
    const commit = await gh("/git/commits", {
      method: "POST",
      body: JSON.stringify({ message: `Estúdio Rádio Prompt: ${resumo.join(", ") || "atualização"}`, tree: novaArvore.sha, parents: [ref.object.sha] }),
    });
    await gh(`/git/refs/heads/${encodeURIComponent(branch)}`, { method: "PATCH", body: JSON.stringify({ sha: commit.sha }) });

    original = clonar(estado);
    arquivosNovos.clear();
    arquivosExcluir.clear();
    log("Publicado. GitHub Pages atualiza em 1 a 2 minutos; ouvintes recebem a nova grade em até 10 minutos.");
    toast("Publicado com sucesso.");
    renderizarMusicas(); renderizarVinhetas(); renderizarProgramas(); atualizarPendentes();
  } catch (e) {
    log(`Erro: ${e.message}`);
    toast("Publicação falhou. Nada foi alterado.", 4000);
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
    const pares = await Promise.all(Object.entries(ARQ_DADOS).map(async ([k, c]) => {
      try {
        return [k, JSON.parse(await gh(`/contents/${c}?ref=${branch}`, { raw: true }))];
      } catch (e) {
        return [k, k === "programas" ? [] : (k === "grade" ? [] : (k === "config" ? {} : []))];
      }
    }));
    return Object.fromEntries(pares);
  } catch (e) {
    console.warn("Carregando dados do site em vez do GitHub", e);
    return null;
  }
}

async function iniciar() {
  preencherGithub();
  preencherFormR2();
  const dados = (await carregarDoGithub()) || (await carregarDados());
  original = clonar({
    config: dados.config || {},
    musicas: dados.musicas || [],
    vinhetas: dados.vinhetas || [],
    grade: dados.grade || [],
    programas: dados.programas || [],
  });
  estado = clonar(original);
  renderizarMusicas();
  renderizarVinhetas();
  renderizarProgramas();
  renderizarGrade();
  renderizarConfig();
  atualizarPendentes();
}
iniciar();
