const HISTORY_STORAGE_KEY = "site-context-history-v1";

const state = {
  activeSelectionKey: "",
  buildingRegister: null,
  landInfo: null,
  landInfoDetails: null,
  isLandInfoRequesting: false,
  map: null,
  marker: null,
  latestSpec: null,
  runtimeConfig: null,
  selectedLocation: null,
  siteContext: null,
  siteContextOptionsSignature: "",
  searchRequestId: 0,
  searchDebounceId: null,
  modelProgressTimer: null,
  modelProgressPollTimer: null,
  modelProgressValue: 0,
  modelProgressSession: null,
  modelProgressEstimates: null,
  history: [],
  layers: {
    buildings: null,
    clipBoundary: null,
    contourLines: null,
    parcelBoundary: null,
  },
};

const providerBadge = document.querySelector("#providerBadge");
const selectionSummary = document.querySelector("#selectionSummary");
const searchResults = document.querySelector("#searchResults");
const selectionMeta = document.querySelector("#selectionMeta");
const siteContextMeta = document.querySelector("#siteContextMeta");
const siteContextNote = document.querySelector("#siteContextNote");
const landInfoMeta = document.querySelector("#landInfoMeta");
const landInfoNote = document.querySelector("#landInfoNote");
const landInfoList = document.querySelector("#landInfoList");
const lawInfoList = document.querySelector("#lawInfoList");
const buildingRegisterMeta = document.querySelector("#buildingRegisterMeta");
const buildingRegisterNote = document.querySelector("#buildingRegisterNote");
const buildingRegisterList = document.querySelector("#buildingRegisterList");
const specPreview = document.querySelector("#specPreview");
const actionFeedback = document.querySelector("#actionFeedback");
const searchForm = document.querySelector("#searchForm");
const searchInput = document.querySelector("#searchInput");
const modelForm = document.querySelector("#modelForm");
const loadLandInfoButton = document.querySelector("#loadLandInfoButton");
const openLandUseDetailButton = document.querySelector("#openLandUseDetailButton");
const openLandMapButton = document.querySelector("#openLandMapButton");
const openLandIssueButton = document.querySelector("#openLandIssueButton");
const loadSiteContextButton = document.querySelector("#loadSiteContextButton");
const loadBuildingRegisterButton = document.querySelector("#loadBuildingRegisterButton");
const showBuildingRegisterDetailsButton = document.querySelector(
  "#showBuildingRegisterDetailsButton"
);
const printBuildingRegisterButton = document.querySelector("#printBuildingRegisterButton");
const openOfficialBuildingRegisterButton = document.querySelector(
  "#openOfficialBuildingRegisterButton"
);
const previewSiteContextButton = document.querySelector("#previewSiteContextButton");
const downloadSiteContextButton = document.querySelector("#downloadSiteContextButton");
const downloadObjButton = document.querySelector("#downloadObjButton");
const download3dmButton = document.querySelector("#download3dmButton");
const modelProgressBar = document.querySelector("#modelProgressBar");
const modelProgressFill = document.querySelector("#modelProgressFill");
const modelProgressLabel = document.querySelector("#modelProgressLabel");
const historyList = document.querySelector("#historyList");
const clearHistoryButton = document.querySelector("#clearHistoryButton");
const MIN_CONTOUR_INTERVAL_METERS = 1;
const MODEL_PROGRESS_STORAGE_KEY =
  "site-context-planner.model-progress-estimates.v1";
const MODEL_PROGRESS_MIN_ESTIMATE_MS = 1500;
const MODEL_PROGRESS_MAX_ESTIMATE_MS = 90000;
const MODEL_PROGRESS_POLL_INTERVAL_MS = 400;
const MODEL_PROGRESS_DEFAULT_ESTIMATES_MS = Object.freeze({
  preview: 3200,
  "export-obj": 5200,
  "export-obj-cached": 3400,
  "export-3dm": 7600,
  "export-3dm-cached": 5200,
});

async function readErrorMessageFromResponse(response, fallbackMessage) {
  try {
    const contentType = String(response.headers.get("Content-Type") || "");

    if (contentType.includes("application/json")) {
      const payload = await response.json();
      const errorMessage = String(payload?.error || "").trim();

      if (errorMessage) {
        return errorMessage;
      }
    }

    const text = String(await response.text()).trim();

    if (text) {
      return text;
    }
  } catch {
    // Ignore body parsing failures and fall back to the caller message.
  }

  return fallbackMessage;
}

function describeRequestFailure(error, endpoint, fallbackMessage) {
  if (!(error instanceof Error)) {
    return fallbackMessage;
  }

  const message = String(error.message || "").trim();
  const normalizedMessage = message.toLowerCase();

  if (
    normalizedMessage.includes("failed to fetch") ||
    normalizedMessage.includes("networkerror")
  ) {
    return `${fallbackMessage} 서버 연결이 끊겼습니다. \`${endpoint}\` 요청 중 개발 서버가 종료되었거나 재시작되었을 수 있습니다. 서버 로그와 브라우저 콘솔을 확인한 뒤 다시 시도해주세요.`;
  }

  if (normalizedMessage.includes("abort")) {
    return `${fallbackMessage} \`${endpoint}\` 요청이 중간에 중단되었습니다. 잠시 후 다시 시도해주세요.`;
  }

  return message || fallbackMessage;
}

async function fetchWithDiagnostics(endpoint, init, fallbackMessage) {
  try {
    const response = await fetch(endpoint, init);

    if (!response.ok) {
      throw new Error(
        await readErrorMessageFromResponse(response, fallbackMessage)
      );
    }

    return response;
  } catch (error) {
    console.error(`[request] ${endpoint} failed`, error);
    throw new Error(describeRequestFailure(error, endpoint, fallbackMessage));
  }
}

function createModelProgressToken() {
  return `progress-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function mapProgressIntoRange(percent, rangeStart = 0, rangeEnd = 100) {
  const normalizedPercent = Math.max(0, Math.min(100, Number(percent) || 0));
  const start = Number(rangeStart) || 0;
  const end = Number(rangeEnd) || 100;
  return start + ((end - start) * normalizedPercent) / 100;
}

async function pollModelProgressOnce(token, rangeStart = 0, rangeEnd = 100) {
  if (!token || !state.modelProgressSession) {
    return;
  }

  try {
    const response = await fetch(
      `/api/request-progress?token=${encodeURIComponent(token)}`,
      {
        headers: {
          Accept: "application/json",
        },
      }
    );

    if (!response.ok) {
      return;
    }

    const payload = await response.json();

    if (!payload || payload.state === "idle") {
      return;
    }

    const mappedValue = mapProgressIntoRange(
      payload.percent,
      rangeStart,
      rangeEnd
    );
    advanceModelProgress(mappedValue, payload.message || state.modelProgressSession.message);
  } catch {
    // Ignore transient polling errors while the main request is still running.
  }
}

function startModelRequestProgressPolling(
  token,
  rangeStart = 0,
  rangeEnd = 100
) {
  clearModelProgressPollTimer();

  if (!token) {
    return;
  }

  void pollModelProgressOnce(token, rangeStart, rangeEnd);
  state.modelProgressPollTimer = window.setInterval(() => {
    void pollModelProgressOnce(token, rangeStart, rangeEnd);
  }, MODEL_PROGRESS_POLL_INTERVAL_MS);
}

async function fetchWithModelProgress(
  endpoint,
  init,
  fallbackMessage,
  options = {}
) {
  const token = createModelProgressToken();
  const headers = new Headers(init?.headers || {});
  headers.set("X-Progress-Token", token);
  startModelRequestProgressPolling(
    token,
    options.rangeStart ?? 0,
    options.rangeEnd ?? 100
  );

  try {
    const response = await fetchWithDiagnostics(
      endpoint,
      {
        ...init,
        headers,
      },
      fallbackMessage
    );
    await pollModelProgressOnce(
      token,
      options.rangeStart ?? 0,
      options.rangeEnd ?? 100
    );
    return response;
  } finally {
    clearModelProgressPollTimer();
  }
}

const BUILDING_REGISTER_FIELD_LABELS = {
  archArea: "건축면적(㎡)",
  atchBldArea: "부속건축물면적(㎡)",
  atchBldCnt: "부속건축물수",
  bcRat: "건폐율(%)",
  bjdongCd: "법정동코드",
  bun: "번",
  bylotCnt: "세대수(기타)",
  crtnDay: "생성일자",
  emgenUseElvtCnt: "비상용승강기수",
  engrEpi: "에너지성능지표",
  engrRat: "에너지효율등급",
  etcPurps: "기타용도",
  etcRoof: "기타지붕",
  etcStrct: "기타구조",
  fmlyCnt: "가구수",
  gnBldCert: "녹색건축인증",
  grndFlrCnt: "지상층수",
  heit: "높이(m)",
  hhldCnt: "세대수",
  hoCnt: "호수",
  indrAutoArea: "옥내자주식주차면적(㎡)",
  indrAutoUtcnt: "옥내자주식주차대수",
  indrMechArea: "옥내기계식주차면적(㎡)",
  indrMechUtcnt: "옥내기계식주차대수",
  itgBldCert: "지능형건축물인증",
  ji: "지",
  mainAtchGbCd: "주/부속구분코드",
  mainAtchGbCdNm: "주/부속구분",
  mainPurpsCd: "주용도코드",
  mainPurpsCdNm: "주용도",
  mgmBldrgstPk: "건축물대장PK",
  naBjdongCd: "도로명주소법정동코드",
  naMainBun: "도로명주소건물본번",
  naRoadCd: "도로명주소도로코드",
  naSubBun: "도로명주소건물부번",
  naUgrndCd: "도로명주소지상지하코드",
  newPlatPlc: "도로명주소",
  oudrAutoArea: "옥외자주식주차면적(㎡)",
  oudrAutoUtcnt: "옥외자주식주차대수",
  oudrMechArea: "옥외기계식주차면적(㎡)",
  oudrMechUtcnt: "옥외기계식주차대수",
  platArea: "대지면적(㎡)",
  platGbCd: "대지구분코드",
  platPlc: "지번주소",
  pmsDay: "허가일자",
  regstrGbCd: "대장구분코드",
  regstrGbCdNm: "대장구분",
  regstrKindCd: "대장종류코드",
  regstrKindCdNm: "대장종류",
  rideUseElvtCnt: "승용승강기수",
  rnum: "순번",
  roofCd: "지붕코드",
  roofCdNm: "지붕",
  rserthqkDsgnApplyYn: "내진설계적용여부",
  sigunguCd: "시군구코드",
  stcnsDay: "착공일자",
  strctCd: "구조코드",
  strctCdNm: "구조",
  totArea: "연면적(㎡)",
  totDongTotArea: "동연면적합계(㎡)",
  ugrndFlrCnt: "지하층수",
  useAprDay: "사용승인일자",
  vlRat: "용적률(%)",
  vlRatEstmTotArea: "용적률산정연면적(㎡)",
};

const LAND_INFO_FUTURE_FIELDS = [
  "소유구분",
  "공유인수",
  "축척구분",
  "토지정보 기준일",
  "지형높이",
  "지형형상",
  "도로접면",
  "토지특성 기준일",
  "토지이동 지목",
  "토지이동 면적(㎡)",
  "토지이동 사유",
  "토지이동일",
  "건축면적(㎡)",
  "연면적(㎡)",
  "용적률산정 연면적(㎡)",
  "건폐율(%)",
  "용적률(%)",
  "사용승인일자",
  "층별현황",
];

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatCoord(value) {
  return Number(value).toFixed(6);
}

function formatArea(value) {
  return `${Number(value).toLocaleString("ko-KR", {
    maximumFractionDigits: 1,
  })}㎡`;
}

function formatRatio(value) {
  if (!Number.isFinite(Number(value)) || Number(value) <= 0) {
    return "미확인";
  }

  return `${Number(value).toLocaleString("ko-KR", {
    maximumFractionDigits: 2,
  })}%`;
}

function formatHeight(value) {
  if (!Number.isFinite(Number(value)) || Number(value) <= 0) {
    return "미확인";
  }

  return `${Number(value).toLocaleString("ko-KR", {
    maximumFractionDigits: 1,
  })}m`;
}

function formatDateText(value) {
  const normalized = String(value || "").trim();

  if (!/^\d{8}$/.test(normalized)) {
    return normalized || "미확인";
  }

  return `${normalized.slice(0, 4)}-${normalized.slice(4, 6)}-${normalized.slice(6, 8)}`;
}

function shortenRegionName(value) {
  return [
    ["서울특별시", "서울"],
    ["부산광역시", "부산"],
    ["대구광역시", "대구"],
    ["인천광역시", "인천"],
    ["광주광역시", "광주"],
    ["대전광역시", "대전"],
    ["울산광역시", "울산"],
    ["세종특별자치시", "세종"],
    ["제주특별자치도", "제주"],
    ["강원특별자치도", "강원"],
    ["전북특별자치도", "전북"],
    ["경기도", "경기"],
    ["충청북도", "충북"],
    ["충청남도", "충남"],
    ["전라북도", "전북"],
    ["전라남도", "전남"],
    ["경상북도", "경북"],
    ["경상남도", "경남"],
  ].reduce(
    (text, [source, target]) => text.replaceAll(source, target),
    String(value || "")
  );
}

function normalizeSystemAddress(value) {
  return shortenRegionName(
    String(value || "")
      .replace(/\([^)]*\)/g, " ")
      .replace(/대한민국/g, " ")
      .replace(/\b\d{5}\b/g, " ")
      .replace(/,/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function getSystemAddress(location) {
  return normalizeSystemAddress(
    location?.roadAddress || location?.parcelAddress || location?.label || ""
  );
}

function buildSelectionLabel(location) {
  return (
    getSystemAddress(location) ||
    location?.roadAddress ||
    location?.parcelAddress ||
    location?.label ||
    `${formatCoord(location.lat)}, ${formatCoord(location.lng)}`
  );
}

function buildHistoryKey(location) {
  return `${location.label || ""}|${formatCoord(location.lat)}|${formatCoord(location.lng)}`;
}

function getSelectionRequestKey(location = state.selectedLocation) {
  return location ? buildHistoryKey(location) : "";
}

function isSelectionRequestCurrent(selectionKey) {
  return Boolean(selectionKey) && selectionKey === state.activeSelectionKey;
}

function getPreferredAddress(location) {
  return getSystemAddress(location) || location.roadAddress || location.parcelAddress || location.label || "";
}

function getRegionText(location) {
  const source = getPreferredAddress(location);
  const parts = source.split(" ").filter(Boolean);
  return parts.slice(0, 2).join(" ") || source;
}

function describeDataSource(provider, mode) {
  const providerNameMap = {
    disabled: "제외",
    flat: "평탄화",
    "open-meteo": "실표고 샘플",
    synthetic: "임시 지형",
    vworld: "브이월드",
  };
  const modeNameMap = {
    fallback: "대체 데이터",
    generated: "자동 생성",
    live: "실데이터",
  };
  const providerText = providerNameMap[provider] || provider || "미확인";
  const modeText = modeNameMap[mode] || mode || "";

  return modeText ? `${providerText} / ${modeText}` : providerText;
}

function formatElevationRange(minValue, maxValue) {
  if (!Number.isFinite(Number(minValue)) || !Number.isFinite(Number(maxValue))) {
    return "미확인";
  }

  return `${Number(minValue).toLocaleString("ko-KR", {
    maximumFractionDigits: 1,
  })}m ~ ${Number(maxValue).toLocaleString("ko-KR", {
    maximumFractionDigits: 1,
  })}m`;
}

function buildAppliedModelSummary(siteContext = state.siteContext) {
  if (!siteContext) {
    return "범위를 설정하면 대지, 지형, 건물 범위를 먼저 확인할 수 있습니다.";
  }

  const stats = siteContext.stats || {};
  const options = siteContext.options || {};

  return (
    `범위 ${Number(options.radius || 0).toLocaleString("ko-KR")}m, ` +
    `등고 간격 ${Number(options.contourInterval || 1).toLocaleString("ko-KR")}m, ` +
    `대지 ${Number(stats.parcelAreaSqm || 0).toLocaleString("ko-KR")}㎡, ` +
    `표고 ${formatElevationRange(stats.minElevation, stats.maxElevation)}, ` +
    `건물 ${stats.buildingCount || 0}개 ` +
    `(대지 내부 ${stats.targetBuildingCount || 0}개)가 추출 범위에 반영되었습니다.`
  );
}

function setProviderBadge() {
  if (!state.runtimeConfig) {
    providerBadge.textContent = "실행 설정 확인 중";
    return;
  }

  const { hasVWorldKey, usesFallbackWithoutKey } = state.runtimeConfig.search;
  const hasJusoKey = state.runtimeConfig.search?.hasJusoKey;
  const hasVWorldDataKey = state.runtimeConfig.data?.hasVWorldDataKey;

  if (hasVWorldKey && hasVWorldDataKey && hasJusoKey) {
    providerBadge.textContent = "브이월드 + 주소API 실데이터 준비됨";
    return;
  }

  if (hasVWorldKey && hasVWorldDataKey) {
    providerBadge.textContent = "브이월드 실데이터 준비됨";
    return;
  }

  if (usesFallbackWithoutKey) {
    providerBadge.textContent = "임시 검색 + 모의 대지 사용 중";
    return;
  }

  providerBadge.textContent = "지도 클릭만 사용 가능";
}

function setActionFeedback(message) {
  if (actionFeedback) {
    actionFeedback.textContent = message;
  }
}

function wait(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function clampModelProgressEstimate(ms) {
  return Math.max(
    MODEL_PROGRESS_MIN_ESTIMATE_MS,
    Math.min(MODEL_PROGRESS_MAX_ESTIMATE_MS, Math.round(Number(ms) || 0))
  );
}

function readModelProgressEstimates() {
  if (state.modelProgressEstimates) {
    return state.modelProgressEstimates;
  }

  try {
    const raw = window.localStorage.getItem(MODEL_PROGRESS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    state.modelProgressEstimates =
      parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    state.modelProgressEstimates = {};
  }

  return state.modelProgressEstimates;
}

function saveModelProgressEstimates(estimates) {
  state.modelProgressEstimates = estimates;

  try {
    window.localStorage.setItem(
      MODEL_PROGRESS_STORAGE_KEY,
      JSON.stringify(estimates)
    );
  } catch {
    // Ignore localStorage write failures and keep in-memory estimates only.
  }
}

function getModelProgressEstimate(operationKey) {
  const estimates = readModelProgressEstimates();
  const storedValue = Number(estimates?.[operationKey]);
  const fallbackValue =
    MODEL_PROGRESS_DEFAULT_ESTIMATES_MS[operationKey] ||
    MODEL_PROGRESS_DEFAULT_ESTIMATES_MS["export-obj"];

  return clampModelProgressEstimate(
    Number.isFinite(storedValue) ? storedValue : fallbackValue
  );
}

function rememberModelProgressEstimate(operationKey, actualDurationMs) {
  if (!operationKey || !Number.isFinite(actualDurationMs)) {
    return;
  }

  const estimates = { ...readModelProgressEstimates() };
  const previousEstimate = getModelProgressEstimate(operationKey);
  const normalizedDuration = clampModelProgressEstimate(actualDurationMs);
  const blendedEstimate =
    previousEstimate * 0.65 + normalizedDuration * 0.35;

  estimates[operationKey] = clampModelProgressEstimate(blendedEstimate);
  saveModelProgressEstimates(estimates);
}

function formatModelRemainingTime(remainingMs) {
  if (!Number.isFinite(remainingMs)) {
    return "시간 계산 중입니다";
  }

  if (remainingMs <= 1200) {
    return "곧 완료됩니다";
  }

  const seconds = Math.ceil(remainingMs / 1000);

  if (seconds < 60) {
    return `약 ${seconds}초 남음`;
  }

  return `약 ${Math.ceil(seconds / 60)}분 남음`;
}

function formatModelElapsedTime(elapsedMs) {
  const normalizedMs = Math.max(0, Number(elapsedMs) || 0);
  const seconds = Math.floor(normalizedMs / 1000);

  if (seconds < 60) {
    return `${seconds}초 경과`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}분 ${remainingSeconds}초 경과`;
}

