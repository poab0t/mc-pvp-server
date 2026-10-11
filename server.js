import {
 createServer
} from 'node:http';
import {
 WebSocketServer,
 WebSocket
} from 'ws';




const PORT = Number(process.env.PORT || 3000);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '';
const ARENA_SIZE = 48;
const MAX_PLAYERS_PER_ROOM = 32;
const MAX_MOVEMENT_PER_SECOND = 7.5;
const rooms = new Map();


const httpServer = createServer((_request, response) => {
 response.writeHead(200, {
   'content-type': 'application/json'
 });
 response.end(JSON.stringify({
   service: 'MC PVP CLUB authoritative arena',
   status: 'online'
 }));
});


const wss = new WebSocketServer({
 server: httpServer,
 maxPayload: 16 * 1024
});


function send(socket, message) {
 if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}


function broadcast(room, message, except = null) {
 for (const peer of room.players.values()) {
   if (peer.socket !== except) send(peer.socket, message);
 }
}


function normalizedRoomName(value) {
 return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
}


function playerSnapshot(peer) {
 return {
   peerId: peer.peerId,
   x: peer.x,
   y: peer.y,
   z: peer.z,
   yaw: peer.yaw,
   health: peer.health
 };
}


function removePeer(socket) {
 const peer = socket.peer;
 if (!peer) return;
 const room = rooms.get(peer.roomKey);
 if (room) {
   room.players.delete(peer.peerId);
   broadcast(room, {
     type: 'presence',
     event: 'leave',
     peerId: peer.peerId
   });
   if (room.players.size === 0 && room.blocks.size === 0) rooms.delete(peer.roomKey);
 }
 socket.peer = null;
}


function joinRoom(socket, message) {
 const roomKey = normalizedRoomName(message.room);
 const peerId = String(message.peerId || '').slice(0, 80);
 if (!roomKey || !peerId) {
   send(socket, {
     type: 'error',
     message: 'A valid arena name and player ID are required.'
   });
   return;
 }


 removePeer(socket);
 let room = rooms.get(roomKey);
 if (!room) {
   room = {
     players: new Map(),
     blocks: new Map()
   };
   rooms.set(roomKey, room);
 }
 if (room.players.size >= MAX_PLAYERS_PER_ROOM) {
   send(socket, {
     type: 'error',
     message: 'This arena is full.'
   });
   return;
 }
 if (room.players.has(peerId)) {
   send(socket, {
     type: 'error',
     message: 'That player is already connected to this arena.'
   });
   return;
 }


 const now = Date.now();
 const peer = {
   socket,
   peerId,
   roomKey,
   x: 24.5,
   y: 16.65,
   z: 24.5,
   yaw: 0,
   health: 3,
   lastMoveAt: now,
   lastAttackAt: 0,
   rewardAt: now
 };
 socket.peer = peer;
 room.players.set(peerId, peer);


 send(socket, {
   type: 'joined',
   peerId,
   players: [...room.players.values()].filter((entry) => entry !== peer).map(playerSnapshot),
   blocks: [...room.blocks.values()]
 });
 broadcast(room, {
   type: 'presence',
   event: 'join',
   peer: playerSnapshot(peer)
 }, socket);
 broadcast(room, {
   type: 'player-state',
   payload: playerSnapshot(peer)
 }, socket);
}


function handleMovement(peer, payload) {
 if (![payload.x, payload.y, payload.z, payload.yaw].every(Number.isFinite)) return;
 const now = Date.now();
 const elapsed = Math.max((now - peer.lastMoveAt) / 1000, 0.016);
 const distance = Math.hypot(payload.x - peer.x, payload.z - peer.z);
 const allowed = MAX_MOVEMENT_PER_SECOND * elapsed + 0.8;
 if (distance > allowed || Math.abs(payload.y - peer.y) > 2.2 || payload.x < -2 || payload.x > ARENA_SIZE + 2 || payload.z < -2 || payload.z > ARENA_SIZE + 2 || payload.y < -30 || payload.y > 40) {
   send(peer.socket, {
     type: 'player-state',
     payload: playerSnapshot(peer)
   });
   return;
 }


 peer.x = payload.x;
 peer.y = payload.y;
 peer.z = payload.z;
 peer.yaw = Math.max(-Math.PI * 20, Math.min(Math.PI * 20, payload.yaw));
 peer.lastMoveAt = now;
 const room = rooms.get(peer.roomKey);
 if (room) broadcast(room, {
   type: 'player-state',
   payload: playerSnapshot(peer)
 });
}


