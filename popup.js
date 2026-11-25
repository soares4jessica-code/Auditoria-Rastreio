const URL_VERSION_JSON = "https://raw.githubusercontent.com/soares4jessica-code/Auditoria-Rastreio/main/version.json";

document.addEventListener("DOMContentLoaded", async () => {
  const versaoLocal = chrome.runtime.getManifest().version;
  const badge = document.getElementById("versaoAtualBadge");
  if (badge) badge.textContent = `v${versaoLocal}`;

  try {
    const res = await fetch(`${URL_VERSION_JSON}?t=${Date.now()}`);
    if (res.ok) {
      const remoto = await res.json();
      if (remoto.version && remoto.version !== versaoLocal) {
        document.getElementById("novaVersaoNum").textContent = `v${remoto.version}`;
        document.getElementById("novaVersaoNotas").textContent = remoto.notes || "";
        document.getElementById("linkDownloadVersao").href = remoto.download_url;
        document.getElementById("avisoAtualizacao").style.display = "block";
      }
    }
  } catch (e) {}

  try {
    const clip = await navigator.clipboard.readText();
    if (clip && /BR[A-Z0-9]{6,}/i.test(clip)) {
      document.getElementById("listaBRs").value = clip.trim();
    }
  } catch (e) {}
});

document.getElementById("btnIniciar").addEventListener("click", async () => {
  const statusEl = document.getElementById("status");
  const btn = document.getElementById("btnIniciar");
  const bruto = document.getElementById("listaBRs").value || "";

  const linhas = bruto.split(/\r?\n/).map(l => l.trim().toUpperCase()).filter(l => l.length > 0);
  const regexBR = /^BR[A-Z0-9]{6,}$/;
  const brsValidos = linhas.filter(l => regexBR.test(l));

  if (brsValidos.length === 0) {
    statusEl.textContent = "Nenhum código BR válido encontrado na caixa acima.";
    statusEl.style.color = "#d93025";
    return;
  }

  btn.disabled = true;
  statusEl.style.color = "#1e293b";

  const linhasSaida = [];
  let okCount = 0;

  for (let i = 0; i < brsValidos.length; i++) {
    const br = brsValidos[i];
    statusEl.textContent = `Consultando ${i + 1} de ${brsValidos.length}: ${br}...`;

    const resposta = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: "CONSULTAR_SPX", shipmentId: br }, (res) => resolve(res));
    });

    if (resposta && resposta.sucesso && Array.isArray(resposta.dados)) {
      const cols = resposta.dados.map(v => String(v ?? "").replace(/[\r\n\t]+/g, " ").trim());
      linhasSaida.push(cols.join("\t"));
      okCount++;
    } else {
      const erroMsg = resposta && resposta.erro ? resposta.erro : "Falha na consulta";
      linhasSaida.push(`Erro: ${erroMsg}\t\t\t`);
    }
  }

  const tsvFinal = linhasSaida.join("\n");
  try {
    await navigator.clipboard.writeText(tsvFinal);
    statusEl.style.color = "#188038";
    statusEl.innerHTML = `<strong>Pronto! (${okCount}/${brsValidos.length} BRs consultados)</strong><br>Resultado copiado! Clique na célula <strong>B2</strong> da planilha e aperte <strong>Ctrl + V</strong>.`;
  } catch (err) {
    document.getElementById("listaBRs").value = tsvFinal;
    statusEl.style.color = "#d93025";
    statusEl.textContent = "Copie o resultado acima (Ctrl+A, Ctrl+C) e cole em B2.";
  } finally {
    btn.disabled = false;
  }
});