function setModelProgress(value, message, stateName = "idle") {
  if (!modelProgressBar || !modelProgressFill || !modelProgressLabel) {
    return;
  }

  const normalized = Math.max(0, Math.min(100, Number(value) || 0));
  state.modelProgressValue = normalized;
  modelProgressBar.dataset.state = stateName;
  modelProgressFill.style.width = `${normalized}%`;
  modelProgressLabel.textContent = message;
}

function clearModelProgressTimer() {
  if (state.modelProgressTimer) {
    window.clearInterval(state.modelProgressTimer);
    state.modelProgressTimer = null;
  }
}

function clearModelProgressPollTimer() {
  if (state.modelProgressPollTimer) {
    window.clearInterval(state.modelProgressPollTimer);
    state.modelProgressPollTimer = null;
  }
}

function syncTimedModelProgress() {
  const session = state.modelProgressSession;

  if (!session) {
    return;
  }

  const elapsedMs = performance.now() - session.startedAt;
  const nextValue = Math.min(
    session.maxValue,
    Math.max(0, session.minValue, session.currentValue)
  );

  setModelProgress(
    nextValue,
    `${session.message} · ${formatModelElapsedTime(elapsedMs)}`,
    "active"
  );
}

function startModelProgress(operationKey, message, options = {}) {
  clearModelProgressTimer();
  clearModelProgressPollTimer();
  const startValue = Math.max(0, Number(options.startValue) || 6);
  const maxValue = Math.max(startValue, Number(options.maxValue) || 94);
  state.modelProgressSession = {
    operationKey,
    message,
    startedAt: performance.now(),
    startValue,
    minValue: startValue,
    currentValue: startValue,
    maxValue,
  };
  syncTimedModelProgress();
  state.modelProgressTimer = window.setInterval(syncTimedModelProgress, 250);
}

function advanceModelProgress(value, message) {
  if (state.modelProgressSession) {
    if (Number.isFinite(value)) {
      const normalizedValue = Math.min(
        state.modelProgressSession.maxValue,
        Math.max(0, Number(value) || 0)
      );
      state.modelProgressSession.minValue = Math.max(
        state.modelProgressSession.minValue,
        normalizedValue
      );
      state.modelProgressSession.currentValue = Math.max(
        state.modelProgressSession.currentValue,
        normalizedValue
      );
    }

    if (typeof message === "string" && message.trim()) {
      state.modelProgressSession.message = message;
    }

    syncTimedModelProgress();
    return;
  }

  setModelProgress(Math.max(value, state.modelProgressValue), message, "active");
}

function finishModelProgress(message) {
  clearModelProgressTimer();
  clearModelProgressPollTimer();
  state.modelProgressSession = null;
  setModelProgress(100, message, "done");
}

function failModelProgress(message) {
  clearModelProgressTimer();
  clearModelProgressPollTimer();
  state.modelProgressSession = null;
  setModelProgress(Math.max(18, state.modelProgressValue), message, "error");
}

function resetModelProgress(
  message = "범위를 설정하면 지도 버퍼와 3D 추출 범위가 여기에 표시됩니다."
) {
  clearModelProgressTimer();
  clearModelProgressPollTimer();
  state.modelProgressSession = null;
  setModelProgress(0, message, "idle");
}

function loadHistory() {
  try {
    const raw = window.localStorage.getItem(HISTORY_STORAGE_KEY);
    state.history = raw ? JSON.parse(raw) : [];
  } catch {
    state.history = [];
  }
}

function saveHistory() {
  window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(state.history));
}

function pushHistory(location) {
  const key = buildHistoryKey(location);
  const nextItem = {
    ...location,
    savedAt: new Date().toISOString(),
    historyKey: key,
  };

  state.history = [
    nextItem,
    ...state.history.filter((item) => item.historyKey !== key),
  ].slice(0, 8);

  saveHistory();
  renderHistory();
}

function renderHistory() {
  if (!state.history.length) {
    historyList.innerHTML =
      '<p class="history-empty">아직 저장된 선택 이력이 없습니다.</p>';
    return;
  }

  historyList.innerHTML = "";

  state.history.forEach((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "history-item";
    button.innerHTML = `
      <strong>${escapeHtml(buildSelectionLabel(item))}</strong>
      <span>${formatCoord(item.lat)}, ${formatCoord(item.lng)}</span>
    `;
    button.addEventListener("click", () => {
      setSelectedLocation(item);
    });
    historyList.append(button);
  });
}

function clearContextLayers() {
  Object.keys(state.layers).forEach((key) => {
    if (state.layers[key]) {
      state.map.removeLayer(state.layers[key]);
      state.layers[key] = null;
    }
  });
}

function updateContextLayers(siteContext) {
  clearContextLayers();

  state.layers.clipBoundary = L.geoJSON(siteContext.clipBoundary, {
    style: {
      color: "#bb5a34",
      dashArray: "8 8",
      fillColor: "#bb5a34",
      fillOpacity: 0.04,
      weight: 2,
    },
  }).addTo(state.map);

  state.layers.parcelBoundary = L.geoJSON(siteContext.parcelBoundary, {
    style: {
      color: "#223d2c",
      fillOpacity: 0,
      weight: 3,
    },
  }).addTo(state.map);

  state.layers.contourLines = L.geoJSON(siteContext.contourLines, {
    style: {
      color: "#6d6a76",
      opacity: 0.9,
      weight: 1.25,
    },
  }).addTo(state.map);

  if (siteContext.buildings?.features?.length) {
    state.layers.buildings = L.geoJSON(siteContext.buildings, {
      style: (feature) => ({
        color: feature?.properties?.isTarget ? "#c5622e" : "#7f6a59",
        fillColor: feature?.properties?.isTarget ? "#d28845" : "#9e8a78",
        fillOpacity: feature?.properties?.isTarget ? 0.32 : 0.18,
        weight: feature?.properties?.isTarget ? 2.2 : 1.1,
      }),
    }).addTo(state.map);
  }

  const bounds = state.layers.clipBoundary.getBounds();

  if (bounds.isValid()) {
    state.map.fitBounds(bounds.pad(0.15));
  }
}

function renderSelectionSummary() {
  if (!state.selectedLocation) {
    selectionSummary.textContent = "아직 선택된 위치가 없습니다.";
    return;
  }

  selectionSummary.textContent = `${buildSelectionLabel(state.selectedLocation)} / ${formatCoord(
    state.selectedLocation.lat
  )}, ${formatCoord(state.selectedLocation.lng)}`;
}

function renderSelectionMeta() {
  if (!state.selectedLocation) {
    selectionMeta.innerHTML = `
      <div><dt>대표 주소</dt><dd>선택 후 표시</dd></div>
      <div><dt>지번 주소</dt><dd>선택 후 표시</dd></div>
      <div><dt>좌표</dt><dd>선택 후 표시</dd></div>
      <div><dt>건물명</dt><dd>선택 후 표시</dd></div>
    `;
    return;
  }

  const item = state.selectedLocation;
  const systemAddress = getSystemAddress(item) || "현재 미확인";
  const parcelAddress = normalizeSystemAddress(item.parcelAddress || "") || "현재 미확인";
  const buildingName = item.buildingName || item.label || "현재 미확인";

  selectionMeta.innerHTML = `
    <div><dt>대표 주소</dt><dd>${escapeHtml(systemAddress)}</dd></div>
    <div><dt>지번 주소</dt><dd>${escapeHtml(parcelAddress)}</dd></div>
    <div><dt>좌표</dt><dd>${formatCoord(item.lat)}, ${formatCoord(item.lng)}</dd></div>
    <div><dt>건물명</dt><dd>${escapeHtml(buildingName)}</dd></div>
  `;
}

