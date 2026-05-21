import React, { useEffect, useMemo, useRef, useState } from "react";

const LS_DRAFT = "scorekeeper_draft_v1";
const LS_HISTORY = "scorekeeper_history_v1";
const LS_PLAYER_PROFILES = "scorekeeper_player_profiles_v1";

const DEFAULT_TAGS = ["family", "friends", "game night", "tournament", "home", "travel"];

function safeParse(json, fallback) {
  try {
    const v = JSON.parse(json);
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

function uid() {
  return (globalThis.crypto?.randomUUID?.() ?? `id_${Date.now()}_${Math.random()}`).toString();
}

function clampScore(n) {
  const MAX = 200;
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(MAX, n));
}

function faceCardValue(label) {
  if (label === "J") return 11;
  if (label === "Q") return 12;
  if (label === "K") return 13;
  const n = Number(label);
  return Number.isFinite(n) ? n : 0;
}

function createScoreHelperCounts() {
  return {
    joker: 0,
    wild: 0,
    "3": 0,
    "4": 0,
    "5": 0,
    "6": 0,
    "7": 0,
    "8": 0,
    "9": 0,
    "10": 0,
    J: 0,
    Q: 0,
    K: 0,
  };
}

function computeScoreHelperTotal(counts) {
  const safeCounts = counts || {};
  let total = (safeCounts.joker || 0) * 50 + (safeCounts.wild || 0) * 20;

  for (const label of ["3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"]) {
    total += (safeCounts[label] || 0) * faceCardValue(label);
  }

  return total;
}

function roundsFor5Crowns() {
  return ["3", "4", "5", "6", "7", "8", "9", "10", "Jacks", "Queens", "Kings"];
}

function getRoundMeta(label, roundIndex) {
  const cardsDealt = roundIndex + 3;
  const wild = label === "Jacks" ? "Jack" : label === "Queens" ? "Queen" : label === "Kings" ? "King" : label;
  return { cardsDealt, wild };
}

function computeTotals(players, rounds) {
  const totals = {};
  for (const p of players) totals[p.id] = 0;

  for (let rIdx = 0; rIdx < rounds.length; rIdx++) {
    const r = rounds[rIdx];
    for (const p of players) {
      const joinRound = typeof p.joinRound === "number" ? p.joinRound : 0;
      if (rIdx < joinRound) continue;
      const raw = r.scores?.[p.id];
      const val = typeof raw === "number" ? raw : 0;
      totals[p.id] += val;
    }
  }
  return totals;
}

function computeRoundsWon(players, rounds) {
  const wins = {};
  for (const p of players) wins[p.id] = 0;
  for (const r of rounds) {
    if (r.wentOutId && wins[r.wentOutId] !== undefined) wins[r.wentOutId] += 1;
  }
  return wins;
}

function computeBestRound(players, rounds) {
  let best = null;

  for (let rIdx = 0; rIdx < rounds.length; rIdx++) {
    const round = rounds[rIdx];
    for (const player of players) {
      const value = round?.scores?.[player.id];
      if (typeof value !== "number") continue;
      if (!best || value < best.score) {
        best = { playerId: player.id, roundIndex: rIdx, score: value };
      }
    }
  }

  return best;
}

function computeWorstRound(players, rounds) {
  let worst = null;

  for (let rIdx = 0; rIdx < rounds.length; rIdx++) {
    const round = rounds[rIdx];
    for (const player of players) {
      const value = round?.scores?.[player.id];
      if (typeof value !== "number") continue;
      if (!worst || value > worst.score) {
        worst = { playerId: player.id, roundIndex: rIdx, score: value };
      }
    }
  }

  return worst;
}

function buildStandings(players, totals, roundsWon) {
  return [...players]
    .sort((a, b) => {
      const totalDiff = (totals[a.id] ?? 0) - (totals[b.id] ?? 0);
      if (totalDiff !== 0) return totalDiff;
      const winsDiff = (roundsWon[b.id] ?? 0) - (roundsWon[a.id] ?? 0);
      if (winsDiff !== 0) return winsDiff;
      return a.name.localeCompare(b.name);
    })
    .map((player, index) => ({
      rank: index + 1,
      id: player.id,
      name: player.name,
      total: totals[player.id] ?? 0,
      roundsWon: roundsWon[player.id] ?? 0,
    }));
}

function getDealerName(players, roundIndex) {
  if (!players || players.length === 0) return "";
  const eligiblePlayers = players.filter((p) => {
    const joinRound = typeof p.joinRound === "number" ? p.joinRound : 0;
    return joinRound <= roundIndex;
  });
  if (eligiblePlayers.length === 0) return "";
  const dealer = eligiblePlayers[roundIndex % eligiblePlayers.length];
  return dealer?.name || "";
}

function winnerIds(players, totals) {
  if (!players.length) return [];
  const eligiblePlayers = players.filter((p) => {
    const joinRound = typeof p.joinRound === "number" ? p.joinRound : 0;
    return joinRound === 0;
  });
  if (!eligiblePlayers.length) return [];

  let best = Infinity;
  for (const p of eligiblePlayers) best = Math.min(best, totals[p.id] ?? 0);

  return eligiblePlayers
    .filter((p) => (totals[p.id] ?? 0) === best)
    .map((p) => p.id);
}

function formatDate(iso) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function normalizeTag(tag) {
  return tag.trim().replace(/\s+/g, " ");
}

function normalizePlayerName(name) {
  return normalizeTag(String(name || "")).toLowerCase();
}

function buildPlayerStats(history) {
  const stats = new Map();

  for (const game of history || []) {
    const players = game.players || [];
    if (!players.length) continue;

    const totals = game.totals || computeTotals(players, game.rounds || []);
    const roundsWon = computeRoundsWon(players, game.rounds || []);

    const standings = [...players]
      .map((player) => ({
        id: player.id,
        key: player.profileId || normalizePlayerName(player.name || "Player"),
        name: normalizeTag(player.name || "Player"),
        total: totals[player.id] ?? 0,
        roundsWon: roundsWon[player.id] ?? 0,
      }))
      .sort((a, b) => {
        const totalDiff = a.total - b.total;
        if (totalDiff !== 0) return totalDiff;

        const roundsWonDiff = b.roundsWon - a.roundsWon;
        if (roundsWonDiff !== 0) return roundsWonDiff;

        return a.name.localeCompare(b.name);
      });

    standings.forEach((player, index) => {
      const key = player.key;
      if (!key) return;

      if (!stats.has(key)) {
        stats.set(key, {
          key,
          name: player.name,
          gamesPlayed: 0,
          wins: 0,
          second: 0,
          third: 0,
          totalPoints: 0,
          bestFinish: Infinity,
        });
      }

      const entry = stats.get(key);
      entry.name = player.name;
      entry.gamesPlayed += 1;
      entry.totalPoints += player.total;
      entry.bestFinish = Math.min(entry.bestFinish, index + 1);

      if (index === 0) entry.wins += 1;
      if (index === 1) entry.second += 1;
      if (index === 2) entry.third += 1;
    });
  }

  return Array.from(stats.values())
    .map((entry) => ({
      ...entry,
      averagePoints: entry.gamesPlayed
        ? Math.round((entry.totalPoints / entry.gamesPlayed) * 10) / 10
        : 0,
      bestFinish: Number.isFinite(entry.bestFinish) ? entry.bestFinish : "—",
    }))
    .sort((a, b) => {
      if (b.wins !== a.wins) return b.wins - a.wins;
      if (b.second !== a.second) return b.second - a.second;
      if (a.averagePoints !== b.averagePoints) return a.averagePoints - b.averagePoints;
      return a.name.localeCompare(b.name);
    });
}

function syncPlayerProfilesWithPlayers(existingProfiles, players) {
  const now = new Date().toISOString();
  const profiles = [...(existingProfiles || [])].map((profile) => ({ ...profile }));
  const profilesById = new Map(profiles.map((profile) => [profile.id, profile]));
  const profilesByName = new Map(
    profiles.map((profile) => [normalizePlayerName(profile.name || ""), profile])
  );

  const syncedPlayers = (players || []).map((player) => {
    const cleanName = normalizeTag(player.name || "") || "Player";
    let profile = player.profileId ? profilesById.get(player.profileId) : null;

    if (!profile) {
      profile = profilesByName.get(normalizePlayerName(cleanName));
    }

    if (!profile) {
      profile = {
        id: uid(),
        name: cleanName,
        createdAt: now,
        lastUsedAt: now,
      };
      profiles.push(profile);
      profilesById.set(profile.id, profile);
      profilesByName.set(normalizePlayerName(profile.name), profile);
    } else {
      profile.name = cleanName;
      profile.lastUsedAt = now;
      profilesByName.set(normalizePlayerName(profile.name), profile);
    }

    return {
      ...player,
      name: cleanName,
      profileId: profile.id,
    };
  });

  const sortedProfiles = profiles.sort((a, b) => {
    const timeA = new Date(a.lastUsedAt || a.createdAt || 0).getTime();
    const timeB = new Date(b.lastUsedAt || b.createdAt || 0).getTime();
    if (timeB !== timeA) return timeB - timeA;
    return (a.name || "").localeCompare(b.name || "");
  });

  return { profiles: sortedProfiles, players: syncedPlayers };
}

function ensureUniqueNames(players) {
  const seen = new Set();
  const out = [];
  for (const p of players) {
    let name = (p.name || "").trim();
    if (!name) name = "Player";
    let candidate = name;
    let i = 2;
    while (seen.has(candidate.toLowerCase())) {
      candidate = `${name} ${i++}`;
    }
    seen.add(candidate.toLowerCase());
    out.push({ ...p, name: candidate });
  }
  return out;
}

function createFreshGameDraft() {
  return {
    id: uid(),
    gameType: "5crowns",
    name: "",
    createdAt: new Date().toISOString(),
    location: "",
    notes: "",
    tags: [],
    players: [
      { id: uid(), name: "Player 1", joinRound: 0 },
      { id: uid(), name: "Player 2", joinRound: 0 },
    ],
    roundLabels: roundsFor5Crowns(),
    rounds: roundsFor5Crowns().map(() => ({ scores: {}, wentOutId: "" })),
  };
}

function loadSavedHistory() {
  const saved = safeParse(localStorage.getItem(LS_HISTORY) || "[]", []);
  return Array.isArray(saved) ? saved : [];
}

function loadSavedPlayerProfiles() {
  const saved = safeParse(localStorage.getItem(LS_PLAYER_PROFILES) || "[]", []);
  return Array.isArray(saved) ? saved : [];
}

function loadSavedDraft() {
  const saved = safeParse(localStorage.getItem(LS_DRAFT) || "null", null);
  if (saved && saved.players && saved.rounds && saved.roundLabels) return saved;
  return createFreshGameDraft();
}

const styles = `
:root{
  --rowAlt: #F1ECFA;
  --bg: #F6F4FB;
  --panel: #FCFBFF;
  --text: #0a0a0a;
  --muted: #6B5E8A;
  --border: #E6E1F2;
  --chip: #F1ECFA;
  --chipText: #111;
  --primary: #6D28D9;
  --focus: rgba(0,0,0,0.12);
  --winner: rgba(109, 40, 217, 0.16);
}
*{ box-sizing:border-box; }
body{
  margin:0;
  font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji","Segoe UI Emoji";
  background: var(--bg);
  color: var(--text);
}
a{ color: inherit; }
.container{
  max-width: 1100px;
  margin: 0 auto;
  padding: 16px;
}
.header{
  display:flex;
  align-items:flex-end;
  justify-content:space-between;
  gap:12px;
  margin-bottom:14px;
}
.brandRow{
  display:flex;
  align-items:center;
  gap:10px;
}
.appIcon{
  width:38px;
  height:38px;
  border-radius:12px;
  background: var(--primary);
  color: var(--bg);
  display:flex;
  align-items:center;
  justify-content:center;
  font-weight:900;
  font-size:20px;
  box-shadow: 0 8px 20px rgba(109,40,217,0.18);
}
.h1{ font-size: 22px; font-weight: 700; margin:0; }
.sub{ font-size: 13px; color: var(--muted); margin-top:4px; }
.statusPill{
  display:inline-flex;
  align-items:center;
  gap:6px;
  padding:6px 10px;
  border:1px solid var(--border);
  border-radius:999px;
  background: rgba(255,255,255,0.7);
  color: var(--muted);
  font-size:12px;
  font-weight:700;
  white-space:nowrap;
}
.tabs{ display:flex; gap:8px; }
.tab{
  border:1px solid var(--border);
  background: var(--chip);
  color: var(--chipText);
  padding: 8px 12px;
  border-radius: 14px;
  font-size: 13px;
  cursor:pointer;
}
.tab.active{ background: var(--panel); }
.panel{
  background: var(--panel);
  border:1px solid var(--border);
  border-radius: 16px;
  padding: 14px;
}
.grid{
  display:grid;
  grid-template-columns: 1fr;
  gap: 12px;
}
@media (min-width: 980px){
  .grid{ grid-template-columns: 360px 1fr; }
}
.label{ font-size: 12px; font-weight: 600; margin-bottom: 6px; }
.input, .textarea{
  width: 100%;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text);
  padding: 10px 10px;
  border-radius: 12px;
  outline: none;
}
.textarea{ resize: vertical; min-height: 86px; }
.row{ display:flex; gap:8px; align-items:center; }
.btn{
  border: 1px solid var(--border);
  background: var(--chip);
  color: var(--chipText);
  padding: 10px 12px;
  border-radius: 14px;
  cursor:pointer;
  font-size: 13px;
}
.btn.primary{
  background: var(--primary);
  color: var(--bg);
  border-color: transparent;
}
.btn:disabled{ opacity: 0.5; cursor:not-allowed; }
.small{ font-size: 12px; color: var(--muted); }
.hr{ height:1px; background: var(--border); margin: 12px 0; }
.chips{ display:flex; flex-wrap:wrap; gap:8px; }
.chip{
  border:1px solid var(--border);
  background: var(--chip);
  color: var(--chipText);
  padding: 6px 10px;
  border-radius: 999px;
  font-size: 12px;
  cursor:pointer;
  user-select:none;
}
.chip.on{
  background: var(--panel);
  border-color: var(--primary);
}
.tableWrap{
  border: 1px solid var(--border);
  border-radius: 14px;
  overflow:auto;
}
.table{
  border-collapse: collapse;
  width: 100%;
  min-width: 760px;
  font-size: 13px;
}
.th, .td{
  border-bottom: 1px solid var(--border);
  padding: 12px 12px;
  vertical-align: middle;
  background: transparent;
}
.th{
  position: sticky;
  top: 0;
  background: var(--panel);
  z-index: 2;
  font-weight: 700;
  text-align:left;
}
.th.round{ left:0; z-index:3; }
.td.round{
  position: sticky;
  left: 0;
  background: var(--panel);
  z-index: 1;
  font-weight: 600;
  color: var(--muted);
}
.trCurrent td,
.trCurrent .td.round{
  background: rgba(109, 40, 217, 0.10) !important;
}
.trCurrent td{
  border-top: 2px solid rgba(109, 40, 217, 0.28);
  border-bottom: 2px solid rgba(109, 40, 217, 0.28);
}
.trCurrent .scoreInput,
.trCurrent .starBtn,
.trCurrent .addBtn{
  transform: scale(1.03);
}
.collapsedRoundRow td,
.collapsedRoundRow .td.round{
  background: rgba(109, 40, 217, 0.04) !important;
}
.collapsedRoundButton{
  width: 100%;
  text-align: left;
  border: 1px dashed var(--border);
  background: rgba(255,255,255,0.72);
  color: var(--text);
  padding: 10px 12px;
  border-radius: 12px;
  cursor: pointer;
}
.activeToolbar{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:10px;
  flex-wrap:wrap;
  border: 1px solid var(--border);
  background: rgba(109,40,217,0.06);
  border-radius: 14px;
  padding: 10px 12px;
  margin-bottom: 10px;
}
.activeToolbarMeta{
  display:flex;
  flex-wrap:wrap;
  gap:8px;
}
.scoreInput{
  width: 90px;
  padding: 8px 8px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text);
  outline: none;
}
.scoreInput:focus{ box-shadow: 0 0 0 4px var(--focus); }
.cell{
  display:flex;
  align-items:center;
  gap: 8px;
}
.starBtn{
  border: 1px solid var(--border);
  background: var(--chip);
  color: var(--chipText);
  width: 34px;
  height: 34px;
  border-radius: 12px;
  cursor:pointer;
  display:flex;
  align-items:center;
  justify-content:center;
  user-select:none;
}
.starBtn.on{
  border-color: transparent;
  background: rgba(255,215,0,0.22);
}
.totalRow th, .totalRow td{
  position: sticky;
  bottom: 0;
  background: var(--panel);
  z-index: 2;
  border-top: 1px solid var(--border);
  border-bottom: none;
  font-weight: 800;
}
.totalRow th.round{ left:0; z-index: 3; }
.badge{
  display:inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--border);
  font-size: 12px;
  color: var(--muted);
  margin-left: 8px;
}
.winnerCell{
  background: var(--winner);
  border-radius: 10px;
  padding: 2px 6px;
  display:inline-block;
}
.dealerPill{
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  padding: 4px 8px;
  border-radius: 999px;
  background: rgba(109, 40, 217, 0.08);
  color: var(--primary);
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
}
.currentPill{
  display: inline-flex;
  align-items: center;
  margin-top: 6px;
  padding: 4px 8px;
  border-radius: 999px;
  background: rgba(109, 40, 217, 0.10);
  color: var(--primary);
  font-size: 11px;
  font-weight: 700;
  line-height: 1;
}
.historyList{ display:flex; flex-direction:column; gap:10px; }
.historyItem{
  text-align:left;
  width:100%;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text);
  padding: 12px;
  border-radius: 14px;
  cursor:pointer;
}
.historyItem.active{ border-color: var(--primary); }
.historyTitle{ font-weight: 800; }
.historyMeta{ margin-top: 4px; font-size: 12px; color: var(--muted); }
.summaryCard{
  border: 1px solid var(--border);
  background: linear-gradient(180deg, rgba(109,40,217,0.06), rgba(109,40,217,0.02));
  border-radius: 16px;
  padding: 14px;
}
.summaryTitle{
  font-size: 18px;
  font-weight: 900;
  margin: 0 0 6px 0;
}
.summaryWinner{
  font-size: 14px;
  margin-bottom: 10px;
}
.summaryGrid{
  display: grid;
  gap: 10px;
  grid-template-columns: 1fr;
}
.summaryStat{
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 10px 12px;
  background: rgba(255,255,255,0.6);
}
.summaryStatLabel{
  font-size: 11px;
  font-weight: 700;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-bottom: 4px;
}
.summaryStatValue{
  font-size: 14px;
  font-weight: 800;
}
.standingsList{
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.standingRow{
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: rgba(255,255,255,0.6);
}
.standingLeft{
  display: flex;
  align-items: center;
  gap: 10px;
}
.rankBadge{
  min-width: 28px;
  height: 28px;
  padding: 0 8px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 800;
  background: var(--chip);
  border: 1px solid var(--border);
}
.standingName{
  font-weight: 800;
}
.standingMeta{
  font-size: 12px;
  color: var(--muted);
}
.playerStatsList{
  display:flex;
  flex-direction:column;
  gap:10px;
}
.playerStatCard{
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 12px;
  background: rgba(255,255,255,0.65);
}
.playerStatHeader{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:10px;
  margin-bottom:8px;
}
.playerStatName{
  font-weight: 900;
}
.playerStatGrid{
  display:grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap:8px;
}
.playerStatItem{
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 8px 10px;
  background: rgba(255,255,255,0.75);
}
.playerStatLabel{
  font-size: 11px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-bottom: 4px;
  font-weight: 700;
}
.playerStatValue{
  font-size: 14px;
  font-weight: 800;
}
.profileRow{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:10px;
  padding:10px 12px;
  border:1px solid var(--border);
  border-radius:12px;
  background: rgba(255,255,255,0.7);
}
.profileName{
  font-weight:800;
}
.profileActions{
  display:flex;
  gap:8px;
  flex-wrap:wrap;
}
.sheetOverlay{
  position: fixed;
  inset: 0;
  background: rgba(10,10,10,0.35);
  z-index: 40;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  padding: 12px;
}
.sheetPanel{
  width: min(640px, 100%);
  max-height: 85vh;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 20px;
  background: var(--panel);
  padding: 14px;
  box-shadow: 0 16px 40px rgba(0,0,0,0.18);
}
.sheetHandle{
  width: 44px;
  height: 5px;
  border-radius: 999px;
  background: var(--border);
  margin: 0 auto 12px auto;
}
.helperPanel{
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 12px;
  background: rgba(109,40,217,0.04);
  margin-top: 12px;
}
.helperHeader{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:10px;
  margin-bottom: 10px;
}
.helperGrid{
  display:grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap:8px;
}
.helperCard{
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 8px 10px;
  background: rgba(255,255,255,0.8);
}
.helperCardTitle{
  font-size: 12px;
  font-weight: 800;
  margin-bottom: 8px;
}
.helperStepper{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:8px;
}
.helperCount{
  min-width: 24px;
  text-align:center;
  font-weight: 800;
}
.helperMiniBtn{
  border: 1px solid var(--border);
  background: var(--chip);
  color: var(--chipText);
  width: 32px;
  height: 32px;
  border-radius: 10px;
  cursor: pointer;
}
.addBtn{
  border: 1px solid var(--border);
  background: var(--chip);
  color: var(--chipText);
  min-width: 44px;
  height: 34px;
  border-radius: 12px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 800;
  padding: 0 10px;
  white-space: nowrap;
}
.quickActionBtn{
  width: 100%;
  text-align: left;
  border: 1px solid var(--border);
  background: rgba(255,255,255,0.7);
  color: var(--text);
  padding: 12px;
  border-radius: 14px;
  cursor: pointer;
}
.quickActionTitle{
  font-size: 13px;
  font-weight: 800;
  margin-bottom: 4px;
}
.quickActionSub{
  font-size: 12px;
  color: var(--muted);
}
.setupPrimary{
  display:flex;
  flex-direction:column;
  gap:10px;
}
.setupDetails{
  border:1px solid var(--border);
  border-radius:14px;
  background: rgba(255,255,255,0.58);
  padding:10px 12px;
}
.setupDetails summary{
  cursor:pointer;
  font-size:13px;
  font-weight:900;
  color: var(--text);
}
.setupDetailsBody{
  padding-top:12px;
}
.gameCompleteCard{
  border:1px solid var(--border);
  border-radius:16px;
  background: linear-gradient(180deg, rgba(109,40,217,0.08), rgba(255,255,255,0.86));
  padding:14px;
  margin-bottom:12px;
}
.completeEyebrow{
  font-size:12px;
  font-weight:800;
  color:var(--primary);
  margin-bottom:4px;
}
.completeTitle{
  font-size:20px;
  font-weight:950;
  margin-bottom:6px;
}
.completeWinner{
  color:var(--muted);
  font-size:13px;
  margin-bottom:10px;
}
.completeGrid{
  display:grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap:8px;
  margin-bottom:12px;
}
.completeStat{
  border:1px solid var(--border);
  border-radius:12px;
  padding:10px;
  background:rgba(255,255,255,0.78);
}
.completeStatLabel{
  font-size:11px;
  color:var(--muted);
  font-weight:800;
  text-transform:uppercase;
  margin-bottom:3px;
}
.completeStatValue{
  font-size:14px;
  font-weight:900;
}
.backupCard{
  border:1px solid rgba(109,40,217,0.20);
  border-radius:16px;
  background: linear-gradient(180deg, rgba(109,40,217,0.07), rgba(255,255,255,0.86));
  padding:14px;
  margin-bottom:12px;
}
.backupTitle{
  font-size:15px;
  font-weight:950;
  margin-bottom:4px;
}
.backupText{
  font-size:12px;
  color:var(--muted);
  margin-bottom:10px;
}
.backupActions{
  display:flex;
  gap:8px;
  flex-wrap:wrap;
}
.scoreActions{
  display:flex;
  gap:8px;
  align-items:center;
}
.viewToggle{
  display:none;
  align-items:center;
  gap:6px;
  padding:4px;
  border:1px solid var(--border);
  border-radius:14px;
  background: rgba(255,255,255,0.65);
}
.viewToggleBtn{
  border:0;
  background: transparent;
  color: var(--muted);
  padding:8px 10px;
  border-radius:10px;
  cursor:pointer;
  font-size:12px;
  font-weight:800;
}
.viewToggleBtn.active{
  background: var(--primary);
  color: var(--bg);
}
.noticeCard,
.feedbackPrompt{
  border:1px solid var(--border);
  border-radius:14px;
  background: rgba(109,40,217,0.05);
  color: var(--muted);
  padding:10px 12px;
  font-size:12px;
}
.feedbackPrompt{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:10px;
  margin-bottom:12px;
}
.mobileRoundWrap{
  display:none;
}
.mobileLeaderStrip{
  display:none;
}
.mobileStandingsPanel{
  display:none;
}
.mobileRoundHeader{
  border:1px solid var(--border);
  border-radius:14px;
  padding:12px;
  background: rgba(109,40,217,0.06);
  margin-bottom:10px;
}
.mobilePlayerList{
  display:flex;
  flex-direction:column;
  gap:10px;
}
.mobilePlayerCard{
  border:1px solid var(--border);
  border-radius:14px;
  padding:12px;
  background: rgba(255,255,255,0.72);
}
.mobilePlayerTop{
  display:flex;
  align-items:flex-start;
  justify-content:space-between;
  gap:10px;
  margin-bottom:10px;
}
.mobilePlayerName{
  border:0;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-weight:900;
  padding:0;
  text-align:left;
  cursor:pointer;
}
.mobilePlayerMeta{
  display:flex;
  gap:6px;
  flex-wrap:wrap;
  justify-content:flex-end;
}
.mobileScoreRow{
  display:grid;
  grid-template-columns: minmax(0, 1fr) 44px 58px;
  gap:8px;
  align-items:center;
}
.mobileScoreRow .scoreInput{
  width:100%;
  min-height:44px;
  font-size:18px;
  font-weight:800;
}
.mobileScoreRow .starBtn,
.mobileScoreRow .addBtn{
  height:44px;
  border-radius:12px;
}
.mobileRoundFooter{
  display:none;
}
@media (min-width: 760px){
  .helperGrid{ grid-template-columns: repeat(4, minmax(0, 1fr)); }
}
@media (min-width: 760px){
  .summaryGrid{ grid-template-columns: repeat(3, 1fr); }
}
.heroCard{
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: 16px;
  background: linear-gradient(180deg, rgba(109,40,217,0.08), rgba(109,40,217,0.02));
  margin-bottom: 12px;
}
.heroHeader{
  display:flex;
  align-items:center;
  gap:12px;
  margin-bottom: 6px;
}
.heroLogoBadge{
  width: 40px;
  height: 40px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: linear-gradient(180deg, #7C3AED, #5B21B6);
  color: white;
  display:flex;
  align-items:center;
  justify-content:center;
  font-size: 22px;
  font-weight: 800;
  flex: 0 0 auto;
}
.heroTitle{
  font-size: 20px;
  font-weight: 800;
  margin: 0;
}
.heroSub{
  font-size: 13px;
  color: var(--muted);
  margin-bottom: 10px;
}
.heroChips{
  display:flex;
  flex-wrap:wrap;
  gap:8px;
}
.heroChip{
  padding: 6px 10px;
  border-radius: 999px;
  background: rgba(255,255,255,0.7);
  border:1px solid var(--border);
  font-size:12px;
  font-weight:600;
}
@media (max-width: 760px){
  .container{ padding: 12px; }
  .header{ align-items:flex-start; flex-direction:column; }
  .brandRow{ width:100%; }
  .statusPill{ align-self:flex-start; }
  .tabs{ width:100%; overflow:auto; }
  .panel{
    padding: 12px;
    background: #fff;
  }
  .table{ min-width: 680px; }
  .scoreInput{ width: 78px; }
  .scoreHeader{
    gap:10px;
  }
  .scoreActions{
    width:100%;
    flex-wrap:wrap;
  }
  .scoreActions .btn{
    flex:1 1 auto;
  }
  .scoreActions .mobileSecondaryAction{
    display:none;
  }
  .scoreActions .primary{
    flex-basis:100%;
  }
  .viewToggle{
    display:inline-flex;
    width:100%;
    background:#fff;
    border-color:#E9E3F4;
  }
  .viewToggleBtn{
    flex:1;
    color:#5F5575;
  }
  .viewToggleBtn.active{
    background:#F4F0FB;
    color:#4C1D95;
    box-shadow: inset 0 0 0 1px rgba(109,40,217,0.12);
  }
  .scoreSummary{
    display:none;
  }
  .mobileLeaderStrip{
    display:flex;
    align-items:center;
    justify-content:space-between;
    gap:10px;
    padding:10px 12px;
    border:1px solid #E9E3F4;
    border-radius:14px;
    background:#fff;
    margin-bottom:10px;
  }
  .mobileStandingsPanel{
    display:block;
    margin-bottom:10px;
  }
  .mobileStandingsToggle{
    width:100%;
    min-height:42px;
    background:#fff;
    border-color:#E9E3F4;
  }
  .mobileStandingsList{
    display:flex;
    flex-direction:column;
    gap:6px;
    margin-top:8px;
  }
  .mobileStandingRow{
    display:flex;
    align-items:center;
    justify-content:space-between;
    gap:10px;
    padding:9px 10px;
    border:1px solid #E9E3F4;
    border-radius:12px;
    background:#FBFAFF;
    font-size:13px;
  }
  .mobileStandingName{
    font-weight:800;
  }
  .mobileStandingMeta{
    font-size:11px;
    color:#6B5E8A;
  }
  .tableWrap.mobileHidden{ display:none; }
  .mobileRoundWrap.show{ display:block; }
  .mobileHelpText{
    display:none;
  }
  .activeToolbar{
    background:#fff;
    border-color:#E9E3F4;
  }
  .dealerPill,
  .currentPill{
    background:#F7F3FC;
    color:#5B21B6;
  }
  .mobileRoundHeader{
    background:#FBFAFF;
    border-color:#E9E3F4;
  }
  .mobilePlayerCard{
    background:#fff;
    border-color:#E9E3F4;
    box-shadow: 0 8px 22px rgba(31, 21, 54, 0.05);
  }
  .mobilePlayerMeta .badge{
    background:#FBFAFF;
    margin-left:0;
  }
  .mobileScoreRow .scoreInput{
    background:#FBFAFF;
    border-color:#DED6EC;
  }
  .mobileScoreRow .scoreInput:focus{
    background:#fff;
    box-shadow: 0 0 0 3px rgba(109,40,217,0.12);
  }
  .mobileScoreRow .starBtn,
  .mobileScoreRow .addBtn{
    background:#fff;
    border-color:#DED6EC;
    color:#312A40;
  }
  .mobileScoreRow .starBtn.on{
    background:#FFF7D6;
    border-color:#F3D36A;
  }
  .mobileRoundFooter{
    display:flex;
    flex-direction:column;
    gap:8px;
    position:sticky;
    bottom:0;
    z-index:5;
    padding:10px 0 2px;
    background: linear-gradient(180deg, rgba(246,244,251,0), #fff 28%);
    margin-top:12px;
  }
  .mobileRoundStatus{
    font-size:12px;
    color:#6B5E8A;
    text-align:center;
  }
  .mobileNextRoundBtn{
    width:100%;
    min-height:46px;
  }
  .summaryCard{
    background:#fff;
    border-color:#E9E3F4;
  }
  .standingRow,
  .summaryStat{
    background:#FBFAFF;
  }
  .noticeCard,
  .feedbackPrompt{
    background:#FBFAFF;
    border-color:#E9E3F4;
  }
  .heroSub,
  .heroChips{
    display:none;
  }
  .setupDetails{
    background:#FBFAFF;
    border-color:#E9E3F4;
  }
  .gameCompleteCard{
    background:#fff;
    border-color:#E9E3F4;
  }
  .backupCard{
    background:#fff;
    border-color:#E9E3F4;
  }
  .backupActions .btn{
    flex:1 1 auto;
  }
  .completeGrid{
    grid-template-columns:1fr;
  }
  .feedbackPrompt{ align-items:flex-start; flex-direction:column; }
}
`;

function pushUndo(stack, entry) {
  const next = [entry, ...stack];
  return next.slice(0, 50);
}

export default function App() {
  const [tab, setTab] = useState("new");
  const [history, setHistory] = useState(loadSavedHistory);
  const [playerProfiles, setPlayerProfiles] = useState(loadSavedPlayerProfiles);
  const [profileSearch, setProfileSearch] = useState("");
  const [draft, setDraft] = useState(loadSavedDraft);
  const [undoStack, setUndoStack] = useState([]);
  const [editGameId, setEditGameId] = useState("");
  const [editGame, setEditGame] = useState(null);
  const [search, setSearch] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [saveStatus, setSaveStatus] = useState("Saved");
  const [renamingPlayerId, setRenamingPlayerId] = useState("");
  const [renamingValue, setRenamingValue] = useState("");
  const [scoreHelper, setScoreHelper] = useState(null);
  const [scoreEntrySheet, setScoreEntrySheet] = useState(null);
  const [expandedFutureRounds, setExpandedFutureRounds] = useState({});
  const [scoreView, setScoreView] = useState("mobile");
  const [isSmallScreen, setIsSmallScreen] = useState(() => window.innerWidth <= 760);
  const [mobileRoundIndex, setMobileRoundIndex] = useState(0);
  const [showMobileStandings, setShowMobileStandings] = useState(false);
  const [showFeedbackPrompt, setShowFeedbackPrompt] = useState(false);
  const [lastSavedGame, setLastSavedGame] = useState(null);
  const inputRefs = useRef(new Map());
  const rowRefs = useRef(new Map());
  const importFileRef = useRef(null);
  const helperPanelRef = useRef(null);

  useEffect(() => {
    localStorage.setItem(LS_HISTORY, JSON.stringify(history));
  }, [history]);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 760px)");
    const updateScreenSize = () => setIsSmallScreen(mediaQuery.matches);
    updateScreenSize();
    mediaQuery.addEventListener("change", updateScreenSize);
    return () => mediaQuery.removeEventListener("change", updateScreenSize);
  }, []);

  useEffect(() => {
    localStorage.setItem(LS_PLAYER_PROFILES, JSON.stringify(playerProfiles));
  }, [playerProfiles]);

  useEffect(() => {
    if (tab !== "new" && tab !== "score") return;

    localStorage.setItem(LS_DRAFT, JSON.stringify(draft));

    const savingTimeoutId = window.setTimeout(() => {
      setSaveStatus("Saving...");
    }, 0);

    const savedTimeoutId = window.setTimeout(() => {
      setSaveStatus("Saved");
    }, 250);

    return () => {
      window.clearTimeout(savingTimeoutId);
      window.clearTimeout(savedTimeoutId);
    };
  }, [draft, tab]);

  const context = tab === "edit" ? "edit" : "draft";
  const current = tab === "edit" ? editGame : draft;
  const activeScoreView = isSmallScreen ? scoreView : "table";

  function setEditField(field, value) {
    setEditGame((prev) => ({ ...prev, [field]: value }));
  }

  function setDraftField(field, value) {
    setDraft((prev) => ({ ...prev, [field]: value }));
  }

  function addPlayer(to = "draft") {
    const fn = to === "edit" ? setEditGame : setDraft;
    fn((prev) => {
      const nextPlayerNumber = (prev.players?.length || 0) + 1;
      const nextPlayers = [
        ...(prev.players || []),
        { id: uid(), name: `Player ${nextPlayerNumber}`, joinRound: 0, profileId: "" },
      ];
      return { ...prev, players: nextPlayers };
    });
  }

  function addSavedPlayerToDraft(profileId) {
    const profile = playerProfiles.find((p) => p.id === profileId);
    if (!profile) return;

    setDraft((prev) => {
      const alreadyInGame = (prev.players || []).some((player) => player.profileId === profileId);
      if (alreadyInGame) return prev;

      return {
        ...prev,
        players: [
          ...(prev.players || []),
          { id: uid(), name: profile.name, joinRound: 0, profileId: profile.id },
        ],
      };
    });
  }

  function renamePlayerProfile(profileId) {
    const profile = playerProfiles.find((p) => p.id === profileId);
    if (!profile) return;

    const nextName = prompt("Rename saved player", profile.name || "");
    if (nextName == null) return;

    const cleanName = normalizeTag(nextName || "");
    if (!cleanName) return;

    setPlayerProfiles((prev) =>
      prev.map((item) => (item.id === profileId ? { ...item, name: cleanName } : item))
    );

    setDraft((prev) => ({
      ...prev,
      players: (prev.players || []).map((player) =>
        player.profileId === profileId ? { ...player, name: cleanName } : player
      ),
    }));

    setEditGame((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        players: (prev.players || []).map((player) =>
          player.profileId === profileId ? { ...player, name: cleanName } : player
        ),
      };
    });

    setHistory((prev) =>
      prev.map((game) => ({
        ...game,
        players: (game.players || []).map((player) =>
          player.profileId === profileId ? { ...player, name: cleanName } : player
        ),
      }))
    );
  }

  function deletePlayerProfile(profileId) {
    const profile = playerProfiles.find((p) => p.id === profileId);
    if (!profile) return;
    if (!confirm(`Delete saved player profile for ${profile.name}? Existing game history will stay intact.`)) return;

    setPlayerProfiles((prev) => prev.filter((item) => item.id !== profileId));

    setDraft((prev) => ({
      ...prev,
      players: (prev.players || []).map((player) =>
        player.profileId === profileId ? { ...player, profileId: "" } : player
      ),
    }));

    setEditGame((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        players: (prev.players || []).map((player) =>
          player.profileId === profileId ? { ...player, profileId: "" } : player
        ),
      };
    });
  }

  const totals = useMemo(() => {
    if (!current) return {};
    return computeTotals(current.players || [], current.rounds || []);
  }, [current]);

  const currentRoundIndex = useMemo(() => {
    if (!current?.rounds?.length || !current?.players?.length) return 0;

    const firstIncompleteRound = current.rounds.findIndex((round) =>
      current.players.some((p) => round.scores?.[p.id] == null)
    );

    return firstIncompleteRound === -1 ? current.rounds.length - 1 : firstIncompleteRound;
  }, [current]);

  const activeMobileRoundIndex = Math.min(
    Math.max(mobileRoundIndex, 0),
    Math.max((current?.rounds?.length || 1) - 1, 0)
  );
  const displayRoundIndex = activeScoreView === "mobile" ? activeMobileRoundIndex : currentRoundIndex;
  const displayRound = current?.rounds?.[displayRoundIndex];
  const displayRoundComplete = Boolean(
    current?.players?.length &&
      current.players.every((player) => displayRound?.scores?.[player.id] != null)
  );
  const missingScoresInDisplayRound = current?.players?.filter(
    (player) => displayRound?.scores?.[player.id] == null
  ).length || 0;

  function addLatePlayer() {
    const newPlayerNumber = draft.players.length + 1;
    const defaultName = `Player ${newPlayerNumber}`;
    const chosenName = prompt("Name for the new player", defaultName);
    if (chosenName == null) return;

    const trimmedName = chosenName.trim() || defaultName;

    setDraft((prev) => {
      const newPlayerId = uid();
      const nextPlayers = [
        ...prev.players,
        { id: newPlayerId, name: trimmedName, joinRound: currentRoundIndex },
      ];
      const nextRounds = prev.rounds.map((round, idx) => {
        const scores = { ...(round.scores || {}) };
        if (idx < currentRoundIndex) scores[newPlayerId] = 0;
        return { ...round, scores };
      });
      return { ...prev, players: nextPlayers, rounds: nextRounds };
    });

    setTimeout(() => {
      focusCell(currentRoundIndex, draft.players.length);
    }, 0);
  }

  function removePlayer(playerId, to = "draft") {
    const fn = to === "edit" ? setEditGame : setDraft;
    fn((prev) => {
      const nextPlayers = prev.players.filter((p) => p.id !== playerId);
      const nextRounds = prev.rounds.map((r) => {
        const scores = { ...(r.scores || {}) };
        delete scores[playerId];
        const wentOutId = r.wentOutId === playerId ? "" : r.wentOutId;
        return { ...r, scores, wentOutId };
      });
      return { ...prev, players: nextPlayers, rounds: nextRounds };
    });
  }

  function setPlayerName(playerId, name, to = "draft") {
    const fn = to === "edit" ? setEditGame : setDraft;
    fn((prev) => {
      const nextPlayers = prev.players.map((p) => {
        if (p.id !== playerId) return p;
        const nextName = name;
        const normalizedNext = normalizePlayerName(nextName);
        const normalizedCurrentProfile = normalizePlayerName(
          playerProfiles.find((profile) => profile.id === p.profileId)?.name || ""
        );

        return {
          ...p,
          name: nextName,
          profileId: normalizedNext && normalizedNext === normalizedCurrentProfile ? p.profileId : "",
        };
      });
      return { ...prev, players: nextPlayers };
    });
  }

  function startRenamingPlayer(playerId) {
    const game = tab === "edit" ? editGame : draft;
    const player = game?.players?.find((p) => p.id === playerId);
    if (!player) return;
    setRenamingPlayerId(playerId);
    setRenamingValue(player.name || "");
  }

  function commitRenamingPlayer(playerId) {
    const trimmedName = renamingValue.trim();
    if (!trimmedName) {
      cancelRenamingPlayer();
      return;
    }
    setPlayerName(playerId, trimmedName, context);
    setRenamingPlayerId("");
    setRenamingValue("");
  }

  function cancelRenamingPlayer() {
    setRenamingPlayerId("");
    setRenamingValue("");
  }

  function toggleTag(tag, to = "draft") {
    tag = normalizeTag(tag);
    if (!tag) return;
    const fn = to === "edit" ? setEditGame : setDraft;
    fn((prev) => {
      const set = new Set(prev.tags || []);
      if (set.has(tag)) set.delete(tag);
      else set.add(tag);
      return { ...prev, tags: Array.from(set) };
    });
  }

  function addCustomTag(tag, to = "draft") {
    tag = normalizeTag(tag);
    if (!tag) return;
    const fn = to === "edit" ? setEditGame : setDraft;
    fn((prev) => {
      const set = new Set(prev.tags || []);
      set.add(tag);
      return { ...prev, tags: Array.from(set) };
    });
  }

  function onScoreChange(rIdx, pIdx, rawValue, to = "draft") {
    const game = to === "edit" ? editGame : draft;
    const playerId = game.players[pIdx].id;
    const trimmed = rawValue.trim();
    let nextVal;
    if (trimmed === "") nextVal = null;
    else {
      const n = clampScore(Number(trimmed));
      if (!Number.isFinite(Number(trimmed))) return;
      nextVal = n;
    }

    const prevVal = game.rounds[rIdx].scores?.[playerId];
    setUndoStack((s) =>
      pushUndo(s, {
        type: "score",
        to,
        rIdx,
        pIdx,
        playerId,
        prevVal: typeof prevVal === "number" ? prevVal : null,
      })
    );

    const fn = to === "edit" ? setEditGame : setDraft;
    fn((prev) => {
      const rounds = prev.rounds.map((r, i) => {
        if (i !== rIdx) return r;
        const scores = { ...(r.scores || {}) };
        if (nextVal === null) delete scores[playerId];
        else scores[playerId] = nextVal;
        return { ...r, scores };
      });
      return { ...prev, rounds };
    });
  }

  function openScoreEntrySheet(rIdx, pIdx) {
    const game = tab === "edit" ? editGame : draft;
    const player = game?.players?.[pIdx];
    if (!player) return;

    const rowLabel = game?.roundLabels?.[rIdx];

    setScoreEntrySheet({
      rIdx,
      pIdx,
      playerId: player.id,
      playerName: player.name || "Player",
      rowLabel,
    });
    setScoreHelper(null);
  }

  function closeScoreEntrySheet() {
    setScoreEntrySheet(null);
    setScoreHelper(null);
  }

  function openScoreHelper() {
    if (!scoreEntrySheet) return;

    setScoreHelper({
      rIdx: scoreEntrySheet.rIdx,
      pIdx: scoreEntrySheet.pIdx,
      playerId: scoreEntrySheet.playerId,
      playerName: scoreEntrySheet.playerName || "Player",
      counts: createScoreHelperCounts(),
    });
  }

  function chooseManualScoreEntry() {
    if (!scoreEntrySheet) return;
    const next = scoreEntrySheet;
    closeScoreEntrySheet();
    setTimeout(() => {
      focusCell(next.rIdx, next.pIdx);
    }, 0);
  }

  function closeScoreHelper() {
    setScoreHelper(null);
  }

  function updateScoreHelperCount(key, delta) {
    setScoreHelper((prev) => {
      if (!prev) return prev;
      const nextCount = Math.max(0, (prev.counts?.[key] || 0) + delta);
      return {
        ...prev,
        counts: {
          ...(prev.counts || {}),
          [key]: nextCount,
        },
      };
    });
  }

  function resetScoreHelper() {
    setScoreHelper((prev) => {
      if (!prev) return prev;
      return { ...prev, counts: createScoreHelperCounts() };
    });
  }

  function applyScoreHelperTotal(markWentOut = false) {
    if (!scoreHelper) return;

    const total = markWentOut ? 0 : clampScore(computeScoreHelperTotal(scoreHelper.counts));
    onScoreChange(scoreHelper.rIdx, scoreHelper.pIdx, String(total), context);

    if (markWentOut) {
      const currentWentOutId = current?.rounds?.[scoreHelper.rIdx]?.wentOutId || "";
      if (currentWentOutId !== scoreHelper.playerId) {
        toggleWentOut(scoreHelper.rIdx, scoreHelper.pIdx, context);
      }
    }

    const next = { rIdx: scoreHelper.rIdx, pIdx: scoreHelper.pIdx };
    closeScoreEntrySheet();
    setTimeout(() => {
      focusCell(next.rIdx, next.pIdx);
    }, 0);
  }

  function applyWentOutZeroFromSheet() {
    if (!scoreEntrySheet) return;
    onScoreChange(scoreEntrySheet.rIdx, scoreEntrySheet.pIdx, "0", context);

    const currentWentOutId = current?.rounds?.[scoreEntrySheet.rIdx]?.wentOutId || "";
    if (currentWentOutId !== scoreEntrySheet.playerId) {
      toggleWentOut(scoreEntrySheet.rIdx, scoreEntrySheet.pIdx, context);
    }

    const next = { rIdx: scoreEntrySheet.rIdx, pIdx: scoreEntrySheet.pIdx };
    closeScoreEntrySheet();
    setTimeout(() => {
      focusCell(next.rIdx, next.pIdx);
    }, 0);
  }

  function toggleWentOut(rIdx, pIdx, to = "draft") {
    const game = to === "edit" ? editGame : draft;
    const playerId = game.players[pIdx].id;
    const prevWentOutId = game.rounds[rIdx].wentOutId || "";
    setUndoStack((s) =>
      pushUndo(s, {
        type: "wentout",
        to,
        rIdx,
        prevWentOutId,
      })
    );

    const fn = to === "edit" ? setEditGame : setDraft;
    fn((prev) => {
      const rounds = prev.rounds.map((r, i) => {
        if (i !== rIdx) return r;
        const next = r.wentOutId === playerId ? "" : playerId;
        return { ...r, wentOutId: next };
      });
      return { ...prev, rounds };
    });
  }

  function undo() {
    const [top, ...rest] = undoStack;
    if (!top) return;
    setUndoStack(rest);
    const fn = top.to === "edit" ? setEditGame : setDraft;

    if (top.type === "score") {
      fn((prev) => {
        const playerId = top.playerId;
        const rounds = prev.rounds.map((r, i) => {
          if (i !== top.rIdx) return r;
          const scores = { ...(r.scores || {}) };
          if (top.prevVal === null || top.prevVal === undefined) delete scores[playerId];
          else scores[playerId] = top.prevVal;
          return { ...r, scores };
        });
        return { ...prev, rounds };
      });
      focusCell(top.rIdx, top.pIdx);
      return;
    }

    if (top.type === "wentout") {
      fn((prev) => {
        const rounds = prev.rounds.map((r, i) => {
          if (i !== top.rIdx) return r;
          return { ...r, wentOutId: top.prevWentOutId || "" };
        });
        return { ...prev, rounds };
      });
    }
  }

  function focusCell(rIdx, pIdx) {
    const key = `${rIdx}_${pIdx}`;
    const el = inputRefs.current.get(key);
    if (el && typeof el.focus === "function") el.focus();
  }

  function focusNextIncompleteCell(to = "draft") {
    const game = to === "edit" ? editGame : draft;
    if (!game?.rounds?.length || !game?.players?.length) return;

    for (let rIdx = 0; rIdx < game.rounds.length; rIdx++) {
      for (let pIdx = 0; pIdx < game.players.length; pIdx++) {
        const playerId = game.players[pIdx]?.id;
        if (!playerId) continue;
        const value = game.rounds[rIdx]?.scores?.[playerId];
        if (value == null) {
          focusCell(rIdx, pIdx);
          return;
        }
      }
    }

    focusCell(game.rounds.length - 1, game.players.length - 1);
  }

  function goToNextMobileRound() {
    if (!current?.rounds?.length) return;

    if (!displayRoundComplete) {
      const nextMissingIndex = current.players.findIndex(
        (player) => displayRound?.scores?.[player.id] == null
      );
      if (nextMissingIndex >= 0) focusCell(displayRoundIndex, nextMissingIndex);
      return;
    }

    const nextRoundIndex = Math.min(displayRoundIndex + 1, current.rounds.length - 1);
    setMobileRoundIndex(nextRoundIndex);
    setTimeout(() => focusCell(nextRoundIndex, 0), 0);
  }

  function toggleFutureRoundExpanded(rIdx) {
    setExpandedFutureRounds((prev) => ({
      ...prev,
      [rIdx]: !prev[rIdx],
    }));
  }

  function onScoreKeyDown(e, rIdx, pIdx, to = "draft") {
    if (e.key === "Enter") {
      e.preventDefault();
      const game = to === "edit" ? editGame : draft;
      const lastCol = (game.players?.length ?? 1) - 1;
      const lastRow = (game.rounds?.length ?? 1) - 1;
      let nextR = rIdx;
      let nextC = pIdx + 1;
      if (pIdx >= lastCol) {
        nextC = 0;
        nextR = Math.min(lastRow, rIdx + 1);
      }
      focusCell(nextR, nextC);
    }
  }

  function validateForStart(game) {
    if (!game.players || game.players.length < 2) return "Add at least 2 players.";
    const cleaned = ensureUniqueNames(game.players);
    if (cleaned.some((p) => !(p.name || "").trim())) return "Player names can’t be blank.";
    return "";
  }

  function startGame() {
    const err = validateForStart(draft);
    if (err) {
      alert(err);
      return;
    }

    const cleanedPlayers = ensureUniqueNames(draft.players);
    const synced = syncPlayerProfilesWithPlayers(playerProfiles, cleanedPlayers);

    setPlayerProfiles(synced.profiles);
    setDraft((prev) => ({ ...prev, players: synced.players }));
    setMobileRoundIndex(0);
    setTab("score");
    setTimeout(() => focusCell(0, 0), 0);
  }

  function createFreshDraft() {
    return createFreshGameDraft();
  }

  function resetDraft() {
    if (!confirm("Reset current game?")) return;
    const fresh = createFreshDraft();
    setDraft(fresh);
    setUndoStack([]);
    localStorage.setItem(LS_DRAFT, JSON.stringify(fresh));
    setTab("new");
  }

  function finishAndSave() {
    const err = validateForStart(draft);
    if (err) {
      alert(err);
      return;
    }

    const normalizedPlayers = ensureUniqueNames(draft.players);
    const synced = syncPlayerProfilesWithPlayers(playerProfiles, normalizedPlayers);
    const normalizedDraft = { ...draft, players: synced.players };
    const t = computeTotals(synced.players, normalizedDraft.rounds);
    const w = winnerIds(synced.players, t);
    const saved = {
      ...normalizedDraft,
      createdAt: normalizedDraft.createdAt || new Date().toISOString(),
      savedAt: new Date().toISOString(),
      totals: t,
      winnerIds: w,
    };

    setPlayerProfiles(synced.profiles);
    setHistory((prev) => [saved, ...prev]);
    const fresh = createFreshDraft();
    setDraft(fresh);
    setUndoStack([]);
    localStorage.setItem(LS_DRAFT, JSON.stringify(fresh));
    setLastSavedGame(saved);
    setShowFeedbackPrompt(false);
    setTab("history");
  }

  function openForEdit(gameId) {
    const g = history.find((x) => x.id === gameId);
    if (!g) return;
    setEditGameId(gameId);
    setEditGame(JSON.parse(JSON.stringify(g)));
    setUndoStack([]);
    setMobileRoundIndex(0);
    setTab("edit");
    setTimeout(() => focusCell(0, 0), 0);
  }

  function saveEdits() {
    if (!editGame) return;
    const normalizedPlayers = ensureUniqueNames(editGame.players || []);
    const synced = syncPlayerProfilesWithPlayers(playerProfiles, normalizedPlayers);
    const updated = { ...editGame, players: synced.players };
    const t = computeTotals(updated.players, updated.rounds);
    const w = winnerIds(updated.players, t);
    const finalGame = { ...updated, totals: t, winnerIds: w, editedAt: new Date().toISOString() };
    setPlayerProfiles(synced.profiles);
    setHistory((prev) => prev.map((g) => (g.id === editGameId ? finalGame : g)));
    setTab("history");
    setEditGameId("");
    setEditGame(null);
    setUndoStack([]);
  }

  function deleteGame(gameId) {
    if (!confirm("Delete this saved game? This cannot be undone.")) return;
    setHistory((prev) => prev.filter((g) => g.id !== gameId));
    if (editGameId === gameId) {
      setEditGameId("");
      setEditGame(null);
      setTab("history");
    }
  }

  function exportBackup() {
    const backup = {
      version: 2,
      exportedAt: new Date().toISOString(),
      draft,
      history,
      playerProfiles,
    };

    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `scorekeeper-backup-${stamp}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function importBackupFromFile(file) {
    if (!file) return;
    const reader = new FileReader();

    reader.onload = () => {
      try {
        const parsed = safeParse(String(reader.result || ""), null);
        if (!parsed || typeof parsed !== "object") {
          alert("That file does not look like a valid backup.");
          return;
        }

        const nextHistory = Array.isArray(parsed.history) ? parsed.history : null;
        const nextDraft = parsed.draft && typeof parsed.draft === "object" ? parsed.draft : null;
        const nextProfiles = Array.isArray(parsed.playerProfiles) ? parsed.playerProfiles : [];

        if (!nextHistory || !nextDraft || !nextDraft.players || !nextDraft.rounds || !nextDraft.roundLabels) {
          alert("That backup file is missing required game data.");
          return;
        }

        if (!confirm("Import this backup and replace the current saved games and current draft on this device?")) {
          return;
        }

        setHistory(nextHistory);
        setDraft(nextDraft);
        setPlayerProfiles(nextProfiles);
        setTab("history");
        setUndoStack([]);
        localStorage.setItem(LS_HISTORY, JSON.stringify(nextHistory));
        localStorage.setItem(LS_DRAFT, JSON.stringify(nextDraft));
        localStorage.setItem(LS_PLAYER_PROFILES, JSON.stringify(nextProfiles));
        alert("Backup imported.");
      } catch {
        alert("Could not read that backup file.");
      }
    };

    reader.readAsText(file);
  }

  const filteredHistory = useMemo(() => {
    const q = search.trim().toLowerCase();
    const tf = tagFilter.trim();
    return history.filter((g) => {
      if (tf && !(g.tags || []).includes(tf)) return false;
      if (!q) return true;
      const blob = [
        g.name,
        g.location,
        g.notes,
        ...(g.tags || []),
        ...(g.players || []).map((p) => p.name),
      ]
        .filter(Boolean)
        .join(" | ")
        .toLowerCase();
      return blob.includes(q);
    });
  }, [history, search, tagFilter]);

  const playerStats = useMemo(() => {
    return buildPlayerStats(history);
  }, [history]);

  const lastSavedSummary = useMemo(() => {
    if (!lastSavedGame) return null;
    const gameTotals = lastSavedGame.totals || computeTotals(lastSavedGame.players || [], lastSavedGame.rounds || []);
    const gameRoundsWon = computeRoundsWon(lastSavedGame.players || [], lastSavedGame.rounds || []);
    const gameStandings = buildStandings(lastSavedGame.players || [], gameTotals, gameRoundsWon);
    return {
      name: (lastSavedGame.name || "").trim() || "Game",
      standings: gameStandings,
      winnerNames: gameStandings
        .filter((player) => player.rank === 1)
        .map((player) => player.name)
        .join(", "),
      players: lastSavedGame.players?.length || 0,
      savedAt: lastSavedGame.savedAt || lastSavedGame.createdAt,
    };
  }, [lastSavedGame]);

  const filteredProfiles = useMemo(() => {
    const q = profileSearch.trim().toLowerCase();
    if (!q) return playerProfiles;
    return playerProfiles.filter((profile) => (profile.name || "").toLowerCase().includes(q));
  }, [playerProfiles, profileSearch]);

  const recentPlayerProfiles = useMemo(() => {
    return [...playerProfiles].slice(0, 12);
  }, [playerProfiles]);

  const roundsWon = useMemo(() => {
    if (!current) return {};
    return computeRoundsWon(current.players || [], current.rounds || []);
  }, [current]);

  const standings = useMemo(() => {
    if (!current) return [];
    return buildStandings(current.players || [], totals, roundsWon);
  }, [current, totals, roundsWon]);

  const bestRound = useMemo(() => {
    if (!current) return null;
    return computeBestRound(current.players || [], current.rounds || []);
  }, [current]);

  const worstRound = useMemo(() => {
    if (!current) return null;
    return computeWorstRound(current.players || [], current.rounds || []);
  }, [current]);

  const scoreHelperTotal = useMemo(() => {
    return computeScoreHelperTotal(scoreHelper?.counts || createScoreHelperCounts());
  }, [scoreHelper]);

  const winners = useMemo(() => {
    if (!current) return [];
    return winnerIds(current.players || [], totals);
  }, [current, totals]);

  const activeRoundMeta = useMemo(() => {
    if (!current?.roundLabels?.length) return null;
    const label = current.roundLabels[displayRoundIndex];
    return {
      label,
      ...getRoundMeta(label, displayRoundIndex),
      dealer: getDealerName(current.players || [], displayRoundIndex),
    };
  }, [current, displayRoundIndex]);

  const hasDraftInProgress = useMemo(() => {
    const hasScores = (draft.rounds || []).some((r) =>
      Object.values(r.scores || {}).some((v) => typeof v === "number")
    );

    const hasCustomMeta = Boolean(
      (draft.name || "").trim() ||
      (draft.location || "").trim() ||
      (draft.notes || "").trim() ||
      (draft.tags || []).length
    );

    const hasExtraPlayers = (draft.players || []).length > 2;
    const hasRenamedPlayers = (draft.players || []).some((p, idx) => (p.name || "").trim() !== `Player ${idx + 1}`);

    return hasScores || hasCustomMeta || hasExtraPlayers || hasRenamedPlayers;
  }, [draft]);

  useEffect(() => {
    if (tab !== "score") return;
    const rowEl = rowRefs.current.get(currentRoundIndex);
    if (!rowEl) return;
    rowEl.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
  }, [currentRoundIndex, tab]);

  useEffect(() => {
    if (!scoreHelper) return;
    helperPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [scoreHelper]);

  return (
    <>
      <style>{styles}</style>
      <div className="container">
        <div className="header">
          <div>
            <div className="brandRow">
              <div className="appIcon">5</div>
              <div>
                <h1 className="h1">Scorekeeper</h1>
                <div className="sub">Five Crowns scoring for game night</div>
              </div>
            </div>
          </div>
          <div className="statusPill">
            {tab === "new" || tab === "score" ? saveStatus : `${history.length} saved game${history.length === 1 ? "" : "s"}`}
          </div>
          <div className="tabs">
            <button className={`tab ${tab === "new" ? "active" : ""}`} onClick={() => setTab("new")}>New Game</button>
            <button
              className={`tab ${tab === "score" ? "active" : ""}`}
              onClick={() => {
                setMobileRoundIndex(currentRoundIndex);
                setTab("score");
              }}
            >
              Scoring
            </button>
            <button className={`tab ${tab === "history" ? "active" : ""}`} onClick={() => setTab("history")}>History <span className="badge">{history.length}</span></button>
          </div>
        </div>

        {(tab === "new" || tab === "score") && (
          <div className="row" style={{ marginBottom: 10 }}>
            <button className="btn" onClick={undo} disabled={!undoStack.length}>⟲ Undo Last Change</button>
            <button className="btn" onClick={() => focusNextIncompleteCell("draft")}>Next Empty Cell</button>
            <button className="btn" onClick={resetDraft}>Reset</button>
          </div>
        )}

        {tab === "new" && (
          <div className="grid">
            <div className="panel">
              <div className="heroCard">
                <div className="heroHeader">
                  <div className="heroLogoBadge">5</div>
                  <div className="heroTitle">Five Crowns Scorekeeper</div>
                </div>
                <div className="heroSub">Track rounds, dealer, wild card, cards dealt, history, and winners without using paper.</div>
                <div className="heroChips">
                  <div className="heroChip">Autosaves</div>
                  <div className="heroChip">Dealer rotation</div>
                  <div className="heroChip">Round helper</div>
                  <div className="heroChip">Late join support</div>
                </div>
              </div>
              <div className="setupPrimary">
                {hasDraftInProgress ? (
                  <div>
                    <div className="small" style={{ marginBottom: 8 }}>
                      You already have a game in progress on this device.
                    </div>
                    <button
                      className="btn"
                      onClick={() => {
                        setMobileRoundIndex(currentRoundIndex);
                        setTab("score");
                      }}
                    >
                      Resume Current Game
                    </button>
                  </div>
                ) : null}
                <button className="btn primary" onClick={startGame}>Start Scoring →</button>
                <div className="noticeCard">Saved locally in this browser. Export a backup anytime.</div>

                <details className="setupDetails">
                  <summary>Game details</summary>
                  <div className="setupDetailsBody">
                    <div className="label">Game name (optional)</div>
                    <input className="input" value={draft.name} onChange={(e) => setDraftField("name", e.target.value)} placeholder="e.g., Friday Night 5 Crowns" />
                    <div style={{ height: 10 }} />
                    <div className="label">Location (optional)</div>
                    <input className="input" value={draft.location} onChange={(e) => setDraftField("location", e.target.value)} placeholder="e.g., Home, Cabin, Mike’s place" />
                    <div style={{ height: 10 }} />
                    <div className="label">Notes (optional)</div>
                    <textarea className="textarea" value={draft.notes} onChange={(e) => setDraftField("notes", e.target.value)} placeholder="Anything you want to remember about this game…" />
                    <div className="hr" />
                    <div className="label">Tags</div>
                    <div className="chips" style={{ marginBottom: 10 }}>
                      {DEFAULT_TAGS.map((t) => (
                        <div key={t} className={`chip ${(draft.tags || []).includes(t) ? "on" : ""}`} onClick={() => toggleTag(t, "draft")} title="Click to toggle">{t}</div>
                      ))}
                    </div>
                    <TagAdder onAdd={(t) => addCustomTag(t, "draft")} />
                  </div>
                </details>

                <a
                  className="btn"
                  href="mailto:lyonss31095@yahoo.com?subject=Five%20Crowns%20Scorekeeper%20Feedback"
                >
                  Send Feedback
                </a>
              </div>
            </div>

            <div className="panel">
              <div className="row" style={{ justifyContent: "space-between" }}>
                <div>
                  <div style={{ fontWeight: 800 }}>Players</div>
                  <div className="small">Add players, rename them, remove as needed.</div>
                </div>
                <button className="btn" onClick={() => addPlayer("draft")}>+ Add player</button>
              </div>
              <div style={{ height: 10 }} />
              <div className="historyList">
                {draft.players.map((p, idx) => (
                  <div key={p.id} className="row">
                    <input className="input" value={p.name} onChange={(e) => setPlayerName(p.id, e.target.value, "draft")} placeholder={`Player ${idx + 1}`} />
                    <button className="btn" disabled={draft.players.length <= 2} onClick={() => removePlayer(p.id, "draft")}>Remove</button>
                  </div>
                ))}
              </div>
              <div className="hr" />
              <div className="label">Saved Players</div>
              {!recentPlayerProfiles.length ? (
                <div className="small" style={{ marginBottom: 10 }}>Saved players will appear here after you finish and save games.</div>
              ) : (
                <div className="chips" style={{ marginBottom: 10 }}>
                  {recentPlayerProfiles.map((profile) => {
                    const alreadyInGame = (draft.players || []).some((player) => player.profileId === profile.id);
                    return (
                      <button
                        key={profile.id}
                        type="button"
                        className={`chip ${alreadyInGame ? "on" : ""}`}
                        onClick={() => addSavedPlayerToDraft(profile.id)}
                        disabled={alreadyInGame}
                        title={alreadyInGame ? "Already added" : "Add saved player"}
                        style={{ opacity: alreadyInGame ? 0.65 : 1 }}
                      >
                        {profile.name}
                      </button>
                    );
                  })}
                </div>
              )}
              <div className="small" style={{ marginBottom: 10 }}>Tip: tap a saved player to reuse the same profile so long-term stats stay cleaner.</div>
              <div className="small">Rounds: <b>11</b> (3 → 13). Winner: <b>lowest total</b>. Mark ⭐ for who went out first each round (drives “Rounds Won”).</div>
              <div className="small" style={{ marginTop: 8 }}>Tip: Add players in seating/dealer order. The first player deals first, then dealer rotates across the row.</div>
            </div>
          </div>
        )}

        {(tab === "score" || tab === "edit") && current && (
          <div className="panel">
            <div className="row scoreHeader" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
              <div>
                <div style={{ fontWeight: 900, fontSize: 16 }}>
                  {(current.name || "").trim() ? current.name : "Game"}
                  <span className="badge">{tab === "edit" ? "Editing saved game" : "In progress"}</span>
                </div>
                <div className="small">
                  {current.location ? `📍 ${current.location} • ` : ""}
                  {tab === "edit" ? `Saved: ${formatDate(current.savedAt || current.createdAt)}` : `Created: ${formatDate(current.createdAt)}`}
                </div>
              </div>

              <div className="scoreActions">
                <div className="viewToggle" aria-label="Scoring view">
                  <button type="button" className={`viewToggleBtn ${activeScoreView === "mobile" ? "active" : ""}`} onClick={() => setScoreView("mobile")}>Mobile View</button>
                  <button type="button" className={`viewToggleBtn ${activeScoreView === "table" ? "active" : ""}`} onClick={() => setScoreView("table")}>Table View</button>
                </div>
                <button className="btn mobileSecondaryAction" onClick={() => focusNextIncompleteCell(context)}>Next Empty Cell</button>
                {tab === "score" && (
                  <>
                    <button className="btn mobileSecondaryAction" onClick={addLatePlayer}>+ Add Player</button>
                    <button className="btn primary" onClick={finishAndSave}>Finish & Save</button>
                  </>
                )}
                {tab === "edit" && (
                  <>
                    <button className="btn" onClick={() => setTab("history")}>Cancel</button>
                    <button className="btn primary" onClick={saveEdits}>Save changes</button>
                  </>
                )}
              </div>
            </div>

            <div className="hr" />
            {scoreEntrySheet ? (
              <div className="sheetOverlay" onClick={closeScoreEntrySheet}>
                <div className="sheetPanel" onClick={(e) => e.stopPropagation()} ref={helperPanelRef}>
                  <div className="sheetHandle" />
                  <div className="helperHeader">
                    <div>
                      <div style={{ fontWeight: 900 }}>Score Entry</div>
                      <div className="small">
                        {scoreEntrySheet.playerName} • Round {scoreEntrySheet.rowLabel || scoreEntrySheet.rIdx + 1} • Wild: {getRoundMeta(scoreEntrySheet.rowLabel, scoreEntrySheet.rIdx).wild}
                      </div>
                    </div>
                    <button className="btn" onClick={closeScoreEntrySheet}>Close</button>
                  </div>

                  <div className="grid" style={{ gap: 8 }}>
                    <button className="quickActionBtn" onClick={chooseManualScoreEntry}>
                      <div className="quickActionTitle">Type score manually</div>
                      <div className="quickActionSub">Use the normal number input for this cell.</div>
                    </button>

                    <button className="quickActionBtn" onClick={applyWentOutZeroFromSheet}>
                      <div className="quickActionTitle">Went out = 0</div>
                      <div className="quickActionSub">Set this score to 0 and mark this player as went out first.</div>
                    </button>

                    {!scoreHelper ? (
                      <button className="quickActionBtn" onClick={openScoreHelper}>
                        <div className="quickActionTitle">Use score helper</div>
                        <div className="quickActionSub">Add leftover cards and let the app calculate the total.</div>
                      </button>
                    ) : null}
                  </div>

                  {scoreHelper ? (
                    <div className="helperPanel">
                      <div className="helperHeader">
                        <div>
                          <div style={{ fontWeight: 900 }}>Leftover Cards</div>
                          <div className="small">Joker = 50 • Wild = 20 • J = 11 • Q = 12 • K = 13</div>
                        </div>
                        <button className="btn" onClick={closeScoreHelper}>Hide helper</button>
                      </div>

                      <div className="helperGrid" style={{ marginBottom: 12 }}>
                        {["joker", "wild", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"].map((key) => (
                          <div key={key} className="helperCard">
                            <div className="helperCardTitle">
                              {key === "joker" ? "Joker" : key === "wild" ? `Wild (${getRoundMeta(scoreEntrySheet.rowLabel, scoreEntrySheet.rIdx).wild})` : key}
                            </div>
                            <div className="helperStepper">
                              <button type="button" className="helperMiniBtn" onClick={() => updateScoreHelperCount(key, -1)}>−</button>
                              <div className="helperCount">{scoreHelper.counts?.[key] || 0}</div>
                              <button type="button" className="helperMiniBtn" onClick={() => updateScoreHelperCount(key, 1)}>+</button>
                            </div>
                          </div>
                        ))}
                      </div>

                      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
                        <div style={{ fontWeight: 900 }}>Calculated total: {scoreHelperTotal}</div>
                        <div className="row" style={{ flexWrap: "wrap" }}>
                          <button className="btn" onClick={resetScoreHelper}>Reset</button>
                          <button className="btn primary" onClick={() => applyScoreHelperTotal(false)}>Use Total</button>
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}

            <div className="summaryCard scoreSummary" style={{ marginBottom: 12 }}>
              <div className="summaryTitle">Game Summary</div>
              <div className="summaryWinner">
                Winner: <b>{standings[0]?.name || "—"}</b>
                {standings.length > 1 ? ` • ${standings[0]?.total ?? 0} total points` : ""}
              </div>

              <div className="summaryGrid" style={{ marginBottom: 12 }}>
                <div className="summaryStat">
                  <div className="summaryStatLabel">Best round</div>
                  <div className="summaryStatValue">
                    {bestRound
                      ? `${current.players.find((p) => p.id === bestRound.playerId)?.name || "—"} • R ${current.roundLabels?.[bestRound.roundIndex] || bestRound.roundIndex + 1} • ${bestRound.score}`
                      : "—"}
                  </div>
                </div>
                <div className="summaryStat">
                  <div className="summaryStatLabel">Highest round</div>
                  <div className="summaryStatValue">
                    {worstRound
                      ? `${current.players.find((p) => p.id === worstRound.playerId)?.name || "—"} • R ${current.roundLabels?.[worstRound.roundIndex] || worstRound.roundIndex + 1} • ${worstRound.score}`
                      : "—"}
                  </div>
                </div>
                <div className="summaryStat">
                  <div className="summaryStatLabel">Most rounds won</div>
                  <div className="summaryStatValue">
                    {standings.length
                      ? `${[...standings].sort((a, b) => (b.roundsWon - a.roundsWon) || a.name.localeCompare(b.name))[0]?.name || "—"} • ${[...standings].sort((a, b) => (b.roundsWon - a.roundsWon) || a.name.localeCompare(b.name))[0]?.roundsWon ?? 0}`
                      : "—"}
                  </div>
                </div>
              </div>

              <div className="label">Standings</div>
              <div className="standingsList">
                {standings.map((player) => (
                  <div key={player.id} className="standingRow">
                    <div className="standingLeft">
                      <div className="rankBadge">#{player.rank}</div>
                      <div>
                        <div className="standingName">{player.name}</div>
                        <div className="standingMeta">Rounds won: {player.roundsWon}</div>
                      </div>
                    </div>
                    <div style={{ fontWeight: 900 }}>{player.total}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="mobileLeaderStrip">
              <div>
                <div className="small">Leader</div>
                <div style={{ fontWeight: 900 }}>{standings[0]?.name || "—"}</div>
              </div>
              <div style={{ fontWeight: 900 }}>{standings[0]?.total ?? 0}</div>
            </div>

            <div className="mobileStandingsPanel">
              <button
                type="button"
                className="btn mobileStandingsToggle"
                onClick={() => setShowMobileStandings((prev) => !prev)}
              >
                {showMobileStandings ? "Hide Standings" : "Show Standings"}
              </button>
              {showMobileStandings ? (
                <div className="mobileStandingsList">
                  {standings.map((player) => (
                    <div key={player.id} className="mobileStandingRow">
                      <div>
                        <div className="mobileStandingName">#{player.rank} {player.name}</div>
                        <div className="mobileStandingMeta">Rounds won: {player.roundsWon}</div>
                      </div>
                      <div style={{ fontWeight: 900 }}>{player.total}</div>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="activeToolbar">
              <div>
                <div style={{ fontWeight: 900 }}>Current Round: {activeRoundMeta?.label || "—"}</div>
                <div className="small">Leader: <b>{winners.length ? current.players.filter((p) => winners.includes(p.id)).map((p) => p.name).join(", ") : "—"}</b></div>
              </div>
              <div className="activeToolbarMeta">
                <div className="dealerPill">Dealer: {activeRoundMeta?.dealer || "—"}</div>
                <div className="dealerPill">Wild: {activeRoundMeta?.wild || "—"}</div>
                <div className="dealerPill">Cards: {activeRoundMeta?.cardsDealt ?? "—"}</div>
              </div>
            </div>
            <div className="row mobileHelpText" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
              <div className="small">Past rounds stay open. Future rounds after the next one collapse until you expand them.</div>
              <div className="small">Enter moves right → end of row goes down. Use Next Empty Cell to jump back to the next missing score. ⭐ marks “went out first.” Add opens quick scoring options and the score helper. Tap a player name above to rename it inline.</div>
            </div>
            <div style={{ height: 10 }} />

            <div className={`mobileRoundWrap ${activeScoreView === "mobile" ? "show" : ""}`}>
              <div className="mobileRoundHeader">
                <div style={{ fontWeight: 900 }}>Round {activeRoundMeta?.label || "—"}</div>
                <div className="small">Dealer: {activeRoundMeta?.dealer || "—"} • Wild: {activeRoundMeta?.wild || "—"} • Cards: {activeRoundMeta?.cardsDealt ?? "—"}</div>
              </div>
              <div className="mobilePlayerList">
                {current.players.map((p, pIdx) => {
                  const val = current.rounds?.[displayRoundIndex]?.scores?.[p.id];
                  const wentOut = (current.rounds?.[displayRoundIndex]?.wentOutId || "") === p.id;

                  return (
                    <div className="mobilePlayerCard" key={p.id}>
                      <div className="mobilePlayerTop">
                        <div>
                          {renamingPlayerId === p.id ? (
                            <input
                              className="input"
                              value={renamingValue}
                              autoFocus
                              onChange={(e) => setRenamingValue(e.target.value)}
                              onBlur={() => commitRenamingPlayer(p.id)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  e.preventDefault();
                                  commitRenamingPlayer(p.id);
                                }
                                if (e.key === "Escape") {
                                  e.preventDefault();
                                  cancelRenamingPlayer();
                                }
                              }}
                              aria-label={`Rename ${p.name}`}
                            />
                          ) : (
                            <button type="button" className="mobilePlayerName" onClick={() => startRenamingPlayer(p.id)} title="Rename player">
                              {p.name}
                            </button>
                          )}
                        </div>
                        <div className="mobilePlayerMeta">
                          <span className={`badge ${winners.includes(p.id) ? "winnerCell" : ""}`}>Total {totals[p.id] ?? 0}</span>
                          <span className="badge">Won {roundsWon[p.id] ?? 0}</span>
                        </div>
                      </div>
                      <div className="mobileScoreRow">
                        <input
                          className="scoreInput"
                          inputMode="numeric"
                          placeholder="Score"
                          value={typeof val === "number" ? String(val) : ""}
                          ref={(el) => {
                            if (el) inputRefs.current.set(`${displayRoundIndex}_${pIdx}`, el);
                            else inputRefs.current.delete(`${displayRoundIndex}_${pIdx}`);
                          }}
                          onKeyDown={(e) => onScoreKeyDown(e, displayRoundIndex, pIdx, context)}
                          onChange={(e) => onScoreChange(displayRoundIndex, pIdx, e.target.value, context)}
                          onFocus={(e) => e.target.select?.()}
                          aria-label={`Score for ${p.name} in round ${activeRoundMeta?.label || displayRoundIndex + 1}`}
                        />
                        <button className={`starBtn ${wentOut ? "on" : ""}`} onClick={() => toggleWentOut(displayRoundIndex, pIdx, context)} title={wentOut ? "Unmark went out first" : "Mark went out first"}>⭐</button>
                        <button className="addBtn" onClick={() => openScoreEntrySheet(displayRoundIndex, pIdx)} title="Open score helper">Helper</button>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="mobileRoundFooter">
                <button className="btn primary mobileNextRoundBtn" onClick={goToNextMobileRound}>
                  {displayRoundComplete ? "Next Round" : "Next Missing Score"}
                </button>
                <div className="mobileRoundStatus">
                  {displayRoundComplete
                    ? displayRoundIndex >= (current.rounds?.length || 1) - 1
                      ? "Final round complete"
                      : `Ready for round ${current.roundLabels?.[displayRoundIndex + 1] || displayRoundIndex + 2}`
                    : `${missingScoresInDisplayRound} score${missingScoresInDisplayRound === 1 ? "" : "s"} left`}
                </div>
              </div>
            </div>

            <div className={`tableWrap ${activeScoreView === "mobile" ? "mobileHidden" : ""}`}>
              <table className="table">
                <thead>
                  <tr>
                    <th className="th round">Round</th>
                    {current.players.map((p) => (
                      <th className="th" key={p.id}>
                        {renamingPlayerId === p.id ? (
                          <div className="row" style={{ alignItems: "center", gap: 6 }}>
                            <input
                              className="input"
                              value={renamingValue}
                              autoFocus
                              onChange={(e) => setRenamingValue(e.target.value)}
                              onBlur={() => commitRenamingPlayer(p.id)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  e.preventDefault();
                                  commitRenamingPlayer(p.id);
                                }
                                if (e.key === "Escape") {
                                  e.preventDefault();
                                  cancelRenamingPlayer();
                                }
                              }}
                              style={{ minWidth: 110, padding: "8px 10px" }}
                              aria-label={`Rename ${p.name}`}
                            />
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => startRenamingPlayer(p.id)}
                            style={{ background: "transparent", border: "none", padding: 0, margin: 0, font: "inherit", color: "inherit", cursor: "pointer", textAlign: "left", fontWeight: 700 }}
                            title="Rename player"
                          >
                            {p.name}
                          </button>
                        )}
                        {winners.includes(p.id) ? <span className="badge">leader</span> : null}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {current.roundLabels.map((label, rIdx) => {
                    const isPastOrCurrentOrNext = rIdx <= currentRoundIndex + 1;
                    const isCollapsedFuture = !isPastOrCurrentOrNext && !expandedFutureRounds[rIdx];
                    const rowMeta = getRoundMeta(label, rIdx);

                    if (isCollapsedFuture) {
                      return (
                        <tr key={label} className="collapsedRoundRow">
                          <td
                            className="td round"
                            style={{ background: "rgba(109, 40, 217, 0.04)" }}
                            colSpan={current.players.length + 1}
                          >
                            <button className="collapsedRoundButton" onClick={() => toggleFutureRoundExpanded(rIdx)}>
                              Future Round: {label} • Dealer: {getDealerName(current.players, rIdx)} • Wild: {rowMeta.wild} • Cards: {rowMeta.cardsDealt} • Tap to expand
                            </button>
                          </td>
                        </tr>
                      );
                    }

                    return (
                    <tr
                      key={label}
                      className={rIdx === currentRoundIndex ? "trCurrent" : ""}
                      ref={(el) => {
                        if (el) rowRefs.current.set(rIdx, el);
                        else rowRefs.current.delete(rIdx);
                      }}
                      style={{ background: rIdx === currentRoundIndex ? "rgba(109, 40, 217, 0.10)" : rIdx % 2 === 1 ? "var(--rowAlt)" : "transparent" }}
                    >
                      <td
                        className="td round"
                        style={{
                          background: rIdx === currentRoundIndex ? "rgba(109, 40, 217, 0.10)" : rIdx % 2 === 1 ? "var(--rowAlt)" : "var(--panel)",
                          borderLeft: rIdx === currentRoundIndex ? "5px solid var(--primary)" : "4px solid transparent",
                        }}
                      >
                        <div>{"R " + label}</div>
                        <div className="dealerPill">Dealer: {getDealerName(current.players, rIdx)}</div>
                        <div className="small" style={{ marginTop: 6 }}>Wild: {rowMeta.wild} • Cards: {rowMeta.cardsDealt}</div>
                        {rIdx === currentRoundIndex ? <div className="currentPill">Current</div> : null}
                        {rIdx === currentRoundIndex + 1 ? <div className="currentPill" style={{ marginLeft: 6 }}>Next</div> : null}
                        {!isPastOrCurrentOrNext ? (
                          <div style={{ marginTop: 8 }}>
                            <button className="btn" onClick={() => toggleFutureRoundExpanded(rIdx)}>Collapse</button>
                          </div>
                        ) : null}
                      </td>
                      {current.players.map((p, pIdx) => {
                        const val = current.rounds?.[rIdx]?.scores?.[p.id];
                        const wentOut = (current.rounds?.[rIdx]?.wentOutId || "") === p.id;
                        return (
                          <td className="td" key={p.id}>
                            <div className="cell">
                              <input
                                className="scoreInput"
                                inputMode="numeric"
                                placeholder="0"
                                value={typeof val === "number" ? String(val) : ""}
                                ref={(el) => {
                                  if (!el) {
                                    inputRefs.current.delete(`${rIdx}_${pIdx}`);
                                    return;
                                  }
                                  if (activeScoreView === "mobile" && rIdx === displayRoundIndex) return;
                                  inputRefs.current.set(`${rIdx}_${pIdx}`, el);
                                }}
                                onKeyDown={(e) => onScoreKeyDown(e, rIdx, pIdx, context)}
                                onChange={(e) => onScoreChange(rIdx, pIdx, e.target.value, context)}
                                onFocus={(e) => e.target.select?.()}
                              />
                              <button className={`starBtn ${wentOut ? "on" : ""}`} onClick={() => toggleWentOut(rIdx, pIdx, context)} title={wentOut ? "Unmark went out first" : "Mark went out first"}>⭐</button>
                              <button className="addBtn" onClick={() => openScoreEntrySheet(rIdx, pIdx)} title="Open score helper">Add</button>
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="totalRow">
                    <th className="th round">Total</th>
                    {current.players.map((p) => (
                      <td className="td" key={p.id}><span className={winners.includes(p.id) ? "winnerCell" : ""}>{totals[p.id] ?? 0}</span></td>
                    ))}
                  </tr>
                  <tr className="totalRow">
                    <th className="th round">Rounds Won</th>
                    {current.players.map((p) => (
                      <td className="td" key={p.id}>{roundsWon[p.id] ?? 0}</td>
                    ))}
                  </tr>
                </tfoot>
              </table>
            </div>

            <div className="hr" />
            <div className="grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
              <div>
                <div className="label">Notes</div>
                <textarea className="textarea" value={current.notes || ""} onChange={(e) => (tab === "edit" ? setEditField("notes", e.target.value) : setDraftField("notes", e.target.value))} placeholder="Optional" />
              </div>
              <div>
                <div className="label">Location</div>
                <input className="input" value={current.location || ""} onChange={(e) => (tab === "edit" ? setEditField("location", e.target.value) : setDraftField("location", e.target.value))} placeholder="Optional" />
                <div style={{ height: 10 }} />
                <div className="label">Tags</div>
                <div className="chips" style={{ marginBottom: 10 }}>
                  {DEFAULT_TAGS.map((t) => (
                    <div key={t} className={`chip ${(current.tags || []).includes(t) ? "on" : ""}`} onClick={() => toggleTag(t, tab === "edit" ? "edit" : "draft")}>{t}</div>
                  ))}
                  {(current.tags || []).filter((t) => !DEFAULT_TAGS.includes(t)).map((t) => (
                    <div key={t} className="chip on" onClick={() => toggleTag(t, tab === "edit" ? "edit" : "draft")} title="Click to remove">{t} ✕</div>
                  ))}
                </div>
                <TagAdder onAdd={(t) => addCustomTag(t, tab === "edit" ? "edit" : "draft")} />
              </div>
            </div>
          </div>
        )}

        {tab === "history" && (
          <>
            {lastSavedSummary ? (
              <div className="gameCompleteCard">
                <div className="completeEyebrow">Game saved</div>
                <div className="completeTitle">{lastSavedSummary.name} complete</div>
                <div className="completeWinner">
                  Winner: <b>{lastSavedSummary.winnerNames || "—"}</b>
                  {lastSavedSummary.standings[0] ? ` • ${lastSavedSummary.standings[0].total} points` : ""}
                </div>
                <div className="completeGrid">
                  <div className="completeStat">
                    <div className="completeStatLabel">Players</div>
                    <div className="completeStatValue">{lastSavedSummary.players}</div>
                  </div>
                  <div className="completeStat">
                    <div className="completeStatLabel">Saved</div>
                    <div className="completeStatValue">{formatDate(lastSavedSummary.savedAt)}</div>
                  </div>
                </div>
                <div className="noticeCard" style={{ marginBottom: 12 }}>
                  Before removing the Home Screen app, clearing Safari data, or switching phones, export a backup.
                </div>
                <div className="row" style={{ flexWrap: "wrap" }}>
                  <button
                    className="btn primary"
                    onClick={() => {
                      setLastSavedGame(null);
                      setTab("new");
                    }}
                  >
                    New Game
                  </button>
                  <button className="btn" onClick={exportBackup}>Export Backup</button>
                  <button className="btn" onClick={() => setLastSavedGame(null)}>View History</button>
                  <a className="btn" href="mailto:lyonss31095@yahoo.com?subject=Five%20Crowns%20Scorekeeper%20Feedback">Send Feedback</a>
                </div>
              </div>
            ) : null}
            {showFeedbackPrompt ? (
              <div className="feedbackPrompt">
                <div>Thanks for saving a game. Feedback helps make the iPhone scoring flow better.</div>
                <div className="row" style={{ flexWrap: "wrap" }}>
                  <a className="btn" href="mailto:lyonss31095@yahoo.com?subject=Five%20Crowns%20Scorekeeper%20Feedback">Send Feedback</a>
                  <button className="btn" onClick={() => setShowFeedbackPrompt(false)}>Dismiss</button>
                </div>
              </div>
            ) : null}
            <div className="backupCard">
              <div className="backupTitle">Protect your scores</div>
              <div className="backupText">
                Saved games live on this browser/device. Export a backup before removing the Home Screen app, clearing Safari data, or changing phones.
              </div>
              <div className="backupActions">
                <button className="btn primary" onClick={exportBackup}>Export Backup</button>
                <button className="btn" onClick={() => importFileRef.current?.click()}>Import Backup</button>
              </div>
            </div>
          <div className="grid">
            <div className="panel">
              <div className="label">Search</div>
              <input className="input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, players, notes, location, tags…" />
              <div style={{ height: 10 }} />
              <div className="label">Filter by tag</div>
              <div className="chips">
                <div className={`chip ${tagFilter === "" ? "on" : ""}`} onClick={() => setTagFilter("")}>All</div>
                {Array.from(new Set(history.flatMap((g) => g.tags || []))).map((t) => (
                  <div key={t} className={`chip ${tagFilter === t ? "on" : ""}`} onClick={() => setTagFilter(tagFilter === t ? "" : t)}>{t}</div>
                ))}
              </div>
              <div className="hr" />
              <div className="small">Tip: Tap a game to view/edit. History is stored locally on this device.</div>
              <div className="hr" />
              <div className="label">Backup</div>
              <div className="row" style={{ flexWrap: "wrap" }}>
                <button className="btn" onClick={exportBackup}>Export Backup</button>
                <button className="btn" onClick={() => importFileRef.current?.click()}>Import Backup</button>
                <input
                  ref={importFileRef}
                  type="file"
                  accept="application/json"
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    importBackupFromFile(file);
                    e.target.value = "";
                  }}
                />
              </div>
              <div className="small" style={{ marginTop: 8 }}>
                Export saves your history and current in-progress game to a JSON file.
              </div>
            </div>

            <div className="panel">
              <div className="row" style={{ justifyContent: "space-between" }}>
                <div>
                  <div style={{ fontWeight: 900 }}>Player Stats</div>
                  <div className="small">{playerStats.length} players tracked from saved games</div>
                </div>
              </div>
              <div style={{ height: 10 }} />
              {!playerStats.length ? (
                <div className="small">No player stats yet. Finish and save some games first.</div>
              ) : (
                <div className="playerStatsList">
                  {playerStats.map((player) => (
                    <div key={player.key} className="playerStatCard">
                      <div className="playerStatHeader">
                        <div className="playerStatName">{player.name}</div>
                        <div className="badge">{player.wins} win{player.wins === 1 ? "" : "s"}</div>
                      </div>

                      <div className="playerStatGrid">
                        <div className="playerStatItem">
                          <div className="playerStatLabel">Games</div>
                          <div className="playerStatValue">{player.gamesPlayed}</div>
                        </div>
                        <div className="playerStatItem">
                          <div className="playerStatLabel">Wins</div>
                          <div className="playerStatValue">{player.wins}</div>
                        </div>
                        <div className="playerStatItem">
                          <div className="playerStatLabel">2nd Place</div>
                          <div className="playerStatValue">{player.second}</div>
                        </div>
                        <div className="playerStatItem">
                          <div className="playerStatLabel">3rd Place</div>
                          <div className="playerStatValue">{player.third}</div>
                        </div>
                        <div className="playerStatItem">
                          <div className="playerStatLabel">Avg Points</div>
                          <div className="playerStatValue">{player.averagePoints}</div>
                        </div>
                        <div className="playerStatItem">
                          <div className="playerStatLabel">Best Finish</div>
                          <div className="playerStatValue">{player.bestFinish === "—" ? "—" : `#${player.bestFinish}`}</div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div className="hr" />

              <div className="label">Saved Players</div>
              <input
                className="input"
                value={profileSearch}
                onChange={(e) => setProfileSearch(e.target.value)}
                placeholder="Search saved players…"
                style={{ marginBottom: 10 }}
              />
              {!filteredProfiles.length ? (
                <div className="small">No saved players yet.</div>
              ) : (
                <div className="historyList" style={{ marginBottom: 12 }}>
                  {filteredProfiles.map((profile) => (
                    <div key={profile.id} className="profileRow">
                      <div>
                        <div className="profileName">{profile.name}</div>
                        <div className="small">Last used: {formatDate(profile.lastUsedAt || profile.createdAt)}</div>
                      </div>
                      <div className="profileActions">
                        <button className="btn" onClick={() => renamePlayerProfile(profile.id)}>Rename</button>
                        <button className="btn" onClick={() => deletePlayerProfile(profile.id)}>Delete</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div className="hr" />

              <div className="row" style={{ justifyContent: "space-between" }}>
                <div>
                  <div style={{ fontWeight: 900 }}>Saved Games</div>
                  <div className="small">{filteredHistory.length} shown</div>
                </div>
              </div>
              <div style={{ height: 10 }} />
              {!filteredHistory.length ? (
                <div className="small">No games yet. Finish a game to save it.</div>
              ) : (
                <div className="historyList">
                  {filteredHistory.map((g) => {
                    const t = g.totals || computeTotals(g.players || [], g.rounds || []);
                    const w = g.winnerIds || winnerIds(g.players || [], t);
                    const winnerNames = (g.players || []).filter((p) => w.includes(p.id)).map((p) => p.name).join(", ");
                    return (
                      <button key={g.id} className={`historyItem ${editGameId === g.id ? "active" : ""}`} onClick={() => openForEdit(g.id)}>
                        <div className="historyTitle">{(g.name || "").trim() ? g.name : "Game"} <span className="badge">{winnerNames ? `Winner: ${winnerNames}` : "—"}</span></div>
                        <div className="historyMeta">{formatDate(g.savedAt || g.createdAt)}{g.location ? ` • ${g.location}` : ""}</div>
                        <div className="historyMeta">Players: {(g.players || []).map((p) => p.name).join(", ")}</div>
                        <div className="historyMeta">Tags: {(g.tags || []).length ? (g.tags || []).join(", ") : "—"}</div>
                        <div className="row" style={{ marginTop: 10 }}>
                          <button className="btn" onClick={(e) => { e.stopPropagation(); deleteGame(g.id); }}>Delete</button>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
          </>
        )}
      </div>
    </>
  );
}

function TagAdder({ onAdd }) {
  const [value, setValue] = useState("");
  return (
    <div className="row">
      <input
        className="input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Add a tag (e.g., cabin weekend)…"
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            const t = value.trim();
            if (!t) return;
            onAdd(t);
            setValue("");
          }
        }}
      />
      <button
        className="btn"
        onClick={() => {
          const t = value.trim();
          if (!t) return;
          onAdd(t);
          setValue("");
        }}
      >
        Add
      </button>
    </div>
  );
}
