// Liga tudo (DOM, Firebase, IGDB) nos modulos puros. Sem teste automatizado
// aqui (precisa de navegador); a logica testada mora nos outros modulos.

import { calculateProgress, formatProgressLabel } from "./progress.js";
import {
  availablePlatforms,
  availableYears,
  filterGames,
  sortGamesAlphabetically,
  sortGamesByYear,
  splitByCompletion,
  splitUpcoming,
} from "./filters.js";
import { averageRating, validateRating } from "./ratings.js";
import { searchPokemonGames } from "./igdb.js";
import { loadLocalProgress, saveLocalProgress, setRating, togglePlayed } from "./storage-local.js";
import { exportProgressPayload, parseImportedProgress } from "./backup.js";
import { averageCompletionDelay, gamesByGeneration, ratingDistribution, stampCompletionIfNeeded, topRankedGames } from "./stats.js";
import { debounce } from "./debounce.js";

// v2: o formato do jogo em cache ganhou summary/totalRating (Fase 5) - muda
// a chave pra quem tinha cache antigo buscar de novo em vez de mostrar
// detalhe faltando ate clicar em atualizar.
const GAMES_CACHE_KEY = "pokemon-games-tracker:games-cache:v2";
const GAMES_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // igual ao s-maxage do proxy da IGDB
const THEME_KEY = "pokemon-games-tracker:theme";
const SHEET_TRANSITION_MS = 250;
const SEARCH_DEBOUNCE_MS = 250;

const el = {
  onboarding: document.getElementById("onboarding"),
  appSection: document.getElementById("app-section"),
  tabCollection: document.getElementById("tab-collection"),
  tabProfile: document.getElementById("tab-profile"),
  bottomNav: document.getElementById("bottom-nav"),
  navButtons: document.querySelectorAll("#bottom-nav .nav-btn"),
  profileGreeting: document.getElementById("profile-greeting"),
  profileStats: document.getElementById("profile-stats"),
  logoutBtn: document.getElementById("logout-btn"),
  shareBanner: document.getElementById("share-banner"),
  exitShareBtn: document.getElementById("exit-share-btn"),
  exportBtn: document.getElementById("export-btn"),
  importBtn: document.getElementById("import-btn"),
  importFileInput: document.getElementById("import-file-input"),
  backupError: document.getElementById("backup-error"),
  guestForm: document.getElementById("guest-form"),
  guestNameInput: document.getElementById("guest-name"),
  googleLoginBtn: document.getElementById("google-login-btn"),
  googleLoginError: document.getElementById("google-login-error"),
  emailForm: document.getElementById("email-form"),
  emailInput: document.getElementById("email-input"),
  passwordInput: document.getElementById("password-input"),
  emailLoginBtn: document.getElementById("email-login-btn"),
  emailRegisterBtn: document.getElementById("email-register-btn"),
  emailLoginError: document.getElementById("email-login-error"),
  searchInput: document.getElementById("search-input"),
  filterToggleBtn: document.getElementById("filter-toggle-btn"),
  filterSheet: document.getElementById("filter-sheet"),
  filterCloseBtn: document.getElementById("filter-close-btn"),
  detailSheet: document.getElementById("detail-sheet"),
  detailCloseBtn: document.getElementById("detail-close-btn"),
  detailTitle: document.getElementById("detail-title"),
  detailRating: document.getElementById("detail-rating"),
  detailPlatforms: document.getElementById("detail-platforms"),
  detailSummary: document.getElementById("detail-summary"),
  yearFilter: document.getElementById("year-filter"),
  platformFilter: document.getElementById("platform-filter"),
  onlyUnplayed: document.getElementById("only-unplayed"),
  sortSelect: document.getElementById("sort-select"),
  refreshBtn: document.getElementById("refresh-btn"),
  rankingList: document.getElementById("ranking-list"),
  ratingDistributionEl: document.getElementById("rating-distribution"),
  generationStats: document.getElementById("generation-stats"),
  completionDelay: document.getElementById("completion-delay"),
  themeToggleBtn: document.getElementById("theme-toggle-btn"),
  listStatus: document.getElementById("list-status"),
  upcomingSection: document.getElementById("upcoming-section"),
  upcomingGrid: document.getElementById("upcoming-grid"),
  gameGrid: document.getElementById("game-grid"),
  profileGrid: document.getElementById("profile-grid"),
};