function renderSiteContextMetaLegacy() {
  if (!hasFreshSiteContextForCurrentOptions()) {
    siteContextMeta.innerHTML = `
      <div><dt>대지 소스</dt><dd>아직 불러오지 않음</dd></div>
      <div><dt>지형 소스</dt><dd>아직 불러오지 않음</dd></div>
      <div><dt>대지 면적</dt><dd>아직 불러오지 않음</dd></div>
      <div><dt>등고선 수</dt><dd>아직 불러오지 않음</dd></div>
    `;
    siteContextNote.textContent = "위치를 선택한 뒤 대지/등고 미리보기를 불러오세요.";
    return;
  }

  const parcel = state.siteContext.dataSources?.parcel;
  const terrain = state.siteContext.dataSources?.terrain;
  const stats = state.siteContext.stats || {};

  siteContextMeta.innerHTML = `
    <div><dt>대지 소스</dt><dd>${escapeHtml(
      `${parcel?.provider || "unknown"} / ${parcel?.mode || "unknown"}`
    )}</dd></div>
    <div><dt>지형 소스</dt><dd>${escapeHtml(
      `${terrain?.provider || "unknown"} / ${terrain?.mode || "unknown"}`
    )}</dd></div>
    <div><dt>대지 면적</dt><dd>${escapeHtml(formatArea(stats.parcelAreaSqm || 0))}</dd></div>
    <div><dt>등고선 수</dt><dd>${escapeHtml(String(stats.contourCount || 0))}</dd></div>
  `;
  siteContextNote.textContent =
    parcel?.note || terrain?.note || "대지 컨텍스트를 불러왔습니다.";
}

function renderSiteContextMeta() {
  if (!state.siteContext) {
    siteContextMeta.innerHTML = `
      <div><dt>대지 경계</dt><dd>아직 불러오지 않음</dd></div>
      <div><dt>지형 생성</dt><dd>아직 불러오지 않음</dd></div>
      <div><dt>건물 매스</dt><dd>아직 불러오지 않음</dd></div>
      <div><dt>대지 면적</dt><dd>아직 불러오지 않음</dd></div>
      <div><dt>표고 범위</dt><dd>아직 불러오지 않음</dd></div>
      <div><dt>포함 건물</dt><dd>아직 불러오지 않음</dd></div>
    `;
    siteContextNote.textContent =
      "위치를 선택한 뒤 대지/지형/건물 미리보기를 불러오세요.";
    return;
  }

  const parcel = state.siteContext.dataSources?.parcel;
  const terrain = state.siteContext.dataSources?.terrain;
  const buildings = state.siteContext.dataSources?.buildings;
  const stats = state.siteContext.stats || {};

  siteContextMeta.innerHTML = `
    <div><dt>대지 경계</dt><dd>${escapeHtml(
      describeDataSource(parcel?.provider, parcel?.mode)
    )}</dd></div>
    <div><dt>지형 생성</dt><dd>${escapeHtml(
      describeDataSource(terrain?.provider, terrain?.mode)
    )}</dd></div>
    <div><dt>건물 매스</dt><dd>${escapeHtml(
      describeDataSource(buildings?.provider, buildings?.mode)
    )}</dd></div>
    <div><dt>대지 면적</dt><dd>${escapeHtml(formatArea(stats.parcelAreaSqm || 0))}</dd></div>
    <div><dt>표고 범위</dt><dd>${escapeHtml(
      formatElevationRange(stats.minElevation, stats.maxElevation)
    )}</dd></div>
    <div><dt>포함 건물</dt><dd>${escapeHtml(
      `${stats.buildingCount || 0}개 / 대지 내부 ${stats.targetBuildingCount || 0}개`
    )}</dd></div>
  `;
  siteContextNote.textContent =
    terrain?.note || buildings?.note || parcel?.note || "대지 컨텍스트를 불러왔습니다.";
}

function renderInfoItems(container, items, emptyMessage) {
  if (!items?.length) {
    container.innerHTML = `<p class="search-results-empty">${escapeHtml(emptyMessage)}</p>`;
    return;
  }

  container.innerHTML = items
    .map(
      (item) => `
        <article class="info-item">
          <div class="info-item-header">
            <strong>${escapeHtml(item.title || "이름 미확인")}</strong>
            ${
              item.detailUrl
                ? `<button type="button" class="info-item-link" data-detail-url="${escapeHtml(item.detailUrl)}" data-detail-title="${escapeHtml(item.title || "상세 정보")}">상세</button>`
                : ""
            }
          </div>
          <p>${escapeHtml(item.category || "")}</p>
        </article>
      `
    )
    .join("");

  container.querySelectorAll(".info-item-link[data-detail-url]").forEach((button) => {
    button.addEventListener("click", () => {
      const detailUrl = button.getAttribute("data-detail-url");
      const detailTitle = button.getAttribute("data-detail-title") || "상세 정보";
      const popup = openPendingWindow(detailTitle);

      if (!popup || !detailUrl) {
        return;
      }

      popup.location.replace(detailUrl);
    });
  });
}

function trimMetaGrid(container, itemCount) {
  if (!container) {
    return;
  }

  while (container.children.length > itemCount) {
    container.removeChild(container.firstElementChild);
  }
}

function renderLandInfo() {
  if (!state.selectedLocation) {
    landInfoMeta.innerHTML = `
      <div><dt>조회 상태</dt><dd>선택 전</dd></div>
      <div><dt>지목</dt><dd>선택 전</dd></div>
      <div><dt>면적</dt><dd>선택 전</dd></div>
      <div><dt>지역지구 수</dt><dd>선택 전</dd></div>
      <div><dt>공시지가</dt><dd>선택 전</dd></div>
      <div><dt>기준 주소</dt><dd>선택 전</dd></div>
    `;
    landInfoNote.textContent =
      "주소를 선택한 뒤 토지정보를 불러오면 토지이음 결과를 검색 없이 바로 연결할 수 있습니다.";
    renderInfoItems(landInfoList, [], "토지정보 요약 결과가 여기에 표시됩니다.");
    renderInfoItems(lawInfoList, [], "법규 요약 결과가 여기에 표시됩니다.");
    return;
  }

  if (!state.landInfo) {
    landInfoMeta.innerHTML = `
      <div><dt>조회 상태</dt><dd>조회 전</dd></div>
      <div><dt>지목</dt><dd>조회 전</dd></div>
      <div><dt>면적</dt><dd>조회 전</dd></div>
      <div><dt>지역지구 수</dt><dd>조회 전</dd></div>
      <div><dt>공시지가</dt><dd>조회 전</dd></div>
      <div><dt>기준 주소</dt><dd>조회 전</dd></div>
    `;
    landInfoNote.textContent =
      "토지정보 불러오기를 누르면 토지이음의 필지 결과와 법규 요약을 이 화면에 정리합니다.";
    renderInfoItems(landInfoList, [], "토지정보 요약 결과가 여기에 표시됩니다.");
    renderInfoItems(lawInfoList, [], "법규 요약 결과가 여기에 표시됩니다.");
    return;
  }

  const summary = state.landInfo.summary || {};
  const urbanPlanningItems = state.landInfo.regulations?.urbanPlanningItems || [];
  const otherLawItems = state.landInfo.regulations?.otherLawItems || [];

  landInfoMeta.innerHTML = `
    <div><dt>조회 상태</dt><dd>실데이터 조회 완료</dd></div>
    <div><dt>지목</dt><dd>${escapeHtml(summary.landCategory || "미확인")}</dd></div>
    <div><dt>면적</dt><dd>${escapeHtml(summary.areaText || "미확인")}</dd></div>
    <div><dt>지역지구 수</dt><dd>${escapeHtml(`${summary.urbanPlanningCount || 0} / ${summary.otherLawCount || 0}`)}</dd></div>
    <div><dt>공시지가</dt><dd>${escapeHtml(summary.announcedPrice || "미확인")}</dd></div>
    <div><dt>기준 주소</dt><dd>${escapeHtml(state.landInfo.address || buildSelectionLabel(state.selectedLocation))}</dd></div>
  `;
  landInfoNote.textContent =
    `${state.landInfo.address || buildSelectionLabel(state.selectedLocation)} 기준 토지이음 결과를 정리했습니다.`;
  renderInfoItems(
    landInfoList,
    urbanPlanningItems,
    "국토계획법 지역ㆍ지구 정보가 없습니다."
  );
  renderInfoItems(
    lawInfoList,
    otherLawItems,
    "다른 법령 등에 따른 지역ㆍ지구 정보가 없습니다."
  );
}

function renderBuildingRegister() {
  if (!state.runtimeConfig?.futureSources?.hasBuildingHubKey) {
    buildingRegisterMeta.innerHTML = `
      <div><dt>조회 상태</dt><dd>키 미설정</dd></div>
      <div><dt>건물 수</dt><dd>조회 불가</dd></div>
      <div><dt>대표 용도</dt><dd>조회 불가</dd></div>
      <div><dt>대표 연면적</dt><dd>조회 불가</dd></div>
      <div><dt>대표 층수</dt><dd>조회 불가</dd></div>
      <div><dt>대표 구조</dt><dd>조회 불가</dd></div>
    `;
    trimMetaGrid(buildingRegisterMeta, 5);
    buildingRegisterNote.textContent =
      "건축HUB 서비스키를 넣으면 앱 안에서 건축물대장 요약을 불러올 수 있습니다.";
    buildingRegisterList.innerHTML =
      '<p class="search-results-empty">건축HUB 키를 설정하면 결과가 표시됩니다.</p>';
    return;
  }

  if (!state.buildingRegister) {
    buildingRegisterMeta.innerHTML = `
      <div><dt>조회 상태</dt><dd>조회 전</dd></div>
      <div><dt>건물 수</dt><dd>조회 전</dd></div>
      <div><dt>대표 용도</dt><dd>조회 전</dd></div>
      <div><dt>대표 연면적</dt><dd>조회 전</dd></div>
      <div><dt>대표 층수</dt><dd>조회 전</dd></div>
      <div><dt>대표 구조</dt><dd>조회 전</dd></div>
    `;
    trimMetaGrid(buildingRegisterMeta, 5);
    buildingRegisterNote.textContent =
      "주소 검색 결과를 선택하거나 대지를 먼저 불러온 뒤 조회하세요. 현재 인쇄는 요약본 기준입니다.";
    buildingRegisterList.innerHTML =
      '<p class="search-results-empty">건축물대장 요약 결과가 여기에 표시됩니다.</p>';
    return;
  }

  const primary = state.buildingRegister.primary;
  const items = state.buildingRegister.items || [];
  buildingRegisterMeta.innerHTML = `
    <div><dt>조회 상태</dt><dd>실데이터 조회 완료</dd></div>
    <div><dt>건물 수</dt><dd>${escapeHtml(String(state.buildingRegister.buildingCount || 0))}</dd></div>
    <div><dt>대표 용도</dt><dd>${escapeHtml(primary?.mainPurpose || "미확인")}</dd></div>
    <div><dt>대표 연면적</dt><dd>${escapeHtml(formatArea(primary?.totalAreaSqm || 0))}</dd></div>
    <div><dt>대표 층수</dt><dd>${escapeHtml(`${primary?.aboveGroundFloors || 0}층 / 지하 ${primary?.belowGroundFloors || 0}층`)}</dd></div>
    <div><dt>대표 구조</dt><dd>${escapeHtml(primary?.structureName || "미확인")}</dd></div>
  `;
  trimMetaGrid(buildingRegisterMeta, 5);
  buildingRegisterNote.textContent =
    "건축HUB 표제부 조회 결과를 요약해 보여주고 있습니다. 공식 원본 확인은 세움터 팝업을 이용하세요.";

  if (!items.length) {
    buildingRegisterList.innerHTML =
      '<p class="search-results-empty">조회된 건축물대장 항목이 없습니다.</p>';
    return;
  }

  buildingRegisterList.innerHTML = items
    .slice(0, 4)
    .map(
      (item) => `
        <article class="building-item">
          <div class="building-item-header">
            <strong>${escapeHtml(item.buildingName || item.dongName || "이름 미확인")}</strong>
            <span>${escapeHtml(item.mainPurpose || "용도 미확인")}</span>
          </div>
          <p>${escapeHtml(item.roadAddress || item.parcelAddress || "주소 미확인")}</p>
          <dl class="building-item-grid">
            <div><dt>연면적</dt><dd>${escapeHtml(formatArea(item.totalAreaSqm || 0))}</dd></div>
            <div><dt>건폐율</dt><dd>${escapeHtml(formatRatio(item.coverageRatio))}</dd></div>
            <div><dt>용적률</dt><dd>${escapeHtml(formatRatio(item.floorAreaRatio))}</dd></div>
            <div><dt>높이</dt><dd>${escapeHtml(formatHeight(item.heightMeters))}</dd></div>
            <div><dt>층수</dt><dd>${escapeHtml(`${item.aboveGroundFloors || 0}층 / 지하 ${item.belowGroundFloors || 0}층`)}</dd></div>
            <div><dt>사용승인</dt><dd>${escapeHtml(formatDateText(item.approvalDate))}</dd></div>
          </dl>
        </article>
      `
    )
    .join("");
}