function handleCombat(peer, payload) {
 const room = rooms.get(peer.roomKey);
 const target = room?.players.get(String(payload.targetPeerId || ''));
 const now = Date.now();
 if (!target || target === peer || now - peer.lastAttackAt < 650) return;
 if (Math.hypot(target.x - peer.x, target.z - peer.z) > 5.2) return;
 peer.lastAttackAt = now;
 target.health = Math.max(0, target.health - 1);


 broadcast(room, {
   type: 'event',
   event: 'combat-hit',
   payload: {
     attackerPeerId: peer.peerId,
     attackerName: String(payload.attackerName || 'Player').slice(0, 18),
     targetPeerId: target.peerId,
     health: target.health
   }
 });


 if (target.health === 0) {
   target.x = 24.5;
   target.y = 16.65;
   target.z = 24.5;
   target.yaw = 0;
   target.health = 3;
   target.lastMoveAt = now;
   send(target.socket, {
     type: 'respawn',
     x: target.x,
     y: target.y,
     z: target.z,
     health: target.health
   });
   broadcast(room, {
     type: 'player-state',
     payload: playerSnapshot(target)
   });
 }
}


function handleBlockEdit(peer, payload) {
 const room = rooms.get(peer.roomKey);
 if (!room || !Number.isInteger(payload.x) || !Number.isInteger(payload.z) || !Number.isInteger(payload.height)) return;
 if (payload.x < 0 || payload.x >= ARENA_SIZE || payload.z < 0 || payload.z >= ARENA_SIZE || payload.height < 0 || payload.height > 12) return;
 if (!['grass', 'blue', 'dirt', 'stone', 'cobble', 'wood'].includes(payload.type)) return;
 if (Math.hypot(peer.x - (payload.x + 0.5), peer.z - (payload.z + 0.5)) > 7) return;


 const block = {
   x: payload.x,
   z: payload.z,
   height: payload.height,
   type: payload.type
 };
 room.blocks.set(`${payload.x},${payload.z}`, block);
 broadcast(room, {
   type: 'event',
   event: 'block-edit',
   payload: block
 });
}


wss.on('connection', (socket, request) => {
 if (ALLOWED_ORIGIN && request.headers.origin !== ALLOWED_ORIGIN) {
   socket.close(1008, 'Origin not allowed');
   return;
 }


 socket.on('message', (raw) => {
   let message;
   try {
     message = JSON.parse(raw.toString());
   } catch {
     send(socket, {
       type: 'error',
       message: 'Invalid message.'
     });
     return;
   }


   if (message.type === 'join') {
     joinRoom(socket, message);
     return;
   }


   const peer = socket.peer;
   if (!peer) return;
   if (message.type === 'player-state') handleMovement(peer, message.payload || {});
   if (message.type === 'combat-hit') handleCombat(peer, message.payload || {});
   if (message.type === 'block-edit') handleBlockEdit(peer, message.payload || {});
 });


 socket.on('close', () => removePeer(socket));
 socket.on('error', () => removePeer(socket));
});


const rewardTimer = setInterval(() => {
 const now = Date.now();
 for (const room of rooms.values()) {
   for (const peer of room.players.values()) {
     if (now - peer.rewardAt < 60_000) continue;
     peer.rewardAt = now;
     send(peer.socket, {
       type: 'reward',
       xp: 25,
       coins: 10
     });
   }
 }
}, 1000);


httpServer.listen(PORT, '0.0.0.0', () => {
 console.log(`Authoritative arena server listening on port ${PORT}`);
});


process.on('SIGTERM', () => {
 clearInterval(rewardTimer);
 for (const client of wss.clients) client.close(1001, 'Server shutting down');
 httpServer.close(() => process.exit(0));
});



   