const state = {
  profile: null, // { mode: "guest" | "google" | "email" | "share", id, name }
  games: [],
  progress: { played: [], ratings: {}, completedAt: {} },
  tab: "collection",
  readOnly: false, // true quando entrou via link publico (?share=uid)
};

// Link publico (?share=uid) tem prioridade sobre o login salvo do Firebase.
const SHARED_UID = new URLSearchParams(window.location.search).get("share");

let appConfig = null;
let firebaseModule = null;
let firebaseRefs = null; // { app, auth, db }

init();

async function init() {
  initTheme();
  registerServiceWorker();
  appConfig = await loadConfig();
  if (appConfig && appConfig.SENTRY_DSN) {
    await setUpErrorMonitoring(appConfig.SENTRY_DSN);
  }

  if (appConfig && appConfig.FIREBASE_CONFIG) {
    await setUpFirebase(appConfig.FIREBASE_CONFIG);
  } else {
    el.googleLoginBtn.disabled = true;
    el.emailLoginBtn.disabled = true;
    el.emailRegisterBtn.disabled = true;
  }

  el.guestForm.addEventListener("submit", handleGuestLogin);
  el.googleLoginBtn.addEventListener("click", handleGoogleLogin);
  el.emailForm.addEventListener("submit", handleEmailLogin);
  el.emailRegisterBtn.addEventListener("click", handleEmailRegister);
  el.logoutBtn.addEventListener("click", handleLogout);
  el.exportBtn.addEventListener("click", handleExportProgress);
  el.importBtn.addEventListener("click", () => el.importFileInput.click());
  el.importFileInput.addEventListener("change", handleImportProgress);
  el.searchInput.addEventListener("input", debounce(render, SEARCH_DEBOUNCE_MS));
  el.yearFilter.addEventListener("change", render);
  el.platformFilter.addEventListener("change", render);
  el.onlyUnplayed.addEventListener("change", render);
  el.sortSelect.addEventListener("change", render);
  el.refreshBtn.addEventListener("click", () => loadGames({ forceRefresh: true }));
  el.themeToggleBtn.addEventListener("click", toggleTheme);
  el.appSection.addEventListener("click", handleGridClick);
  el.appSection.addEventListener("keydown", handleGridKeydown);
  el.navButtons.forEach((button) => {
    button.addEventListener("click", () => switchTab(button.dataset.tab));
  });
  el.filterToggleBtn.addEventListener("click", openFilterSheet);
  el.filterCloseBtn.addEventListener("click", closeFilterSheet);
  el.filterSheet.addEventListener("click", (event) => {
    if (event.target === el.filterSheet) {
      closeFilterSheet();
    }
  });
  el.detailCloseBtn.addEventListener("click", closeDetailSheet);
  el.detailSheet.addEventListener("click", (event) => {
    if (event.target === el.detailSheet) {
      closeDetailSheet();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") {
      return;
    }
    if (!el.filterSheet.hidden) {
      closeFilterSheet();
    }
    if (!el.detailSheet.hidden) {
      closeDetailSheet();
    }
  });
  el.exitShareBtn.addEventListener("click", () => {
    window.location.href = window.location.pathname;
  });

  await enterShareViewIfRequested();
}

