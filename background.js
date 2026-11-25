chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "CONSULTAR_SPX") {
    consultarViaAbaSPX(request.shipmentId)
      .then(res => sendResponse({ sucesso: true, dados: res }))
      .catch(err => sendResponse({ sucesso: false, erro: err.message }));
    return true;
  }
});

async function consultarViaAbaSPX(shipmentId) {
  const abasSPX = await chrome.tabs.query({
    url: ["https://spx.shopee.com.br/*", "https://*.shopee.com.br/*"]
  });

  if (!abasSPX || abasSPX.length === 0) {
    throw new Error("Aba do SPX não encontrada nesta janela.");
  }

  const resultados = await chrome.scripting.executeScript({
    target: { tabId: abasSPX[0].id },
    func: async (idPedido) => {
      const matchCsrf = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
      const csrf = matchCsrf ? matchCsrf[1] : (localStorage.getItem("csrftoken") || sessionStorage.getItem("csrftoken") || "");
      const headers = { "Accept": "application/json, text/plain, */*" };
      if (csrf) headers["x-csrftoken"] = csrf;

      const encId = encodeURIComponent(idPedido);
      const [resTrack, resExc, resTrade] = await Promise.all([
        fetch(`https://spx.shopee.com.br/api/fleet_order/order/detail/tracking_info?shipment_id=${encId}`, { headers, credentials: "include" }),
        fetch(`https://spx.shopee.com.br/api/fleet_order/order/detail/exception_record_list?shipment_id=${encId}`, { headers, credentials: "include" }).catch(() => null),
        fetch(`https://spx.shopee.com.br/api/fleet_order/order/detail/trade_info?shipment_id=${encId}`, { headers, credentials: "include" }).catch(() => null)
      ]);

      const textoTrack = await resTrack.text();
      if (resTrack.status !== 200 || textoTrack.trim().startsWith("<")) {
        return { erro: "Sessão SPX expirada. Dê F5 na aba do SPX." };
      }

      const jsonTrack = JSON.parse(textoTrack);
      if (jsonTrack.retcode !== 0) {
        return { erro: jsonTrack.message || `Erro SPX (${jsonTrack.retcode})` };
      }

      let jsonExc = null;
      if (resExc && resExc.status === 200) { try { jsonExc = await resExc.json(); } catch (e) {} }

      let jsonTrade = null;
      if (resTrade && resTrade.status === 200) { try { jsonTrade = await resTrade.json(); } catch (e) {} }

      return { sucesso: true, jsonTrack, jsonExc, jsonTrade };
    },
    args: [shipmentId]
  });

  const retorno = resultados && resultados[0] ? resultados[0].result : null;
  if (!retorno || retorno.erro) {
    throw new Error(retorno ? retorno.erro : "Falha ao comunicar com a aba do SPX.");
  }

  return processarDadosEnxutos(retorno.jsonTrack, retorno.jsonExc, retorno.jsonTrade);
}

function extrairEventos(lista, destino = []) {
  if (!Array.isArray(lista)) return destino;
  for (const item of lista) {
    destino.push(item);
    if (Array.isArray(item.children) && item.children.length > 0) extrairEventos(item.children, destino);
  }
  return destino;
}