function formatRegisterFieldLabel(key) {
  if (BUILDING_REGISTER_FIELD_LABELS[key]) {
    return BUILDING_REGISTER_FIELD_LABELS[key];
  }

  return String(key || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatRegisterFieldValue(value) {
  if (value === null || value === undefined || value === "") {
    return "미확인";
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value.toLocaleString("ko-KR") : "미확인";
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  return String(value);
}

function buildDetailFieldCards(entries, emptyMessage) {
  if (!entries.length) {
    return `<p class="notice">${escapeHtml(emptyMessage)}</p>`;
  }

  return `
    <div class="grid">
      ${entries
        .map(
          ([label, value]) => `
            <div>
              <strong>${escapeHtml(label)}</strong>
              <span>${escapeHtml(formatRegisterFieldValue(value))}</span>
            </div>
          `
        )
        .join("")}
    </div>
  `;
}

async function openBuildingRegisterDetails(popup = null) {
  if (!state.selectedLocation) {
    window.alert("먼저 위치를 선택해 주세요.");
    return;
  }

  if (!state.buildingRegister) {
    await loadBuildingRegister();
  }

  const targetWindow = popup || openPendingWindow("건축물대장 상세 정보");

  if (!targetWindow) {
    return;
  }

  const items = state.buildingRegister?.items || [];
  const address = buildSelectionLabel(state.selectedLocation);
  const sections = items.length
    ? items
        .map((item, index) => {
          const summaryEntries = [
            ["건물명", item.buildingName || item.dongName || "미확인"],
            ["도로명 주소", item.roadAddress || "미확인"],
            ["지번 주소", item.parcelAddress || "미확인"],
            ["주용도", item.mainPurpose || "미확인"],
            ["기타 용도", item.etcPurpose || "미확인"],
            ["연면적", formatArea(item.totalAreaSqm || 0)],
            ["건축면적", formatArea(item.buildingAreaSqm || 0)],
            ["대지면적", formatArea(item.landAreaSqm || 0)],
            ["건폐율", formatRatio(item.coverageRatio)],
            ["용적률", formatRatio(item.floorAreaRatio)],
            ["높이", formatHeight(item.heightMeters)],
            ["층수", `${item.aboveGroundFloors || 0}층 / 지하 ${item.belowGroundFloors || 0}층`],
            ["구조", item.structureName || "미확인"],
            ["지붕", item.roofName || "미확인"],
            ["사용승인일", formatDateText(item.approvalDate)],
            ["주/부속 구분", item.mainAttachmentType || "미확인"],
            ["대장 종류", item.registerKind || "미확인"],
            ["주차 대수", item.parkingCount ?? "미확인"],
            ["식별 ID", item.id || "미확인"],
          ];
          const sourceEntries = Object.entries(item.sourceFields || {}).sort((left, right) =>
            String(left[0]).localeCompare(String(right[0]))
          );

          return `
            <section class="card">
              <h2>${escapeHtml(
                `${index + 1}. ${item.buildingName || item.dongName || "건축물"}`
              )}</h2>
              <p class="meta">${escapeHtml(item.roadAddress || item.parcelAddress || address)}</p>
              <div class="section">
                <h3>요약 필드</h3>
                ${buildDetailFieldCards(summaryEntries, "표시할 요약 필드가 없습니다.")}
              </div>
              <div class="section">
                <h3>API 원본 필드</h3>
                ${buildDetailFieldCards(
                  sourceEntries.map(([key, value]) => [formatRegisterFieldLabel(key), value]),
                  "응답된 원본 필드가 없습니다."
                )}
              </div>
            </section>
          `;
        })
        .join("")
    : '<p class="notice">조회된 건축물대장 항목이 없습니다.</p>';

  renderPopupWindow(
    targetWindow,
    "건축물대장 상세 정보",
    `
      <h1>건축물대장 상세 정보</h1>
      <p class="meta">${escapeHtml(address)}<br />조회 시각: ${escapeHtml(
        new Date().toLocaleString("ko-KR")
      )}</p>
      <p class="notice">
        이 창은 현재 API로 받아오는 필드를 최대한 펼쳐 보여주는 참고용 화면입니다.
      </p>
      <div class="section">${sections}</div>
    `
  );
}

function buildLandRegulationCards(items, emptyMessage) {
  if (!items.length) {
    return `<p class="notice">${escapeHtml(emptyMessage)}</p>`;
  }

  return items
    .map(
      (item) => `
        <section class="card">
          <h3>${escapeHtml(item.title || "상세 정보")}</h3>
          <p class="meta">${escapeHtml(item.category || "")}</p>
          ${
            item.detailUrl
              ? `<p class="notice">상세 링크: ${escapeHtml(item.detailUrl)}</p>`
              : ""
          }
        </section>
      `
    )
    .join("");
}

function buildLandMovementCards(items, emptyMessage) {
  if (!items.length) {
    return `<p class="notice">${escapeHtml(emptyMessage)}</p>`;
  }

  return items
    .map(
      (item, index) => `
        <section class="card">
          <h3>${escapeHtml(`${index + 1}. ${item.movementDate || "일자 미상"}`)}</h3>
          ${buildDetailFieldCards(
            [
              ["지목", item.landCategory || "미확인"],
              ["면적", formatArea(item.areaSquareMeters || 0)],
              ["토지이동사유", item.reason || "미확인"],
              ["토지이동일", item.movementDate || "미확인"],
            ],
            "표시할 토지이동 정보가 없습니다."
          )}
        </section>
      `
    )
    .join("");
}

function buildLandBuildingCards(buildings, emptyMessage) {
  if (!buildings.length) {
    return `<p class="notice">${escapeHtml(emptyMessage)}</p>`;
  }

  return buildings
    .map((item, index) => {
      const summaryEntries = [
        ["건물명", item.buildingName || item.dongName || "미확인"],
        ["동명", item.dongName || "미확인"],
        ["도로명 주소", item.roadAddress || "미확인"],
        ["지번 주소", item.parcelAddress || "미확인"],
        ["대장 종류", item.registerKind || "미확인"],
        ["주/부속 구분", item.mainAttachmentType || "미확인"],
        ["주용도", item.mainPurpose || "미확인"],
        ["건축면적", formatArea(item.buildingAreaSqm || 0)],
        ["연면적", formatArea(item.totalAreaSqm || 0)],
        [
          "용적률산정용 연면적",
          formatArea(Number(item.sourceFields?.vlRatEstmTotArea || 0)),
        ],
        ["건폐율", formatRatio(item.coverageRatio)],
        ["용적률", formatRatio(item.floorAreaRatio)],
        ["높이", formatHeight(item.heightMeters)],
        ["층수", `${item.aboveGroundFloors || 0}층 / 지하 ${item.belowGroundFloors || 0}층`],
        ["구조", item.structureName || "미확인"],
        ["사용승인일", formatDateText(item.approvalDate)],
      ];
      const floorEntries = (item.floorOutline || []).map((floorItem) => [
        floorItem.floorName || floorItem.floorTypeName || "층 미상",
        [
          floorItem.floorTypeName || "",
          floorItem.purpose || "",
          floorItem.structureName || "",
          formatArea(floorItem.areaSquareMeters || 0),
        ]
          .filter(Boolean)
          .join(" · "),
      ]);

      return `
        <section class="card">
          <h3>${escapeHtml(`${index + 1}. ${item.buildingName || item.dongName || "건축물"}`)}</h3>
          <div class="section">
            <h4>건축물 정보</h4>
            ${buildDetailFieldCards(summaryEntries, "표시할 건축물 정보가 없습니다.")}
          </div>
          <div class="section">
            <h4>층별현황</h4>
            ${buildDetailFieldCards(floorEntries, "층별현황이 없습니다.")}
          </div>
        </section>
      `;
    })
    .join("");
}

function getRemainingLandFutureFields(details = {}) {
  const loadedLabels = new Set();

  if (details.landOwnership) {
    loadedLabels.add("소유구분");
    loadedLabels.add("공유인수");
    loadedLabels.add("축척구분");
    loadedLabels.add("토지정보 기준일");
  }

  if (details.landCharacteristics) {
    loadedLabels.add("지형높이");
    loadedLabels.add("지형형상");
    loadedLabels.add("도로접면");
    loadedLabels.add("토지특성 기준일");
  }

  if ((details.landMovements || []).length) {
    loadedLabels.add("토지이동 지목");
    loadedLabels.add("토지이동 면적(㎡)");
    loadedLabels.add("토지이동 사유");
    loadedLabels.add("토지이동일");
  }

  if ((details.buildingInfo?.buildings || []).length) {
    loadedLabels.add("건축면적(㎡)");
    loadedLabels.add("연면적(㎡)");
    loadedLabels.add("용적률산정용 연면적(㎡)");
    loadedLabels.add("건폐율(%)");
    loadedLabels.add("용적률(%)");
    loadedLabels.add("사용승인일자");
    loadedLabels.add("층별현황");
  }

  return LAND_INFO_FUTURE_FIELDS.filter((label) => !loadedLabels.has(label));
}

async function openLandInfoDetails(popup = null) {
  if (!state.selectedLocation) {
    window.alert("먼저 위치를 선택해 주세요.");
    return;
  }

  const landInfo = await ensureLandInfoDetailsLoaded();

  const targetWindow = popup || openPendingWindow("토지이음 상세 정보");

  if (!targetWindow) {
    return;
  }

  const summary = landInfo.summary || {};
  const detailData = landInfo.details || {};
  const parcelReference = landInfo.parcelReference || {};
  const urbanPlanningItems = landInfo.regulations?.urbanPlanningItems || [];
  const otherLawItems = landInfo.regulations?.otherLawItems || [];
  const remainingFutureFields = getRemainingLandFutureFields(detailData);
  const overviewEntries = [
    ["기준 주소", landInfo.address || buildSelectionLabel(state.selectedLocation)],
    ["PNU", parcelReference.pnu || "미확인"],
    ["시군구코드", parcelReference.sigunguCd || "미확인"],
    ["법정동코드", parcelReference.bjdongCd || "미확인"],
    ["지목", summary.landCategory || "미확인"],
    ["면적", summary.areaText || "미확인"],
    ["개별공시지가", summary.announcedPrice || "미확인"],
    ["국토계획법 항목 수", urbanPlanningItems.length],
    ["다른 법령 항목 수", otherLawItems.length],
    ["토지이음 상세 링크", buildLandInfoHandoffUrl(landInfo)],
    ["토지이음 지도 링크", landInfo.official?.mapUrl || "미확인"],
    ["발급 안내 링크", landInfo.official?.issueUrl || "미확인"],
  ];
  const landOwnershipEntries = detailData.landOwnership
    ? [
        ["소유구분", detailData.landOwnership.possessionType || "미확인"],
        ["공유인수", detailData.landOwnership.coOwnerCount || "미확인"],
        ["축척구분", detailData.landOwnership.scaleType || "미확인"],
        ["토지정보 기준일", detailData.landOwnership.baseDate || "미확인"],
      ]
    : [];
  const landCharacteristicEntries = detailData.landCharacteristics
    ? [
        ["지형높이", detailData.landCharacteristics.topographyHeight || "미확인"],
        ["지형형상", detailData.landCharacteristics.topographyShape || "미확인"],
        ["도로접면", detailData.landCharacteristics.roadSide || "미확인"],
        ["토지특성 기준일", detailData.landCharacteristics.baseDate || "미확인"],
      ]
    : [];

  renderPopupWindow(
    targetWindow,
    "토지이음 상세 정보",
    `
      <h1>토지이음 상세 정보</h1>
      <p class="meta">${escapeHtml(
        landInfo.address || buildSelectionLabel(state.selectedLocation)
      )}<br />조회 시각: ${escapeHtml(new Date().toLocaleString("ko-KR"))}</p>
      <div class="section">
        <h3>현재 수집된 정보</h3>
        ${buildDetailFieldCards(overviewEntries, "표시할 토지 정보가 없습니다.")}
      </div>
      <div class="section">
        <h3>토지이력 · 특성</h3>
        ${buildDetailFieldCards(
          [...landOwnershipEntries, ...landCharacteristicEntries],
          "추가로 수집된 토지이력 · 특성 정보가 없습니다."
        )}
      </div>
      <div class="section">
        <h3>토지이동 이력</h3>
        ${buildLandMovementCards(
          detailData.landMovements || [],
          "표시할 토지이동 이력이 없습니다."
        )}
      </div>
      <div class="section">
        <h3>관련 건축물 정보</h3>
        ${buildLandBuildingCards(
          detailData.buildingInfo?.buildings || [],
          "표시할 관련 건축물 정보가 없습니다."
        )}
      </div>
      <div class="section">
        <h3>국토계획법 지역·지구</h3>
        ${buildLandRegulationCards(
          urbanPlanningItems,
          "국토계획법에 따른 상세 항목이 없습니다."
        )}
      </div>
      <div class="section">
        <h3>다른 법령 지역·지구</h3>
        ${buildLandRegulationCards(otherLawItems, "다른 법령에 따른 상세 항목이 없습니다.")}
      </div>
      <div class="section">
        <h3>추가 연계 후보 필드</h3>
        ${buildDetailFieldCards(
          remainingFutureFields.map((label) => [label, "추가 연계 후보"]),
          "추가 연계 후보 필드가 없습니다."
        )}
      </div>
      <p class="notice">
        토지이음 상세 팝업은 즉시 수집 가능한 값과 아직 별도 연계가 필요한 후보 필드를 함께 보여줍니다.
      </p>
    `
  );
}

function createKeywordChip(text, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "keyword-chip";
  button.textContent = text;
  button.addEventListener("click", onClick);
  return button;
}

async function copyText(value, successMessage) {
  if (!value) {
    window.alert("복사할 텍스트가 없습니다.");
    return;
  }

  try {
    await navigator.clipboard.writeText(value);
    setActionFeedback(successMessage);
  } catch {
    window.alert("클립보드 복사에 실패했습니다.");
  }
}

async function runOfficialAction(action) {
  if (action.copyText) {
    await copyText(action.copyText, action.feedbackText);
  }

  if (action.openUrl) {
    window.open(action.openUrl, "_blank", "noopener,noreferrer");
  }
}

function renderActionButtons(containerId, actions) {
  const container = document.querySelector(containerId);
  container.innerHTML = "";

  actions.forEach((action) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = action.secondary ? "secondary-button" : "link-button";
    button.textContent = action.label;
    button.addEventListener("click", () => {
      runOfficialAction(action);
    });
    container.append(button);
  });
}

function renderKeywordChips(containerId, texts) {
  const container = document.querySelector(containerId);
  container.innerHTML = "";

  texts
    .filter(Boolean)
    .slice(0, 4)
    .forEach((text) => {
      container.append(
        createKeywordChip(text, () => {
          copyText(text, `추천 검색어를 복사했습니다: ${text}`);
        })
      );
    });
}

function renderDefaultActionPanel() {
  renderActionButtons("#landLinks", [
    { label: "토지이음 열기", openUrl: "https://www.eum.go.kr/" },
    { label: "일사편리 열기", openUrl: "https://www.kras.go.kr/" },
  ]);
  renderActionButtons("#lawLinks", [
    { label: "국가법령정보 열기", openUrl: "https://www.law.go.kr/" },
    { label: "공동활용 안내 열기", openUrl: "https://open.law.go.kr/" },
  ]);
  renderActionButtons("#buildingLinks", [
    { label: "세움터 열기", openUrl: "https://cloud.eais.go.kr/" },
    { label: "정부24 열기", openUrl: "https://www.gov.kr/" },
  ]);
  renderKeywordChips("#landKeywords", []);
  renderKeywordChips("#lawKeywords", []);
  renderKeywordChips("#buildingKeywords", []);
}

function renderSelectionAwareActions() {
  if (!state.selectedLocation) {
    renderDefaultActionPanel();
    setActionFeedback("위치를 선택하면 주소별 추천 액션이 준비됩니다.");
    return;
  }

  const location = state.selectedLocation;
  const preferredAddress = getPreferredAddress(location);
  const parcelAddress = location.parcelAddress || preferredAddress;
  const roadAddress = location.roadAddress || preferredAddress;
  const regionText = getRegionText(location);
  const lawQuery = `${regionText} 건축 조례`;
  const planQuery = `${preferredAddress} 토지이용계획`;
  const buildingQuery = `${preferredAddress} 건축물대장`;

  renderActionButtons("#landLinks", [
    {
      label: "토지이음 열기 + 지번 복사",
      openUrl: "https://www.eum.go.kr/",
      copyText: parcelAddress,
      feedbackText: `지번 주소를 복사했습니다: ${parcelAddress}`,
    },
    {
      label: "일사편리 열기 + 지번 복사",
      openUrl: "https://www.kras.go.kr/",
      copyText: parcelAddress,
      feedbackText: `지번 주소를 복사했습니다: ${parcelAddress}`,
    },
    {
      label: "도로명 주소 복사",
      copyText: roadAddress,
      feedbackText: `도로명 주소를 복사했습니다: ${roadAddress}`,
      secondary: true,
    },
  ]);

  renderActionButtons("#lawLinks", [
    {
      label: "국가법령정보 열기 + 검색어 복사",
      openUrl: "https://www.law.go.kr/",
      copyText: lawQuery,
      feedbackText: `법규 검색어를 복사했습니다: ${lawQuery}`,
    },
    {
      label: "토지이음 열기 + 계획 검색어 복사",
      openUrl: "https://www.eum.go.kr/",
      copyText: planQuery,
      feedbackText: `계획 검색어를 복사했습니다: ${planQuery}`,
    },
  ]);

  renderActionButtons("#buildingLinks", [
    {
      label: "세움터 열기 + 주소 복사",
      openUrl: "https://cloud.eais.go.kr/",
      copyText: preferredAddress,
      feedbackText: `주소를 복사했습니다: ${preferredAddress}`,
    },
    {
      label: "정부24 열기 + 검색어 복사",
      openUrl: "https://www.gov.kr/",
      copyText: buildingQuery,
      feedbackText: `건축물대장 검색어를 복사했습니다: ${buildingQuery}`,
    },
  ]);

  renderKeywordChips("#landKeywords", [roadAddress, parcelAddress]);
  renderKeywordChips("#lawKeywords", [lawQuery, `${regionText} 지구단위계획`, planQuery]);
  renderKeywordChips("#buildingKeywords", [buildingQuery, preferredAddress]);
  setActionFeedback("현재 선택한 주소 기준으로 공식 사이트 진입용 복사/열기 버튼을 준비했습니다.");
}

function openPopup(location) {
  if (!state.marker) {
    return;
  }

  state.marker.bindPopup(
    `
      <strong>${escapeHtml(buildSelectionLabel(location))}</strong><br />
      ${formatCoord(location.lat)}, ${formatCoord(location.lng)}
    `
  );
  state.marker.openPopup();
}

function setSelectedLocationLegacy(location, moveMap = true) {
  state.selectedLocation = location;
  state.activeSelectionKey = buildHistoryKey(location);
  state.siteContext = null;
  state.siteContextOptionsSignature = "";
  state.buildingRegister = null;
  state.landInfo = null;
  state.landInfoDetails = null;
  state.latestSpec = null;
  specPreview.textContent =
    "추출 조건 확인을 누르면 범위, 지형, 포함 건물 수를 이곳에서 먼저 확인할 수 있습니다.";

  if (!state.marker) {
    state.marker = L.marker([location.lat, location.lng]).addTo(state.map);
  } else {
    state.marker.setLatLng([location.lat, location.lng]);
  }

  if (moveMap) {
    state.map.flyTo([location.lat, location.lng], 18, {
      duration: 0.8,
    });
  }

  pushHistory(location);
  clearContextLayers();
  renderSelectionSummary();
  renderSelectionMeta();
  renderSiteContextMeta();
  renderLandInfo();
  renderBuildingRegister();
  openPopup(location);
  siteContextNote.textContent =
    "선택한 위치 기준으로 대지, 지형, 건물 컨텍스트를 불러오는 중입니다.";
  landInfoNote.textContent =
    "선택한 위치 기준으로 토지이음 요약을 불러오는 중입니다.";
  if (state.runtimeConfig?.futureSources?.hasBuildingHubKey) {
    buildingRegisterNote.textContent =
      "선택한 위치 기준으로 건축물대장 요약을 불러오는 중입니다.";
  }
  siteContextNote.textContent =
    "현재 위치가 선택되었습니다. 대지/건물 미리보기를 누르면 지금 설정한 범위와 지형 모드로 불러옵니다.";
  syncPanelStatusChips();
  void refreshSelectionData(state.activeSelectionKey);
}

function createResultBadges(item) {
  const badges = [];

  if (item.searchType === "road") {
    badges.push("도로명");
  } else if (item.searchType === "parcel") {
    badges.push("지번");
  }

  if (item.provider === "vworld") {
    badges.push("브이월드");
  } else if (item.provider === "vworld+juso" || item.provider === "juso+vworld") {
    badges.push("브이월드");
    badges.push("주소API");
  } else if (item.provider === "nominatim") {
    badges.push("임시검색");
  }

  return badges
    .map((text) => `<span class="result-badge">${escapeHtml(text)}</span>`)
    .join("");
}

function renderSearchResults(items, providerLabel) {
  if (!items.length) {
    searchResults.innerHTML = `
      <p class="search-results-empty">
        검색 결과가 없습니다. 지도를 직접 클릭해도 됩니다.
      </p>
    `;
    return;
  }

  searchResults.innerHTML = "";

  items.forEach((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "result-item";
    button.innerHTML = `
      <div class="result-title-row">
        <div class="result-title">${escapeHtml(item.label)}</div>
        <div class="result-badges">${createResultBadges(item)}</div>
      </div>
      <div class="result-meta">
        ${escapeHtml(getSystemAddress(item) || "주소 정보 없음")}<br />
        ${formatCoord(item.lat)}, ${formatCoord(item.lng)} / ${escapeHtml(providerLabel)}
      </div>
    `;

    button.addEventListener("click", () => {
      setSelectedLocation(item);
    });

    searchResults.append(button);
  });
}

async function loadRuntimeConfig() {
  const response = await fetch("/api/config");
  state.runtimeConfig = await response.json();
  setProviderBadge();
}

async function geocodeAddress(query, currentRequestId) {
  const response = await fetch(`/api/geocode?q=${encodeURIComponent(query)}`);
  const payload = await response.json();

  if (currentRequestId !== state.searchRequestId) {
    return;
  }

  if (!response.ok) {
    throw new Error(payload.error || "주소 검색에 실패했습니다.");
  }

  renderSearchResults(payload.results, payload.provider || "search");
  return payload;
}

async function reverseGeocode(lat, lng) {
  const response = await fetch(
    `/api/reverse-geocode?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}`
  );
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error || "역지오코딩에 실패했습니다.");
  }

  return payload.result || {
    id: `manual-${lat}-${lng}`,
    label: `${formatCoord(lat)}, ${formatCoord(lng)}`,
    roadAddress: "",
    parcelAddress: "",
    lat,
    lng,
    provider: payload.provider || "manual",
    searchType: "mixed",
  };
}