// Link publico somente-leitura: "?share=<uid>" na URL entra direto na
// colecao de outra pessoa, sem login. So funciona se o Firestore tiver a
// regra de leitura publica de progress/{uid}/games/{gameId} (veja
// firestore.rules) - so' "get" de um doc por vez, nunca "list" da
// subcolecao inteira, por isso loadSharedProgress pede um get por jogo em
// vez de usar getDocs como o login normal.
//
// Marca state.profile de forma sincrona (antes de qualquer await) pra
// ganhar de qualquer login persistido do Firebase que resolva depois -
// watchAuthState so' pisa em cima do perfil quando ele ainda esta null.
// Isso e' intencional: quem abre um link de colecao compartilhada espera
// ver aquela colecao, mesmo que tambem esteja logado na propria conta.
async function enterShareViewIfRequested() {
  const sharedUid = SHARED_UID;
  if (!sharedUid) {
    return;
  }
  if (!firebaseModule || !firebaseRefs) {
    showListStatus("Este link de colecao compartilhada precisa do Firebase configurado.");
    return;
  }
  state.profile = { mode: "share", id: sharedUid, name: "Colecao compartilhada" };
  state.readOnly = true;
  el.shareBanner.hidden = false;
  el.appSection.classList.add("read-only");
  await enterApp(); // popula state.games - precisa disso pra saber quais ids de jogo pedir a seguir

  try {
    const gameIds = state.games.map((game) => game.id);
    state.progress = await firebaseModule.loadSharedProgress(firebaseRefs.db, sharedUid, gameIds);
  } catch (error) {
    console.error("Erro ao carregar colecao compartilhada:", error);
    state.progress = { played: [], ratings: {}, completedAt: {} };
  }
  render();
}

// O <head> do index.html ja aplicou o tema certo antes da 1a pintura (pra
// nao piscar); aqui so' sincroniza o icone do botao com o que ja esta la.
function initTheme() {
  applyThemeIcon(document.documentElement.dataset.theme === "dark");
}

function toggleTheme() {
  const dark = document.documentElement.dataset.theme !== "dark";
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  try {
    localStorage.setItem(THEME_KEY, dark ? "dark" : "light");
  } catch {
    // Sem storage disponivel: o tema so' nao sobrevive a um reload, sem problema.
  }
  applyThemeIcon(dark);
}

function applyThemeIcon(dark) {
  el.themeToggleBtn.textContent = dark ? "☀" : "🌙";
}

// Instalavel como PWA (opcional - se o navegador nao suportar ou o
// registro falhar, o site continua funcionando normalmente sem isso).
function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    return;
  }
  navigator.serviceWorker.register("sw.js").catch((error) => {
    console.error("Nao foi possivel registrar o service worker:", error);
  });
}

async function loadConfig() {
  try {
    return await import("./config.js");
  } catch {
    return null;
  }
}

// Opcional (so' liga se SENTRY_DSN estiver configurado - veja
// scripts/generate-config.js). Sem bundler, entao importa direto do CDN
// (mesmo jeito que o Firebase ja faz aqui). Falha aqui nunca deve derrubar
// o app - so' fica sem monitoramento.
async function setUpErrorMonitoring(dsn) {
  try {
    const Sentry = await import("https://esm.sh/@sentry/browser@8?bundle");
    Sentry.init({ dsn });
  } catch (error) {
    console.error("Nao foi possivel iniciar o monitoramento de erro:", error);
  }
}

async function setUpFirebase(firebaseConfig) {
  try {
    firebaseModule = await import("./firebase-app.js");
    firebaseRefs = firebaseModule.initFirebase(firebaseConfig);
    firebaseModule.watchAuthState(firebaseRefs.auth, (user) => {
      if (user && !state.profile && !SHARED_UID) {
        loginWithFirebaseUser(user, firebaseProviderMode(user));
      }
    });
  } catch (error) {
    console.error("Nao foi possivel iniciar o Firebase:", error);
    el.googleLoginBtn.disabled = true;
    el.emailLoginBtn.disabled = true;
    el.emailRegisterBtn.disabled = true;
    el.googleLoginError.hidden = false;
    el.googleLoginError.textContent = "Login com Google e por e-mail indisponivel agora (confira js/config.js).";
  }
}

// Descobre se o login foi por Google ou e-mail/senha, olhando o provedor
// que o Firebase registra (usado ao restaurar a sessao num reload).
function firebaseProviderMode(user) {
  const providerId = user.providerData && user.providerData[0] ? user.providerData[0].providerId : null;
  return providerId === "google.com" ? "google" : "email";
}

async function handleGuestLogin(event) {
  event.preventDefault();
  const name = el.guestNameInput.value.trim();
  if (!name) {
    return;
  }
  state.profile = { mode: "guest", id: name, name };
  state.progress = loadLocalProgress(name);
  await enterApp();
}

