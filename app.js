const encryptedUrl = "./data/status.enc.json";
const $ = (id) => document.getElementById(id);
const won = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 });
const percent = new Intl.NumberFormat("ko-KR", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 });
let deferredInstallPrompt = null;
let lastPassphrase = "";
let pushConfig = null;
let refreshInFlight = false;
let lastPublishedAt = "";
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

async function fetchAndDecrypt(passphrase, networkOnly = false) {
  const query = networkOnly ? `fresh=${Date.now()}` : `t=${Date.now()}`;
  const response = await fetch(`${encryptedUrl}?${query}`, { cache: "no-store" });
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
  const suggestions = Array.isArray(data.recommendations) ? data.recommendations : null;
  const actions = suggestions ?? (Array.isArray(data.actions) ? data.actions : []);
  const blocked = Boolean(data.execution_blocked) && !(suggestions?.length);
  const dataBlocked = Boolean(data.data_connection_blocked);
  if (!actions.length) {
    root.innerHTML = dataBlocked
      ? '<div class="empty"><strong>자료 연결 때문에 일부 투자 판단이 보류됐습니다.</strong><br>아래에서 보류 사유를 확인하세요.</div>'
      : '<div class="empty"><strong>지금 표시할 매수·매도 제안이 없습니다.</strong></div>';
    text("actionBadge", dataBlocked ? "자료 확인 필요" : blocked ? "판단 보류" : "제안 없음");
  } else {
    text("actionBadge", blocked ? "판단 보류" : `${actions.length}건 제안`);
    $("actionBadge").className = `badge ${blocked ? "danger" : "warn"}`;
    for (const action of actions) {
      const row = document.createElement("article");
      const verified = suggestions !== null || action.order_allowed;
      row.className = `action-row ${verified ? "" : "blocked"}`;
      const shares = Number(action.shares).toLocaleString("ko-KR", { maximumFractionDigits: 4 });
      const lines = [
        ["h3", `${action.name} (${action.ticker})`],
        ["strong", `${verified ? "투자 제안" : "계산상 후보"} ${action.side} ${shares}주 · ${formatWon(action.amount_krw)}`],
        ["p", `가격 기준일 ${action.price_date || "확인 필요"}`],
        ["p", action.reason || "상세 이유는 PC 화면에서 확인하세요."],
      ];
      for (const [tag, value] of lines) {
        const line = document.createElement(tag);
        line.textContent = value;
        row.append(line);
      }
      root.append(row);
    }
  }
  if (data.trade_pause_reason && !suggestions?.length) {
    const pause = document.createElement("p");
    pause.textContent = String(data.trade_pause_reason);
    root.append(pause);
  }
  const reasons = [...new Set([
    ...(Array.isArray(data.blocking_reasons) ? data.blocking_reasons : []),
    ...(Array.isArray(data.data_connection_reasons) ? data.data_connection_reasons : []),
  ])];
  $("blockingDetails").hidden = !(blocked || dataBlocked);
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
    const valueKnown = holding.market_value_krw != null;
    const pnlKnown = holding.pnl_krw != null && holding.pnl_ratio != null;
    row.innerHTML = `
      <div><strong>${holding.name}</strong><small>${holding.ticker} · ${Number(holding.shares).toLocaleString("ko-KR")}주</small></div>
      <div class="right"><strong>${valueKnown ? formatWon(holding.market_value_krw) : "평가 보류"}</strong><small>${valueKnown ? "평가금액" : "최신 판단 재확인 필요"}</small></div>
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

function renderResearch(research) {
  const summary = $("researchStatus");
  if (summary) {
    summary.hidden = !research;
    if (research) {
      summary.textContent = `연구 점검 ${new Date(research.checked_at).toLocaleString("ko-KR")} · 검증 호가 ${research.verified_quotes}건 · 가상 체결 ${research.hypothetical_fills}건`;
    }
  }
  const panel = $("researchDetails");
  const details = research?.details;
  if (!panel) return;
  panel.hidden = !details;
  if (!details) return;
  const names = { "005930.KS": "삼성전자", GOOG: "알파벳", "487240.KS": "전력 ETF" };
  const problems = {
    unverified_bid_or_ask: "검증 호가 없음", valuation_unqualified: "가치평가 기준 미충족",
    macro_input_unverified: "경제 지표 미확인", unverified_etf_inav: "장중 순자산가치 미확인",
    etf_inav_adverse_gap: "장중 순자산가치와의 차이가 큼", unverified_fx: "환율 미확인",
    monthly_stage_already_filled: "이번 달 회차 처리 완료", lot_budget_or_size: "예산 또는 호가 잔량 부족",
    month_open_marks_missing: "월초 평가가격 미확인", portfolio_marks_missing: "보유 종목 시세 미확인",
    fixed_cash_marks_missing: "보유 종목 시세 미확인",
  };
  const states = {
    issued_token: "인증 성공", cached_token: "저장 토큰 사용", configured_token: "설정 토큰 사용",
    missing_kis_app_credentials: "키 미설정", no_api_key: "키 미설정",
    confirmed_broker_tls_stream_required: "암호화 실시간 연결 미확인",
    market_credentials_windows_user_cannot_decrypt: "이 Windows 계정에서 키를 열 수 없음", observed: "자료 조회 성공",
    outside_regular_session: "정규장 밖", verified_realtime: "실시간 호가 확인", partial_realtime: "일부 실시간 호가 확인",
    meritz_token_unavailable: "메리츠 인증 실패", meritz_quote_not_received: "호가 수신 대기",
    meritz_stream_unavailable: "시세 연결 실패", meritz_subscription_rejected: "시세 구독 거절",
    no_etf_rows_for_requested_date: "당일 ETF 자료 게시 대기",
    http_401: "인증 실패", http_403: "접근 거부", http_429: "요청 한도 도달",
  };
  const check = details.last_run || {};
  const runState = {recorded: "기록 완료", unavailable: "실행 실패", deferred: "실행 보류",
    skipped_concurrent_research: "다른 점검 진행 중"}[check.state] || "기록 미확인";
  const connection = details.connection || {};
  const stateLabel = (state) => states[state] || "미확인";
  text("researchCheck", `최근 실행 ${runState}${check.checked_at ? ` · ${new Date(check.checked_at).toLocaleString("ko-KR")}` : ""} · 예약 실행 여부 미확인 · ${connection.broker === "Meritz" ? "메리츠" : "KIS"} ${stateLabel(connection.kis)} · KRX ${stateLabel(connection.krx)} · 실시간 연결 ${stateLabel(connection.stream)}`);
  const list = (id, rows) => $(id).replaceChildren(...rows.map((value) => {
    const li = document.createElement("li");
    li.textContent = value;
    return li;
  }));
  const kinds = {verified_hoga: "검증 호가", regular_close: "정규장 종가", operator_reference: "운용사 참고 시세"};
  const sessions = {regular: "정규장", before_regular: "개장 전", after_regular: "장 종료 후", closed_day: "휴장"};
  list("researchPrices", (details.prices || []).map((row) => {
    const price = (value) => value == null ? "—" : new Intl.NumberFormat("ko-KR", {style: "currency", currency: row.currency}).format(value);
    const market = row.kind
      ? `${kinds[row.kind]} ${row.source}${row.kind === "verified_hoga" ? (row.bid && row.ask ? ` · 매수 ${price(row.bid)} (${row.bid_size ?? "—"}주) / 매도 ${price(row.ask)} (${row.ask_size ?? "—"}주)` : "") : ` · ${price(row.current)}`}`
      : `시세 미확인${row.session && sessions[row.session] ? ` (${sessions[row.session]})` : ""}`;
    const value = row.research_value_range?.map(price).join("~");
    return `${names[row.ticker]} · 가치평가 ${row.grade || "미확인"}${value ? ` · 연구 가치범위 ${value}` : ""} · ${market}${row.observed_at ? ` · ${new Date(row.observed_at).toLocaleString("ko-KR")}` : ""}`;
  }));
  const strategies = {A: "정기적립", B: "가치", C: "가치·공통 위험", D: "가치·공통 위험·거시", E: "고정 현금"};
  list("researchAccounts", (details.strategies || []).flatMap((account) => {
    const partial = !account.return_complete ? " (일부 평가 구간 누락)" : "";
    const perf = account.return == null ? "수익률 미확인" : `관측 수익률 ${percent.format(account.return)}${partial}`;
    const candidate = {buy: "모의 매수 검토", sell: "모의 매도 검토", hold: "보류"};
    const actions = account.actions.map((action) => action.shares
      ? `${names[action.ticker]} 가상 ${action.side === "buy" ? "매수" : "매도"} ${action.shares}주 · 체결가 ${formatWon(action.fill_price_krw)} · 수수료 ${formatWon(action.fee_krw)}`
      : `${names[action.ticker]} ${candidate[action.side]} · ${problems[action.reason] || "체결 없음"}`);
    return [`${account.code} ${strategies[account.code]} · ${perf}${actions.length ? ` · ${actions.join(" / ")}` : ""}`];
  }));
  text("researchForecasts", `공식 실적과 비교 ${details.official_forecast_comparisons}건 · 발표 대기 ${details.pending_forecasts}건`);
  const metrics = {capex_bn: "설비투자(십억 달러)", revenue_bn: "매출(십억 달러)",
    parent_profit_krw: "지배주주 순이익(원)", working_samsung_ebit_trillion_krw: "영업이익(조 원)"};
  const number = new Intl.NumberFormat("ko-KR", {maximumFractionDigits: 2});
  list("researchComparisons", (details.compared_forecasts || []).map((item) =>
    `${names[item.ticker]} ${item.period} ${metrics[item.metric]} · 최초 ${number.format(item.initial)} / 실제 ${number.format(item.actual)}`));
}

function render(data) {
  $("unlockPanel").hidden = true;
  $("dashboard").hidden = false;
  text("checkedAt", `결과 완료 ${data.checked_at ? new Date(data.checked_at).toLocaleString("ko-KR") : "시각 확인 필요"}`);
  if ($("portfolioSyncedAt")) {
    text("portfolioSyncedAt", `서버에 마지막으로 반영된 PC 변경 ${data.portfolio_synced_at ? new Date(data.portfolio_synced_at).toLocaleString("ko-KR") : "시각 미확인"}`);
  }
  const policy = data.policy_check;
  if (policy?.current_version) {
    $("checkedAt").append(document.createTextNode(
      ` · 계산 규칙 ${policy.current_version} · 고정 기준 ${policy.saved_version || "확인 필요"}`
    ));
  }
  $("checkedAt").title = [
    policy?.source_commit && `서버 배포 ${policy.source_commit}`,
    policy?.current_files_hash && `현재 계산파일 지문 ${policy.current_files_hash}`,
    policy?.saved_files_hash && `고정 계산파일 지문 ${policy.saved_files_hash}`,
  ].filter(Boolean).join("\n");
  text("headline", data.headline || "점검 결과 확인 필요");
  renderResearch(data.forward_research);
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
  const targetCash = portfolio.target_cash_like_ratio == null
    ? "목표 확인 필요"
    : `목표 ${percent.format(portfolio.target_cash_like_ratio)}`;
  const cashLikeAmount = portfolio.cash_like_krw == null ? "현금성 평가 확인 필요" : formatWon(portfolio.cash_like_krw);
  text("cashLikeAmount", `${cashLikeAmount} · ${targetCash}`);
  $("cashLikeAmount").title = portfolio.cash_target_basis || "";
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

async function unlock(passphrase, options = {}) {
  if (refreshInFlight) return;
  const manual = Boolean(options.manual);
  refreshInFlight = true;
  const previousPublishedAt = lastPublishedAt;
  if (manual) {
    $("refreshButton").disabled = true;
    text("refreshButton", "확인 중…");
    text("refreshStatus", "서버에서 최신 파일을 새로 받고 있습니다.");
  } else {
    text("unlockMessage", "암호화된 최신 결과를 확인하고 있습니다…");
  }
  try {
    const data = await fetchAndDecrypt(passphrase, manual);
    lastPassphrase = passphrase;
    lastPublishedAt = String(data.generated_at || data.checked_at || "");
    render(data);
    if (manual) {
      const changed = Boolean(previousPublishedAt && lastPublishedAt !== previousPublishedAt);
      text("refreshStatus", changed
        ? "새 점검 결과를 반영했습니다."
        : "서버 최신 결과를 확인했습니다. 새 점검 결과는 아직 없습니다.");
    }
  } catch (error) {
    const message = error.name === "OperationError" ? "비밀번호가 맞지 않습니다." : error.message;
    text(manual ? "refreshStatus" : "unlockMessage", manual ? `${message} 저장된 화면은 그대로 유지합니다.` : message);
  } finally {
    refreshInFlight = false;
    if (manual) {
      $("refreshButton").disabled = false;
      text("refreshButton", "최신 결과 확인");
    }
  }
}

function refreshLatestResult() {
  if (lastPassphrase && document.visibilityState === "visible") {
    unlock(lastPassphrase);
  }
}

$("unlockForm").addEventListener("submit", (event) => {
  event.preventDefault();
  unlock($("passphrase").value);
});
$("refreshButton").addEventListener("click", () => unlock(lastPassphrase, { manual: true }));
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
  window.addEventListener("load", async () => {
    const registration = await navigator.serviceWorker.register(
      "./sw.js",
      { updateViaCache: "none" },
    );
    registration.update().catch(() => {});
  });
}

document.addEventListener("visibilitychange", refreshLatestResult);
window.addEventListener("pageshow", refreshLatestResult);
window.addEventListener("online", refreshLatestResult);
