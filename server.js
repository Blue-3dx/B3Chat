// server.js
const WebSocket = require('ws');

const wss = new WebSocket.Server({ port: 8080 });

let clients = new Map(); // ws -> { username, currentRoom }
let chatRooms = {}; // roomName -> { host, users:Set(ws), isPrivate, banned:Set(username), messages: [] }

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
        if (!data.username || typeof data.username !== 'string') {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid username' }));
          return;
        }
        clientData.username = data.username;
        break;

      case 'create_room':
        if (!clientData.username) {
          ws.send(JSON.stringify({ type: 'error', message: 'Set username first' }));
          return;
        }
        if (!data.roomName || typeof data.roomName !== 'string') {
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
          messages: []
        };
        joinRoom(ws, data.roomName, true);
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
        if (!data.roomName || !chatRooms[data.roomName]) {
          ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
          return;
        }
        joinRoom(ws, data.roomName, false);
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

function joinRoom(ws, roomName, isHostJoining) {
  const clientData = clients.get(ws);

  if (clientData.currentRoom) {
    leaveRoom(ws);
  }

  const room = chatRooms[roomName];

  if (room.banned.has(clientData.username)) {
    ws.send(JSON.stringify({ type: 'error', message: 'You are banned from this room' }));
    return;
  }

  clientData.currentRoom = roomName;
  room.users.add(ws);

  ws.send(JSON.stringify({ type: 'joined_room', roomName, isHost: room.host === clientData.username }));
  ws.send(JSON.stringify({ type: 'room_status', isPrivate: room.isPrivate }));

  // Send existing messages to the client
  room.messages.forEach(msg => {
    ws.send(JSON.stringify({ type: 'message', user: msg.user, text: msg.text, isHostMsg: msg.user === room.host }));
  });

  broadcast(roomName, { type: 'message', user: 'System', text: `${clientData.username} joined the room.`, isHostMsg: false });
  sendRoomListUpdate();
}

function leaveRoom(ws) {
  const clientData = clients.get(ws);
  if (!clientData || !clientData.currentRoom) return;

  const room = chatRooms[clientData.currentRoom];
  room.users.delete(ws);

  broadcast(clientData.currentRoom, { type: 'message', user: 'System', text: `${clientData.username} left the room.`, isHostMsg: false });

  if (room.users.size === 0) {
    // Delete room if empty
    delete chatRooms[clientData.currentRoom];
    sendRoomListUpdate();
  }

  clientData.currentRoom = null;
}

function handleChatMessage(ws, roomName, text) {
  const clientData = clients.get(ws);
  const room = chatRooms[roomName];
  if (!room) return;

  if (!text || typeof text !== 'string') return;

  if (text.startsWith('!cmd') && clientData.username === room.host) {
    handleCommand(ws, room, text);
    return;
  }

  // Normal chat message
  const msg = { user: clientData.username, text };
  room.messages.push(msg);
  broadcast(roomName, { type: 'message', user: clientData.username, text, isHostMsg: clientData.username === room.host });
}

function handleCommand(ws, room, text) {
  const clientData = clients.get(ws);
  const args = text.split(' ');
  const cmd = args[1];

  switch (cmd) {
    case 'private':
      room.isPrivate = true;
      broadcast(room.host, { type: 'room_status', isPrivate: true });
      broadcast(room.host, { type: 'message', user: 'System', text: 'Room set to private.' });
      sendRoomListUpdate();
      break;

    case 'public':
      room.isPrivate = false;
      broadcast(room.host, { type: 'room_status', isPrivate: false });
      broadcast(room.host, { type: 'message', user: 'System', text: 'Room set to public.' });
      sendRoomListUpdate();
      break;

    case 'kick':
      const kickUser = args[2];
      kickUserFromRoom(room, kickUser);
      break;

    case 'ban':
      const banUser = args[2];
      banUserFromRoom(room, banUser);
      break;

    case 'shutdown':
      shutdownRoom(room);
      break;

    case 'clear':
      room.messages = [];
      broadcast(room.host, { type: 'message', user: 'System', text: 'Messages cleared.' });
      break;

    default:
      ws.send(JSON.stringify({ type: 'error', message: 'Unknown command' }));
  }
}

function kickUserFromRoom(room, username) {
  for (const ws of room.users) {
    const clientData = clients.get(ws);
    if (clientData.username === username) {
      ws.send(JSON.stringify({ type: 'message', user: 'System', text: 'You were kicked from the room.', isHostMsg: false }));
      leaveRoom(ws);
      break;
    }
  }
  broadcast(room.host, { type: 'message', user: 'System', text: `${username} was kicked.` });
}

function banUserFromRoom(room, username) {
  room.banned.add(username);
  kickUserFromRoom(room, username);
  broadcast(room.host, { type: 'message', user: 'System', text: `${username} was banned.` });
}

function shutdownRoom(room) {
  // Notify and disconnect all users
  room.users.forEach(ws => {
    ws.send(JSON.stringify({ type: 'message', user: 'System', text: 'Room is shutting down.' }));
    leaveRoom(ws);
  });
  delete chatRooms[room.host];
  sendRoomListUpdate();
}

function sendRoomListUpdate() {
  const publicRooms = Object.entries(chatRooms)
    .filter(([_, room]) => !room.isPrivate)
    .map(([name, room]) => ({ name, userCount: room.users.size }));

  // Broadcast updated room list to all connected clients
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'room_list', rooms: publicRooms }));
    }
  });
}

console.log('WebSocket server started on ws://localhost:8080');