async function handleGoogleLogin() {
  if (!firebaseModule || !firebaseRefs) {
    return;
  }
  el.googleLoginError.hidden = true;
  try {
    const user = await firebaseModule.loginWithGoogle(firebaseRefs.auth);
    await loginWithFirebaseUser(user, "google");
  } catch (error) {
    console.error("Falha no login com Google:", error);
    el.googleLoginError.hidden = false;
    el.googleLoginError.textContent = "Nao foi possivel entrar com Google. Tente de novo.";
  }
}

async function handleEmailLogin(event) {
  event.preventDefault();
  if (!firebaseModule || !firebaseRefs) {
    return;
  }
  el.emailLoginError.hidden = true;
  try {
    const user = await firebaseModule.loginWithEmail(firebaseRefs.auth, el.emailInput.value.trim(), el.passwordInput.value);
    await loginWithFirebaseUser(user, "email");
  } catch (error) {
    console.error("Falha no login com e-mail:", error);
    el.emailLoginError.hidden = false;
    el.emailLoginError.textContent = emailErrorMessage(error);
  }
}

async function handleEmailRegister() {
  if (!firebaseModule || !firebaseRefs) {
    return;
  }
  el.emailLoginError.hidden = true;
  try {
    const user = await firebaseModule.registerWithEmail(firebaseRefs.auth, el.emailInput.value.trim(), el.passwordInput.value);
    await loginWithFirebaseUser(user, "email");
  } catch (error) {
    console.error("Falha ao criar conta por e-mail:", error);
    el.emailLoginError.hidden = false;
    el.emailLoginError.textContent = emailErrorMessage(error);
  }
}

// Traduz os codigos de erro mais comuns do Firebase pra uma frase legivel.
function emailErrorMessage(error) {
  const code = error && error.code;
  if (code === "auth/email-already-in-use") {
    return "Ja existe uma conta com esse e-mail. Tenta entrar em vez de criar uma nova.";
  }
  if (code === "auth/weak-password") {
    return "Senha muito curta (minimo de 6 caracteres).";
  }
  if (code === "auth/invalid-email") {
    return "Esse e-mail nao parece valido.";
  }
  if (code === "auth/invalid-credential" || code === "auth/wrong-password" || code === "auth/user-not-found") {
    return "E-mail ou senha incorretos.";
  }
  return "Nao foi possivel completar agora. Tenta de novo.";
}

async function loginWithFirebaseUser(user, mode) {
  const fallbackName = mode === "google" ? "sua conta Google" : user.email || "sua conta";
  state.profile = { mode, id: user.uid, name: user.displayName || fallbackName };
  state.progress = await firebaseModule.loadUserProgress(firebaseRefs.db, user.uid);
  await enterApp();
}

async function handleLogout() {
  const isRealAccount = state.profile && state.profile.mode !== "guest" && state.profile.mode !== "share";
  if (isRealAccount && firebaseModule && firebaseRefs) {
    try {
      await firebaseModule.logout(firebaseRefs.auth);
    } catch (error) {
      console.error("Erro ao sair da conta:", error);
    }
  }
  state.profile = null;
  state.progress = { played: [], ratings: {}, completedAt: {} };
  state.tab = "collection";
  state.readOnly = false;
  el.appSection.classList.remove("read-only");
  el.shareBanner.hidden = true;
  el.appSection.hidden = true;
  el.bottomNav.hidden = true;
  el.refreshBtn.hidden = true;
  el.filterSheet.hidden = true;
  el.filterSheet.classList.remove("open");
  el.onboarding.hidden = false;
}

async function enterApp() {
  el.onboarding.hidden = true;
  el.appSection.hidden = false;
  el.bottomNav.hidden = false;
  el.refreshBtn.hidden = false;
  switchTab("collection");
  await loadGames({ forceRefresh: false });
}

function switchTab(tab) {
  state.tab = tab;
  el.navButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === tab);
  });
  el.tabCollection.hidden = tab !== "collection";
  el.tabProfile.hidden = tab !== "profile";
}

