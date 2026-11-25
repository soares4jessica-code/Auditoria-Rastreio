const URL_VERSION_JSON = "https://raw.githubusercontent.com/SEU-USUARIO/Auditoria-Rastreio/main/version.json";

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
  statusEl.textContent = "Iniciando leitura dos BRs na planilha...";
  statusEl.style.color = "#188038";

  chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: iniciarAutomacaoEnxuta
  });

  setTimeout(() => window.close(), 700);
});

async function iniciarAutomacaoEnxuta() {
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
    font-weight: bold; box-shadow: 0 4px 12px rgba(0,0,0,0.3); max-width: 400px;
  `;
  banner.textContent = "SPX: Lendo Coluna A...";
  document.body.appendChild(banner);

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  async function irParaCelula(refCelula) {
    const nameBox = document.getElementById("t-name-box") || document.querySelector(".waffle-name-box input");
    if (!nameBox) throw new Error("Caixa de nome do Sheets não encontrada.");

    nameBox.focus();
    nameBox.select();
    document.execCommand("insertText", false, refCelula);
    nameBox.dispatchEvent(new Event("input", { bubbles: true }));
    nameBox.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
    await sleep(170);
  }

  function lerValorCelulaAtual() {
    let textoCopiado = "";
    const onCopy = (e) => {
      if (e.clipboardData) textoCopiado = e.clipboardData.getData("text/plain") || "";
    };
    document.addEventListener("copy", onCopy, true);
    try { document.execCommand("copy"); } finally { document.removeEventListener("copy", onCopy, true); }
    if (textoCopiado.trim()) return textoCopiado.trim();

    const formulaInput = document.querySelector("#t-formula-bar-input .cell-input") ||
                         document.querySelector(".cell-input[aria-label]") ||
                         document.querySelector("#t-formula-bar-input");
    return formulaInput ? (formulaInput.innerText || formulaInput.textContent || "").trim() : "";
  }

  function colarTexto(texto) {
    const alvo = document.querySelector(".grid-container") || document.activeElement || document.body;
    const dt = new DataTransfer();
    dt.setData("text/plain", texto);
    alvo.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }

  // Altere para 3 caso os seus códigos BR comecem na linha 3
  let linha = 2;
  let vaziasSeguidas = 0;
  let processados = 0;
  let pulados = 0;

  try {
    while (vaziasSeguidas < 5) {
      await irParaCelula(`A${linha}`);
      const valorA = lerValorCelulaAtual().toUpperCase();

      if (!valorA) {
        vaziasSeguidas++;
        linha++;
        continue;
      }
      vaziasSeguidas = 0;

      if (!valorA.startsWith("BR")) {
        linha++;
        continue;
      }

      await irParaCelula(`B${linha}`);
      const valorB = lerValorCelulaAtual();

      if (valorB && !valorB.startsWith("Erro:")) {
        pulados++;
        banner.textContent = `Linha ${linha} (${valorA}): Já auditado (${pulados} pulados)...`;
        linha++;
        continue;
      }

      banner.textContent = `Linha ${linha}: Consultando ${valorA}...`;

      const resposta = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: "CONSULTAR_SPX", shipmentId: valorA }, (res) => resolve(res));
      });

      if (resposta && resposta.sucesso && Array.isArray(resposta.dados)) {
        // Preenche apenas B, C, D e E, preservando F e G (fórmulas)
        const cols = ["B", "C", "D", "E"];
        for (let i = 0; i < cols.length; i++) {
          const valLimpo = String(resposta.dados[i] ?? "").replace(/[
	]+/g, " ").trim();
          await irParaCelula(`${cols[i]}${linha}`);
          colarTexto(valLimpo);
          await sleep(120);
        }
        processados++;
      } else {
        const msgErro = resposta && resposta.erro ? resposta.erro : "Falha na consulta";
        await irParaCelula(`B${linha}`);
        colarTexto(`Erro: ${msgErro}`);
        await sleep(120);
      }

      linha++;
    }

    banner.style.background = "#188038";
    banner.textContent = `Concluído! ${processados} atualizados | ${pulados} já preenchidos.`;
    setTimeout(() => banner.remove(), 6000);
  } catch (err) {
    banner.style.background = "#d93025";
    banner.textContent = `Parado na linha ${linha}: ${err.message}`;
  } finally {
    window.__spxRodando = false;
  }
}
