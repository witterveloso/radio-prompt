/* =========================================================
   Rádio Prompt · motor de programação
   Calcula, a partir do relógio, o que está tocando agora.
   Todo ouvinte calcula a mesma grade, então todos escutam
   a mesma faixa no mesmo segundo, sem servidor de streaming.
   ========================================================= */

export const DIA = 86400;

/* ---------- utilidades ---------- */
export function hashTexto(str) {
  let h1 = 0xdeadbeef ^ 0, h2 = 0x41c6ce57 ^ 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0) * 4294967296 + (h1 >>> 0);
}

export function aleatorio(semente) {
  let a = typeof semente === "number" ? semente >>> 0 : hashTexto(String(semente)) >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function embaralhar(lista, rnd) {
  const a = lista.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function horaParaSeg(hhmm) {
  const [h, m] = String(hhmm || "0:0").split(":").map(Number);
  return Math.min(DIA, (h || 0) * 3600 + (m || 0) * 60);
}

export function segParaHora(seg) {
  seg = ((Math.floor(seg) % DIA) + DIA) % DIA;
  const h = Math.floor(seg / 3600), m = Math.floor((seg % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function formatarTempo(seg) {
  seg = Math.max(0, Math.floor(seg || 0));
  const m = Math.floor(seg / 60), s = seg % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function escapar(txt) {
  return String(txt ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function normalizarGenero(g) {
  return String(g || "").trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function proximaData(dataStr, delta = 1) {
  const [y, m, d] = dataStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  return dt.toISOString().slice(0, 10);
}

const DIAS_SEMANA = ["dom", "seg", "ter", "qua", "qui", "sex", "sab"];
function diaDaSemana(dataStr) {
  return DIAS_SEMANA[new Date(dataStr + "T12:00:00Z").getUTCDay()];
}

/* ---------- carregamento ---------- */
export async function carregarDados(base = "") {
  const pegar = async (arq, padrao) => {
    try {
      const r = await fetch(`${base}data/${arq}?v=${Date.now()}`, { cache: "no-store" });
      if (!r.ok) throw new Error(r.status);
      return await r.json();
    } catch (e) {
      console.warn("Não foi possível carregar", arq, e);
      return padrao;
    }
  };
  const [config, musicas, vinhetas, grade, programas] = await Promise.all([
    pegar("config.json", {}),
    pegar("musicas.json", []),
    pegar("vinhetas.json", []),
    pegar("grade.json", []),
    pegar("programas.json", []),
  ]);
  return { config, musicas, vinhetas, grade, programas };
}

/* ---------- programação ---------- */
export class Programacao {
  constructor(dados) {
    this.atualizar(dados);
    this.desvioRelogio = 0;
  }

  atualizar({ config = {}, musicas = [], vinhetas = [], grade = [], programas = [] }) {
    this.config = Object.assign(
      { fusoHorario: "America/Sao_Paulo", vinhetaACadaMusicas: 3, aberturaDeBloco: true },
      config
    );
    this.musicas = musicas.filter((m) => m.ativa !== false && Number(m.duracao) > 0);
    this.vinhetas = vinhetas.filter((v) => v.ativa !== false && Number(v.duracao) > 0);
    this.programas = programas.filter((p) => p.ativa !== false);
    this.grade = grade
      .map((b) => ({ ...b, _ini: horaParaSeg(b.inicio), _fim: horaParaSeg(b.fim) || DIA }))
      .sort((a, b) => a._ini - b._ini);
    this._cache = new Map();
    this._fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: this.config.fusoHorario,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    });
  }

  /* relógio corrigido pelo horário do servidor (cabeçalho Date) */
  async sincronizarRelogio(url = "data/config.json") {
    try {
      const t0 = Date.now();
      const r = await fetch(`${url}?t=${t0}`, { method: "HEAD", cache: "no-store" });
      const t1 = Date.now();
      const data = r.headers.get("date");
      if (!data) return;
      const servidor = new Date(data).getTime() + 500;
      const desvio = servidor - (t0 + t1) / 2;
      if (Math.abs(desvio) > 2500) this.desvioRelogio = desvio;
    } catch (e) { /* segue com o relógio local */ }
  }

  agoraMs() { return Date.now() + this.desvioRelogio; }

  partesNoFuso(ms) {
    const p = Object.fromEntries(this._fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    const seg = Number(p.hour) * 3600 + Number(p.minute) * 60 + Number(p.second) + (ms % 1000) / 1000;
    return { data: `${p.year}-${p.month}-${p.day}`, seg };
  }

  blocoEm(seg) {
    for (const b of this.grade) {
      if (b._ini <= b._fim) { if (seg >= b._ini && seg < b._fim) return b; }
      else if (seg >= b._ini || seg < b._fim) return b;
    }
    return { id: "livre", nome: "Programação livre", generos: [], descricao: "", _ini: 0, _fim: DIA, _livre: true };
  }

  poolDoBloco(bloco) {
    const gs = (bloco.generos || []).map(normalizarGenero).filter(Boolean);
    if (!gs.length) return this.musicas;
    const pool = this.musicas.filter((m) => gs.includes(normalizarGenero(m.genero)));
    return pool.length ? pool : this.musicas;
  }

  /* monta a linha do tempo completa de um dia (00:00 até 24:00) */
  linhaDoDia(data) {
    if (this._cache.has(data)) return this._cache.get(data);
    const linha = [];

    const temMusicas = this.musicas.length > 0;
    const temProgramas = this.programas.some((p) =>
      (p.episodios || []).some((e) => e.ativa !== false && Number(e.duracao) > 0)
    );
    if (!temMusicas && !temProgramas) { this._cache.set(data, linha); return linha; }

    // Filtra blocos pelo dia da semana
    const dia = diaDaSemana(data);
    const gradeDoDia = this.grade.filter(
      (b) => !b.diasDaSemana || !b.diasDaSemana.length || b.diasDaSemana.includes(dia)
    );

    const blocoEmDia = (seg) => {
      for (const b of gradeDoDia) {
        if (b._ini <= b._fim) { if (seg >= b._ini && seg < b._fim) return b; }
        else if (seg >= b._ini || seg < b._fim) return b;
      }
      return { id: "livre", nome: "Programação livre", generos: [], descricao: "", _ini: 0, _fim: DIA, _livre: true };
    };

    const ids = this.vinhetas.filter((v) => v.tipo !== "abertura");
    const aberturas = this.vinhetas.filter((v) => v.tipo === "abertura");
    const N = Number(this.config.vinhetaACadaMusicas) || 0;
    const sacos = new Map();
    const rodadas = new Map();
    const epIndices = new Map();
    let t = 0, blocoAtual = null, cont = 0, ultima = null, idxVinheta = 0;

    const empurrar = (tipo, ref, bloco) => {
      const d = Math.max(1, Number(ref.duracao));
      linha.push({ tipo, ref, inicio: t, fim: t + d, blocoId: bloco.id, data });
      t += d;
    };

    const tirarDoSaco = (bloco) => {
      const pool = this.poolDoBloco(bloco);
      if (!pool.length) return null;
      let saco = sacos.get(bloco.id);
      if (!saco || !saco.length) {
        const r = (rodadas.get(bloco.id) || 0) + 1;
        rodadas.set(bloco.id, r);
        saco = embaralhar(pool, aleatorio(`${data}|${bloco.id}|${r}`));
        if (saco.length > 1 && ultima && saco[saco.length - 1].id === ultima.id) {
          [saco[0], saco[saco.length - 1]] = [saco[saco.length - 1], saco[0]];
        }
        sacos.set(bloco.id, saco);
      }
      return saco.pop();
    };

    let guarda = 0;
    while (t < DIA && guarda++ < 20000) {
      const bloco = blocoEmDia(t);
      if (bloco.id !== blocoAtual) {
        blocoAtual = bloco.id;
        cont = 0;
        if (this.config.aberturaDeBloco && aberturas.length && linha.length) {
          empurrar("vinheta", aberturas[idxVinheta++ % aberturas.length], bloco);
          continue;
        }
      }

      /* bloco de programa: toca episódios em sequência */
      if (bloco.tipo === "programa" && bloco.programaId) {
        const prog = this.programas.find((p) => p.id === bloco.programaId);
        if (prog) {
          const eps = (prog.episodios || []).filter((e) => e.ativa !== false && Number(e.duracao) > 0);
          if (eps.length) {
            const idx = epIndices.get(bloco.id) || 0;
            empurrar("musica", { ...eps[idx % eps.length], _episodio: true, artista: prog.apresentador || "" }, bloco);
            epIndices.set(bloco.id, idx + 1);
            cont++;
            continue;
          }
        }
        /* programa sem episódios: cai para musical */
      }

      /* bloco musical */
      const musica = tirarDoSaco(bloco);
      if (!musica) break;
      empurrar("musica", musica, bloco);
      ultima = musica;
      cont++;
      if (N > 0 && ids.length && cont % N === 0 && t < DIA && blocoEmDia(t).id === bloco.id) {
        empurrar("vinheta", ids[idxVinheta++ % ids.length], bloco);
      }
    }
    this._cache.set(data, linha);
    return linha;
  }

  /* o que está no ar em um instante (ms) */
  noAr(ms = this.agoraMs()) {
    const { data, seg } = this.partesNoFuso(ms);
    const linha = this.linhaDoDia(data);
    if (!linha.length) return null;
    let lo = 0, hi = linha.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (linha[mid].inicio <= seg) lo = mid; else hi = mid - 1;
    }
    const item = linha[lo];
    return {
      item, indice: lo, data, seg,
      offset: Math.max(0, seg - item.inicio),
      restante: Math.max(0, item.fim - seg),
      bloco: this.blocoEm(seg),
    };
  }

  /* itens a partir de uma posição, atravessando a meia-noite se precisar */
  sequencia(data, indice, quantidade, direcao = 1) {
    const out = [];
    let d = data, i = indice, linha = this.linhaDoDia(d);
    while (out.length < quantidade && linha.length) {
      i += direcao;
      if (i >= linha.length) { d = proximaData(d, 1); linha = this.linhaDoDia(d); i = 0; }
      if (i < 0) { d = proximaData(d, -1); linha = this.linhaDoDia(d); i = linha.length - 1; }
      out.push(linha[i]);
    }
    return out;
  }

  proximas(n = 4) {
    const a = this.noAr();
    if (!a) return [];
    return this.sequencia(a.data, a.indice, n * 3, 1).filter((x) => x.tipo === "musica" && x.inicio < DIA).slice(0, n);
  }

  anteriores(n = 6) {
    const a = this.noAr();
    if (!a) return [];
    return this.sequencia(a.data, a.indice, n * 3, -1).filter((x) => x.tipo === "musica").slice(0, n);
  }
}

/* ---------- capa generativa ---------- */
const PALETAS = {
  lofi: ["#2b1d3a", "#f2a65a", "#e85d75", "#ffd6a5"],
  synthwave: ["#160b33", "#ff2e88", "#7b2cff", "#21e1ff"],
  bossa: ["#0f3b33", "#f6c453", "#3ab795", "#fef6e4"],
  house: ["#0b0b18", "#ff5a1f", "#6b5bff", "#f4f1ff"],
  ambient: ["#0a1a2a", "#5fb3d9", "#b9a6ff", "#e8f6ff"],
  pop: ["#2a0b2e", "#ff4fa3", "#ffcc33", "#ffffff"],
};
export function paletaDe(genero, semente) {
  const p = PALETAS[normalizarGenero(genero)];
  if (p) return p;
  const r = aleatorio(normalizarGenero(genero) || String(semente) + "pal");
  const h = Math.floor(r() * 360);
  return [hslHex(h, 45, 9), hslHex((h + 30) % 360, 90, 60), hslHex((h + 200) % 360, 80, 62), hslHex(h, 60, 92)];
}

function hslHex(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))))).toString(16).padStart(2, "0");
  return `#${f(0)}${f(8)}${f(4)}`;
}

export function desenharCapa(canvas, semente, genero) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const W = canvas.width, H = canvas.height;
  const r = aleatorio(String(semente));
  const [fundo, c1, c2, c3] = paletaDe(genero, semente);
  ctx.fillStyle = fundo;
  ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < 3; i++) {
    const x = r() * W, y = r() * H, rad = W * (0.35 + r() * 0.5);
    const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, [c1, c2, c3][i] + "cc");
    g.addColorStop(1, "transparent");
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
  ctx.globalCompositeOperation = "source-over";
  ctx.lineWidth = Math.max(1, W / 220);
  const linhas = 14 + Math.floor(r() * 10);
  const freq = 2 + r() * 5, amp = H * (0.03 + r() * 0.08), fase = r() * Math.PI * 2;
  for (let l = 0; l < linhas; l++) {
    const y0 = H * 0.18 + (l / linhas) * H * 0.64;
    ctx.strokeStyle = `rgba(255,255,255,${0.08 + 0.25 * (l / linhas)})`;
    ctx.beginPath();
    for (let x = 0; x <= W; x += W / 120) {
      const k = Math.sin((x / W) * Math.PI);
      const y = y0 + Math.sin((x / W) * Math.PI * freq + fase + l * 0.35) * amp * k * (0.3 + l / linhas);
      x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  const img = ctx.getImageData(0, 0, W, H);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (r() - 0.5) * 22;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
}