// Abre/fecha qualquer um dos sheets (filtros, detalhe do jogo) - mesma
// animacao pros dois, so muda qual elemento.
function openSheet(sheetEl) {
  sheetEl.hidden = false;
  requestAnimationFrame(() => {
    sheetEl.classList.add("open");
  });
}

function closeSheet(sheetEl) {
  sheetEl.classList.remove("open");
  setTimeout(() => {
    sheetEl.hidden = true;
  }, SHEET_TRANSITION_MS);
}

function openFilterSheet() {
  el.filterToggleBtn.setAttribute("aria-expanded", "true");
  openSheet(el.filterSheet);
}

function closeFilterSheet() {
  el.filterToggleBtn.setAttribute("aria-expanded", "false");
  closeSheet(el.filterSheet);
}

function openDetailSheet(game) {
  el.detailTitle.textContent = `${game.name} (${game.year})`;
  el.detailRating.textContent = game.totalRating !== null ? `Nota IGDB: ${game.totalRating}/10` : "Sem nota na IGDB.";
  el.detailPlatforms.textContent =
    game.platforms.length > 0 ? `Plataformas: ${game.platforms.join(", ")}` : "Plataformas nao informadas.";
  el.detailSummary.textContent = game.summary || "Sem sinopse disponivel na IGDB.";
  openSheet(el.detailSheet);
  el.detailCloseBtn.focus();
}

function closeDetailSheet() {
  closeSheet(el.detailSheet);
}

async function loadGames({ forceRefresh }) {
  let cacheEmDia = false;
  if (!forceRefresh) {
    const cached = readGamesCache();
    if (cached) {
      state.games = cached.games;
      cacheEmDia = !cached.velho;
      populateYearFilter();
      populatePlatformFilter();
      render();
    }
  }

  // Cache com mais de 6 horas: mostra o salvo e atualiza por baixo (antes o cache nunca vencia).
  if (!forceRefresh && state.games.length > 0 && cacheEmDia) {
    return;
  }

  if (state.games.length === 0) {
    el.gameGrid.innerHTML = skeletonGridHtml();
  }
  showListStatus("Buscando jogos na IGDB...");
  try {
    const games = await searchPokemonGames();
    state.games = games;
    saveGamesCache(games);
    populateYearFilter();
    populatePlatformFilter();
    hideListStatus();
    render();
  } catch (error) {
    console.error("Erro ao buscar jogos na IGDB:", error);
    if (error.code === "missing_env") {
      showListStatus(
        "IGDB_CLIENT_ID e/ou IGDB_CLIENT_SECRET nao configurados na Vercel. Cadastre as duas variaveis em " +
          "Project Settings > Environment Variables e faca um novo deploy.",
      );
    } else {
      showListStatus(
        state.games.length > 0
          ? "Nao deu pra atualizar agora. Mostrando a ultima lista salva."
          : "Nao deu pra buscar os jogos na IGDB agora. Confira se o proxy (api/igdb-search.js) esta configurado.",
      );
    }
    if (state.games.length === 0) {
      el.gameGrid.innerHTML = "";
    }
  }
}

// Placeholders com "brilho" enquanto a IGDB nao responde, no lugar de tela
// em branco. So aparece na 1a busca (sem cache ainda) - com cache, o
// usuario ja ve os jogos antigos enquanto atualiza em segundo plano.
function skeletonGridHtml(count = 6) {
  return Array.from({ length: count })
    .map(
      () => `
        <div class="skeleton-card">
          <div class="skeleton-cover"></div>
          <div class="skeleton-line" style="width: 70%"></div>
          <div class="skeleton-line" style="width: 40%"></div>
        </div>
      `,
    )
    .join("");
}

function readGamesCache() {
  try {
    const raw = localStorage.getItem(GAMES_CACHE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.games)) {
      return null;
    }
    return { games: parsed.games, velho: !(Date.now() - (parsed.fetchedAt || 0) < GAMES_CACHE_TTL_MS) };
  } catch {
    return null;
  }
}

function saveGamesCache(games) {
  try {
    localStorage.setItem(GAMES_CACHE_KEY, JSON.stringify({ games, fetchedAt: Date.now() }));
  } catch (error) {
    console.error("Nao deu pra salvar o cache dos jogos:", error);
  }
}

