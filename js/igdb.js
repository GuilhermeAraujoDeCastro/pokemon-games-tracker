// Busca os jogos de Pokemon via IGDB, chamando o proxy em api/igdb-search.js
// (o Client Secret da IGDB nao pode ficar no navegador).

const PROXY_ENDPOINT = "/api/igdb-search";

// Tipos da IGDB que nao entram: DLC, expansao, pacote, mod, episodio, temporada, fork, pack, update.
const NON_GAME_TYPES = new Set([1, 2, 3, 5, 6, 7, 12, 13, 14]);
// Empresas que fazem ou publicam os jogos oficiais. ROM hack e jogo de fa nao tem nenhuma delas.
const OFFICIAL_COMPANY =
  /\b(nintendo|game freak|the pok[eé]mon company|pok[eé]mon company international|creatures|genius sonority|spike chunsoft|chunsoft|ambrella|ilca|niantic|dena|tencent|timi studio|hal laboratory|jupiter|intelligent systems|koei tecmo|select button|heroz|hudson soft|nd cube|bandai namco|camelot|pokelabo|cygames)\b/i;

export async function searchPokemonGames(fetchImpl = fetch) {
  const response = await fetchImpl(PROXY_ENDPOINT);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(`Erro ao buscar jogos: ${response.status}`);
  }
  if (data && data.error) {
    const error = new Error(data.error);
    error.code = data.code || null;
    throw error;
  }

  return normalizeGames(filterOfficialGames(data));
}

// Jogo oficial: tipo valido e pelo menos uma empresa oficial envolvida.
function isOfficialGame(game) {
  const type = typeof game.game_type === "number" ? game.game_type : game.game_type?.id ?? game.category;
  if (NON_GAME_TYPES.has(type)) {
    return false;
  }
  const companies = Array.isArray(game.involved_companies) ? game.involved_companies : [];
  return companies.some((entry) => OFFICIAL_COMPANY.test(entry?.company?.name || ""));
}

// Sem dado de empresa (proxy antigo ou IGDB mudou) nao filtra, pra lista nunca ficar vazia.
function filterOfficialGames(rawResults) {
  if (!rawResults.some((game) => Array.isArray(game.involved_companies))) {
    return rawResults;
  }
  const official = rawResults.filter(isOfficialGame);
  return official.length > 0 ? official : rawResults;
}

function normalizeGames(rawResults) {
  return rawResults
    .filter((game) => game.name && normalizeText(game.name).includes("pokemon"))
    .map((game) => ({
      id: game.id,
      name: game.name,
      year: game.first_release_date ? new Date(game.first_release_date * 1000).getFullYear() : null,
      releaseDate: game.first_release_date ? game.first_release_date * 1000 : null,
      platforms: Array.isArray(game.platforms) ? game.platforms.map((platform) => platform.name).filter(Boolean) : [],
      coverUrl:
        game.cover && game.cover.image_id
          ? `https://images.igdb.com/igdb/image/upload/t_cover_big/${game.cover.image_id}.jpg`
          : null,
      summary: game.summary || null,
      // IGDB usa escala 0-100; converte pra 0-10 e chama de "nota IGDB" na
      // UI pra nao confundir com as estrelas de 1 a 5 do proprio app.
      totalRating: typeof game.total_rating === "number" ? Math.round(game.total_rating) / 10 : null,
    }))
    .filter((game) => game.year !== null)
    .sort((a, b) => a.year - b.year);
}

// Remove acentos pra "Pokemon" bater no filtro com ou sem acento.
function normalizeText(text) {
  return text
    .normalize("NFD")
    .replace(new RegExp("[\\u0300-\\u036f]", "g"), "")
    .toLowerCase();
}
