const URL_VERSION_JSON = "https://raw.githubusercontent.com/soares4jessica-code/Auditoria-Rastreio/main/version.json";

document.addEventListener("DOMContentLoaded", async () => {
  const versaoLocal = chrome.runtime.getManifest().version;
  const badge = document.getElementById("versaoAtualBadge");
  if (badge) badge.textContent = `v${versaoLocal}`;

  try {
    const res = await fetch(`${URL_VERSION_JSON}?t=${Date.now()}`);
    if (!res.ok) return;
    const remoto = await res.json();
    if (remoto.version && remoto.version !== versaoLocal) {
      document.getElementById("novaVersaoNum").textContent = `v${remoto.version}`;
      document.getElementById("novaVersaoNotas").textContent = remoto.notes || "";
      document.getElementById("linkDownloadVersao").href = remoto.download_url;
      document.getElementById("avisoAtualizacao").style.display = "block";
    }
  } catch (e) {}
});

document.getElementById("btnIniciar").addEventListener("click", async () => {
  const statusEl = document.getElementById("status");
  const btn = document.getElementById("btnIniciar");

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab || !tab.url || !tab.url.includes("docs.google.com/spreadsheets")) {
    statusEl.textContent = "Abra a aba do Google Sheets primeiro!";
    statusEl.style.color = "#d93025";
    return;
  }

  btn.disabled = true;
  statusEl.textContent = "Iniciando auditoria (pulando já preenchidos)...";
  statusEl.style.color = "#188038";

  chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: iniciarAuditoriaNovosBR
  });

  setTimeout(() => window.close(), 700);
});

async function iniciarAuditoriaNovosBR() {
  if (window.__spxRodando) {
    alert("A auditoria já está rodando nesta aba!");
    return;
  }
  window.__spxRodando = true;

  const banner = document.createElement("div");
  banner.style.cssText = `
    position: fixed; bottom: 20px; right: 20px; z-index: 999999;
    background: #ee4d2d; color: #fff; padding: 12px 18px;
    border-radius: 8px; font-family: Arial, sans-serif; font-size: 13px;
    font-weight: bold; box-shadow: 0 4px 12px rgba(0,0,0,0.3); max-width: 450px;
  `;
  banner.textContent = "SPX: Verificando linhas já preenchidas...";
  document.body.appendChild(banner);

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const regexCodigoBR = /^BR[A-Z0-9](6,)$/i;

  function obterFormulaInput() {
    return document.querySelector("#t-formula-bar-input .cell-input") ||
           document.querySelector(".cell-input[aria-label]") ||
           document.querySelector("#t-formula-bar-input [contenteditable='true']") ||
           document.querySelector("#t-formula-bar-input");
  }

  async function irParaCelula(refCelula) {
    const nameBox = document.getElementById("t-name-box") || document.querySelector(".waffle-name-box input");
    if (!nameBox) throw new Error("Caixa de nome do Sheets não encontrada.");

    nameBox.focus();
    nameBox.select();
    nameBox.value = refCelula;
    nameBox.dispatchEvent(new Event("input", { bubbles: true }));
    nameBox.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
    nameBox.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
    await sleep(170);
  }

  function lerValorCelulaAtual() {
    const formulaInput = obterFormulaInput();
    if (!formulaInput) return "";
    return (formulaInput.innerText || formulaInput.textContent || "").replace(/\u200B/g, "").trim();
  }

  async function escreverNaCelula(refCelula, texto) {
    await irParaCelula(refCelula);
    const formulaInput = obterFormulaInput();
    if (!formulaInput) throw new Error("Barra de fórmulas não encontrada.");

    formulaInput.focus();
    await sleep(30);

    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(formulaInput);
    sel.removeAllRanges();
    sel.addRange(range);

    document.execCommand("insertText", false, texto);
    formulaInput.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(40);

    formulaInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
    formulaInput.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
    await sleep(120);
  }

  let linha = 2;
  let vaziasSeguidas = 0;
  let processados = 0;
  let ignoradosNaoBR = 0;
  let puladosJaPreenchidos = 0;

  try {
    while (vaziasSeguidas < 5) {
      await irParaCelula(`A${linha}`);
      const valorA = lerValorCelulaAtual().toUpperCase().replace(/\s+/g, "");

      if (!valorA) {
        vaziasSeguidas++;
        linha++;
        continue;
      }
      vaziasSeguidas = 0;

      if (!regexCodigoBR.test(valorA)) {
        ignoradosNaoBR++;
        banner.textContent = `Linha ${linha}: Não é BR (ignorado) | Novos: ${processados}`;
        linha++;
        continue;
      }

      // Checa B, C, D e E: se qualquer coluna de resultado já tiver conteúdo válido, pula a linha inteira
      const cols = ["B", "C", "D", "E"];
      let jaTemResultado = false;
      for (const col of cols) {
        await irParaCelula(`${col}${linha}`);
        const valCol = lerValorCelulaAtual();
        if (valCol && !valCol.startsWith("Erro:")) {
          jaTemResultado = true;
          break;
        }
      }

      if (jaTemResultado) {
        puladosJaPreenchidos++;
        banner.textContent = `Linha ${linha} (${valorA}): Já preenchido (${puladosJaPreenchidos} pulados)...`;
        linha++;
        continue;
      }

      banner.textContent = `Linha ${linha}: Consultando ${valorA} no SPX...`;

      const resposta = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: "CONSULTAR_SPX", shipmentId: valorA }, (res) => resolve(res));
      });

      if (resposta && resposta.sucesso && Array.isArray(resposta.dados)) {
        for (let i = 0; i < cols.length; i++) {
          const valLimpo = String(resposta.dados[i] ?? "").replace(/[\r\n\t]+/g, " ").trim();
          await escreverNaCelula(`${cols[i]}${linha}`, valLimpo);
        }
        processados++;
        banner.textContent = `Linha ${linha} (${valorA}) gravada! Total novos: ${processados}`;
      } else {
        const msgErro = resposta && resposta.erro ? resposta.erro : "Falha na consulta";
        await escreverNaCelula(`B${linha}`, `Erro: ${msgErro}`);
        banner.textContent = `Linha ${linha} (${valorA}): ${msgErro}`;
      }

      linha++;
    }

    banner.style.background = "#188038";
    banner.textContent = "Concluído! " + processados + " novos BRs | " + puladosJaPreenchidos + " já preenchidos pulados | " + ignoradosNaoBR + " não-BR ignorados.";
    setTimeout(() => banner.remove(), 8000);
  } catch (err) {
    banner.style.background = "#d93025";
    banner.textContent = `Parado na linha ${linha}: ${err.message}`;
  } finally {
    window.__spxRodando = false;
  }
}