// Recria as <option> de um <select> de filtro, preservando a selecao atual
// se ela ainda existir na lista nova (usado pro filtro de ano e de
// plataforma, que faziam a mesma coisa duas vezes com pequenas diferencas).
function populateSelect(selectEl, values, allLabel) {
  const previousValue = selectEl.value;
  const options = values
    .map((value) => `<option value="${escapeHtml(String(value))}">${escapeHtml(String(value))}</option>`)
    .join("");
  selectEl.innerHTML = `<option value="">${allLabel}</option>` + options;
  selectEl.value = values.some((value) => String(value) === previousValue) ? previousValue : "";
}

function populateYearFilter() {
  populateSelect(el.yearFilter, availableYears(state.games), "Todos");
}

function populatePlatformFilter() {
  populateSelect(el.platformFilter, availablePlatforms(state.games), "Todas");
}

function showListStatus(message) {
  el.listStatus.hidden = false;
  el.listStatus.textContent = message;
}

function hideListStatus() {
  el.listStatus.hidden = true;
}

function render() {
  const { released, upcoming } = splitUpcoming(state.games);
  const { active, completed } = splitByCompletion(released, state.progress);
  renderCollection(active);
  renderProfile(completed, released);
  renderUpcoming(upcoming);
}

// Aplica os mesmos filtros de busca/ano/plataforma da colecao (so' sem
// onlyUnplayed/playedIds, que nao fazem sentido pra um jogo que ainda nao
// saiu) - senao um jogo "Em breve" continuava aparecendo mesmo depois de
// filtrado pra fora da colecao logo acima, parecendo que o filtro nao funcionou.
function renderUpcoming(upcomingGames) {
  const filtered = filterGames(upcomingGames, {
    search: el.searchInput.value,
    year: el.yearFilter.value ? Number(el.yearFilter.value) : null,
    platform: el.platformFilter.value || null,
  });
  el.upcomingSection.hidden = filtered.length === 0;
  el.upcomingGrid.innerHTML = sortGamesByYear(filtered, "asc")
    .map((game) => gameCardHtml(game, { upcoming: true }))
    .join("");
}

function renderCollection(activeGames) {
  const filtered = filterGames(activeGames, {
    search: el.searchInput.value,
    year: el.yearFilter.value ? Number(el.yearFilter.value) : null,
    platform: el.platformFilter.value || null,
    onlyUnplayed: el.onlyUnplayed.checked,
    playedIds: state.progress.played,
  });
  const sorted = applySort(filtered, el.sortSelect.value);

  el.gameGrid.innerHTML =
    sorted.length > 0
      ? sorted.map((game) => gameCardHtml(game)).join("")
      : '<p class="empty-message">Nenhum jogo encontrado com esses filtros.</p>';
}

// releasedGames exclui os "Em breve" (js/filters.js splitUpcoming) - um
// jogo que ainda nao saiu nao deveria contar contra o seu progresso.
function renderProfile(completedGames, releasedGames) {
  el.profileGreeting.textContent = `Ola, ${state.profile.name}`;

  const progress = calculateProgress(releasedGames, state.progress.played);
  const avg = averageRating(state.progress.ratings);
  el.profileStats.textContent =
    avg === null ? formatProgressLabel(progress) : `${formatProgressLabel(progress)} · nota media: ${avg}`;

  const sorted = sortGamesByYear(completedGames, "desc");
  el.profileGrid.innerHTML =
    sorted.length > 0
      ? sorted.map((game) => gameCardHtml(game)).join("")
      : '<p class="empty-message">Nenhum jogo concluido ainda. Marca como jogado e da uma nota pra ele aparecer aqui.</p>';

  renderStats(releasedGames);
}

