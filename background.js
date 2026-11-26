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
      const [resTrack, resExc] = await Promise.all([
        fetch(`https://spx.shopee.com.br/api/fleet_order/order/detail/tracking_info?shipment_id=${encId}`, { headers, credentials: "include" }),
        fetch(`https://spx.shopee.com.br/api/fleet_order/order/detail/exception_record_list?shipment_id=${encId}`, { headers, credentials: "include" }).catch(() => null)
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

      return { sucesso: true, jsonTrack, jsonExc };
    },
    args: [shipmentId]
  });

  const retorno = resultados && resultados[0] ? resultados[0].result : null;
  if (!retorno || retorno.erro) {
    throw new Error(retorno ? retorno.erro : "Falha ao comunicar com a aba do SPX.");
  }

  return processarDadosCompletos(retorno.jsonTrack, retorno.jsonExc);
}

function extrairEventos(lista, destino = []) {
  if (!Array.isArray(lista)) return destino;
  for (const item of lista) {
    destino.push(item);
    if (Array.isArray(item.children) && item.children.length > 0) extrairEventos(item.children, destino);
  }
  return destino;
}

const MAPA_STATUS_SPX = {
  1: "LMHub Recebido",
  2: "LMHub Sorting",
  3: "Em entrega",
  4: "Entregue",
  5: "On-Hold / Insucesso",
  6: "Devolvido ao Hub",
  60: "Em Transporte (Line Haul)",
  581: "Missing / Extravio",
  616: "On-Hold / Retido no Hub",
  648: "LMHub Sorted (Na Gaiola)",
  934: "LMHub Atribuindo / Atribuído",
  1006: "Calculation Task"
};

function nomeLegivelEvento(ev) {
  const bruto = (ev.status_name && ev.status_name !== "-") ? ev.status_name.trim() : "";
  if (bruto && !/^Status_\d+$/i.test(bruto)) {
    return bruto;
  }
  const msg = (ev.message || "").trim();
  const msgUpper = msg.toUpperCase();

  if (msgUpper.includes("BACKLOG, PROCESS FOR DELIVERY") || (ev.tracking_name || "").toUpperCase().includes("SWEEPER")) return "Parcel Sweeper Scan";
  if (msgUpper.includes("PARCEL ARRIVED AT LIQUIDATION")) return "Liquidate_Received";
  if (msgUpper.includes("PEDIDO EM DEVOLUÇÃO") || msgUpper.includes("PEDIDO EM DEVOLUCAO")) return "Retorno_Recebido_LMHub";
  if (msgUpper.includes("ALL EXCEPTIONS HAVE BEEN CANCELLED")) return "Cancelar Interceptação";
  if (msgUpper.includes("ALL EXCEPTIONS HAVE BEEN RESOLVED")) return "EHA Resolved";
  if (msgUpper.includes("TICKET SUBMITTED")) return "Ticket Submitted";
  if (msgUpper.includes("SOLICITAÇÃO DE RTS") || msgUpper.includes("SOLICITACAO DE RTS")) return "Solicitação de RTS";
  if (msgUpper.includes("AVARIA EXTERNA")) return "Avaria Externa";
  if (msgUpper.includes("AVARIA DE PRODUTO")) return "Avaria de Produto";
  if (msgUpper.includes("AVARIA LIQUIDA") || msgUpper.includes("AVARIA LÍQUIDA")) return "Avaria Líquida";
  if (msgUpper.includes("ETIQUETA AVARIADA")) return "Etiqueta Avariada";
  if (msgUpper.includes("PEDIDO ENTREGUE")) return "Entregue";
  if (msgUpper.includes("PEDIDO EM PROCESSO DE ENTREGA")) return "Em entrega";
  if (msgUpper.includes("PEDIDO ADICIONADO A ASSIGNMENT") || msgUpper.includes("PEDIDO ADICIONADO À ASSIGNMENT")) return "LMHub Atribuído";
  if (msgUpper.includes("PEDIDO EM PROCESSAMENTO NA ASSIGNMENT")) return "LMHub Atribuindo";
  if (msgUpper.includes("PARCEL SORTED TO ROUTE")) return "LMHub Sorted";
  if (msgUpper.includes("PARCEL SORTING TO ROUTE")) return "LMHub Sorting";
  if (msgUpper.includes("PEDIDO CHEGOU AO LAST MILE HUB")) return "LMHub Recebido";
  if (msgUpper.includes("UNLOADED AT")) return "LMHub LHUnloaded";
  if (msgUpper.includes("UNLOADING AT")) return "LMHub LHUnloading";
  if (msgUpper.includes("ARRIVED AT")) return "LMHub LHArrived";

  if (ev.tracking_name && ev.tracking_name !== "-") return ev.tracking_name;
  if (MAPA_STATUS_SPX[ev.status]) return MAPA_STATUS_SPX[ev.status];
  return `Evento_${ev.status}`;
}

