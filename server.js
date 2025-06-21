// server.js
const http = require('http'),
      fs   = require('fs'),
      path = require('path'),
      WebSocket = require('ws');

// — HTTP server for static files —
const server = http.createServer((req, res) => {
  let file = req.url === '/' ? '/index.html' : req.url;
  let ext  = path.extname(file).toLowerCase();
  let map  = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css' };
  let ct   = map[ext] || 'application/octet-stream';
  fs.readFile(path.join(__dirname,'public',file), (err, data) => {
    if(err){ res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': ct });
    res.end(data);
  });
});

// — WebSocket server —
const wss = new WebSocket.Server({ server });

// — In‐memory chat state —
let clients   = new Map(); // ws -> { username, room }
let chatRooms = {};        // name -> { host, users:Set(ws), isPrivate, banned:Set, muted:Set, nicknames:Map, messages:[] }

function broadcast(room, data) {
  if (!chatRooms[room]) return;
  chatRooms[room].users.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
  });
}

function updateRoomList() {
  const list = Object.entries(chatRooms)
    .filter(([_,r]) => !r.isPrivate)
    .map(([name,r]) => ({ name, userCount: r.users.size }));
  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type:'room_list', rooms:list }));
    }
  });
}

wss.on('connection', ws => {
  clients.set(ws, { username: null, room: null });

  ws.on('message', raw => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }
    const client = clients.get(ws);

    switch(data.type) {
      case 'set_username':
        client.username = data.username;
        break;

      case 'create_room':
        if (!client.username || !data.roomName) {
          ws.send(JSON.stringify({ type:'error', message:'Invalid room or user' }));
        } else if (chatRooms[data.roomName]) {
          ws.send(JSON.stringify({ type:'error', message:'Room exists' }));
        } else {
          chatRooms[data.roomName] = {
            host: client.username,
            users: new Set(),
            isPrivate: false,
            banned: new Set(),
            muted:  new Set(),
            nicknames: new Map(),
            messages: []
          };
          joinRoom(ws, data.roomName);
          updateRoomList();
        }
        break;

      case 'list_rooms':
        updateRoomList();
        break;

      case 'join_room':
        joinRoom(ws, data.roomName);
        break;

      case 'leave_room':
        leaveRoom(ws);
        break;

      case 'chat_message':
        handleChat(ws, data.text);
        break;
    }
  });

  ws.on('close', () => {
    leaveRoom(ws);
    clients.delete(ws);
  });
});

function joinRoom(ws, name) {
  const client = clients.get(ws);
  const room   = chatRooms[name];
  if (!room) {
    ws.send(JSON.stringify({ type:'error', message:'No such room' }));
    return;
  }
  if (room.banned.has(client.username)) {
    ws.send(JSON.stringify({ type:'error', message:'You are banned' }));
    return;
  }
  leaveRoom(ws);
  room.users.add(ws);
  client.room = name;
  ws.send(JSON.stringify({ type:'joined_room', roomName:name, isHost: room.host===client.username }));
  ws.send(JSON.stringify({ type:'room_status', isPrivate: room.isPrivate }));
  room.messages.forEach(m => {
    ws.send(JSON.stringify({ type:'message', user:m.user, text:m.text }));
  });
  broadcast(name, { type:'message', user:'System', text:`${client.username} joined` });
  updateRoomList();
}

function leaveRoom(ws) {
  const client = clients.get(ws);
  const name   = client.room;
  if (!name || !chatRooms[name]) return;
  const room = chatRooms[name];
  room.users.delete(ws);
  broadcast(name, { type:'message', user:'System', text:`${client.username} left` });
  if (room.users.size===0) delete chatRooms[name];
  client.room = null;
  updateRoomList();
}

function handleChat(ws, text) {
  const client = clients.get(ws);
  const room   = chatRooms[client.room];
  if (!room || room.muted.has(client.username)) return;

  // HOST COMMANDS
  if (text.startsWith('!cmd ') && client.username===room.host) {
    const parts = text.split(' ');
    const cmd   = parts[1];
    const arg   = parts[2];
    const nick  = parts[3];
    let ok = false;

    switch(cmd) {
      case 'mute':    if (arg&&!room.muted.has(arg)){ room.muted.add(arg); ok=true;} break;
      case 'clear':   room.messages = []; ok=true; break;
      case 'shutdown':
        room.users.forEach(x=>x.close());
        delete chatRooms[client.room];
        ok=true;
        break;
      case 'kick':
        room.users.forEach(x=>{
          const c = clients.get(x);
          if (c.username===arg) {
            x.send(JSON.stringify({ type:'message', user:'System', text:'You were kicked' }));
            leaveRoom(x);
          }
        });
        ok=true;
        break;
      case 'ban':     if(arg){ room.banned.add(arg); ok=true;} break;
      case 'nick':    if(arg&&nick){ room.nicknames.set(arg,nick); ok=true;} break;
      case 'private': room.isPrivate = true; ok=true; break;
      case 'public':  room.isPrivate = false; ok=true; break;
    }

    ws.send(JSON.stringify({ type:'message', user:'System', text: ok?'done!':'denied' }));
    return updateRoomList();
  }

  // NORMAL MESSAGE
  const display = room.nicknames.get(client.username) || client.username;
  const msg = { user:display, text };
  room.messages.push(msg);
  broadcast(client.room, msg);
}

// BIND TO PORT
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Listening on port ${PORT}`));
