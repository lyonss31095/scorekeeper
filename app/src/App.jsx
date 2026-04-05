import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * Scorekeeper MVP (5 Crowns-first)
 * - New Game setup
 * - Scoring: rounds as rows, players as columns, totals auto-summed
 * - "Went out first" marker per round (⭐) -> "Rounds Won" row
 * - Autosave on every change (Google Docs style)
 * - Undo last change
 * - History + Edit saved game
 *
 * Storage:
 * - Draft (in-progress game): localStorage key scorekeeper_draft_v1
 * - History (saved games): localStorage key scorekeeper_history_v1
 */

const LS_DRAFT = "scorekeeper_draft_v1";
const LS_HISTORY = "scorekeeper_history_v1";

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
  // Prevent accidental huge values; you can adjust later
  const MAX = 200;
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(MAX, n));
}

function roundsFor5Crowns() {
  return [ 
    "3","4","5","6","7","8","9","10",
    "Jacks","Queens","Kings"
  ];
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
function getDealerName(players, roundIndex) {
  if (!players || players.length === 0) return "";
  const eligible = players.filter((p) => {
    const joinRound = typeof p.joinRound === "number" ? p.joinRound : 0;
    return joinRound <= roundIndex;
  });
  if (eligible.length === 0) return "";
  const dealerIndex = roundIndex % eligible.length;
  return eligible[dealerIndex]?.name || "";
}
function winnerIds(players, totals, rounds = []) {
  if (!players.length) return [];
  const currentRoundIndex = rounds.findIndex((round) =>
    players.some((p) => round.scores?.[p.id] == null)
  );
  const effectiveCurrentRoundIndex =
    currentRoundIndex === -1 ? rounds.length : currentRoundIndex;
  const eligiblePlayers = players.filter((p) => {
    const joinRound = typeof p.joinRound === "number" ? p.joinRound : 0;
    return joinRound < effectiveCurrentRoundIndex;
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

const styles = `
:root{
  --rowAlt: #F3F0FA;
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
  --wentout: rgba(50, 205, 50, 0.18); /* subtle green */
}

@media (prefers-color-scheme: dark){
  :root{
    --rowAlt: #171325;
    --bg: #0b0b0c;
    --panel: #121214;
    --text: #f5f5f5;
    --muted: #b7b7b7;
    --border: #2a2a2e;
    --chip: #1b1b1f;
    --chipText: #f5f5f5;
    --primary: #8B5CF6;
    --focus: rgba(255,255,255,0.18);
    --winner: rgba(139, 92, 246, 0.22);
    --wentout: rgba(50, 205, 50, 0.14);
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
.h1{ font-size: 22px; font-weight: 700; margin:0; }
.sub{ font-size: 13px; color: var(--muted); margin-top:4px; }
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
.input, .textarea, .select{
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
`;

// Change record for Undo
// type: "score" | "wentout" | "meta" | "player"
function pushUndo(stack, entry) {
  const next = [entry, ...stack];
  // keep small
  return next.slice(0, 50);
}

export default function App() {
  const [tab, setTab] = useState("new"); // new | score | history | edit
  const [history, setHistory] = useState([]);

  // Draft / current game
  const [draft, setDraft] = useState(() => ({
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
    roundLabels: roundsFor5Crowns(), // [3..13]
    rounds: roundsFor5Crowns().map(() => ({ scores: {}, wentOutId: "" })),
  }));

  // Undo stack for the *current editing context* (draft or edit)
  const [undoStack, setUndoStack] = useState([]);

  // Editing saved game
  const [editGameId, setEditGameId] = useState("");
  const [editGame, setEditGame] = useState(null);
  const [search, setSearch] = useState("");
  const [tagFilter, setTagFilter] = useState("");
    // refs for score inputs (for Enter navigation)
  const inputRefs = useRef(new Map()); // key: `${r}_${c}` -> element

  function setEditField(field, value) {
    setEditGame((prev) => {
      const next = { ...prev, [field]: value };
      return next;
    });
  }

  function setDraftField(field, value) {
    setDraft((prev) => {
      const next = { ...prev, [field]: value };
      return next;
    });
  }

  function addPlayer(to = "draft") {
    const fn = to === "edit" ? setEditGame : setDraft;
    fn((prev) => {
      const nextPlayerNumber = (prev.players?.length || 0) + 1;
      const nextPlayers = [
        ...(prev.players || []),
        { id: uid(), name: `Player ${nextPlayerNumber}`, joinRound: 0 },
      ];
      return { ...prev, players: nextPlayers };
    });
  }

  function addLatePlayer() {
    setDraft((prev) => {
      const newPlayerId = uid();
      const newPlayerNumber = prev.players.length + 1;

      const nextPlayers = [
        ...prev.players,
        { id: newPlayerId, name: `Player ${newPlayerNumber}`, joinRound: currentRoundIndex },
      ];

      const nextRounds = prev.rounds.map((round, idx) => {
        const scores = { ...(round.scores || {}) };

        if (idx < currentRoundIndex) {
          scores[newPlayerId] = 0;
        }

        return { ...round, scores };
      });

      return {
        ...prev,
        players: nextPlayers,
        rounds: nextRounds,
      };
    });
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
      const nextPlayers = prev.players.map((p) => (p.id === playerId ? { ...p, name } : p));
      return { ...prev, players: nextPlayers };
    });
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

    // Allow blank -> remove key
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
        // restore focus
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
        return;
      }
    }

    function focusCell(rIdx, pIdx) {
      const key = `${rIdx}_${pIdx}`;
      const el = inputRefs.current.get(key);
      if (el && typeof el.focus === "function") el.focus();
    }

    function onScoreKeyDown(e, rIdx, pIdx, to = "draft") {
      if (e.key === "Enter") {
        e.preventDefault();
        // move right; if last column, move to next row first column
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
      // ensure no blank
      if (cleaned.some((p) => !(p.name || "").trim())) return "Player names can’t be blank.";
      return "";
    }

    function startGame() {
      const err = validateForStart(draft);
      if (err) {
        alert(err);
        return;
      }
      // normalize names unique
      setDraft((prev) => ({ ...prev, players: ensureUniqueNames(prev.players) }));
      setTab("score");
      // focus first cell
      setTimeout(() => focusCell(0, 0), 0);
    }

    function resetDraft() {
      if (!confirm("Reset current game?")) return;
      const fresh = {
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
      const normalizedDraft = { ...draft, players: normalizedPlayers };

      const t = computeTotals(normalizedPlayers, normalizedDraft.rounds);
      const w = winnerIds(normalizedPlayers, t);

      const saved = {
        ...normalizedDraft,
        createdAt: normalizedDraft.createdAt || new Date().toISOString(),
        savedAt: new Date().toISOString(),
        totals: t,
        winnerIds: w,
      };

      setHistory((prev) => [saved, ...prev]);
      // reset draft after saving
      const fresh = {
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
      setDraft(fresh);
      setUndoStack([]);
      localStorage.setItem(LS_DRAFT, JSON.stringify(fresh));
      setTab("history");
    }

    function openForEdit(gameId) {
      const g = history.find((x) => x.id === gameId);
      if (!g) return;
      setEditGameId(gameId);
      // deep-ish clone to avoid editing history object directly
      setEditGame(JSON.parse(JSON.stringify(g)));
      setUndoStack([]);
      setTab("edit");
      setTimeout(() => focusCell(0, 0), 0);
    }

    function saveEdits() {
      if (!editGame) return;
      const normalizedPlayers = ensureUniqueNames(editGame.players || []);
      const updated = { ...editGame, players: normalizedPlayers };

      const t = computeTotals(updated.players, updated.rounds);
      const w = winnerIds(updated.players, t);
      const finalGame = { ...updated, totals: t, winnerIds: w, editedAt: new Date().toISOString() };

      setHistory((prev) => prev.map((g) => (g.id === editGameId ? finalGame : g)));
      setTab("history");
      setEditGameId("");
      setEditGame(null);
      setUndoStack([]);
    }
    function editPlayersPrompt() {
      const game = tab === "edit" ? editGame : draft;
      if (!game?.players?.length) return;

      const choices = game.players
        .map((p, idx) => `${idx + 1}. ${p.name}`)
        .join("\n");

      const rawChoice = prompt(`Which player do you want to rename?\n\n${choices}`);
      if (rawChoice == null) return;

      const choice = Number(rawChoice);
      if (!Number.isInteger(choice) || choice < 1 || choice > game.players.length) return;

      const player = game.players[choice - 1];
      const nextName = prompt("New player name", player.name);
      if (nextName == null) return;

      setPlayerName(player.id, nextName, context);
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

    const context = tab === "edit" ? "edit" : "draft";
    const current = tab === "edit" ? editGame : draft;
    
    const totals = useMemo(() => {
     if (!current) return {};
      return computeTotals(current.players || [], current.rounds || []);
}, [current]);

    const currentRoundIndex =
      current?.rounds?.findIndex((round) =>
      current.players.some((p) => round.scores?.[p.id] == null)
  ) ?? 0;

const roundsWon = useMemo(() => {
  if (!current) return {};
  return computeRoundsWon(current.players || [], current.rounds || []);
}, [current]);

const winners = useMemo(() => {
  if (!current) return [];
  return winnerIds(current.players || [], totals, current.rounds || []);
}, [current, totals]);

    return (
    <>
      <style>{styles}</style>
      <div className="container">
        <div className="header">
          <div>
            <h1 className="h1">Scorekeeper</h1>
            <div className="sub">5 Crowns-first • autosave • history • edit • rounds won</div>
          </div>
          <div className="tabs">
            <button className={`tab ${tab === "new" ? "active" : ""}`} onClick={() => setTab("new")}>
              New Game
            </button>
            <button
              className={`tab ${tab === "score" ? "active" : ""}`}
              onClick={() => setTab("score")}
            >
              Scoring
            </button>
            <button
              className={`tab ${tab === "history" ? "active" : ""}`}
              onClick={() => setTab("history")}
            >
              History <span className="badge">{history.length}</span>
            </button>
          </div>
        </div>

        {(tab === "new" || tab === "score") && (
          <div className="row" style={{ marginBottom: 10 }}>
            <button className="btn" onClick={undo} disabled={!undoStack.length}>
              ⟲ Undo Last Change
            </button>
            <button className="btn" onClick={resetDraft}>
              Reset
            </button>
            <div className="small" style={{ marginLeft: "auto" }}>
              Autosaving…
            </div>
          </div>
        )}

        {tab === "new" && (
          <div className="grid">
            <div className="panel">
              <div className="label">Game name (optional)</div>
              <input
                className="input"
                value={draft.name}
                onChange={(e) => setDraftField("name", e.target.value)}
                placeholder="e.g., Friday Night 5 Crowns"
              />

              <div style={{ height: 10 }} />

              <div className="label">Location (optional)</div>
              <input
                className="input"
                value={draft.location}
                onChange={(e) => setDraftField("location", e.target.value)}
                placeholder="e.g., Home, Cabin, Mike’s place"
              />

              <div style={{ height: 10 }} />

              <div className="label">Notes (optional)</div>
              <textarea
                className="textarea"
                value={draft.notes}
                onChange={(e) => setDraftField("notes", e.target.value)}
                placeholder="Anything you want to remember about this game…"
              />

              <div className="hr" />

              <div className="label">Tags</div>
              <div className="chips" style={{ marginBottom: 10 }}>
                {DEFAULT_TAGS.map((t) => (
                  <div
                    key={t}
                    className={`chip ${(draft.tags || []).includes(t) ? "on" : ""}`}
                    onClick={() => toggleTag(t, "draft")}
                    title="Click to toggle"
                  >
                    {t}
                  </div>
                ))}
              </div>

              <TagAdder onAdd={(t) => addCustomTag(t, "draft")} />

              <div className="hr" />

              <button className="btn primary" onClick={startGame}>
                Start Scoring →
              </button>
              <div className="small" style={{ marginTop: 8 }}>
                Tip: Scoring screen uses rounds as rows and players as columns. Enter moves right.
              </div>
            </div>

            <div className="panel">
              <div className="row" style={{ justifyContent: "space-between" }}>
                <div>
                  <div style={{ fontWeight: 800 }}>Players</div>
                  <div className="small">Add players, rename them, remove as needed.</div>
                </div>
                <button className="btn" onClick={() => addPlayer("draft")}>
                  + Add player
                </button>
              </div>

              <div style={{ height: 10 }} />

              <div className="historyList">
                {draft.players.map((p, idx) => (
                  <div key={p.id} className="row">
                    <input
                      className="input"
                      value={p.name}
                      onChange={(e) => setPlayerName(p.id, e.target.value, "draft")}
                      placeholder={`Player ${idx + 1}`}
                    />
                    <button
                      className="btn"
                      disabled={draft.players.length <= 2}
                      onClick={() => removePlayer(p.id, "draft")}
                      title={draft.players.length <= 2 ? "Need at least 2 players" : "Remove"}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>

              <div className="hr" />

              <div className="small">
                Rounds: <b>11</b> (3 → 13). Winner: <b>lowest total</b>. Mark ⭐ for who went out first
                each round (drives “Rounds Won”).
              </div>
            </div>
          </div>
        )}

        {(tab === "score" || tab === "edit") && current && (
          <div className="panel">
            <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
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

              <div className="row">
                {tab === "score" && (
                  <>
                    <button className="btn" onClick={addLatePlayer}>
                      + Add Player
                    </button>
                    <button className="btn" onClick={editPlayersPrompt}>
                      Edit Players
                    </button>
                    <button className="btn primary" onClick={finishAndSave}>
                      Finish & Save
                    </button>
                  </>
                )}

                {tab === "edit" && (
                  <>
                    <button className="btn" onClick={() => setTab("history")}>
                      Cancel
                    </button>
                    <button className="btn primary" onClick={saveEdits}>
                      Save changes
                    </button>
                  </>
                )}
              </div>
            </div>

            <div className="hr" />

            <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
              <div className="small">
                Leader:{" "}
                <b>
                  {winners.length
                    ? current.players
                        .filter((p) => winners.includes(p.id))
                        .map((p) => p.name)
                        .join(", ")
                    : "—"}
                </b>
              </div>
              <div className="small">
                Enter moves right → end of row goes down. ⭐ marks “went out first.”
              </div>
            </div>

            <div style={{ height: 10 }} />

            <div className="tableWrap">
              <table className="table">
                <thead>
                  <tr>
                    <th className="th round">Round</th>
                    {current.players.map((p) => (
                      <th className="th" key={p.id}>
                        <div>{p.name}</div>
                        {winners.includes(p.id) ? <span className="badge">leader</span> : null}
                      </th>
                    ))}
                  </tr>
                </thead>

                <tbody>
                  {current.roundLabels.map((label, rIdx) => (
                      <tr 
                        key={label}
                        style={{
                          background:
                            rIdx === currentRoundIndex
                              ? "#E9DDFB"
                              : rIdx % 2 === 1
                              ? "var(--rowAlt)"
                              : "transparent",
                        }}
                      >

                      <td className="td round">
                        {"R " + label}
                        <div className="small">Dealer: {getDealerName(current.players, rIdx)}</div>
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
                              if (!el) return;
                              inputRefs.current.set(`${rIdx}_${pIdx}`, el);
                            }}
                            onKeyDown={(e) => onScoreKeyDown(e, rIdx, pIdx, context)}
                            onChange={(e) => onScoreChange(rIdx, pIdx, e.target.value, context)}
                            onFocus={(e) => e.target.select?.()}
                          />
                          <button
                            className={`starBtn ${wentOut ? "on" : ""}`}
                            onClick={() => toggleWentOut(rIdx, pIdx, context)}
                            title={wentOut ? "Unmark went out first" : "Mark went out first"}
                          >
                            ⭐
                          </button>
                        </div>
                      </td>
                    );
                  })}

                    </tr>
                  ))}
                </tbody>

                <tfoot>
                  <tr className="totalRow">
                    <th className="th round">Total</th>
                    {current.players.map((p) => (
                      <td className="td" key={p.id}>
                        <span className={winners.includes(p.id) ? "winnerCell" : ""}>
                          {totals[p.id] ?? 0}
                        </span>
                      </td>
                    ))}
                  </tr>
                  <tr className="totalRow">
                    <th className="th round">Rounds Won</th>
                    {current.players.map((p) => (
                      <td className="td" key={p.id}>
                        {roundsWon[p.id] ?? 0}
                      </td>
                    ))}
                  </tr>
                </tfoot>
              </table>
            </div>

            <div className="hr" />

            <div className="grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
              <div>
                <div className="label">Notes</div>
                <textarea
                  className="textarea"
                  value={current.notes || ""}
                  onChange={(e) =>
                    tab === "edit" ? setEditField("notes", e.target.value) : setDraftField("notes", e.target.value)
                  }
                  placeholder="Optional"
                />
              </div>
              <div>
                <div className="label">Location</div>
                <input
                  className="input"
                  value={current.location || ""}
                  onChange={(e) =>
                    tab === "edit"
                      ? setEditField("location", e.target.value)
                      : setDraftField("location", e.target.value)
                  }
                  placeholder="Optional"
                />

                <div style={{ height: 10 }} />

                <div className="label">Tags</div>
                <div className="chips" style={{ marginBottom: 10 }}>
                  {DEFAULT_TAGS.map((t) => (
                    <div
                      key={t}
                      className={`chip ${(current.tags || []).includes(t) ? "on" : ""}`}
                      onClick={() => toggleTag(t, tab === "edit" ? "edit" : "draft")}
                    >
                      {t}
                    </div>
                  ))}
                  {(current.tags || [])
                    .filter((t) => !DEFAULT_TAGS.includes(t))
                    .map((t) => (
                      <div
                        key={t}
                        className={`chip on`}
                        onClick={() => toggleTag(t, tab === "edit" ? "edit" : "draft")}
                        title="Click to remove"
                      >
                        {t} ✕
                      </div>
                    ))}
                </div>

                <TagAdder onAdd={(t) => addCustomTag(t, tab === "edit" ? "edit" : "draft")} />
              </div>
            </div>
          </div>
        )}

        {tab === "history" && (
          <div className="grid">
            <div className="panel">
              <div className="label">Search</div>
              <input
                className="input"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search name, players, notes, location, tags…"
              />

              <div style={{ height: 10 }} />

              <div className="label">Filter by tag</div>
              <div className="chips">
                <div
                  className={`chip ${tagFilter === "" ? "on" : ""}`}
                  onClick={() => setTagFilter("")}
                >
                  All
                </div>
                {Array.from(new Set(history.flatMap((g) => g.tags || []))).map((t) => (
                  <div
                    key={t}
                    className={`chip ${tagFilter === t ? "on" : ""}`}
                    onClick={() => setTagFilter(tagFilter === t ? "" : t)}
                  >
                    {t}
                  </div>
                ))}
              </div>

              <div className="hr" />

              <div className="small">
                Tip: Tap a game to view/edit. History is stored locally on this device.
              </div>
            </div>

            <div className="panel">
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
                    const winnerNames = (g.players || [])
                      .filter((p) => w.includes(p.id))
                      .map((p) => p.name)
                      .join(", ");

                    return (
                      <button
                        key={g.id}
                        className={`historyItem ${editGameId === g.id ? "active" : ""}`}
                        onClick={() => openForEdit(g.id)}
                      >
                        <div className="historyTitle">
                          {(g.name || "").trim() ? g.name : "Game"}{" "}
                          <span className="badge">{winnerNames ? `Winner: ${winnerNames}` : "—"}</span>
                        </div>
                        <div className="historyMeta">
                          {formatDate(g.savedAt || g.createdAt)}
                          {g.location ? ` • ${g.location}` : ""}
                        </div>
                        <div className="historyMeta">
                          Players: {(g.players || []).map((p) => p.name).join(", ")}
                        </div>
                        <div className="historyMeta">
                          Tags: {(g.tags || []).length ? (g.tags || []).join(", ") : "—"}
                        </div>
                        <div className="row" style={{ marginTop: 10 }}>
                          <button
                            className="btn"
                            onClick={(e) => {
                              e.stopPropagation();
                              deleteGame(g.id);
                            }}
                          >
                            Delete
                          </button>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
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