function extrairRotaEvento(ev) {
  const m = (ev.message || "").match(/Route\s*\[([^\]]+)\]/i);
  return m ? m[1].trim() : "";
}

function extrairMotoristaEvento(ev) {
  const msg = ev.message || "";
  const mPt = msg.match(/Motorista:\s*(?:\[\d+\])?\s*([^,\n]+)/i);
  if (mPt) return mPt[1].trim().split(/\s+/).slice(0, 2).join(" ");
  const mEn = msg.match(/Driver:\s*(?:\[\d+\])?\s*([A-ZÀ-Ú\s]+)/i);
  if (mEn) return mEn[1].trim().split(/\s+/).slice(0, 2).join(" ");
  return "";
}

function isEventoAutomaticoSistema(ev) {
  const nm = nomeLegivelEvento(ev).toUpperCase();
  const bruto = (ev.status_name || "").toUpperCase();
  const track = (ev.tracking_name || "").toUpperCase();
  const msg = (ev.message || "").toUpperCase().trim();
  return ev.status === 1006 ||
         nm.includes("1006") ||
         nm.includes("CALCULATION_TASK") ||
         nm.includes("CALCULATION TASK") ||
         nm.includes("CONFIRM CALCULATION") ||
         bruto.includes("CALCULATION") ||
         track.includes("CALCULATION") ||
         /^CTBR[A-Z0-9]+$/.test(msg);
}

