const encryptedUrl = "./data/status.enc.json";
const $ = (id) => document.getElementById(id);
const won = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 });
const percent = new Intl.NumberFormat("ko-KR", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 });
let deferredInstallPrompt = null;
let lastPassphrase = "";
let pushConfig = null;
const proofContext = "investment-watch-registration-v1:";

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

function toBase64Url(bytes) {
  let binary = "";
  bytes.forEach((value) => { binary += String.fromCharCode(value); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value) {
  const padded = value + "=".repeat((4 - (value.length % 4)) % 4);
  return fromBase64(padded.replace(/-/g, "+").replace(/_/g, "/"));
}

async function registrationProof(passphrase) {
  const bytes = new TextEncoder().encode(`${proofContext}${passphrase}`);
  return toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

async function loadPushConfig() {
  if (pushConfig) return pushConfig;
  const response = await fetch(`./push-config.json?t=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) throw new Error("가격 알림 설정을 가져오지 못했습니다.");
  pushConfig = await response.json();
  return pushConfig;
}

async function pushFetch(path, options = {}) {
  const config = await loadPushConfig();
  if (!config.endpoint) throw new Error("가격 알림 서버가 아직 등록되지 않았습니다.");
  const proof = await registrationProof(lastPassphrase);
  return fetch(`${config.endpoint.replace(/\/$/, "")}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Registration-Proof": proof,
      ...(options.headers || {}),
    },
  });
}

function pushSupported() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

async function refreshPushStatus() {
  if (!pushSupported()) {
    text("pushStatus", "이 브라우저는 백그라운드 푸시 알림을 지원하지 않습니다.");
    $("connectPushButton").disabled = true;
    return;
  }
  try {
    const config = await loadPushConfig();
    if (!config.endpoint) {
      text("pushStatus", "서버 최초 등록이 남아 있습니다. 등록 전까지는 아침 점검만 표시됩니다.");
      $("connectPushButton").disabled = true;
      return;
    }
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    $("disconnectPushButton").hidden = !subscription;
    text("pushStatus", subscription
      ? "이 기기는 5분 가격 재검토선 알림에 연결되어 있습니다."
      : "알림을 받으려면 이 기기에서 한 번만 연결하세요.");
    if (subscription) {
      const response = await pushFetch("/api/status", { method: "GET" });
      if (response.ok) {
        const status = await response.json();
        if (status.checked_at) {
          text("pushLastCheck", `서버 최근 확인 ${new Date(status.checked_at).toLocaleString("ko-KR")}`);
        }
      }
    }
  } catch (error) {
    text("pushStatus", error.message);
  }
}

async function connectPush() {
  text("pushStatus", "알림 권한과 서버 연결을 확인하고 있습니다…");
  try {
    if (!pushSupported()) throw new Error("이 브라우저에서는 푸시 알림을 사용할 수 없습니다.");
    const permission = await Notification.requestPermission();
    if (permission !== "granted") throw new Error("휴대폰 알림 권한이 허용되지 않았습니다.");
    const config = await loadPushConfig();
    if (!config.endpoint) throw new Error("가격 알림 서버가 아직 등록되지 않았습니다.");
    const publicResponse = await fetch(`${config.endpoint.replace(/\/$/, "")}/api/config`);
    if (!publicResponse.ok) throw new Error("가격 알림 서버 설정을 확인하지 못했습니다.");
    const publicConfig = await publicResponse.json();
    const registration = await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: fromBase64Url(publicConfig.vapid_public_key),
      });
    }
    const response = await pushFetch("/api/subscribe", {
      method: "POST",
      body: JSON.stringify(subscription.toJSON()),
    });
    if (!response.ok) throw new Error("이 기기의 알림 등록을 완료하지 못했습니다.");
    const testResponse = await pushFetch("/api/test", { method: "POST", body: "{}" });
    if (!testResponse.ok) throw new Error("등록은 됐지만 시험 알림 전송에 실패했습니다.");
    text("pushStatus", "연결 완료. 잠시 후 시험 알림이 오며, 이후 조건 도달 때만 알립니다.");
    $("disconnectPushButton").hidden = false;
  } catch (error) {
    text("pushStatus", error.message);
  }
}

async function disconnectPush() {
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      await pushFetch("/api/subscribe", {
        method: "DELETE",
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      });
      await subscription.unsubscribe();
    }
    text("pushStatus", "이 기기의 가격 알림을 해제했습니다.");
    $("disconnectPushButton").hidden = true;
  } catch (error) {
    text("pushStatus", error.message);
  }
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
  refreshPushStatus();
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
$("connectPushButton").addEventListener("click", connectPush);
$("disconnectPushButton").addEventListener("click", disconnectPush);

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
