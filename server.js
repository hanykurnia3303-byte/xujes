/**
 * TOPIA HexGL Multiplayer Server
 * Deploy to Railway — WebSocket server for real-time racing
 */

const http = require("http");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS_PER_ROOM = 8;

// ── State ──────────────────────────────────────────────────────────────────
const rooms = new Map(); // roomId → { players: Map<id, playerData> }
let nextId = 1;

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) rooms.set(roomId, { players: new Map() });
  return rooms.get(roomId);
}

function broadcast(room, data, excludeId = null) {
  const msg = JSON.stringify(data);
  for (const [id, player] of room.players) {
    if (id !== excludeId && player.ws.readyState === 1) {
      player.ws.send(msg);
    }
  }
}

function cleanRoom(roomId, playerId) {
  const room = rooms.get(roomId);
  if (!room) return;
  room.players.delete(playerId);
  if (room.players.size === 0) rooms.delete(roomId);
}

// ── HTTP Server ────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      rooms: rooms.size,
      players: [...rooms.values()].reduce((n, r) => n + r.players.size, 0)
    }));
    return;
  }
  // CORS for Vercel frontend
  res.writeHead(200, {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "text/plain"
  });
  res.end("TOPIA HexGL Multiplayer Server");
});

// ── WebSocket Server ───────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  const params = new URLSearchParams(req.url.replace("/?", ""));
  const roomId = params.get("room") || "default";
  const playerName = params.get("name") || `Pilot_${nextId}`;

  const room = getOrCreateRoom(roomId);
  if (room.players.size >= MAX_PLAYERS_PER_ROOM) {
    ws.close(1008, "Room full");
    return;
  }

  const playerId = nextId++;
  const playerColor = `hsl(${(playerId * 137) % 360}, 80%, 60%)`;

  room.players.set(playerId, {
    ws,
    id: playerId,
    name: playerName,
    color: playerColor,
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    speed: 0,
    lap: 0,
    finished: false,
    bestLap: null
  });

  console.log(`[+] ${playerName} (${playerId}) joined room "${roomId}" — ${room.players.size} players`);

  // Send this player their ID + all existing players
  const existingPlayers = [...room.players.entries()]
    .filter(([id]) => id !== playerId)
    .map(([, p]) => ({
      id: p.id, name: p.name, color: p.color,
      position: p.position, rotation: p.rotation
    }));

  ws.send(JSON.stringify({
    type: "init",
    playerId,
    color: playerColor,
    name: playerName,
    room: roomId,
    players: existingPlayers
  }));

  // Notify others
  broadcast(room, {
    type: "player_join",
    id: playerId,
    name: playerName,
    color: playerColor,
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 }
  }, playerId);

  // ── Message handler ──────────────────────────────────────────────────────
  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const player = room.players.get(playerId);
    if (!player) return;

    switch (msg.type) {
      case "update":
        // Position/rotation update — broadcast to room
        player.position = msg.position || player.position;
        player.rotation = msg.rotation || player.rotation;
        player.speed    = msg.speed    ?? player.speed;
        player.lap      = msg.lap      ?? player.lap;

        broadcast(room, {
          type: "update",
          id: playerId,
          position: player.position,
          rotation: player.rotation,
          speed: player.speed,
          lap: player.lap
        }, playerId);
        break;

      case "lap_complete":
        // Player finished a lap
        const lapTime = msg.lapTime;
        if (!player.bestLap || lapTime < player.bestLap) player.bestLap = lapTime;

        broadcast(room, {
          type: "lap_complete",
          id: playerId,
          name: playerName,
          lap: msg.lap,
          lapTime,
          bestLap: player.bestLap
        });

        console.log(`[LAP] ${playerName} lap ${msg.lap} — ${lapTime}ms`);
        break;

      case "race_finish":
        player.finished = true;
        broadcast(room, {
          type: "race_finish",
          id: playerId,
          name: playerName,
          totalTime: msg.totalTime,
          bestLap: player.bestLap
        });

        // Check if all finished → send final leaderboard
        const allFinished = [...room.players.values()].every(p => p.finished);
        if (allFinished) {
          const leaderboard = [...room.players.values()]
            .sort((a, b) => (a.bestLap || Infinity) - (b.bestLap || Infinity))
            .map((p, i) => ({ rank: i + 1, id: p.id, name: p.name, bestLap: p.bestLap }));

          broadcast(room, { type: "leaderboard", leaderboard });
        }
        break;

      case "chat":
        if (msg.text && msg.text.length < 200) {
          broadcast(room, {
            type: "chat",
            id: playerId,
            name: playerName,
            color: playerColor,
            text: msg.text.slice(0, 200)
          });
        }
        break;
    }
  });

  // ── Disconnect ───────────────────────────────────────────────────────────
  ws.on("close", () => {
    cleanRoom(roomId, playerId);
    broadcast(room || { players: new Map() }, {
      type: "player_leave",
      id: playerId,
      name: playerName
    });
    console.log(`[-] ${playerName} (${playerId}) left room "${roomId}"`);
  });

  ws.on("error", (e) => console.error(`[WS Error] ${playerName}:`, e.message));
});

server.listen(PORT, () => {
  console.log(`🦇 TOPIA HexGL Multiplayer Server running on port ${PORT}`);
});
