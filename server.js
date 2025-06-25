const express = require('express');
const http = require('http');
const sqlite3 = require('sqlite3').verbose();
const WebSocket = require('ws');

// ─── Express & SQLite Setup ───
const app = express();
app.use(express.json());
app.use(express.static(__dirname)); // Serve HTML files
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

const path = require('path');
const db = new sqlite3.Database(path.join(__dirname, 'data', 'users.db'), err => {
  if (err) console.error('SQLite error:', err);
  else {
    db.run(`CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY,
      password TEXT NOT NULL,
      admin INTEGER DEFAULT 0,
      bio TEXT DEFAULT '',
      bgColor TEXT DEFAULT '#ffffff'
    )`, err => {
      if (err) console.error('Error creating users table:', err);
      else console.log('Users table ready');
    });
  }
});

// ─── Auth Routes ───
app.post('/register', (req, res) => {
  const { username, password } = req.body;
  console.log('[REGISTER]', req.body);
  if (!username || !password) return res.json({ ok: false, error: 'Missing fields' });

  // Check if the username is Blue_3dx, if yes, admin = 1, else admin = 0
  const isAdmin = (username === 'Blue_3dx') ? 1 : 0;

// Insert user with admin flag
db.run(
  `INSERT INTO users(username, password, admin) VALUES(?, ?, ?)`,
  [username, password, isAdmin],
  err => {
    if (err) return res.json({ ok: false, error: 'User exists' });
    res.json({ ok: true });
  }
);



app.post('/login', (req, res) => {
  const { username, password } = req.body;
  db.get(
    'SELECT password, admin FROM users WHERE username = ?',
    [username],
    (err, row) => {
      if (err || !row || row.password !== password) return res.json({ ok: false });
      res.json({ ok: true, admin: row.admin === 1 });
    }
  );
});

// ─── Get profile info for settings.html ───
app.get('/profile/:username', (req, res) => {
  const { username } = req.params;
db.get(
  `SELECT password, admin FROM users WHERE username = ?`,
  [username],
  (err, row) => {
    if (err || !row || row.password !== password) return res.json({ ok: false });
    res.json({ ok: true, admin: row.admin === 1 });
  }
);

// ─── Update bio, bgColor, and password ───
app.post('/update-account', (req, res) => {
  const { username, currentPassword, newPassword, bio, bgColor } = req.body;
  db.get(`SELECT password FROM users WHERE username = ?`, [username], (err, row) => {
    if (err || !row) return res.json({ ok: false, message: 'User not found' });

    // Verify current password if changing password
    if (newPassword && currentPassword !== row.password) {
      return res.json({ ok: false, message: 'Incorrect current password' });
    }

    const updates = [];
    const params  = [];
    if (bio !== undefined)     { updates.push('bio = ?');     params.push(bio); }
    if (bgColor !== undefined) { updates.push('bgColor = ?'); params.push(bgColor); }
    if (newPassword)           { updates.push('password = ?'); params.push(newPassword); }

    if (updates.length === 0) {
      return res.json({ ok: false, message: 'No changes provided' });
    }

    params.push(username);
    db.run(
      `UPDATE users SET ${updates.join(', ')} WHERE username = ?`,
      params,
      err => {
        if (err) res.json({ ok: false, message: 'Update failed' });
        else     res.json({ ok: true,  message: 'Changes saved!' });
      }
    );
  });
});
// ─── Delete logged-in user account ───
app.post('/delete-account', (req, res) => {
  const { username } = req.body;
  if (username === 'Blue_3dx') {
    return res.json({ ok: false, message: 'Cannot delete protected admin account.' });
  }

  db.run(`DELETE FROM users WHERE username = ?`, [username], err => {
    if (err) res.json({ ok: false, message: 'Delete failed' });
    else     res.json({ ok: true,  message: 'Account deleted' });
  });
});




// ─── WebSocket Setup ───
const port = process.env.PORT || 8080;
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let clients = new Map();
let chatRooms = {};
// Custom join messages — % will be replaced with the player's username
const joinMessages = [
  'A wild % appeared!',
  '% has joined the fray!',
  'Everyone, say hi to %!',
  '% teleported in!',
  '% just slid into the room!',
  '% came out of nowhere!',
  'Boom! % is here!',
  '% joined the chaos!',
  'Welcome % – better late than never!',
  '% is online. Things just got serious.',
  '% fell from the sky!',
  '% has entered the chat.',
  'Make some noise! % just showed up!',
  '% materialized.',
  '% joined with style!',
  '% is watching you 👀',
  '% spawned in.',
  '% just arrived from another dimension.',
  '% popped in uninvited!',
  '% appeared like magic!',
  'Brace yourselves – % has entered!',
  '% was summoned.',
  'Incoming player: %!',
  'Ping! % joined.',
  'It’s a bird! It’s a plane! Nope, it’s %!',
  'System: % has loaded into reality.',
  '% slid down the chat pipe.',
  '% rode in on a hoverboard.',
  'Look who’s back: %!',
  '% spawned with a cape!'
];

// Custom leave messages — % will be replaced with the player's username
const leaveMessages = [
  'Rest In Piss %!',
  '% vanished into thin air.',
  '% rage quit.',
  '% left like a ghost.',
  '% went offline. F.',
  'Goodbye % – gone but not forgotten!',
  '% dipped.',
  '% fell through the cracks.',
  '% just rage-teleported.',
  'Peace out %!',
  '% went to get milk.',
  'Another one bites the dust – % is out.',
  '% just Alt+F4’d.',
  'Poof! % disappeared.',
  'Silence... % has left.',
  '% unplugged the router.',
  '% got snapped by Thanos.',
  '% escaped.',
  'Well... % left the building.',
  '% has been yeeted.',
  'We barely knew ya, %!',
  '% logged off.',
  'Farewell, %.',
  '% melted away.',
  '% disintegrated.',
  'RIP %',
  'Connection lost with %.',
  '% rage quit (again).',
  '% has left. Freedom at last.'
];

function applyColorCodes(text) {
  const codeMap = {
    '%0': '#000000', '%1': '#0000AA', '%2': '#00AA00', '%3': '#00AAAA',
    '%4': '#AA0000', '%5': '#AA00AA', '%6': '#FFAA00', '%7': '#AAAAAA',
    '%8': '#555555', '%9': '#5555FF', '%a': '#55FF55', '%b': '#55FFFF',
    '%c': '#FF5555', '%d': '#FF55FF', '%e': '#FFFF55', '%f': '#FFFFFF'
  };
  let currentColor = null;
  return text.replace(/%[0-9a-f]/gi, match => {
    currentColor = codeMap[match.toLowerCase()];
    return `<span style="color:${currentColor}">`;
  }) + (currentColor ? '</span>' : '');
}


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
    try { data = JSON.parse(message); }
    catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      return;
    }

    const clientData = clients.get(ws);
if (data.type === 'admin_command') {
  handleAdminCommand(ws, data.command);
  return;  // Important: stop further processing here
}

    switch (data.type) {
case 'set_username': 
  clientData.username = data.username;
case 'checkAdmin':
db.get("SELECT admin FROM users WHERE username = ?", [data.username], (err, row) => {
  if (err) return console.error(err);
  if (row) {
    // handle the row.admin value
  }
});
  break;



      case 'create_room': {
        if (!clientData.username || !data.roomName || chatRooms[data.roomName]) {
          ws.send(JSON.stringify({ type: 'error', message: 'Cannot create room' }));
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
      }
      case 'list_rooms': {
        const publicRooms = Object.entries(chatRooms)
          .filter(([_, room]) => !room.isPrivate)
          .map(([name, room]) => ({ name, userCount: room.users.size }));
        ws.send(JSON.stringify({ type: 'room_list', rooms: publicRooms }));
        break;
      }
      case 'join_room': {
        if (!clientData.username || !chatRooms[data.roomName]) {
          ws.send(JSON.stringify({ type: 'error', message: 'Cannot join room' }));
          return;
        }
        joinRoom(ws, data.roomName);
        break;
      }
      case 'chat_message': {
        if (!clientData.currentRoom) {
          ws.send(JSON.stringify({ type: 'error', message: 'Join a room first' }));
          return;
        }
        handleChatMessage(ws, clientData.currentRoom, data.text);
        break;
      }
      case 'leave_room': leaveRoom(ws); break;
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

  room.messages.forEach(m => {
    ws.send(JSON.stringify({ type: 'message', user: m.user, text: m.text, isHostMsg: m.user === room.host }));
  });

  const joinMsg = joinMessages[Math.floor(Math.random() * joinMessages.length)].replace('%', clientData.username);
  broadcast(roomName, { type: 'message', user: 'System', text: joinMsg, isHostMsg: false });

  sendRoomListUpdate();
}

function leaveRoom(ws) {
  const clientData = clients.get(ws);
  if (!clientData.currentRoom) return;
  const room = chatRooms[clientData.currentRoom];
  room.users.delete(ws);

  const leaveMsg = leaveMessages[Math.floor(Math.random() * leaveMessages.length)].replace('%', clientData.username);
  broadcast(clientData.currentRoom, { type: 'message', user: 'System', text: leaveMsg, isHostMsg: false });

  if (room.users.size === 0) delete chatRooms[clientData.currentRoom];
  clientData.currentRoom = null;
  sendRoomListUpdate();
}

function handleChatMessage(ws, roomName, text) {
  const clientData = clients.get(ws);
  const room = chatRooms[roomName];
  if (room.muted.has(clientData.username)) return;

  if (text.startsWith('!cmd') && clientData.username === room.host) {
    handleCommand(ws, room, text);
    return;
  }

  const msg = { user: clientData.username, text };
  room.messages.push(msg);
  const coloredText = applyColorCodes(text);
  broadcast(roomName, { type: 'message', user: clientData.username, text: coloredText, isHostMsg: false });
}

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
      feedback = `muted ${arg}`;  // Correct use of backticks
    }
    break;

  case 'unmute':
    if (arg && room.muted.has(arg)) {
      room.muted.delete(arg);
      feedback = unmuted ${arg};  // **Error here! Missing backticks**
    }
    break;

  case 'kick': {
    if (arg) {
      const target = [...clients.entries()].find(
        ([sock, data]) => data.username === arg && room.users.has(sock)
      );
      if (target) {
        const [targetSock] = target;
        targetSock.send(
          JSON.stringify({ type: 'error', message: 'You have been kicked.' })
        );
        targetSock.close();
        feedback = kicked ${arg};  // **Error here! Missing backticks**
      }
    }
    break;
  }

  case 'clear':
    room.messages = [];
    feedback = 'cleared messages';
    break;

  case 'shutdown':
    room.users.forEach((u) => u.close());
    delete chatRooms[room.host];
    feedback = 'room shut down';
    break;

  case 'private':
    room.isPrivate = true;
    feedback = 'room is now private';
    break;

  case 'public':
    room.isPrivate = false;
    feedback = 'room is now public';
    break;

  case 'all':
    feedback =
      '%eAvailable Commands:%f !cmd mute <user>, !cmd unmute <user>, !cmd kick <user>, !cmd clear, !cmd shutdown, !cmd public, !cmd private, !cmd all';
    break;

  default:
    feedback = 'denied';
}

ws.send(
  JSON.stringify({ type: 'message', user: 'System', text: feedback, isHostMsg: false })
);
sendRoomListUpdate();


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

// Start the server
server.listen(port, () => {
  console.log(Server listening on port ${port});
});
function handleAdminCommand(ws, commandText) {
  const clientData = clients.get(ws);
  if (!clientData.admin) {
    ws.send(JSON.stringify({ type: 'error', message: 'Access denied: Admins only.' }));
    return;
  }

  const parts = commandText.trim().split(' ');
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1);

  switch (cmd) {
    case 'ban': {
      const userToBan = args[0];
      if (!userToBan) {
        ws.send(JSON.stringify({ type: 'error', message: 'Usage: ban <user>' }));
        return;
      }
      db.run(DELETE FROM users WHERE username = ?, [userToBan], function(err) {
        if (err) {
          ws.send(JSON.stringify({ type: 'error', message: 'Error banning user' }));
        } else {
          for (const [clientWs, data] of clients.entries()) {
            if (data.username === userToBan) {
              clientWs.send(JSON.stringify({ type: 'error', message: 'You have been banned.' }));
              clientWs.close();
              clients.delete(clientWs);
            }
          }
          ws.send(JSON.stringify({ type: 'message', message: User ${userToBan} banned. }));
        }
      });
      break;
    }
    case 'rename': {
      const oldName = args[0];
      const newName = args[1];
      if (!oldName || !newName) {
        ws.send(JSON.stringify({ type: 'error', message: 'Usage: rename <oldname> <newname>' }));
        return;
      }
      db.get(SELECT username FROM users WHERE username = ?, [newName], (err, row) => {
        if (row) {
          ws.send(JSON.stringify({ type: 'error', message: 'New username already exists.' }));
          return;
        }
        db.run(UPDATE users SET username = ? WHERE username = ?, [newName, oldName], function(err) {
          if (err) {
            ws.send(JSON.stringify({ type: 'error', message: 'Rename failed.' }));
          } else {
            ws.send(JSON.stringify({ type: 'message', message: ${oldName} renamed to ${newName} }));
            for (const [clientWs, data] of clients.entries()) {
              if (data.username === oldName) {
                data.username = newName;
                clientWs.send(JSON.stringify({ type: 'message', message: Your username was changed to ${newName} }));
              }
            }
          }
        });
      });
      break;
    }
    case 'promote': {
      const userToPromote = args[0];
      if (!userToPromote) {
        ws.send(JSON.stringify({ type: 'error', message: 'Usage: promote <user>' }));
        return;
      }
      db.run(UPDATE users SET admin = 1 WHERE username = ?, [userToPromote], function(err) {
        if (err) {
          ws.send(JSON.stringify({ type: 'error', message: 'Promote failed.' }));
        } else {
          ws.send(JSON.stringify({ type: 'message', message: ${userToPromote} promoted to admin. }));
        }
      });
      break;
    }
    case 'demote': {
      const userToDemote = args[0];
      if (!userToDemote) {
        ws.send(JSON.stringify({ type: 'error', message: 'Usage: demote <user>' }));
        return;
      }
      db.run(UPDATE users SET admin = 0 WHERE username = ?, [userToDemote], function(err) {
        if (err) {
          ws.send(JSON.stringify({ type: 'error', message: 'Demote failed.' }));
        } else {
          ws.send(JSON.stringify({ type: 'message', message: ${userToDemote} demoted. }));
        }
      });
      break;
    }
    case 'password': {
      const userToReset = args[0];
      const newPass = args[1];
      if (!userToReset || !newPass) {
        ws.send(JSON.stringify({ type: 'error', message: 'Usage: password <user> <newpassword>' }));
        return;
      }
      db.run(UPDATE users SET password = ? WHERE username = ?, [newPass, userToReset], function(err) {
        if (err) {
          ws.send(JSON.stringify({ type: 'error', message: 'Password reset failed.' }));
        } else {
          ws.send(JSON.stringify({ type: 'message', message: Password for ${userToReset} changed. }));
        }
      });
      break;
    }
    case 'mute': {
      const userToMute = args[0];
      if (!userToMute) {
        ws.send(JSON.stringify({ type: 'error', message: 'Usage: mute <user>' }));
        return;
      }
      Object.values(chatRooms).forEach(room => room.muted.add(userToMute));
      ws.send(JSON.stringify({ type: 'message', message: ${userToMute} muted globally. }));
      break;
    }
    case 'unmute': {
      const userToUnmute = args[0];
      if (!userToUnmute) {
        ws.send(JSON.stringify({ type: 'error', message: 'Usage: unmute <user>' }));
        return;
      }
      Object.values(chatRooms).forEach(room => room.muted.delete(userToUnmute));
      ws.send(JSON.stringify({ type: 'message', message: ${userToUnmute} unmuted globally. }));
      break;
    }
    case 'kick': {
      const userToKick = args[0];
      if (!userToKick) {
        ws.send(JSON.stringify({ type: 'error', message: 'Usage: kick <user>' }));
        return;
      }
      for (const [clientWs, data] of clients.entries()) {
        if (data.username === userToKick) {
          clientWs.send(JSON.stringify({ type: 'error', message: 'You have been kicked.' }));
          clientWs.close();
          clients.delete(clientWs);
          ws.send(JSON.stringify({ type: 'message', message: ${userToKick} kicked. }));
          return;
        }
      }
      ws.send(JSON.stringify({ type: 'error', message: 'User not found online.' }));
      break;
    }
    case 'clear': {
      const roomName = args[0];
      if (!roomName) {
        ws.send(JSON.stringify({ type: 'error', message: 'Usage: clear <room>' }));
        return;
      }
      const room = chatRooms[roomName];
      if (!room) {
        ws.send(JSON.stringify({ type: 'error', message: 'Room does not exist.' }));
        return;
      }
      room.messages = [];
      ws.send(JSON.stringify({ type: 'message', message: Messages cleared in ${roomName} }));
      break;
    }
    case 'rooms': {
      const list = Object.entries(chatRooms).map(([name, room]) => ${name} (${room.users.size} users)).join(', ');
      ws.send(JSON.stringify({ type: 'message', message: Active rooms: ${list} }));
      break;
    }
    case 'broadcast': {
      const msg = args.join(' ');
      if (!msg) {
        ws.send(JSON.stringify({ type: 'error', message: 'Usage: broadcast <message>' }));
        return;
      }
      Object.values(chatRooms).forEach(room => {
        broadcast(room.host, { type: 'message', user: 'Admin', text: msg });
      });
      ws.send(JSON.stringify({ type: 'message', message: 'Broadcast sent.' }));
      break;
    }
    case 'all': {
      const cmds = [
        'ban <user>', 'rename <oldname> <newname>', 'promote <user>',
        'demote <user>', 'password <user> <newpassword>',
        'mute <user>', 'unmute <user>', 'kick <user>',
        'clear <room>', 'rooms', 'broadcast <message>', 'all'
      ];
      ws.send(JSON.stringify({ type: 'message', message: 'Commands: ' + cmds.join(', ') }));
      break;
    }
    default:
      ws.send(JSON.stringify({ type: 'error', message: 'Unknown command' }));
  }
}
