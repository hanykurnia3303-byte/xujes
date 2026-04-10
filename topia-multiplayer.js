/**
 * TOPIA HexGL — Multiplayer Patch + Custom Ship
 * 
 * HOW TO USE:
 * 1. Clone HexGL: git clone https://github.com/BKcore/HexGL
 * 2. Copy this file to HexGL/js/topia-multiplayer.js
 * 3. Add to index.html before </body>:
 *    <script src="js/topia-multiplayer.js"></script>
 * 4. Set WS_URL to your Railway server URL
 */

(function () {
  "use strict";

  // ── Config ─────────────────────────────────────────────────────────────
  const WS_URL   = "wss://YOUR-RAILWAY-APP.railway.app"; // ← ganti ini
  const ROOM     = new URLSearchParams(location.search).get("room") || "lobby-1";
  const MY_NAME  = localStorage.getItem("topia_pilot") || promptName();

  function promptName() {
    const n = prompt("Nama pilot kamu:", "Pilot_" + Math.floor(Math.random() * 9999)) || "Anonymous";
    localStorage.setItem("topia_pilot", n);
    return n;
  }

  // ── Ghost ship registry ─────────────────────────────────────────────────
  const ghosts = new Map(); // playerId → { mesh, label, data }

  // ── WebSocket ───────────────────────────────────────────────────────────
  let ws, myId, myColor;
  let scene3d = null; // Three.js scene — grabbed after HexGL inits
  let connected = false;

  function connect() {
    ws = new WebSocket(`${WS_URL}/?room=${encodeURIComponent(ROOM)}&name=${encodeURIComponent(MY_NAME)}`);

    ws.onopen = () => {
      connected = true;
      setStatus("🟢 " + MY_NAME, myColor || "#fff");
      console.log("[TOPIA MP] Connected");
    };

    ws.onclose = () => {
      connected = false;
      setStatus("🔴 Disconnected — reconnecting...", "#ff4444");
      setTimeout(connect, 3000);
    };

    ws.onerror = (e) => console.error("[TOPIA MP] WS error", e);

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      handleMessage(msg);
    };
  }

  function send(data) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
  }

  // ── Message handlers ────────────────────────────────────────────────────
  function handleMessage(msg) {
    switch (msg.type) {
      case "init":
        myId    = msg.playerId;
        myColor = msg.color;
        setStatus("🟢 " + MY_NAME, myColor);
        // Spawn ghosts for existing players
        msg.players.forEach(p => spawnGhost(p));
        addChatLine(`[系统] 房间 ${ROOM} — ${msg.players.length + 1} 位飞行员`, "#aaa");
        addChatLine(`[System] Room ${ROOM} — ${msg.players.length + 1} pilots online`, "#aaa");
        break;

      case "player_join":
        spawnGhost(msg);
        addChatLine(`✈ ${msg.name} joined`, msg.color);
        updatePlayerList();
        break;

      case "player_leave":
        removeGhost(msg.id);
        addChatLine(`✈ ${msg.name} left`, "#888");
        updatePlayerList();
        break;

      case "update":
        updateGhost(msg);
        break;

      case "lap_complete":
        addChatLine(`🏁 ${msg.name} — Lap ${msg.lap} — ${formatTime(msg.lapTime)}`, msg.id === myId ? myColor : "#ffcc00");
        break;

      case "race_finish":
        addChatLine(`🏆 ${msg.name} finished! Best: ${formatTime(msg.bestLap)}`, "#00ff88");
        break;

      case "leaderboard":
        showLeaderboard(msg.leaderboard);
        break;

      case "chat":
        addChatLine(`${msg.name}: ${msg.text}`, msg.color);
        break;
    }
  }

  // ── Ghost ship (Three.js) ───────────────────────────────────────────────
  function getScene() {
    // Try to grab Three.js scene from HexGL globals
    if (scene3d) return scene3d;
    try {
      // HexGL exposes game.scene or similar
      if (window.game && window.game.renderer && window.game.renderer.scene) {
        scene3d = window.game.renderer.scene;
      } else if (window.bkcore && window.bkcore.hexgl && window.bkcore.hexgl.scene) {
        scene3d = window.bkcore.hexgl.scene;
      }
    } catch {}
    return scene3d;
  }

  function makeGhostMesh(color) {
    const THREE = window.THREE;
    if (!THREE) return null;

    const group = new THREE.Group();

    // Main body — sleek angular fuselage
    const bodyGeo = new THREE.BoxGeometry(14, 3, 30);
    const bodyMat = new THREE.MeshPhongMaterial({
      color: new THREE.Color(color),
      transparent: true,
      opacity: 0.75,
      shininess: 120,
      emissive: new THREE.Color(color).multiplyScalar(0.3)
    });
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    group.add(body);

    // Left wing
    const wingGeo = new THREE.BoxGeometry(30, 1.5, 18);
    const wingMat = new THREE.MeshPhongMaterial({
      color: new THREE.Color(color),
      transparent: true,
      opacity: 0.6,
      shininess: 80
    });
    const leftWing = new THREE.Mesh(wingGeo, wingMat);
    leftWing.position.set(-22, -0.5, 2);
    leftWing.rotation.z = 0.08;
    group.add(leftWing);

    // Right wing
    const rightWing = new THREE.Mesh(wingGeo, wingMat);
    rightWing.position.set(22, -0.5, 2);
    rightWing.rotation.z = -0.08;
    group.add(rightWing);

    // Engine glow (cyan/color)
    const glowGeo = new THREE.SphereGeometry(3, 8, 8);
    const glowMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(color),
      transparent: true,
      opacity: 0.9
    });
    const glow = new THREE.Mesh(glowGeo, glowMat);
    glow.position.set(0, 0, 18);
    group.add(glow);

    // TOPIA bat wing silhouette (simple geometry approximation)
    const batGeo = new THREE.CylinderGeometry(0, 8, 2, 6);
    const batMat = new THREE.MeshBasicMaterial({ color: 0x9933ff, transparent: true, opacity: 0.5 });
    const bat = new THREE.Mesh(batGeo, batMat);
    bat.position.set(0, 4, 0);
    group.add(bat);

    return group;
  }

  function spawnGhost(playerData) {
    const sc = getScene();
    if (!sc || !window.THREE) {
      // Queue for later
      setTimeout(() => spawnGhost(playerData), 2000);
      return;
    }

    if (ghosts.has(playerData.id)) return;

    const mesh = makeGhostMesh(playerData.color);
    if (mesh) {
      sc.add(mesh);
      if (playerData.position) {
        mesh.position.set(playerData.position.x, playerData.position.y, playerData.position.z);
      }
    }

    ghosts.set(playerData.id, { mesh, data: playerData });
    updatePlayerList();
  }

  function updateGhost(msg) {
    const ghost = ghosts.get(msg.id);
    if (!ghost || !ghost.mesh) return;

    // Smooth interpolation
    const m = ghost.mesh;
    const p = msg.position;
    const r = msg.rotation;

    m.position.lerp(new window.THREE.Vector3(p.x, p.y, p.z), 0.3);
    if (r) {
      m.rotation.x += (r.x - m.rotation.x) * 0.3;
      m.rotation.y += (r.y - m.rotation.y) * 0.3;
      m.rotation.z += (r.z - m.rotation.z) * 0.3;
    }

    ghost.data = { ...ghost.data, ...msg };
  }

  function removeGhost(id) {
    const ghost = ghosts.get(id);
    if (ghost && ghost.mesh) {
      const sc = getScene();
      if (sc) sc.remove(ghost.mesh);
    }
    ghosts.delete(id);
    updatePlayerList();
  }

  // ── Position sender (hook into HexGL game loop) ─────────────────────────
  let lastSend = 0;
  const SEND_INTERVAL = 50; // 20 updates/sec

  function hookGameLoop() {
    const origRAF = window.requestAnimationFrame;
    window.requestAnimationFrame = function (cb) {
      return origRAF.call(window, function (t) {
        cb(t);
        // Send position after each frame (throttled)
        if (connected && t - lastSend > SEND_INTERVAL) {
          lastSend = t;
          sendMyPosition();
        }
      });
    };
  }

  function sendMyPosition() {
    try {
      // Grab position from HexGL's ship object
      let ship = null;
      if (window.game && window.game.ship) ship = window.game.ship;
      else if (window.bkcore && window.bkcore.hexgl && window.bkcore.hexgl.ship) {
        ship = window.bkcore.hexgl.ship;
      }

      if (!ship) return;

      const pos = ship.position || ship.mesh && ship.mesh.position;
      const rot = ship.rotation || ship.mesh && ship.mesh.rotation;

      if (!pos) return;

      send({
        type: "update",
        position: { x: pos.x, y: pos.y, z: pos.z },
        rotation: { x: rot ? rot.x : 0, y: rot ? rot.y : 0, z: rot ? rot.z : 0 },
        speed: ship.speed || 0,
        lap: window.__topiaCurLap || 0
      });
    } catch {}
  }

  // ── UI ──────────────────────────────────────────────────────────────────
  function buildUI() {
    const ui = document.createElement("div");
    ui.id = "topia-mp-ui";
    ui.innerHTML = `
      <div id="topia-status">⏳ Connecting...</div>
      <div id="topia-room">🏁 Room: <strong>${ROOM}</strong></div>
      <div id="topia-players-list"></div>
      <div id="topia-chat-box"></div>
      <div style="display:flex;gap:6px;margin-top:6px">
        <input id="topia-chat-input" placeholder="Chat..." maxlength="120"/>
        <button id="topia-chat-send">Send</button>
      </div>
    `;
    ui.style.cssText = `
      position:fixed; top:16px; right:16px; z-index:9999;
      background:rgba(0,0,0,0.82); border:1px solid #9933ff;
      border-radius:12px; padding:14px 16px; min-width:220px;
      font-family:'Space Mono',monospace; font-size:12px; color:#f0f0f0;
      backdrop-filter:blur(8px); box-shadow:0 0 24px rgba(153,51,255,0.4);
    `;
    document.body.appendChild(ui);

    const style = document.createElement("style");
    style.textContent = `
      #topia-status { font-weight:700; margin-bottom:4px; font-size:13px; }
      #topia-room { color:#9933ff; margin-bottom:8px; font-size:11px; }
      #topia-players-list { border-top:1px solid #333; padding-top:8px; margin-bottom:8px; min-height:20px; }
      #topia-chat-box {
        height:120px; overflow-y:auto; border:1px solid #333; border-radius:6px;
        padding:6px; font-size:11px; line-height:1.6; background:rgba(255,255,255,0.03);
      }
      #topia-chat-input {
        flex:1; background:#111; border:1px solid #444; border-radius:6px;
        color:#fff; padding:4px 8px; font-size:11px; font-family:inherit;
      }
      #topia-chat-send {
        background:#9933ff; border:none; border-radius:6px; color:#fff;
        padding:4px 10px; cursor:pointer; font-size:11px;
      }
      #topia-chat-send:hover { background:#7722dd; }
      .topia-player-row { display:flex; align-items:center; gap:6px; margin:2px 0; }
      .topia-player-dot { width:8px; height:8px; border-radius:50%; flex-shrink:0; }
    `;
    document.head.appendChild(style);

    // Chat send
    const input = document.getElementById("topia-chat-input");
    const sendBtn = document.getElementById("topia-chat-send");

    function sendChat() {
      const text = input.value.trim();
      if (!text) return;
      send({ type: "chat", text });
      input.value = "";
    }

    sendBtn.onclick = sendChat;
    input.onkeydown = (e) => { if (e.key === "Enter") sendChat(); };
  }

  function setStatus(text, color) {
    const el = document.getElementById("topia-status");
    if (el) { el.textContent = text; el.style.color = color || "#fff"; }
  }

  function addChatLine(text, color) {
    const box = document.getElementById("topia-chat-box");
    if (!box) return;
    const line = document.createElement("div");
    line.style.color = color || "#ccc";
    line.textContent = text;
    box.appendChild(line);
    box.scrollTop = box.scrollHeight;
  }

  function updatePlayerList() {
    const list = document.getElementById("topia-players-list");
    if (!list) return;
    list.innerHTML = `<div style="color:#666;font-size:10px;margin-bottom:4px">PILOTS (${ghosts.size + 1})</div>`;

    // Me
    const me = document.createElement("div");
    me.className = "topia-player-row";
    me.innerHTML = `<div class="topia-player-dot" style="background:${myColor || '#fff'}"></div><span style="color:${myColor || '#fff'}">${MY_NAME} (you)</span>`;
    list.appendChild(me);

    // Others
    for (const [, g] of ghosts) {
      const row = document.createElement("div");
      row.className = "topia-player-row";
      row.innerHTML = `<div class="topia-player-dot" style="background:${g.data.color}"></div><span>${g.data.name}</span>`;
      list.appendChild(row);
    }
  }

  function showLeaderboard(lb) {
    const overlay = document.createElement("div");
    overlay.style.cssText = `
      position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;
      background:rgba(0,0,0,0.85);font-family:'Space Mono',monospace;
    `;
    const medals = ["🥇","🥈","🥉"];
    const rows = lb.map((p, i) =>
      `<div style="padding:10px 0;border-bottom:1px solid #333;color:${i===0?'#ffd700':i===1?'#c0c0c0':i===2?'#cd7f32':'#fff'}">
        ${medals[i]||`#${p.rank}`} &nbsp; ${p.name} &nbsp; <span style="color:#9933ff">${formatTime(p.bestLap)}</span>
      </div>`
    ).join("");
    overlay.innerHTML = `
      <div style="background:#0a0a0a;border:2px solid #9933ff;border-radius:16px;padding:32px 48px;min-width:320px;text-align:center;
                  box-shadow:0 0 48px rgba(153,51,255,0.6)">
        <div style="font-size:28px;margin-bottom:4px">🦇</div>
        <div style="font-size:20px;font-weight:700;color:#9933ff;margin-bottom:20px;letter-spacing:2px">TOPIA RACE RESULT</div>
        ${rows}
        <button onclick="this.parentElement.parentElement.remove()"
          style="margin-top:20px;background:#9933ff;border:none;border-radius:8px;color:#fff;
                 padding:10px 28px;font-size:14px;cursor:pointer;font-family:inherit">
          Close
        </button>
      </div>
    `;
    document.body.appendChild(overlay);
  }

  function formatTime(ms) {
    if (!ms) return "--:--.---";
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000).toString().padStart(2, "0");
    const ms3 = (ms % 1000).toString().padStart(3, "0");
    return `${m}'${s}"${ms3}`;
  }

  // ── Room selector UI (shown before game) ───────────────────────────────
  function buildRoomSelector() {
    if (new URLSearchParams(location.search).get("room")) return; // already set

    const overlay = document.createElement("div");
    overlay.style.cssText = `
      position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;
      background:rgba(0,0,0,0.95);font-family:'Space Mono',monospace;
    `;
    overlay.innerHTML = `
      <div style="background:#0a0a0a;border:2px solid #9933ff;border-radius:16px;padding:40px;min-width:340px;text-align:center;
                  box-shadow:0 0 48px rgba(153,51,255,0.5)">
        <div style="font-size:40px;margin-bottom:8px">🦇</div>
        <div style="font-size:22px;font-weight:700;color:#9933ff;letter-spacing:3px;margin-bottom:4px">TOPIA RACING</div>
        <div style="font-size:11px;color:#555;margin-bottom:28px;letter-spacing:1px">MULTIPLAYER HexGL</div>

        <div style="text-align:left;margin-bottom:16px">
          <label style="font-size:11px;color:#888;display:block;margin-bottom:4px">PILOT NAME</label>
          <input id="inp-name" value="${MY_NAME}" style="width:100%;box-sizing:border-box;background:#111;border:1px solid #444;
            border-radius:8px;color:#fff;padding:10px;font-family:inherit;font-size:13px;"/>
        </div>

        <div style="text-align:left;margin-bottom:24px">
          <label style="font-size:11px;color:#888;display:block;margin-bottom:4px">ROOM</label>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">
            ${["lobby-1","lobby-2","lobby-3","tournament"].map(r =>
              `<button class="room-btn" data-room="${r}" style="background:#1a1a1a;border:1px solid #333;border-radius:6px;
               color:#ccc;padding:6px 12px;cursor:pointer;font-family:inherit;font-size:11px;">${r}</button>`
            ).join("")}
          </div>
          <input id="inp-room" placeholder="or type custom room..." value="lobby-1"
            style="width:100%;box-sizing:border-box;background:#111;border:1px solid #444;
            border-radius:8px;color:#fff;padding:10px;font-family:inherit;font-size:13px;"/>
        </div>

        <button id="btn-race" style="width:100%;background:#9933ff;border:none;border-radius:10px;color:#fff;
          padding:14px;font-size:15px;font-weight:700;cursor:pointer;font-family:inherit;letter-spacing:2px;">
          🚀 RACE
        </button>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.querySelectorAll(".room-btn").forEach(btn => {
      btn.onclick = () => {
        document.getElementById("inp-room").value = btn.dataset.room;
        overlay.querySelectorAll(".room-btn").forEach(b => b.style.borderColor = "#333");
        btn.style.borderColor = "#9933ff";
      };
    });

    document.getElementById("btn-race").onclick = () => {
      const name = document.getElementById("inp-name").value.trim() || MY_NAME;
      const room = document.getElementById("inp-room").value.trim() || "lobby-1";
      localStorage.setItem("topia_pilot", name);
      const url = new URL(location.href);
      url.searchParams.set("room", room);
      url.searchParams.set("name", name);
      location.href = url.toString();
    };
  }

  // ── Boot ─────────────────────────────────────────────────────────────────
  function init() {
    buildRoomSelector();
    if (!new URLSearchParams(location.search).get("room")) return; // wait for room selection

    buildUI();
    hookGameLoop();
    connect();

    // Try to grab scene after HexGL loads (2-5 sec)
    setTimeout(() => {
      getScene();
      if (scene3d) console.log("[TOPIA MP] Three.js scene hooked ✓");
      else console.warn("[TOPIA MP] Scene not found yet — ghosts will spawn on join");
    }, 3000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

})();