function processarDadosCompletos(jsonTrack, jsonExc) {
  const data = jsonTrack.data || {};
  const eventos = extrairEventos(data.tracking_list || []);
  eventos.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

  // Filtra eventos reais (ignorando Evento_1006 / Calculation Task no final da timeline)
  const eventosReais = eventos.filter(ev => !isEventoAutomaticoSistema(ev));
  const ultimoEvento = eventosReais.length > 0
    ? eventosReais[eventosReais.length - 1]
    : (eventos.length > 0 ? eventos[eventos.length - 1] : null);

  let statusAtual = "Sem registros";

  if (ultimoEvento) {
    const baseUltimo = formatarEvento(ultimoEvento);
    const nmUlt = nomeLegivelEvento(ultimoEvento).toUpperCase();
    const msgUlt = (ultimoEvento.message || "").trim();
    const rotaUlt = extrairRotaEvento(ultimoEvento);
    const motUlt = extrairMotoristaEvento(ultimoEvento);

    if (rotaUlt) {
      statusAtual = `${baseUltimo} [Rota ${rotaUlt}]`;
    } else if (motUlt) {
      statusAtual = `${baseUltimo} [Mot: ${motUlt}]`;
    } else if ((nmUlt.includes("EHA RESOLVED") || nmUlt.includes("TICKET SUBMITTED") || nmUlt.includes("EXCEPTION")) && eventosReais.length >= 2) {
      const anteriorComMotivo = [...eventosReais].slice(0, -1).reverse().find(e => {
        const m = (e.message || "").trim();
        return m && m.length < 55 && !/all exceptions|ticket submitted|parcel arrived|pedido chegou/i.test(m);
      });
      statusAtual = anteriorComMotivo
        ? `${baseUltimo} (${anteriorComMotivo.message.trim()})`
        : (msgUlt ? `${baseUltimo} (${msgUlt})` : baseUltimo);
    } else if (msgUlt && !/pedido chegou ao last mile hub|pedido em processo de entrega|pedido entregue/i.test(msgUlt)) {
      statusAtual = `${baseUltimo} (${msgUlt})`;
    } else {
      statusAtual = baseUltimo;
    }
  }

  let recebeuNoHub = false;
  let ultimoIndexRecebimento = -1;
  let foiLiquidado = false;
  let foiDevolucaoLMHub = false;

  let ultimoIndexSaida = -1;
  let dataUltimaSaida = "";
  let ultimoMotorista = "";

  let ultimoIndexOnHold = -1;
  let dataUltimoOnHold = "";

  let foiEntregue = false;
  let dataEntrega = "";

  let ultimoIndexSweeper = -1;
  let dataSweeper = "";

  let deuMissing = false;
  let ultimoIdxMissing = -1;

  eventos.forEach((ev, idx) => {
    const nome = nomeLegivelEvento(ev).toUpperCase();
    const msg = (ev.message || "").toUpperCase();
    const motEv = extrairMotoristaEvento(ev);
    if (motEv) ultimoMotorista = motEv;

    if (ev.status === 581 || nome.includes("MISSING") || msg.includes("MISSING") || msg.includes("EXTRAVIO")) {
      deuMissing = true;
      ultimoIdxMissing = idx;
    }

    if (nome.includes("PARCEL SWEEPER") || msg.includes("BACKLOG, PROCESS FOR DELIVERY")) {
      ultimoIndexSweeper = idx;
      dataSweeper = formatarDataCurta(ev.timestamp);
    }

    if (nome.includes("LIQUIDATE") || msg.includes("LIQUIDATION")) {
      foiLiquidado = true;
    }

    if (nome.includes("RETORNO_RECEBIDO") || msg.includes("PEDIDO EM DEVOLUÇÃO") || msg.includes("PEDIDO EM DEVOLUCAO")) {
      foiDevolucaoLMHub = true;
    }

    if (ev.status === 1 || nome.includes("LMHUB_RECEBIDO") || nome.includes("LMHUB RECEBIDO") || msg.includes("PEDIDO CHEGOU AO LAST MILE HUB")) {
      recebeuNoHub = true;
      ultimoIndexRecebimento = idx;
    }

    if (ev.status === 3 || nome === "EM ENTREGA" || msg.includes("PEDIDO EM PROCESSO DE ENTREGA") || msg.includes("TAKEN BY COURIER")) {
      ultimoIndexSaida = idx;
      dataUltimaSaida = formatarDataCurta(ev.timestamp);
    }

    if (ev.status === 4 || nome === "ENTREGUE" || msg.includes("PEDIDO ENTREGUE")) {
      foiEntregue = true;
      dataEntrega = formatarDataCurta(ev.timestamp);
    }

    if (ev.status === 5 || ev.status === 616 || nome.includes("ON-HOLD") || nome.includes("ON HOLD") || msg.includes("INSUCESSO")) {
      ultimoIndexOnHold = idx;
      dataUltimoOnHold = formatarDataCurta(ev.timestamp);
    }
  });

  // Coluna D: Apenas se deu Missing ou não
  const situacaoMissing = deuMissing ? "Deu Missing" : "Sem Missing";

  // Parcel Sweeper recente (após último Missing, On-Hold ou Recebimento atual)
  const marcoAtual = Math.max(ultimoIdxMissing, ultimoIndexOnHold, ultimoIndexRecebimento);
  const temSweeperRecente = ultimoIndexSweeper !== -1 && ultimoIndexSweeper > marcoAtual;

  // Coluna C: Curta, direta e sem texto desnecessário
  let resumoCurto = "";

  if (deuMissing) {
    const aposMissingReais = eventos.slice(ultimoIdxMissing + 1).filter(ev => !isEventoAutomaticoSistema(ev));
    if (aposMissingReais.length === 0) {
      resumoCurto = "Lost (Não apareceu mais)";
    } else if (foiEntregue) {
      resumoCurto = `Entregue (${dataEntrega})`;
    } else {
      const saiuPosMissing = [...aposMissingReais].reverse().find(ev => {
        const nm = nomeLegivelEvento(ev).toUpperCase();
        return ev.status === 3 || nm === "EM ENTREGA" || (ev.message || "").toUpperCase().includes("PEDIDO EM PROCESSO DE ENTREGA");
      });
      const gaiolaPosMissing = [...aposMissingReais].reverse().find(ev => extrairRotaEvento(ev) !== "");
      if (saiuPosMissing) {
        const mot = extrairMotoristaEvento(saiuPosMissing) || ultimoMotorista;
        resumoCurto = `Em entrega (${formatarDataCurta(saiuPosMissing.timestamp)}${mot ? ` • ${mot}` : ""})`;
      } else if (gaiolaPosMissing) {
        resumoCurto = `Na gaiola (${extrairRotaEvento(gaiolaPosMissing)})`;
      } else {
        resumoCurto = "No Hub (Pós-Missing)";
      }
    }
  } else if (foiEntregue) {
    resumoCurto = `Entregue (${dataEntrega}${ultimoMotorista ? ` • ${ultimoMotorista}` : ""})`;
  } else if (ultimoIndexOnHold !== -1) {
    const aposHold = eventos.slice(ultimoIndexOnHold + 1);
    const novaSaida = [...aposHold].reverse().find(ev => {
      const nm = nomeLegivelEvento(ev).toUpperCase();
      return ev.status === 3 || nm === "EM ENTREGA" || (ev.message || "").toUpperCase().includes("PEDIDO EM PROCESSO DE ENTREGA");
    });
    const novaGaiolaEv = [...aposHold].reverse().find(ev => extrairRotaEvento(ev) !== "");

    if (novaSaida) {
      const motNovo = extrairMotoristaEvento(novaSaida) || ultimoMotorista;
      resumoCurto = `Em entrega (${formatarDataCurta(novaSaida.timestamp)}${motNovo ? ` • ${motNovo}` : ""})`;
    } else if (novaGaiolaEv) {
      resumoCurto = `Na gaiola (${extrairRotaEvento(novaGaiolaEv)})`;
    } else {
      resumoCurto = `Parado no On-Hold (${dataUltimoOnHold})`;
    }
  } else if (ultimoIndexSaida !== -1) {
    const aposSaida = eventos.slice(ultimoIndexSaida + 1);
    const voltouHub = aposSaida.some(ev => {
      const nm = nomeLegivelEvento(ev).toUpperCase();
      return ev.status === 1 || ev.status === 6 || nm.includes("LMHUB RECEBIDO") || nm.includes("LMHUB_RECEBIDO") || nm.includes("DEVOLVIDO");
    });
    if (voltouHub) {
      resumoCurto = "Retornou ao Hub";
    } else {
      resumoCurto = `Em entrega (${dataUltimaSaida}${ultimoMotorista ? ` • ${ultimoMotorista}` : ""})`;
    }
  } else if (foiLiquidado) {
    resumoCurto = "Liquidação";
  } else if (foiDevolucaoLMHub) {
    resumoCurto = "Devolução Hub";
  } else {
    const ultimaGaiola = [...eventos].reverse().find(ev => extrairRotaEvento(ev) !== "");
    if (ultimaGaiola) {
      resumoCurto = `Na gaiola (${extrairRotaEvento(ultimaGaiola)})`;
    } else if (recebeuNoHub) {
      resumoCurto = "No Hub (Sem rota)";
    } else {
      resumoCurto = "Não chegou no Hub";
    }
  }

  if (temSweeperRecente) {
    resumoCurto += ` • Sweeper (${dataSweeper})`;
  }

  // Coluna E: Ocorrências Operacionais
  const alertas = [];
  if (foiLiquidado) alertas.push("Liquidação");
  if (foiDevolucaoLMHub) alertas.push("Devolução Hub");
  if (temSweeperRecente) alertas.push("Parcel Sweeper");

  const textoSemLiquidacao = (JSON.stringify(eventos) + JSON.stringify(jsonExc || {}))
    .toUpperCase()
    .replace(/LIQUIDAT[A-Z_]*/g, "");

  if (textoSemLiquidacao.includes("SOLICITAÇÃO DE RTS") || textoSemLiquidacao.includes("SOLICITACAO DE RTS")) {
    const rtsCancelado = textoSemLiquidacao.includes("CANCELAR INTERCEPTAÇÃO") ||
                         textoSemLiquidacao.includes("CANCELAR INTERCEPTACAO") ||
                         textoSemLiquidacao.includes("ALL EXCEPTIONS HAVE BEEN CANCELLED");
    alertas.push(rtsCancelado ? "RTS Cancelado" : "Solicitação RTS");
  } else if (data.is_intercepted === 1 || data.intercept_status === 1) {
    alertas.push("Interceptado");
  }

  if (textoSemLiquidacao.includes("ETIQUETA AVARIADA")) alertas.push("Etiqueta Avariada");
  if (textoSemLiquidacao.includes("AVARIA EXTERNA")) alertas.push("Avaria Externa");
  if (textoSemLiquidacao.includes("AVARIA DE PRODUTO")) alertas.push("Avaria de Produto");
  if (textoSemLiquidacao.includes("AVARIA LIQUIDA") || textoSemLiquidacao.includes("AVARIA LÍQUIDA") || textoSemLiquidacao.includes("VAZAMENTO")) alertas.push("Avaria Líquida");
  if (textoSemLiquidacao.includes("EMBALAGEM VAZIA") || textoSemLiquidacao.includes("EMPTY")) alertas.push("Emb. Vazia");
  if (data.damaged_tag === 1 && !alertas.some(a => a.includes("Avaria") || a.includes("Etiqueta"))) alertas.push("Avaria");

  const ocorrenciasLimpa = alertas.length > 0 ? [...new Set(alertas)].join(" + ") : "Sem ocorrências";

  return [
    statusAtual,
    resumoCurto,
    situacaoMissing,
    ocorrenciasLimpa
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
  const nome = nomeLegivelEvento(ev);
  const opBruto = ev.operator_name || ev.operator || "";
  let op = "";
  if (opBruto && !opBruto.includes("spx@shopee.com")) {
    const primeiro = opBruto.replace(/\[[^\]]+\]/g, "").trim().split(/[\s.@]+/)[0];
    if (primeiro) op = ` (${primeiro})`;
  }
  return `${dataCurta} - ${nome}${op}`.trim();
}