function normalizeContourInterval(value) {
  return MIN_CONTOUR_INTERVAL_METERS;
}

function syncContourIntervalInput() {
  const contourField = modelForm?.querySelector('input[name="contourInterval"]');

  if (!contourField) {
    return MIN_CONTOUR_INTERVAL_METERS;
  }

  const rawValue = Number(contourField.value);
  const normalizedValue = normalizeContourInterval(contourField.value);

  if (!Number.isFinite(rawValue) || rawValue < MIN_CONTOUR_INTERVAL_METERS) {
    contourField.value = String(normalizedValue);
  }

  return normalizedValue;
}

function collectModelOptions() {
  const formData = new FormData(modelForm);

  return {
    shape: "rectangle",
    radius: Number(formData.get("radius")),
    contourInterval: MIN_CONTOUR_INTERVAL_METERS,
    terrainMode: "contour",
    includeContours: formData.get("includeContours") === "on",
    includeBuildings:
      formData.has("includeBuildings")
        ? formData.get("includeBuildings") === "on"
        : true,
    includeRoads: formData.get("includeRoads") === "on",
    includeParcelBoundary: formData.get("includeParcelBoundary") === "on",
  };
}

function buildModelOptionsSignature(options = collectModelOptions()) {
  return JSON.stringify({
    radius: Number(options.radius) || 0,
    contourInterval: MIN_CONTOUR_INTERVAL_METERS,
    terrainMode: "contour",
    includeContours: options.includeContours !== false,
    includeBuildings: options.includeBuildings !== false,
    includeRoads: options.includeRoads === true,
    includeParcelBoundary: options.includeParcelBoundary !== false,
  });
}

function hasFreshSiteContextForCurrentOptions() {
  return (
    Boolean(state.siteContext) &&
    state.siteContextOptionsSignature === buildModelOptionsSignature()
  );
}

function selectionHasParcelReference(location = state.selectedLocation) {
  return Boolean(
    location?.pnu ||
      location?.juso?.admCd ||
      state.siteContext?.parcelBoundary?.properties?.pnu ||
      state.siteContext?.parcelBoundary?.properties?.PNU
  );
}

function markModelOptionsDirty() {
  state.latestSpec = null;
  resetModelProgress(
    "범위 설정을 누르면 지도에 버퍼가 반영되고 추출 준비 상태가 갱신됩니다."
  );

  if (!state.selectedLocation || !state.siteContext) {
    return;
  }

  if (hasFreshSiteContextForCurrentOptions()) {
    return;
  }

  specPreview.textContent =
    "설정이 바뀌었습니다. 미리보기 또는 다운로드를 누르면 현재 조건으로 대지/건물 컨텍스트를 다시 불러옵니다.";
  siteContextNote.textContent =
    "현재 지도 미리보기는 이전 조건 기준입니다. 다시 불러오면 새 범위와 지형 모드가 반영됩니다.";
}

async function loadSiteContext(
  selectionKey = getSelectionRequestKey(),
  requestOptions = {}
) {
  if (!state.selectedLocation) {
    throw new Error("먼저 위치를 선택하세요.");
  }

  const location = { ...state.selectedLocation };
  const options = collectModelOptions();

  const requestInit = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      location,
      options,
    }),
  };
  const response = requestOptions.useModelProgress
    ? await fetchWithModelProgress(
        "/api/site-context",
        requestInit,
        "대지 컨텍스트 요청에 실패했습니다.",
        {
          rangeStart: requestOptions.rangeStart ?? 0,
          rangeEnd: requestOptions.rangeEnd ?? 100,
        }
      )
    : await fetchWithDiagnostics(
        "/api/site-context",
        requestInit,
        "대지 컨텍스트 요청에 실패했습니다."
      );

  let payload;

  try {
    payload = await response.json();
  } catch (error) {
    console.error("[request] /api/site-context returned invalid JSON", error);
    throw new Error(
      "대지 컨텍스트 응답을 해석하지 못했습니다. /api/site-context 응답이 JSON 형식인지 확인해주세요."
    );
  }

  if (!response.ok) {
    throw new Error(payload.error || "대지 컨텍스트 요청에 실패했습니다.");
  }

  if (!isSelectionRequestCurrent(selectionKey)) {
    return payload;
  }

  const parcelProperties = payload.parcelBoundary?.properties || {};
  state.siteContext = payload;
  state.siteContextOptionsSignature = buildModelOptionsSignature(options);
  state.selectedLocation = {
    ...state.selectedLocation,
    pnu:
      state.selectedLocation?.pnu ||
      parcelProperties.pnu ||
      parcelProperties.PNU ||
      "",
    parcelAddress:
      state.selectedLocation?.parcelAddress || parcelProperties.addr || "",
  };
  renderSiteContextMeta();
  updateContextLayers(payload);
  renderSelectionMeta();
  renderSelectionSummary();
  return payload;
}

async function loadBuildingRegisterLegacy(
  silent = false,
  selectionKey = getSelectionRequestKey()
) {
  if (!state.selectedLocation) {
    throw new Error("먼저 위치를 선택하세요.");
  }

  const location = { ...state.selectedLocation };
  let siteContext = state.siteContext;

  let response = await fetch("/api/building-register", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      location,
      siteContext,
    }),
  });

  let payload = await response.json();

  if (!response.ok && !selectionHasParcelReference(location)) {
    await loadSiteContext(selectionKey);
    siteContext = state.siteContext;

    response = await fetch("/api/building-register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        location: state.selectedLocation,
        siteContext,
      }),
    });
    payload = await response.json();
  }

  if (!response.ok) {
    throw new Error(payload.error || "건축물대장 조회에 실패했습니다.");
  }

  if (!isSelectionRequestCurrent(selectionKey)) {
    return payload;
  }

  state.buildingRegister = payload;
  renderBuildingRegister();
  return payload;
}