// releasedGames (sem os "Em breve") pra nao deixar um jogo ainda nao
// lancado entrar no ranking/media so' porque ganhou nota/data por algum
// jeito incomum (cache velho, doc importado, etc) - mesmo motivo do
// releasedGames em renderProfile acima.
function renderStats(releasedGames) {
  const ranked = topRankedGames(releasedGames, state.progress);
  el.rankingList.innerHTML =
    ranked.length > 0
      ? ranked
          .map(
            (game, index) =>
              `<li class="ranking-item"><span>${index + 1}. ${escapeHtml(game.name)}</span><span class="ranking-rating">${"★".repeat(game.rating)}</span></li>`,
          )
          .join("")
      : '<li class="ranking-item">Ainda sem jogos avaliados.</li>';

  el.ratingDistributionEl.innerHTML = statBarsHtml(ratingDistribution(state.progress.ratings), (value) => `${value} ★`);

  const playedGames = releasedGames.filter((game) => state.progress.played.includes(game.id));
  el.generationStats.innerHTML = statBarsHtml(gamesByGeneration(playedGames), (label) => label);

  const delay = averageCompletionDelay(releasedGames, state.progress);
  el.completionDelay.textContent =
    delay === null
      ? "Ainda sem dados suficientes pra calcular ha quantos anos do lancamento voce costuma terminar um jogo."
      : `Em media, voce termina um jogo Pokemon ${delay} anos depois do lancamento dele.`;
}

// Barra de progresso simples em CSS puro (sem lib de grafico) pra cada
// entrada de um {chave: contagem} - usado tanto pra notas quanto geracoes.
function statBarsHtml(counts, labelFor) {
  const entries = Object.entries(counts).filter(([, count]) => count > 0);
  if (entries.length === 0) {
    return '<p class="stat-note">Sem dados ainda.</p>';
  }
  const max = Math.max(...entries.map(([, count]) => count));
  return entries
    .map(([key, count]) => {
      const percent = Math.round((count / max) * 100);
      return `
        <div class="stat-bar-row">
          <span>${escapeHtml(labelFor(key))}</span>
          <span class="stat-bar-track"><span class="stat-bar-fill" style="width: ${percent}%"></span></span>
          <span>${count}</span>
        </div>
      `;
    })
    .join("");
}

function applySort(games, sortKey) {
  if (sortKey === "year-desc") {
    return sortGamesByYear(games, "desc");
  }
  if (sortKey === "title-asc") {
    return sortGamesAlphabetically(games, "asc");
  }
  return sortGamesByYear(games, "asc");
}

function gameCardHtml(game, { upcoming = false } = {}) {
  const safeName = escapeHtml(game.name);
  const platformsText = game.platforms.length > 0 ? escapeHtml(game.platforms.join(", ")) : "";

  const cover = game.coverUrl
    ? `<img class="game-cover" src="${game.coverUrl}" alt="Capa de ${safeName}" loading="lazy" />`
    : `<div class="cover-placeholder"><span>${safeName}</span></div>`;

  // Jogo ainda nao lancado: sem controle de jogado/nota, so um selo (nem
  // calcula played/stars nesse caso, ja que nao vao ser usados).
  const controls = upcoming ? `<span class="badge-upcoming">Em breve</span>` : playedControlsHtml(game);

  return `
    <article class="game-card" data-game-id="${game.id}" tabindex="0" aria-label="${safeName}, abrir ficha">
      ${cover}
      <div class="game-info">
        <h3>${safeName} <span class="game-year">(${game.year})</span></h3>
        ${platformsText ? `<p class="game-platforms">${platformsText}</p>` : ""}
        ${controls}
      </div>
    </article>
  `;
}

