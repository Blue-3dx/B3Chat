const WebSocket = require('ws');
const port = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port });

let clients = new Map();
let chatRooms = {};

function broadcast(room, data) {
  chatRooms[room]?.users.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  });
}

wss.on('connection', ws => {
  clients.set(ws, { username: null, room: null });
  ws.on('message', msg => {
    let data = JSON.parse(msg);
    const client = clients.get(ws);
    switch (data.type) {
      case 'set_username':
        client.username = data.username;
        break;
      case 'create_room':
        if (!chatRooms[data.room]) {
          chatRooms[data.room] = { users: new Set(), host: client.username, messages: [] };
        }
        joinRoom(ws, data.room);
        break;
      case 'join_room':
        if (chatRooms[data.room]) joinRoom(ws, data.room);
        break;
      case 'chat_message':
        if (client.room) {
          const room = chatRooms[client.room];
          room.messages.push({ user: client.username, text: data.text });
          broadcast(client.room, { type: 'message', user: client.username, text: data.text });
        }
        break;
    }
  });
  ws.on('close', () => leaveRoom(ws));
});

function joinRoom(ws, roomName) {
  leaveRoom(ws);
  const room = chatRooms[roomName];
  room.users.add(ws);
  clients.get(ws).room = roomName;
  ws.send(JSON.stringify({ type: 'joined_room', room: roomName }));
}

function leaveRoom(ws) {
  const client = clients.get(ws);
  if (!client?.room) return;
  chatRooms[client.room]?.users.delete(ws);
  clients.get(ws).room = null;
}

console.log('Server running on port', port);