async function printBuildingRegister(printWindow = null) {
  if (!state.selectedLocation) {
    window.alert("먼저 위치를 선택하세요.");
    return;
  }

  if (!state.buildingRegister) {
    await loadBuildingRegister();
  }

  const items = state.buildingRegister?.items || [];
  const address = buildSelectionLabel(state.selectedLocation);
  const cards = items
    .slice(0, 6)
    .map(
      (item) => `
        <section class="card">
          <h2>${escapeHtml(item.buildingName || item.dongName || "건물")}</h2>
          <p class="meta">${escapeHtml(item.roadAddress || item.parcelAddress || "")}</p>
          <div class="grid">
            <div><strong>주용도</strong><span>${escapeHtml(item.mainPurpose || "미확인")}</span></div>
            <div><strong>연면적</strong><span>${escapeHtml(formatArea(item.totalAreaSqm || 0))}</span></div>
            <div><strong>건폐율</strong><span>${escapeHtml(formatRatio(item.coverageRatio))}</span></div>
            <div><strong>용적률</strong><span>${escapeHtml(formatRatio(item.floorAreaRatio))}</span></div>
            <div><strong>높이</strong><span>${escapeHtml(formatHeight(item.heightMeters))}</span></div>
            <div><strong>층수</strong><span>${escapeHtml(`${item.aboveGroundFloors || 0}층 / 지하 ${item.belowGroundFloors || 0}층`)}</span></div>
            <div><strong>구조</strong><span>${escapeHtml(item.structureName || "미확인")}</span></div>
            <div><strong>사용승인일</strong><span>${escapeHtml(formatDateText(item.approvalDate))}</span></div>
          </div>
        </section>
      `
    )
    .join("");

  renderPrintWindow(
    printWindow || openPendingWindow(),
    "건축물대장 요약",
    `
      <h1>건축물대장 요약</h1>
      <p class="meta">${escapeHtml(address)}<br />출력 시각: ${escapeHtml(new Date().toLocaleString("ko-KR"))}</p>
      <div class="section">${cards}</div>
      <p class="notice">이 출력물은 건축HUB 표제부 조회 결과를 바탕으로 정리한 요약본입니다. 정부24 또는 세움터의 공식 발급 문서와는 다를 수 있습니다.</p>
    `
  );
}

function openOfficialBuildingRegister() {
  const popup = openPendingWindow("건축물대장 공식 열람");

  if (!popup) {
    return;
  }

  popup.location.replace(
    "https://cloud.eais.go.kr/"
  );
}

function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function downloadJson(filename, payload) {
  downloadBlob(
    filename,
    new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    })
  );
}

function openPendingWindowLegacy() {
  const popup = window.open("", "_blank", "noopener,noreferrer");

  if (!popup) {
    return null;
  }

  popup.document.write(`
    <!doctype html>
    <html lang="ko">
      <head>
        <meta charset="utf-8" />
        <title>불러오는 중</title>
        <style>
          body { font-family: 'Segoe UI', sans-serif; padding: 32px; color: #2e241c; }
        </style>
      </head>
      <body>
        <p>결과를 준비하는 중입니다...</p>
      </body>
    </html>
  `);
  popup.document.close();
  return popup;
}

function renderPrintWindowLegacy(printWindow, title, bodyHtml) {
  if (!printWindow || printWindow.closed) {
    const fallbackDocument = window.document;
    const originalHtml = fallbackDocument.documentElement.innerHTML;
    fallbackDocument.open();
    fallbackDocument.write(`
      <!doctype html>
      <html lang="ko">
        <head>
          <meta charset="utf-8" />
          <title>${escapeHtml(title)}</title>
          <style>
            body { font-family: 'Pretendard Variable', 'Segoe UI', sans-serif; margin: 32px; color: #2e241c; }
            h1, h2, p { margin: 0; }
            h1 { font-size: 24px; margin-bottom: 8px; }
            .meta { color: #6c5a49; margin-bottom: 20px; line-height: 1.6; }
            .section { margin-top: 24px; }
            .card { border: 1px solid #d7c5b2; border-radius: 16px; padding: 16px; margin-bottom: 14px; }
            .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-top: 12px; }
            .grid strong { display: block; font-size: 12px; color: #6c5a49; margin-bottom: 4px; }
            .notice { margin-top: 24px; color: #6c5a49; font-size: 12px; }
          </style>
        </head>
        <body>${bodyHtml}</body>
      </html>
    `);
    fallbackDocument.close();
    window.focus();
    window.setTimeout(() => {
      window.print();
      window.location.reload();
    }, 250);
    return;
  }

  printWindow.document.write(`
    <!doctype html>
    <html lang="ko">
      <head>
        <meta charset="utf-8" />
        <title>${escapeHtml(title)}</title>
        <style>
          body { font-family: 'Pretendard Variable', 'Segoe UI', sans-serif; margin: 32px; color: #2e241c; }
          h1, h2, p { margin: 0; }
          h1 { font-size: 24px; margin-bottom: 8px; }
          .meta { color: #6c5a49; margin-bottom: 20px; line-height: 1.6; }
          .section { margin-top: 24px; }
          .card { border: 1px solid #d7c5b2; border-radius: 16px; padding: 16px; margin-bottom: 14px; }
          .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-top: 12px; }
          .grid strong { display: block; font-size: 12px; color: #6c5a49; margin-bottom: 4px; }
          .notice { margin-top: 24px; color: #6c5a49; font-size: 12px; }
        </style>
      </head>
      <body>${bodyHtml}</body>
    </html>
  `);
  printWindow.document.close();
  printWindow.focus();
  window.setTimeout(() => {
    printWindow.print();
  }, 250);
}

async function ensureSiteContextLoaded(requestOptions = {}) {
  if (!hasFreshSiteContextForCurrentOptions()) {
    await loadSiteContext(getSelectionRequestKey(), requestOptions);
  }
}

async function loadLandInfoLegacy(selectionKey = getSelectionRequestKey()) {
  if (!state.selectedLocation) {
    throw new Error("먼저 위치를 선택하세요.");
  }

  const location = { ...state.selectedLocation };
  state.isLandInfoRequesting = true;

  try {
    let siteContext = state.siteContext;
    let response = await fetch("/api/land-info", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        location,
        siteContext,
      }),
    });
    let payload = await response.json();

    if (!response.ok && !selectionHasParcelReference(location) && !siteContext) {
      await loadSiteContext(selectionKey);
      siteContext = state.siteContext;

      response = await fetch("/api/land-info", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          location,
          siteContext,
        }),
      });
      payload = await response.json();
    }

    if (
      !response.ok &&
      String(payload.error || "").includes("필지 식별정보") &&
      !siteContext
    ) {
      await loadSiteContext(selectionKey);
      siteContext = state.siteContext;

      response = await fetch("/api/land-info", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          location,
          siteContext,
        }),
      });
      payload = await response.json();
    }

    if (!response.ok) {
      throw new Error(payload.error || "토지정보 조회에 실패했습니다.");
    }

    if (!isSelectionRequestCurrent(selectionKey)) {
      return payload;
    }

    state.landInfo = payload;
    state.landInfoDetails = null;
    renderLandInfo();
    syncPanelStatusChips();
    return payload;
  } finally {
    state.isLandInfoRequesting = false;
  }
}

async function loadLandInfo(
  selectionKey = getSelectionRequestKey(),
  retryCount = 0
) {
  if (!state.selectedLocation) {
    throw new Error("먼저 위치를 선택해 주세요.");
  }

  const location = { ...state.selectedLocation };

  if (retryCount === 0) {
    state.isLandInfoRequesting = true;
  }

  try {
    let siteContext = state.siteContext;
    let response = await fetch("/api/land-info", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        location,
        siteContext,
      }),
    });
    let payload = await response.json();

    if (!response.ok && !selectionHasParcelReference(location) && !siteContext) {
      await loadSiteContext(selectionKey);
      siteContext = state.siteContext;

      response = await fetch("/api/land-info", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          location,
          siteContext,
        }),
      });
      payload = await response.json();
    }

    if (!response.ok) {
      throw new Error(payload.error || "토지정보 조회에 실패했습니다.");
    }

    if (!isSelectionRequestCurrent(selectionKey)) {
      return payload;
    }

    state.landInfo = payload;
    state.landInfoDetails = null;

    if (payload?.parcelReference?.pnu) {
      state.selectedLocation = {
        ...state.selectedLocation,
        pnu: state.selectedLocation?.pnu || payload.parcelReference.pnu,
      };
    }

    renderLandInfo();
    return payload;
  } catch (error) {
    const canRetry =
      retryCount < 1 &&
      isSelectionRequestCurrent(selectionKey) &&
      Boolean(state.selectedLocation);

    if (canRetry) {
      try {
        await loadSiteContext(selectionKey);
      } catch {
        // Continue with one retry even if preview context cannot be refreshed.
      }

      await wait(350);
      return loadLandInfo(selectionKey, retryCount + 1);
    }

    throw error;
  } finally {
    if (retryCount === 0) {
      state.isLandInfoRequesting = false;
      syncPanelStatusChips();
    }
  }
}

async function ensureLandInfoLoaded() {
  if (!state.landInfo) {
    await loadLandInfo();
  }
}

async function loadLandInfoDetails(
  selectionKey = getSelectionRequestKey(),
  retryCount = 0
) {
  if (!state.selectedLocation) {
    throw new Error("먼저 위치를 선택해 주세요.");
  }

  if (!state.landInfo) {
    await loadLandInfo(selectionKey);
  }

  const location = {
    ...state.selectedLocation,
    pnu:
      state.selectedLocation?.pnu ||
      state.landInfo?.parcelReference?.pnu ||
      "",
  };

  try {
    const response = await fetch("/api/land-info-details", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        location,
        siteContext: state.siteContext,
      }),
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "토지 상세정보 조회에 실패했습니다.");
    }

    if (!isSelectionRequestCurrent(selectionKey)) {
      return payload;
    }

    state.landInfo = payload;
    state.landInfoDetails = payload;

    if (payload?.parcelReference?.pnu) {
      state.selectedLocation = {
        ...state.selectedLocation,
        pnu: state.selectedLocation?.pnu || payload.parcelReference.pnu,
      };
    }

    renderLandInfo();
    return payload;
  } catch (error) {
    const canRetry =
      retryCount < 1 &&
      isSelectionRequestCurrent(selectionKey) &&
      Boolean(state.selectedLocation) &&
      !selectionHasParcelReference(location);

    if (canRetry) {
      await loadLandInfo(selectionKey);
      return loadLandInfoDetails(selectionKey, retryCount + 1);
    }

    throw error;
  }
}

async function ensureLandInfoDetailsLoaded() {
  if (!state.landInfoDetails) {
    await loadLandInfoDetails();
  }

  return state.landInfoDetails || state.landInfo;
}

async function refreshSelectionDataLegacy(selectionKey) {
  const tasks = [
    Promise.resolve().catch((error) => {
      if (isSelectionRequestCurrent(selectionKey)) {
        siteContextNote.textContent =
          error instanceof Error ? error.message : "대지 컨텍스트를 불러오지 못했습니다.";
      }
    }),
    loadLandInfo(selectionKey).catch((error) => {
      if (isSelectionRequestCurrent(selectionKey)) {
        landInfoNote.textContent =
          error instanceof Error ? error.message : "토지정보를 불러오지 못했습니다.";
      }
    }),
  ];

  if (state.runtimeConfig?.futureSources?.hasBuildingHubKey) {
    tasks.push(
      loadBuildingRegister(true, selectionKey).catch((error) => {
        if (isSelectionRequestCurrent(selectionKey)) {
          buildingRegisterNote.textContent =
            error instanceof Error
              ? error.message
              : "건축물대장 요약을 불러오지 못했습니다.";
        }
      })
    );
  }

  await Promise.allSettled(tasks);
}

function buildLandInfoHandoffUrl(landInfo) {
  const params = new URLSearchParams({
    pnu: landInfo?.parcelReference?.pnu || "",
    sggcd: landInfo?.parcelReference?.sigunguCd || "",
    p_location: landInfo?.address || "",
  });

  return `/handoff/eum?${params.toString()}`;
}

async function openLandUseDetailLegacy(popup = null) {
  await ensureLandInfoLoaded();
  const targetUrl = buildLandInfoHandoffUrl(state.landInfo);

  if (popup && !popup.closed) {
    popup.location.replace(targetUrl);
    return;
  }

  window.location.assign(targetUrl);
}

async function openLandMapLegacy(popup = null) {
  await ensureLandInfoLoaded();

  if (popup && !popup.closed) {
    popup.location.replace(state.landInfo.official.mapUrl);
    return;
  }

  window.location.assign(state.landInfo.official.mapUrl);
}

async function openLandIssueLegacy(popup = null) {
  await ensureLandInfoLoaded();

  if (popup && !popup.closed) {
    popup.location.replace(state.landInfo.official.issueUrl);
    return;
  }

  window.location.assign(state.landInfo.official.issueUrl);
}

function showPopupBlockedMessage() {
  window.alert(
    "이 기능은 팝업으로 열리도록 설계했습니다. 브라우저에서 이 사이트의 팝업을 허용해 주세요."
  );
}