function processarDadosEnxutos(jsonTrack, jsonExc, jsonTrade) {
  const data = jsonTrack.data || {};
  const eventos = extrairEventos(data.tracking_list || []);
  eventos.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

  // COLUNA B: Status Atual
  const statusAtual = eventos.length > 0 ? formatarEvento(eventos[eventos.length - 1]) : "Sem registros";

  // COLUNA C: On-Hold & Retorno SPX
  let ultimoIndexSaida = -1;
  let ultimoMotorista = "";
  let ultimoOnHold = "";

  eventos.forEach((ev, idx) => {
    const st = `${ev.status_name || ""} ${ev.tracking_name || ""} ${ev.message || ""}`.toUpperCase();
    const matchDriver = (ev.message || "").match(/Driver:\s*(?:\[\d+\])?([A-ZÀ-Ú\s]+)/i);
    if (matchDriver) ultimoMotorista = matchDriver[1].trim().split(" ").slice(0, 2).join(" ");

    if (ev.status === 3 || st.includes("DELIVERING") || st.includes("TAKEN BY COURIER")) {
      ultimoIndexSaida = idx;
    }
    if (st.includes("ON_HOLD") || st.includes("ON HOLD") || st.includes("FAILED") || st.includes("INSUCESSO")) {
      const motivo = ev.on_hold_reason || ev.remark || "";
      ultimoOnHold = `${formatarDataCurta(ev.timestamp)}${motivo ? ` (${motivo})` : ""}`;
    }
  });

  let infoOnHoldRetorno = "Sem saída para rota";
  if (ultimoIndexSaida !== -1) {
    const aposSaida = eventos.slice(ultimoIndexSaida + 1);
    const retornoHub = [...aposSaida].reverse().find(ev => {
      const st = `${ev.status_name || ""} ${ev.tracking_name || ""} ${ev.message || ""}`.toUpperCase();
      return ev.status === 1 || st.includes("LMHUB_RECEIVED") || st.includes("LM_HUBRECEIVED") || st.includes("RETURN");
    });

    const tagMot = ultimoMotorista ? `Mot: ${ultimoMotorista} | ` : "";
    const tagHold = ultimoOnHold ? `On-Hold: ${ultimoOnHold} | ` : "";

    if (retornoHub) {
      infoOnHoldRetorno = `${tagMot}${tagHold}Retorno SPX: ${formatarEvento(retornoHub)}`;
    } else {
      infoOnHoldRetorno = `${tagMot}${tagHold}Sem retorno bipado no SPX`;
    }
  }

  // COLUNA D: Situação Missing
  let qtdMissing = 0;
  let ultimoIdxMissing = -1;
  eventos.forEach((ev, idx) => {
    const txt = `${ev.status_name || ""} ${ev.tracking_name || ""} ${ev.message || ""}`.toUpperCase();
    if (ev.status === 581 || txt.includes("MISSING") || txt.includes("EXTRAVIO")) {
      qtdMissing++;
      ultimoIdxMissing = idx;
    }
  });

  let situacaoMissing = "Sem Missing";
  if (qtdMissing > 0) {
    const aposMissing = eventos.slice(ultimoIdxMissing + 1);
    if (aposMissing.length === 0) {
      situacaoMissing = `${qtdMissing}x Missing ➔ Pendente (Sem bipagem)`;
    } else {
      const ultEv = aposMissing[aposMissing.length - 1];
      situacaoMissing = `${qtdMissing}x Missing ➔ ${formatarEvento(ultEv)}`;
    }
  }

  // COLUNA E: Ocorrências & Perfil
  const alertas = [];
  if (data.damaged_tag === 1) alertas.push("Avaria");
  if (data.is_intercepted === 1 || data.intercept_status === 1) alertas.push("Interceptado");

  const textoGeral = JSON.stringify(eventos).toUpperCase() + JSON.stringify(jsonExc || {}).toUpperCase();
  if (textoGeral.includes("EMBALAGEM VAZIA") || textoGeral.includes("EMPTY")) alertas.push("Emb. Vazia");
  if ((textoGeral.includes("LIQUIDA") || textoGeral.includes("LÍQUIDA")) && !alertas.includes("Avaria")) alertas.push("Avaria Líquida");

  const prefixoAlerta = alertas.length > 0 ? `[${[...new Set(alertas)].join(" + ")}] ` : "";

  let perfilItem = "";
  const skuList = jsonTrade?.data?.sku_list;
  if (Array.isArray(skuList) && skuList.length > 0) {
    const item = skuList[0];
    const qtd = item.quantity != null ? `${item.quantity} un` : "1 un";
    const peso = item.item_weight != null ? `${String(item.item_weight).replace(".", ",")} kg` : "";
    const nome = (item.name || item.sku_id || "").trim();
    perfilItem = nome ? `${nome} (${qtd}${peso ? ` • ${peso}` : ""})` : [qtd, peso].filter(Boolean).join(" • ");
  }

  const ocorrenciaEPerfil = `${prefixoAlerta}${perfilItem || "Normal"}`.trim();

  return [
    statusAtual,
    infoOnHoldRetorno,
    situacaoMissing,
    ocorrenciaEPerfil
  ];
}

function formatarDataCurta(ts) {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const dm = d.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit" });
  const hm = d.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });
  return `${dm} ${hm}`;
}

function formatarEvento(ev) {
  const dataCurta = formatarDataCurta(ev.timestamp);
  const nome = (ev.status_name && ev.status_name !== "-") ? ev.status_name : (ev.tracking_name || `Status_${ev.status}`);
  const opBruto = ev.operator_name || ev.operator || "";
  let op = "";
  if (opBruto && !opBruto.includes("spx@shopee.com")) {
    const primeiro = opBruto.replace(/\[[^\]]+\]/g, "").trim().split(/[\s.@]+/)[0];
    if (primeiro) op = ` (${primeiro})`;
  }
  return `${dataCurta} - ${nome}${op}`.trim();
}
