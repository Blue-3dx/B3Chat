const WebSocket = require('ws');
const port = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port });

let clients = new Map(); // ws -> { username, currentRoom }
let chatRooms = {}; // roomName -> { host, users:Set(ws), isPrivate, banned:Set(username), muted:Set(username), messages: [] }

function broadcast(roomName, data) {
  if (!chatRooms[roomName]) return;
  chatRooms[roomName].users.forEach(clientWs => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify(data));
    }
  });
}

wss.on('connection', ws => {
  clients.set(ws, { username: null, currentRoom: null });

  ws.on('message', message => {
    let data;
    try {
      data = JSON.parse(message);
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      return;
    }

    const clientData = clients.get(ws);

    switch (data.type) {
      case 'set_username':
        clientData.username = data.username;
        break;

      case 'create_room':
        if (!clientData.username) {
          ws.send(JSON.stringify({ type: 'error', message: 'Set username first' }));
          return;
        }
        if (!data.roomName) {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid room name' }));
          return;
        }
        if (chatRooms[data.roomName]) {
          ws.send(JSON.stringify({ type: 'error', message: 'Room already exists' }));
          return;
        }
        chatRooms[data.roomName] = {
          host: clientData.username,
          users: new Set(),
          isPrivate: false,
          banned: new Set(),
          muted: new Set(),
          messages: []
        };
        joinRoom(ws, data.roomName);
        sendRoomListUpdate();
        break;

      case 'list_rooms':
        const publicRooms = Object.entries(chatRooms)
          .filter(([_, room]) => !room.isPrivate)
          .map(([name, room]) => ({ name, userCount: room.users.size }));
        ws.send(JSON.stringify({ type: 'room_list', rooms: publicRooms }));
        break;

      case 'join_room':
        if (!clientData.username) {
          ws.send(JSON.stringify({ type: 'error', message: 'Set username first' }));
          return;
        }
        if (!chatRooms[data.roomName]) {
          ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
          return;
        }
        joinRoom(ws, data.roomName);
        break;

      case 'chat_message':
        if (!clientData.currentRoom) {
          ws.send(JSON.stringify({ type: 'error', message: 'Join a room first' }));
          return;
        }
        handleChatMessage(ws, clientData.currentRoom, data.text);
        break;

      case 'leave_room':
        leaveRoom(ws);
        break;

      default:
        ws.send(JSON.stringify({ type: 'error', message: 'Unknown command' }));
    }
  });

  ws.on('close', () => {
    leaveRoom(ws);
    clients.delete(ws);
  });
});

function joinRoom(ws, roomName) {
  const clientData = clients.get(ws);
  leaveRoom(ws);

  const room = chatRooms[roomName];
  if (room.banned.has(clientData.username)) {
    ws.send(JSON.stringify({ type: 'error', message: 'Banned from room' }));
    return;
  }

  clientData.currentRoom = roomName;
  room.users.add(ws);

  ws.send(JSON.stringify({ type: 'joined_room', roomName, isHost: room.host === clientData.username }));
  ws.send(JSON.stringify({ type: 'room_status', isPrivate: room.isPrivate }));

  // Send existing messages
  room.messages.forEach(m => {
    ws.send(JSON.stringify({ type: 'message', user: m.user, text: m.text, isHostMsg: m.user === room.host }));
  });

  broadcast(roomName, { type: 'message', user: 'System', text: `${clientData.username} joined.`, isHostMsg: false });
  sendRoomListUpdate();
}

function leaveRoom(ws) {
  const clientData = clients.get(ws);
  if (!clientData.currentRoom) return;
  const room = chatRooms[clientData.currentRoom];
  room.users.delete(ws);
  broadcast(clientData.currentRoom, { type: 'message', user: 'System', text: `${clientData.username} left.`, isHostMsg: false });
  if (room.users.size === 0) delete chatRooms[clientData.currentRoom];
  clientData.currentRoom = null;
  sendRoomListUpdate();
}

function handleChatMessage(ws, roomName, text) {
  const clientData = clients.get(ws);
  const room = chatRooms[roomName];
  if (room.muted.has(clientData.username)) {
    // ignore messages from muted users
    return;
  }
  if (text.startsWith('!cmd') && clientData.username === room.host) {
function handleCommand(ws, room, text) {
  const clientData = clients.get(ws);
  const parts = text.split(' ');
  const cmd = parts[1];
  const arg = parts[2];
  let feedback = 'denied';

  switch (cmd) {
    case 'mute':
      if (arg && !room.muted.has(arg)) {
        room.muted.add(arg);
        feedback = 'done!';
      }
      break;
    case 'clear':
      room.messages = [];
      feedback = 'done!';
      break;
    case 'shutdown':
      room.users.forEach(u => u.close());
      delete chatRooms[room.host];
      feedback = 'done!';
      break;
    case 'private':
      room.isPrivate = true;
      feedback = 'done!';
      break;
    case 'public':
      room.isPrivate = false;
      feedback = 'done!';
      break;
    default:
      feedback = 'denied';
  }

  ws.send(JSON.stringify({ type: 'message', user: 'System', text: feedback, isHostMsg: false }));
  sendRoomListUpdate();
}


function sendRoomListUpdate() {
  const publicRooms = Object.entries(chatRooms)
    .filter(([_, room]) => !room.isPrivate)
    .map(([name, room]) => ({ name, userCount: room.users.size }));
  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN) {
      c.send(JSON.stringify({ type: 'room_list', rooms: publicRooms }));
    }
  });
}

console.log('Chat server running on port', port);