function openPendingWindow(title = "결과 창") {
  const popup = window.open(
    "about:blank",
    `site-context-popup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    "popup=yes,width=1320,height=900,scrollbars=yes,resizable=yes"
  );

  if (!popup) {
    showPopupBlockedMessage();
    return null;
  }

  popup.document.write(`
    <!doctype html>
    <html lang="ko">
      <head>
        <meta charset="utf-8" />
        <title>${escapeHtml(title)}</title>
        <style>
          body { font-family: 'Segoe UI', sans-serif; padding: 32px; color: #2e241c; }
        </style>
      </head>
      <body>
        <p>결과를 준비하는 중입니다...</p>
      </body>
    </html>
  `);
  popup.document.close();
  return popup;
}

function renderPopupWindow(popupWindow, title, bodyHtml) {
  if (!popupWindow || popupWindow.closed) {
    throw new Error("팝업이 차단되어 상세 창을 열 수 없습니다.");
  }

  popupWindow.document.write(`
    <!doctype html>
    <html lang="ko">
      <head>
        <meta charset="utf-8" />
        <title>${escapeHtml(title)}</title>
        <style>
          body { font-family: 'Pretendard Variable', 'Segoe UI', sans-serif; margin: 32px; color: #2e241c; background: #f7f2ea; }
          h1, h2, h3, p { margin: 0; }
          h1 { font-size: 28px; margin-bottom: 8px; }
          h2 { font-size: 20px; margin-bottom: 8px; }
          h3 { font-size: 14px; margin-bottom: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: #944220; }
          .meta { color: #6c5a49; margin-bottom: 18px; line-height: 1.6; }
          .section { margin-top: 22px; }
          .card { border: 1px solid #d7c5b2; border-radius: 18px; padding: 18px; margin-bottom: 16px; background: #fffaf2; }
          .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-top: 12px; }
          .grid div { border: 1px solid rgba(108, 90, 73, 0.14); border-radius: 14px; padding: 12px; background: rgba(255,255,255,0.72); }
          .grid strong { display: block; font-size: 12px; color: #6c5a49; margin-bottom: 6px; }
          .notice { margin-top: 14px; color: #6c5a49; line-height: 1.6; }
          @media (max-width: 880px) { .grid { grid-template-columns: 1fr; } body { margin: 18px; } }
        </style>
      </head>
      <body>${bodyHtml}</body>
    </html>
  `);
  popupWindow.document.close();
  popupWindow.focus();
}

function renderPrintWindow(printWindow, title, bodyHtml) {
  if (!printWindow || printWindow.closed) {
    throw new Error("팝업이 차단되어 인쇄 창을 열 수 없습니다.");
  }

  printWindow.document.write(`
    <!doctype html>
    <html lang="ko">
      <head>
        <meta charset="utf-8" />
        <title>${escapeHtml(title)}</title>
        <style>
          body { font-family: 'Pretendard Variable', 'Segoe UI', sans-serif; margin: 32px; color: #2e241c; }
          h1, h2, p { margin: 0; }
          h1 { font-size: 24px; margin-bottom: 8px; }
          .meta { color: #6c5a49; margin-bottom: 20px; line-height: 1.6; }
          .section { margin-top: 24px; }
          .card { border: 1px solid #d7c5b2; border-radius: 16px; padding: 16px; margin-bottom: 14px; }
          .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-top: 12px; }
          .grid strong { display: block; font-size: 12px; color: #6c5a49; margin-bottom: 4px; }
          .notice { margin-top: 24px; color: #6c5a49; font-size: 12px; }
        </style>
      </head>
      <body>${bodyHtml}</body>
    </html>
  `);
  printWindow.document.close();
  printWindow.focus();
  window.setTimeout(() => {
    printWindow.print();
  }, 250);
}

async function openLandUseDetail(popup = null) {
  await ensureLandInfoLoaded();

  if (!popup || popup.closed) {
    throw new Error("팝업이 차단되어 토지이음 창을 열 수 없습니다.");
  }

  popup.location.replace(buildLandInfoHandoffUrl(state.landInfo));
}

async function openLandMap(popup = null) {
  await ensureLandInfoLoaded();

  if (!popup || popup.closed) {
    throw new Error("팝업이 차단되어 도면 창을 열 수 없습니다.");
  }

  popup.location.replace(state.landInfo.official.mapUrl);
}

async function openLandIssue(popup = null) {
  await ensureLandInfoLoaded();

  if (!popup || popup.closed) {
    throw new Error("팝업이 차단되어 발급 안내 창을 열 수 없습니다.");
  }

  popup.location.replace(state.landInfo.official.issueUrl);
}

async function generateModelSpecLegacy() {
  if (!state.selectedLocation) {
    window.alert("먼저 위치를 선택하세요.");
    return;
  }

  await ensureSiteContextLoaded();

  const options = collectModelOptions();
  const response = await fetch("/api/model-spec", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      location: state.selectedLocation,
      options,
      siteContext: state.siteContext,
    }),
  });

  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error || "3D 스펙 생성에 실패했습니다.");
  }

  state.latestSpec = payload;
  const exportFormat = String(options.exportFormat || "3dm").toUpperCase();
  specPreview.textContent =
    `3D 추출 준비가 완료되었습니다. ` +
    `범위 사각 ${Number(payload.options?.radius || 0).toLocaleString("ko-KR")}m, ` +
    `대지 ${Number(payload.siteContextSummary?.parcelAreaSqm || 0).toLocaleString("ko-KR")}㎡, ` +
    `표고 ${formatElevationRange(
      payload.siteContextSummary?.minElevation,
      payload.siteContextSummary?.maxElevation
    )}, ` +
    `건물 ${payload.siteContextSummary?.buildingCount || 0}개입니다. ` +
    `${exportFormat} 파일 다운로드 버튼으로 바로 추출하세요.`;
}

async function downloadSiteContext() {
  await ensureSiteContextLoaded();
  downloadJson(`site-context-${Date.now()}.json`, state.siteContext);
}

async function downloadObjLegacy() {
  if (!state.selectedLocation) {
    window.alert("먼저 위치를 선택하세요.");
    return;
  }

  await ensureSiteContextLoaded();
  const options = collectModelOptions();

  const response = await fetchWithDiagnostics(
    "/api/export-model",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        location: state.selectedLocation,
        options,
        siteContext: state.siteContext,
      }),
    },
    "3D 파일 다운로드에 실패했습니다."
  );

  if (!response.ok) {
    const payload = await response.json();
    throw new Error(payload.error || "3D 파일 다운로드에 실패했습니다.");
  }

  const filename =
    response.headers.get("X-Export-Filename") ||
    `site-context-${Date.now()}.${options.exportFormat || "3dm"}`;
  const blob = await response.blob();
  downloadBlob(filename, blob);
}

async function generateModelSpec() {
  if (!state.selectedLocation) {
    window.alert("먼저 위치를 선택해 주세요.");
    return;
  }

  startModelProgress("preview", "범위와 버퍼를 계산하는 중입니다...");
  specPreview.textContent = "현재 범위 조건으로 대지, 지형, 건물 컨텍스트를 다시 불러오는 중입니다.";

  try {
    await loadSiteContext(getSelectionRequestKey(), {
      useModelProgress: true,
      rangeStart: 6,
      rangeEnd: 96,
    });
    advanceModelProgress(82, "추출 범위를 지도에 반영하는 중입니다...");
    state.latestSpec = {
      appliedAt: new Date().toISOString(),
      options: collectModelOptions(),
      siteContextSummary: state.siteContext?.stats || {},
    };
    specPreview.textContent = `${buildAppliedModelSummary()} OBJ 또는 3DM 다운로드로 바로 추출할 수 있습니다.`;
    finishModelProgress("범위 적용이 완료되었습니다.");
  } catch (error) {
    failModelProgress(
      error instanceof Error ? error.message : "범위 적용 중 문제가 발생했습니다."
    );
    throw error;
  }
}

async function downloadObj(exportFormat = "obj") {
  if (!state.selectedLocation) {
    window.alert("먼저 위치를 선택해 주세요.");
    return;
  }

  const normalizedFormat =
    String(exportFormat || "obj").toLowerCase() === "3dm" ? "3dm" : "obj";
  const needsFreshSiteContext = !hasFreshSiteContextForCurrentOptions();
  const progressOperationKey =
    normalizedFormat === "3dm"
      ? needsFreshSiteContext
        ? "export-3dm"
        : "export-3dm-cached"
      : needsFreshSiteContext
        ? "export-obj"
        : "export-obj-cached";

  startModelProgress(
    progressOperationKey,
    normalizedFormat === "3dm"
      ? "3DM 파일을 준비하는 중입니다..."
      : "OBJ 파일을 준비하는 중입니다..."
  );
  advanceModelProgress(
    18,
    needsFreshSiteContext
      ? "현재 범위의 대지 컨텍스트를 계산하는 중입니다..."
      : "저장된 대지 컨텍스트를 확인하는 중입니다..."
  );

  try {
    await ensureSiteContextLoaded({
      useModelProgress: true,
      rangeStart: 6,
      rangeEnd: 42,
    });
    advanceModelProgress(46, "3D 파일 생성 요청을 시작하는 중입니다...");

    const options = {
      ...collectModelOptions(),
      exportFormat: normalizedFormat,
    };
    const response = await fetchWithModelProgress(
      "/api/export-model",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          location: state.selectedLocation,
          options,
          siteContext: state.siteContext,
        }),
      },
      "3D 파일 다운로드에 실패했습니다.",
      {
        rangeStart: needsFreshSiteContext ? 46 : 6,
        rangeEnd: 96,
      }
    );

    if (!response.ok) {
      const payload = await response.json();
      throw new Error(payload.error || "3D 파일 다운로드에 실패했습니다.");
    }

    const filename =
      response.headers.get("X-Export-Filename") ||
      `site-context-${Date.now()}.${normalizedFormat}`;
    advanceModelProgress(98, "파일을 내려받을 준비를 하는 중입니다...");
    const blob = await response.blob();
    downloadBlob(filename, blob);
    specPreview.textContent = `${buildAppliedModelSummary()} ${normalizedFormat.toUpperCase()} 다운로드를 시작했습니다.`;
    finishModelProgress(
      normalizedFormat === "3dm"
        ? "3DM 다운로드를 시작했습니다."
        : "OBJ 다운로드를 시작했습니다."
    );
  } catch (error) {
    failModelProgress(
      error instanceof Error ? error.message : "3D 파일 다운로드에 실패했습니다."
    );
    throw error;
  }
}

function scheduleSearch() {
  const query = searchInput.value.trim();

  if (state.searchDebounceId) {
    window.clearTimeout(state.searchDebounceId);
  }

  if (query.length < 2) {
    searchResults.innerHTML =
      '<p class="search-results-empty">두 글자 이상 입력하면 추천 검색 결과가 표시됩니다.</p>';
    return;
  }

  state.searchDebounceId = window.setTimeout(async () => {
    state.searchRequestId += 1;
    const currentRequestId = state.searchRequestId;
    searchResults.innerHTML =
      '<p class="search-results-empty">추천 결과를 불러오는 중입니다...</p>';

    try {
      await geocodeAddress(query, currentRequestId);
    } catch (error) {
      if (currentRequestId !== state.searchRequestId) {
        return;
      }

      searchResults.innerHTML = `
        <p class="search-results-empty">
          ${escapeHtml(error instanceof Error ? error.message : "검색에 실패했습니다.")}
        </p>
      `;
    }
  }, 280);
}

function attachEventsLegacy() {
  searchForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const query = new FormData(searchForm).get("query")?.toString().trim();

    if (!query) {
      return;
    }

    state.searchRequestId += 1;
    const currentRequestId = state.searchRequestId;
    searchResults.innerHTML =
      '<p class="search-results-empty">검색 결과를 불러오는 중입니다...</p>';

    try {
      await geocodeAddress(query, currentRequestId);
    } catch (error) {
      searchResults.innerHTML = `
        <p class="search-results-empty">
          ${escapeHtml(error instanceof Error ? error.message : "검색에 실패했습니다.")}
        </p>
      `;
    }
  });

  searchInput.addEventListener("input", () => {
    scheduleSearch();
  });

  modelForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    try {
      await generateModelSpec();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "3D 스펙 생성에 실패했습니다.");
    }
  });

  modelForm.addEventListener("input", () => {
    markModelOptionsDirty();
  });

  modelForm.addEventListener("change", () => {
    markModelOptionsDirty();
  });

  loadSiteContextButton.addEventListener("click", async () => {
    try {
      await loadSiteContext();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "대지 컨텍스트 불러오기에 실패했습니다.");
    }
  });

  previewSiteContextButton.addEventListener("click", async () => {
    try {
      await loadSiteContext();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "대지 컨텍스트 불러오기에 실패했습니다.");
    }
  });

  downloadSiteContextButton.addEventListener("click", async () => {
    try {
      await downloadSiteContext();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "컨텍스트 JSON 다운로드에 실패했습니다.");
    }
  });

  downloadObjButton.addEventListener("click", async () => {
    try {
      await downloadObj();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "3D 파일 다운로드에 실패했습니다.");
    }
  });

  clearHistoryButton.addEventListener("click", () => {
    state.history = [];
    saveHistory();
    renderHistory();
  });

  loadLandInfoButton.addEventListener("click", async () => {
    try {
      await loadLandInfo();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "토지정보 조회에 실패했습니다.");
    }
  });

  document.querySelector("#showLandInfoDetailsButton")?.addEventListener("click", async () => {
    const popup = openPendingWindow("토지이음 상세 정보");

    try {
      await openLandInfoDetails(popup);
    } catch (error) {
      if (popup && !popup.closed) {
        popup.close();
      }
      window.alert(error instanceof Error ? error.message : "토지이음 상세 정보를 여는 데 실패했습니다.");
    }
  });

  openLandUseDetailButton.addEventListener("click", async () => {
    const popup = openPendingWindow();

    try {
      await openLandUseDetail(popup);
    } catch (error) {
      if (popup && !popup.closed) {
        popup.close();
      }
      window.alert(error instanceof Error ? error.message : "토지이음 결과 열기에 실패했습니다.");
    }
  });

  openLandMapButton.addEventListener("click", async () => {
    const popup = openPendingWindow();

    try {
      await openLandMap(popup);
    } catch (error) {
      if (popup && !popup.closed) {
        popup.close();
      }
      window.alert(error instanceof Error ? error.message : "도면 크게보기에 실패했습니다.");
    }
  });

  openLandIssueButton.addEventListener("click", async () => {
    const popup = openPendingWindow();

    try {
      await openLandIssue(popup);
    } catch (error) {
      if (popup && !popup.closed) {
        popup.close();
      }
      window.alert(error instanceof Error ? error.message : "확인서 발급 안내 열기에 실패했습니다.");
    }
  });

  loadBuildingRegisterButton.addEventListener("click", async () => {
    try {
      await loadBuildingRegister();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "건축물대장 조회에 실패했습니다.");
    }
  });

  printBuildingRegisterButton.addEventListener("click", async () => {
    const popup = openPendingWindow();

    try {
      await printBuildingRegister(popup);
    } catch (error) {
      if (popup && !popup.closed) {
        popup.close();
      }
      window.alert(error instanceof Error ? error.message : "건축물대장 요약 인쇄에 실패했습니다.");
    }
  });

  openOfficialBuildingRegisterButton.addEventListener("click", () => {
    openOfficialBuildingRegister();
  });
}

function createMapLegacy(config) {
  const map = L.map("map", {
    zoomControl: false,
  }).setView(
    [config.map.initialCenter.lat, config.map.initialCenter.lng],
    config.map.initialZoom
  );

  L.control.zoom({ position: "bottomright" }).addTo(map);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 20,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>',
  }).addTo(map);

  map.on("click", async (event) => {
    const { lat, lng } = event.latlng;

    selectionSummary.textContent = "선택한 위치의 주소를 확인하는 중입니다...";

    try {
      const location = await reverseGeocode(lat, lng);
      setSelectedLocation(location, false);
    } catch {
      setSelectedLocation(
        {
          id: `manual-${lat}-${lng}`,
          label: `${formatCoord(lat)}, ${formatCoord(lng)}`,
          roadAddress: "",
          parcelAddress: "",
          lat,
          lng,
          provider: "manual",
          searchType: "mixed",
        },
        false
      );
    }
  });

  state.map = map;
}

function updateDownloadButtonLabel() {
  if (downloadObjButton) {
    downloadObjButton.textContent = "OBJ 파일 다운로드";
  }

  if (download3dmButton) {
    download3dmButton.textContent = "3DM 파일 다운로드";
  }

  if (previewSiteContextButton) {
    previewSiteContextButton.textContent = "범위 설정";
  }
}

function ensureStatusChip(id, labelElement) {
  if (!labelElement || document.querySelector(`#${id}`)) {
    return;
  }

  const chip = document.createElement("span");
  chip.id = id;
  chip.className = "data-status-chip";
  chip.textContent = "대기";
  labelElement.append(chip);
}

function syncPanelStatusChips() {
  const landChip = document.querySelector("#landInfoStatusChip");

  if (landChip) {
    landChip.textContent = !state.selectedLocation
      ? "대기"
      : state.landInfo
        ? "조회 완료"
        : state.isLandInfoRequesting
          ? "조회중"
          : "미조회";
  }
}

function prepareModelFormUi() {
  const terrainModeField = modelForm.querySelector('select[name="terrainMode"]');
  const exportFormatField = modelForm.querySelector('select[name="exportFormat"]');
  const contourIntervalField = modelForm.querySelector('input[name="contourInterval"]');
  const submitButton = modelForm.querySelector('button[type="submit"]');
  const sidePanel = document.querySelector(".side-panel");
  const landCard = loadLandInfoButton?.closest(".card");
  const buildingCard = loadBuildingRegisterButton?.closest(".card");
  const modelCard = modelForm?.closest(".card");
  const landHeader = landCard?.querySelector(".card-header > div");
  const landCardHeader = landCard?.querySelector(".card-header");
  const buildingHeader = buildingCard?.querySelector(".card-header > div");
  const showLandInfoDetailsButton = document.querySelector("#showLandInfoDetailsButton");

  terrainModeField?.closest("label")?.remove();
  exportFormatField?.closest("label")?.remove();
  contourIntervalField?.closest("label")?.remove();
  submitButton?.remove();

  modelCard?.classList.add("model-card");
  buildingCard?.classList.add("building-card");
  landCard?.classList.add("land-card");

  if (sidePanel) {
    [modelCard, buildingCard, landCard]
      .filter(Boolean)
      .forEach((card) => sidePanel.append(card));
  }

  if (loadBuildingRegisterButton) {
    loadBuildingRegisterButton.textContent = "대장 요약";
  }

  if (showBuildingRegisterDetailsButton) {
    showBuildingRegisterDetailsButton.textContent = "상세 정보";
  }

  printBuildingRegisterButton?.remove();

  if (loadLandInfoButton) {
    loadLandInfoButton.textContent = "토지 요약";
  }

  let detailButton = showLandInfoDetailsButton;

  if (!detailButton && loadLandInfoButton) {
    detailButton = document.createElement("button");
    detailButton.type = "button";
    detailButton.id = "showLandInfoDetailsButton";
    detailButton.className = "secondary-button";
    detailButton.textContent = "상세 정보";
  }

  detailButton?.classList.add("secondary-button");

  if (openLandUseDetailButton) {
    openLandUseDetailButton.textContent = "토지이음 공식 열람";
    openLandUseDetailButton.classList.add("secondary-button");
  }

  openLandMapButton?.remove();
  openLandIssueButton?.remove();

  if (landCardHeader && loadLandInfoButton && detailButton && openLandUseDetailButton) {
    let actionRow = landCardHeader.querySelector(".button-row.compact-row");

    if (!actionRow) {
      actionRow = document.createElement("div");
      actionRow.className = "button-row compact-row";
      landCardHeader.append(actionRow);
    }

    actionRow.replaceChildren(loadLandInfoButton, detailButton, openLandUseDetailButton);
  }

  ensureStatusChip("landInfoStatusChip", landHeader);
  document.querySelector("#buildingInfoStatusChip")?.remove();
  syncPanelStatusChips();
}

async function loadBuildingRegister(
  silent = false,
  selectionKey = getSelectionRequestKey()
) {
  try {
    return await loadBuildingRegisterLegacy(silent, selectionKey);
  } finally {
    syncPanelStatusChips();
  }
}

function attachEvents() {
  searchForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const query = new FormData(searchForm).get("query")?.toString().trim();

    if (!query) {
      return;
    }

    state.searchRequestId += 1;
    const currentRequestId = state.searchRequestId;
    searchResults.innerHTML =
      '<p class="search-results-empty">검색 결과를 불러오는 중입니다...</p>';

    try {
      const payload = await geocodeAddress(query, currentRequestId);

      if (payload?.results?.length) {
        setSelectedLocation(payload.results[0]);
        setActionFeedback(
          `검색 결과 1순위를 바로 선택했습니다: ${buildSelectionLabel(payload.results[0])}`
        );
      }
    } catch (error) {
      searchResults.innerHTML = `
        <p class="search-results-empty">
          ${escapeHtml(error instanceof Error ? error.message : "검색에 실패했습니다.")}
        </p>
      `;
    }
  });

  searchInput.addEventListener("input", () => {
    scheduleSearch();
  });

  modelForm.addEventListener("input", () => {
    syncContourIntervalInput();
    markModelOptionsDirty();
  });

  modelForm.addEventListener("change", () => {
    syncContourIntervalInput();
    markModelOptionsDirty();
  });

  loadSiteContextButton?.addEventListener("click", async () => {
    try {
      await generateModelSpec();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "범위 적용에 실패했습니다.");
    }
  });

  previewSiteContextButton?.addEventListener("click", async () => {
    try {
      await generateModelSpec();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "범위 적용에 실패했습니다.");
    }
  });

  downloadSiteContextButton?.addEventListener("click", async () => {
    try {
      await downloadSiteContext();
    } catch (error) {
      window.alert(
        error instanceof Error ? error.message : "컨텍스트 JSON 다운로드에 실패했습니다."
      );
    }
  });

  downloadObjButton?.addEventListener("click", async () => {
    try {
      await downloadObj("obj");
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "OBJ 파일 다운로드에 실패했습니다.");
    }
  });

  download3dmButton?.addEventListener("click", async () => {
    try {
      await downloadObj("3dm");
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "3DM 파일 다운로드에 실패했습니다.");
    }
  });

  clearHistoryButton.addEventListener("click", () => {
    state.history = [];
    saveHistory();
    renderHistory();
  });

  loadLandInfoButton.addEventListener("click", async () => {
    try {
      await loadLandInfo();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "토지정보 조회에 실패했습니다.");
    }
  });

  document.querySelector("#showLandInfoDetailsButton")?.addEventListener("click", async () => {
    const popup = openPendingWindow("토지이음 상세 정보");

    try {
      await openLandInfoDetails(popup);
    } catch (error) {
      if (popup && !popup.closed) {
        popup.close();
      }
      window.alert(error instanceof Error ? error.message : "토지이음 상세 정보를 여는 데 실패했습니다.");
    }
  });

  openLandUseDetailButton?.addEventListener("click", async () => {
    const popup = openPendingWindow();

    try {
      await openLandUseDetail(popup);
    } catch (error) {
      if (popup && !popup.closed) {
        popup.close();
      }
      window.alert(error instanceof Error ? error.message : "토지이음 결과 열기에 실패했습니다.");
    }
  });

  loadBuildingRegisterButton.addEventListener("click", async () => {
    try {
      await loadBuildingRegister();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "건축물대장 조회에 실패했습니다.");
    }
  });

  showBuildingRegisterDetailsButton?.addEventListener("click", async () => {
    const popup = openPendingWindow("건축물대장 상세 정보");

    try {
      await openBuildingRegisterDetails(popup);
    } catch (error) {
      if (popup && !popup.closed) {
        popup.close();
      }
      window.alert(
        error instanceof Error ? error.message : "건축물대장 상세 정보를 여는 데 실패했습니다."
      );
    }
  });

  printBuildingRegisterButton?.addEventListener("click", async () => {
    const popup = openPendingWindow();

    try {
      await printBuildingRegister(popup);
    } catch (error) {
      if (popup && !popup.closed) {
        popup.close();
      }
      window.alert(error instanceof Error ? error.message : "건축물대장 요약 인쇄에 실패했습니다.");
    }
  });

  openOfficialBuildingRegisterButton.addEventListener("click", () => {
    openOfficialBuildingRegister();
  });
}

function createMap(config) {
  const map = L.map("map", {
    zoomControl: false,
  }).setView(
    [config.map.initialCenter.lat, config.map.initialCenter.lng],
    config.map.initialZoom
  );

  L.control.zoom({ position: "bottomright" }).addTo(map);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 22,
    maxNativeZoom: 19,
    detectRetina: false,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>',
  }).addTo(map);

  map.on("click", async (event) => {
    const { lat, lng } = event.latlng;

    selectionSummary.textContent = "선택한 위치의 주소를 확인하는 중입니다...";

    try {
      const location = await reverseGeocode(lat, lng);
      setSelectedLocation(location, false);
    } catch {
      setSelectedLocation(
        {
          id: `manual-${lat}-${lng}`,
          label: `${formatCoord(lat)}, ${formatCoord(lng)}`,
          roadAddress: "",
          parcelAddress: "",
          lat,
          lng,
          provider: "manual",
          searchType: "mixed",
        },
        false
      );
    }
  });

  state.map = map;
}

