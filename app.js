const encryptedUrl = "./data/status.enc.json";
const $ = (id) => document.getElementById(id);
const won = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 });
const percent = new Intl.NumberFormat("ko-KR", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 });
let deferredInstallPrompt = null;
let lastPassphrase = "";

const text = (id, value) => { $(id).textContent = value; };
const formatWon = (value) => `${won.format(Number(value || 0))}원`;
const ratioClass = (value) => value == null ? "unknown" : Number(value) >= 0 ? "positive" : "negative";

function fromBase64(value) {
  const raw = atob(value);
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

async function decryptEnvelope(envelope, passphrase) {
  if (envelope.version !== 1 || envelope.algorithm !== "AES-256-GCM") {
    throw new Error("지원하지 않는 결과파일 형식입니다.");
  }
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  const key = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: fromBase64(envelope.salt),
      iterations: envelope.iterations,
      hash: "SHA-256",
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(envelope.iv), tagLength: 128 },
    key,
    fromBase64(envelope.ciphertext),
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}

async function fetchAndDecrypt(passphrase) {
  const response = await fetch(`${encryptedUrl}?t=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(response.status === 404 ? "아직 휴대폰용 결과가 올라오지 않았습니다." : "결과를 가져오지 못했습니다.");
  }
  const raw = await response.text();
  text("dataSize", `${Math.max(1, Math.ceil(new Blob([raw]).size / 1024))}KB`);
  return decryptEnvelope(JSON.parse(raw), passphrase);
}

function renderActions(data) {
  const root = $("actions");
  root.replaceChildren();
  const actions = Array.isArray(data.actions) ? data.actions : [];
  const blocked = Boolean(data.execution_blocked);
  if (!actions.length) {
    root.innerHTML = `<div class="empty"><strong>오늘 새로 실행할 거래가 없습니다.</strong><br>기존 보유분과 적립 계획을 유지합니다.</div>`;
    text("actionBadge", "거래 없음");
  } else {
    text("actionBadge", blocked ? "주문 보류" : `${actions.length}건 확인`);
    $("actionBadge").className = `badge ${blocked ? "danger" : "warn"}`;
    for (const action of actions) {
      const row = document.createElement("article");
      row.className = `action-row ${action.order_allowed ? "" : "blocked"}`;
      const shares = Number(action.shares).toLocaleString("ko-KR", { maximumFractionDigits: 4 });
      row.innerHTML = `
        <h3>${action.name} <small>${action.ticker}</small></h3>
        <strong>${action.order_allowed ? "1차" : "계산상"} ${action.side} ${shares}주 · ${formatWon(action.amount_krw)}</strong>
        <p>가격 기준일 ${action.price_date || "확인 필요"}</p>
        <p>${action.reason || "상세 이유는 PC 화면에서 확인하세요."}</p>
      `;
      root.append(row);
    }
  }
  const reasons = Array.isArray(data.blocking_reasons) ? data.blocking_reasons : [];
  $("blockingDetails").hidden = !blocked;
  $("blockingReasons").replaceChildren(...reasons.map((reason) => {
    const li = document.createElement("li");
    li.textContent = reason;
    return li;
  }));
}

function renderHoldings(data) {
  const root = $("holdings");
  root.replaceChildren();
  const holdings = Array.isArray(data.holdings) ? data.holdings : [];
  if (!holdings.length) {
    root.innerHTML = `<div class="empty">보유종목 요약을 만들지 못했습니다. PC 점검 상태를 확인하세요.</div>`;
    return;
  }
  for (const holding of holdings) {
    const row = document.createElement("div");
    row.className = "table-row";
    const pnlKnown = holding.pnl_krw != null && holding.pnl_ratio != null;
    row.innerHTML = `
      <div><strong>${holding.name}</strong><small>${holding.ticker} · ${Number(holding.shares).toLocaleString("ko-KR")}주</small></div>
      <div class="right"><strong>${formatWon(holding.market_value_krw)}</strong><small>평가금액</small></div>
      <div class="right ${ratioClass(holding.pnl_ratio)}"><strong>${pnlKnown ? `${Number(holding.pnl_krw) >= 0 ? "+" : ""}${formatWon(holding.pnl_krw)}` : "계산 보류"}</strong><small>${pnlKnown ? percent.format(holding.pnl_ratio) : "원화 원가 확인 필요"}</small></div>
    `;
    root.append(row);
  }
}

function renderMonthly(data) {
  const root = $("monthlyTrades");
  root.replaceChildren();
  const rows = Array.isArray(data.monthly_trades) ? [...data.monthly_trades].reverse() : [];
  if (!rows.length) {
    root.innerHTML = `<div class="empty">기록된 실제 체결이 아직 없습니다.</div>`;
    return;
  }
  for (const item of rows) {
    const row = document.createElement("div");
    row.className = "table-row";
    const known = item.realized_pnl_krw != null;
    row.innerHTML = `
      <div><strong>${item.month}</strong><small>${item.trade_count}회 · 비용 ${formatWon(item.costs_krw)}</small></div>
      <div class="right"><strong>${formatWon(item.buy_amount_krw)}</strong><small>매수 / 매도 ${formatWon(item.sell_proceeds_krw)}</small></div>
      <div class="right ${ratioClass(item.realized_pnl_krw)}"><strong>${known ? `${Number(item.realized_pnl_krw) >= 0 ? "+" : ""}${formatWon(item.realized_pnl_krw)}` : "계산 보류"}</strong><small>확정손익</small></div>
    `;
    root.append(row);
  }
}

function render(data) {
  $("unlockPanel").hidden = true;
  $("dashboard").hidden = false;
  text("checkedAt", `${data.checked_at ? new Date(data.checked_at).toLocaleString("ko-KR") : "시각 확인 필요"} 점검`);
  text("headline", data.headline || "점검 결과 확인 필요");
  const stateMessage = {
    quiet: "새 거래나 중요한 변화가 없습니다.",
    action: "수량과 주문 가능 여부를 확인하세요.",
    attention: "중요한 변화가 있어 내용을 확인해야 합니다.",
    blocked: "계산상 후보가 있어도 문제를 해결하기 전에는 주문하지 마세요.",
    failed: "점검에 실패했습니다. 이전 결과로 거래하지 마세요.",
  }[data.attention_level] || "상태를 확인하세요.";
  text("statusExplanation", stateMessage);
  $("statusHero").className = `hero card ${data.attention_level || ""}`;
  text("marketRegime", data.market_regime || "확인 필요");
  const portfolio = data.portfolio || {};
  text("cashLikeRatio", portfolio.cash_like_ratio == null ? "확인 필요" : percent.format(portfolio.cash_like_ratio));
  text("cashLikeAmount", formatWon(portfolio.cash_like_krw));
  renderActions(data);
  renderHoldings(data);
  renderMonthly(data);
  const changes = Array.isArray(data.material_changes) ? data.material_changes : [];
  $("changesCard").hidden = !changes.length;
  $("materialChanges").replaceChildren(...changes.map((change) => {
    const li = document.createElement("li");
    li.textContent = change;
    return li;
  }));
}

async function unlock(passphrase) {
  text("unlockMessage", "암호화된 최신 결과를 확인하고 있습니다…");
  try {
    const data = await fetchAndDecrypt(passphrase);
    lastPassphrase = passphrase;
    render(data);
  } catch (error) {
    text("unlockMessage", error.name === "OperationError" ? "비밀번호가 맞지 않습니다." : error.message);
  }
}

$("unlockForm").addEventListener("submit", (event) => {
  event.preventDefault();
  unlock($("passphrase").value);
});
$("refreshButton").addEventListener("click", () => unlock(lastPassphrase));

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  $("installButton").hidden = false;
});
$("installButton").addEventListener("click", async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  $("installButton").hidden = true;
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js"));
}