function playedControlsHtml(game) {
  const played = state.progress.played.includes(game.id);
  const rating = state.progress.ratings[game.id] || 0;
  const stars = [1, 2, 3, 4, 5]
    .map(
      (value) =>
        `<button type="button" class="star${value <= rating ? " filled" : ""}" data-rating="${value}" aria-label="Dar nota ${value}">★</button>`,
    )
    .join("");

  return `
    <label class="played-label">
      <input type="checkbox" class="played-checkbox" ${played ? "checked" : ""} />
      Jogado
    </label>
    <div class="stars">${stars}</div>
  `;
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function handleGridClick(event) {
  const card = event.target.closest(".game-card");
  if (!card || !state.profile) {
    return;
  }
  const gameId = Number(card.dataset.gameId);
  const isMutationTarget = event.target.matches(".star") || event.target.matches(".played-checkbox");

  // Um guard so' aqui pra bloquear qualquer mutacao na visualizacao
  // compartilhada (?share=uid), em vez de repetir "&& !state.readOnly" em
  // cada branch - assim um controle novo que alguem adicionar aqui no
  // futuro nao esquece de checar isso. Abrir o detalhe do jogo continua
  // liberado (nao muda nada).
  if (isMutationTarget && state.readOnly) {
    return;
  }

  if (event.target.matches(".star")) {
    const validated = validateRating(event.target.dataset.rating);
    if (validated === null || validated === (state.progress.ratings[gameId] || 0)) {
      return;
    }
    state.progress = setRating(state.progress, gameId, validated);
    state.progress = stampCompletionIfNeeded(state.progress, gameId);
    persistProgress(gameId);
    render();
    return;
  }

  if (event.target.matches(".played-checkbox")) {
    state.progress = togglePlayed(state.progress, gameId);
    state.progress = stampCompletionIfNeeded(state.progress, gameId);
    persistProgress(gameId);
    render();
    return;
  }

  // Clique no texto "Jogado" ou entre as estrelas nao abre a ficha por baixo.
  if (event.target.closest(".played-label") || event.target.closest(".stars")) {
    return;
  }

  const game = state.games.find((candidate) => candidate.id === gameId);
  if (game) {
    openDetailSheet(game);
  }
}

// Enter ou espaco no card focado abre a ficha (acessibilidade por teclado).
function handleGridKeydown(event) {
  if ((event.key !== "Enter" && event.key !== " ") || !event.target.matches(".game-card")) {
    return;
  }
  event.preventDefault();
  const game = state.games.find((candidate) => candidate.id === Number(event.target.dataset.gameId));
  if (game) {
    openDetailSheet(game);
  }
}

// Baixa o progresso atual como .json (Blob + link temporario, sem backend).
// O botao ja fica escondido em modo somente-leitura (.read-only .profile-
// actions no css/styles.css), o guard aqui e' so' redundancia de proposito.
function handleExportProgress() {
  if (state.readOnly) {
    return;
  }
  const payload = exportProgressPayload(state.profile, state.progress);
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `pokemon-games-tracker-${state.profile.name}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

async function handleImportProgress(event) {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file || state.readOnly) {
    return;
  }
  el.backupError.hidden = true;
  const text = await file.text();
  const imported = parseImportedProgress(text);
  if (!imported) {
    el.backupError.hidden = false;
    el.backupError.textContent = "Esse arquivo nao parece um backup valido do Pokémon Games Tracker.";
    return;
  }
  state.progress = imported;
  persistProgress();
  render();
}

// gameId presente: so' aquele jogo mudou (clique na estrela/checkbox),
// grava so' ele no Firestore. gameId ausente: mudanca em varios jogos de
// uma vez (importar um backup), grava tudo junto num lote so'. O modo
// visitante sempre grava o progresso inteiro (localStorage e' local e de
// graca, nao tem custo por escrita como o Firestore).
function persistProgress(gameId) {
  if (state.profile.mode === "guest") {
    // try/catch pra um erro de quota nao travar a excecao antes do
    // render() rodar (senao o clique parecia nao ter feito nada).
    try {
      saveLocalProgress(state.profile.id, state.progress);
    } catch (error) {
      console.error("Erro ao salvar progresso localmente:", error);
    }
    return;
  }
  if (!firebaseModule || !firebaseRefs) {
    return;
  }
  const onError = (error) => console.error("Erro ao salvar progresso no Firestore:", error);
  if (gameId !== undefined) {
    firebaseModule
      .saveGameProgress(firebaseRefs.db, state.profile.id, gameId, {
        played: state.progress.played.includes(gameId),
        rating: state.progress.ratings[gameId] || null,
        completedAt: state.progress.completedAt[gameId] || null,
      })
      .catch(onError);
  } else {
    firebaseModule.saveAllProgress(firebaseRefs.db, state.profile.id, state.progress).catch(onError);
  }
}