function setSelectedLocation(location, moveMap = true) {
  state.selectedLocation = location;
  state.activeSelectionKey = buildHistoryKey(location);
  state.siteContext = null;
  state.siteContextOptionsSignature = "";
  state.buildingRegister = null;
  state.landInfo = null;
  state.landInfoDetails = null;
  state.latestSpec = null;

  specPreview.textContent =
    "범위 설정을 누르면 현재 반경, 표고, 포함 건물을 먼저 확인할 수 있습니다.";
  resetModelProgress(
    "범위를 설정하면 지도 버퍼와 3D 추출 범위가 여기에 표시됩니다."
  );

  if (!state.marker) {
    state.marker = L.marker([location.lat, location.lng]).addTo(state.map);
  } else {
    state.marker.setLatLng([location.lat, location.lng]);
  }

  if (moveMap) {
    state.map.flyTo([location.lat, location.lng], 18, {
      duration: 0.8,
    });
  }

  pushHistory(location);
  clearContextLayers();
  renderSelectionSummary();
  renderSelectionMeta();
  renderSiteContextMeta();
  renderLandInfo();
  renderBuildingRegister();
  openPopup(location);
  siteContextNote.textContent =
    "현재 위치가 선택되었습니다. 범위 설정을 누르면 현재 반경으로 버퍼와 건물 범위를 다시 계산합니다.";
  landInfoNote.textContent =
    "선택한 위치 기준으로 토지이음 요약을 자동으로 불러오는 중입니다.";

  if (state.runtimeConfig?.futureSources?.hasBuildingHubKey) {
    buildingRegisterNote.textContent =
      "선택한 위치 기준으로 건축물대장 요약을 자동으로 불러오는 중입니다.";
  }

  void refreshSelectionData(state.activeSelectionKey);
}

async function refreshSelectionData(selectionKey) {
  try {
    await loadLandInfo(selectionKey);
  } catch (error) {
    if (isSelectionRequestCurrent(selectionKey)) {
      landInfoNote.textContent =
        error instanceof Error ? error.message : "토지정보를 불러오지 못했습니다.";
    }
  }

  if (state.runtimeConfig?.futureSources?.hasBuildingHubKey) {
    try {
      await loadBuildingRegister(true, selectionKey);
    } catch (error) {
      if (isSelectionRequestCurrent(selectionKey)) {
        buildingRegisterNote.textContent =
          error instanceof Error
            ? error.message
            : "건축물대장 요약을 불러오지 못했습니다.";
      }
    }
  }
}

async function bootstrap() {
  loadHistory();
  renderHistory();
  renderSelectionSummary();
  renderSelectionMeta();
  renderSiteContextMeta();
  renderLandInfo();
  renderBuildingRegister();
  prepareModelFormUi();
  updateDownloadButtonLabel();
  resetModelProgress();
  syncContourIntervalInput();
  specPreview.textContent =
    "범위 설정을 누르면 현재 반경, 표고, 포함 건물 수를 먼저 확인할 수 있습니다.";
  syncPanelStatusChips();
  attachEvents();
  await loadRuntimeConfig();
  createMap(state.runtimeConfig);
}

bootstrap().catch((error) => {
  providerBadge.textContent = "초기화 실패";
  specPreview.textContent =
    error instanceof Error
      ? `초기화 중 문제가 발생했습니다: ${error.message}`
      : "초기화 중 문제가 발생했습니다.";
});
