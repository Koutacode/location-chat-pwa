// Client‑side script for the Location Chat PWA

(() => {
  // Global error handler: show a popup if any uncaught error occurs. This helps
  // surface issues in production deployments where a silent error might
  // prevent the UI from working as expected. Note: alerts are intrusive but
  // useful for debugging. Remove or disable in final production builds.
  window.addEventListener('error', (event) => {
    try {
      alert('Client error: ' + event.message);
    } catch (_) {
      // ignore if alert fails
    }
  });
  // Helper: format timestamp into readable HH:MM
  function formatTime(ts) {
    const date = new Date(ts);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // User/session state variables. These are set when the user logs in via the
  // overlay. Until then, the chat and location features are disabled.
  let userName = '';
  let roomName = '';
  let roomPass = '';
  let eventSource = null;
  let watchId = null;

  // DOM elements
  const messagesEl = document.getElementById('messages');
  const inputEl = document.getElementById('message-input');
  const sendBtn = document.getElementById('send-btn');
  const shareBtn = document.getElementById('share-btn');
  const inviteBtn = document.getElementById('invite-btn');
  const connectionStatusEl = document.getElementById('connection-status');
  const notifyToggle = document.getElementById('notify-toggle');
  const rememberLoginCheckbox = document.getElementById('remember-login');

  // File upload elements
  const fileBtn = document.getElementById('file-btn');
  const fileInput = document.getElementById('file-input');
  // Login overlay and inputs
  const loginOverlay = document.getElementById('login-overlay');
  const loginNameInput = document.getElementById('login-name');
  const loginRoomInput = document.getElementById('login-room');
  const loginPassInput = document.getElementById('login-pass');
  const loginBtn = document.getElementById('login-btn');
  const deleteRoomBtn = document.getElementById('delete-room-btn');
  const logoutBtn = document.getElementById('logout-btn');
  // Dropdown of existing rooms and room display
  const roomsSelect = document.getElementById('rooms-select');
  const roomDisplay = document.getElementById('room-display');

  // Connection retry delay (exponential backoff) for SSE
  let reconnectDelay = 1000; // start with 1 second
  const maxReconnectDelay = 30000; // cap at 30 seconds
  let reconnectTimeoutId = null;

  // Whether to show notifications for incoming messages
  let notificationsEnabled = false;

      // Initialize map using Leaflet if available. Some deployment
      // environments may block external scripts (like Leaflet from unpkg),
      // which would leave `L` undefined. Guard against this so the rest of
      // the app (chat and location sharing) can still function without
      // throwing errors. When Leaflet is unavailable, the map element
      // remains blank and markers are ignored.
      let map = null;
      try {
        if (typeof L !== 'undefined') {
          map = L.map('map').setView([35.0, 135.0], 3); // Default to Japan
          L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '&copy; OpenStreetMap contributors',
          }).addTo(map);
        } else {
          console.warn('Leaflet library is not loaded; map disabled');
        }
      } catch (err) {
        console.error('Failed to initialize map:', err);
        map = null;
      }

  // Store markers keyed by user name
  const markers = {};

  /**
   * Clean up the current session: stop SSE, stop geolocation, clear markers and
   * messages, and reset UI to the login overlay. This is used when the user
   * logs out.
   */
  function resetSession() {
    // Stop SSE
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
    // Cancel pending reconnect attempts
    if (reconnectTimeoutId) {
      clearTimeout(reconnectTimeoutId);
      reconnectTimeoutId = null;
    }
    // Stop geolocation watch
    if (watchId != null) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
      // Reset share button state
      shareBtn.disabled = false;
      shareBtn.textContent = '位置共有開始';
    }
    // Remove our own marker from the map
    if (markers[userName]) {
      if (map && map.removeLayer) {
        map.removeLayer(markers[userName]);
      }
      delete markers[userName];
    }
    // Clear chat messages
    messagesEl.innerHTML = '';
    // Reset state variables
    userName = '';
    roomName = '';
    roomPass = '';
    // Show login overlay and hide logout button
    loginOverlay.style.display = 'flex';
    logoutBtn.style.display = 'none';
    // Clear the current room display when logged out
    if (roomDisplay) {
      roomDisplay.textContent = '';
    }
    // Reset connection status indicator
    if (connectionStatusEl) {
      connectionStatusEl.textContent = '未接続';
    }
  }

  /**
   * Add or update a marker on the map for a user.
   *
   * @param {string} name User name
   * @param {number} lat Latitude
   * @param {number} lon Longitude
   */
      function updateMarker(name, lat, lon) {
        // Only attempt to update markers if a map is available
        if (!map) return;
        if (markers[name]) {
          markers[name].setLatLng([lat, lon]);
        } else {
          // Guard against L being undefined
          if (typeof L !== 'undefined') {
            const marker = L.marker([lat, lon]).addTo(map);
            marker.bindPopup(name);
            markers[name] = marker;
          }
        }
        // If this update is for our current user, re-center the map. Without
        // centering, the marker may be off-screen because the default view is
        // central Japan. Only adjust for our own user.
        if (name === userName) {
          const currentZoom = map.getZoom();
          const desiredZoom = currentZoom < 12 ? 12 : currentZoom;
          map.setView([lat, lon], desiredZoom);
        }
      }

  /**
   * Append a message to the chat area.
   *
   * @param {Object} msg Message object with name, text, time
   */
  function appendMessage(msg) {
    const wrapper = document.createElement('div');
    wrapper.className = 'message';
    const nameSpan = document.createElement('span');
    nameSpan.className = 'name';
    nameSpan.textContent = msg.name;
    const timeSpan = document.createElement('span');
    timeSpan.className = 'time';
    timeSpan.textContent = formatTime(msg.time);
    const textSpan = document.createElement('span');
    textSpan.className = 'text';
    textSpan.textContent = ' ' + msg.text;
    wrapper.appendChild(nameSpan);
    wrapper.appendChild(timeSpan);
    wrapper.appendChild(textSpan);
    messagesEl.appendChild(wrapper);
    // Scroll to bottom
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  /**
   * Send a chat message to the server.
   */
  function sendMessage() {
    if (!userName || !roomName) return;
    const textVal = inputEl.value.trim();
    if (!textVal) return;
    const url = `/message?room=${encodeURIComponent(roomName)}&password=${encodeURIComponent(roomPass)}&name=${encodeURIComponent(userName)}&text=${encodeURIComponent(textVal)}`;
    fetch(url, { method: 'GET' });
    inputEl.value = '';
  }

  // Event listeners for sending messages
  sendBtn.addEventListener('click', sendMessage);
  inputEl.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      sendMessage();
    }
  });

  // Request geolocation and continuously send updates
  function startSharing() {
    if (!userName || !roomName) return;
    if (!navigator.geolocation) {
      alert('このブラウザでは位置情報がサポートされていません');
      return;
    }
    shareBtn.disabled = true;
    shareBtn.textContent = '共有中…';
    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        const urlLoc = `/location?room=${encodeURIComponent(roomName)}&password=${encodeURIComponent(roomPass)}&name=${encodeURIComponent(userName)}&lat=${latitude}&lon=${longitude}`;
        fetch(urlLoc, { method: 'GET' });
      },
      (err) => {
        console.error(err);
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }
    );
  }
  shareBtn.addEventListener('click', startSharing);

  /**
   * Start the SSE connection for the current room and password. Handles
   * receiving chat messages and location updates.
   */
  function startSSE() {
    if (!roomName) return;
    // Close any existing connection
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
    // Cancel any pending reconnect
    if (reconnectTimeoutId) {
      clearTimeout(reconnectTimeoutId);
      reconnectTimeoutId = null;
    }
    const url = `/events?room=${encodeURIComponent(roomName)}&password=${encodeURIComponent(roomPass)}`;
    // Inner function to establish connection with reconnection logic
    const connect = () => {
      // Ensure we still have a room and not logged out
      if (!roomName) return;
      // Open SSE
      try {
        eventSource = new EventSource(url);
      } catch (err) {
        console.error('Failed to create EventSource', err);
        scheduleReconnect();
        return;
      }
      // On open
      eventSource.onopen = () => {
        console.log('SSE connection established');
        // Reset reconnect delay on success
        reconnectDelay = 1000;
        if (connectionStatusEl) connectionStatusEl.textContent = '接続中';
      };
      // Generic error handler
      eventSource.onerror = (err) => {
        console.error('SSE error', err);
        if (connectionStatusEl) connectionStatusEl.textContent = '再接続中…';
        // Close connection before reconnecting
        if (eventSource) {
          eventSource.close();
          eventSource = null;
        }
        scheduleReconnect();
      };
      // Receive chat messages
      eventSource.addEventListener('message', (e) => {
        try {
          const msg = JSON.parse(e.data);
          appendMessage(msg);
          // Show notification if enabled
          if (notificationsEnabled && Notification.permission === 'granted') {
            // Only notify when the page is not visible to reduce noise
            if (document.hidden || !document.hasFocus()) {
              try {
                new Notification(`${msg.name} (${formatTime(msg.time)})`, { body: msg.text });
              } catch (_) {
                // Ignore if notification fails
              }
            }
          }
        } catch (err) {
          console.error('Failed to parse message event', err);
        }
      });
      // Receive location updates
      eventSource.addEventListener('location', (e) => {
        try {
          const loc = JSON.parse(e.data);
          updateMarker(loc.name, loc.lat, loc.lon);
        } catch (err) {
          console.error('Failed to parse location event', err);
        }
      });
      // Receive remove events for markers
      eventSource.addEventListener('remove', (e) => {
        try {
          const data = JSON.parse(e.data);
          const name = data.name;
          if (markers[name]) {
            if (map && map.removeLayer) {
              map.removeLayer(markers[name]);
            }
            delete markers[name];
          }
        } catch (err) {
          console.error('Failed to parse remove event', err);
        }
      });
    };
    // Schedule a reconnect with exponential backoff
    function scheduleReconnect() {
      if (reconnectTimeoutId) return;
      reconnectTimeoutId = setTimeout(() => {
        reconnectTimeoutId = null;
        reconnectDelay = Math.min(reconnectDelay * 2, maxReconnectDelay);
        connect();
      }, reconnectDelay);
    }
    // Initiate first connection
    connect();
  }

  // Handle login button: collect credentials and start session. Before
  // proceeding, validate the password for existing rooms via the
  // /checkRoom endpoint. If the password is wrong, display an error and
  // do not proceed.
  loginBtn.addEventListener('click', async () => {
    const nameVal = loginNameInput.value.trim();
    const roomVal = loginRoomInput.value.trim();
    const passVal = loginPassInput.value;
    if (!nameVal || !roomVal) {
      alert('名前とルーム名を入力してください');
      return;
    }
    try {
      // Verify password for existing rooms. If the room does not exist
      // yet, the server returns 404 and we treat it as a new room. If the
      // password is incorrect, the server returns 403 and we abort.
      const respCheck = await fetch(
        `/checkRoom?room=${encodeURIComponent(roomVal)}&password=${encodeURIComponent(passVal)}`,
        { method: 'GET' }
      );
      if (respCheck.status === 403) {
        alert('パスワードが間違っています');
        return;
      }
      // If status is 404 (room does not exist) or 200 (password matches),
      // proceed to join/create the room.
    } catch (err) {
      // Network or other errors shouldn't block room creation. Log and continue.
      console.error('パスワード確認中にエラーが発生しました', err);
    }
    userName = nameVal;
    roomName = roomVal;
    roomPass = passVal || '';
    // Hide login overlay and show logout button
    loginOverlay.style.display = 'none';
    logoutBtn.style.display = 'block';
    // Show the current room name in the header when logged in
    if (roomDisplay) {
      roomDisplay.textContent = 'ルーム: ' + roomName;
    }
    // Save login details based on remember checkbox
    saveLogin();
    // Start SSE for this room
    startSSE();
  });

  // Handle delete room button: attempts to remove a room (must match password)
  deleteRoomBtn.addEventListener('click', async () => {
    const roomVal = loginRoomInput.value.trim();
    const passVal = loginPassInput.value;
    if (!roomVal) {
      alert('削除するルーム名を入力してください');
      return;
    }
    try {
      const resp = await fetch(`/deleteRoom?room=${encodeURIComponent(roomVal)}&password=${encodeURIComponent(passVal)}`, { method: 'GET' });
      const text = await resp.text();
      if (resp.ok) {
        alert('ルームを削除しました');
        // Optionally clear inputs
        loginRoomInput.value = '';
        loginPassInput.value = '';
        // Refresh the rooms list after deletion
        fetchRooms();
      } else {
        alert('削除に失敗: ' + text);
      }
    } catch (err) {
      alert('削除リクエストに失敗しました');
    }
  });

  // Handle logout button: clear session and notify server to remove location
  logoutBtn.addEventListener('click', () => {
    if (roomName && userName) {
      // Notify server to remove our location from the room
      fetch(`/logout?room=${encodeURIComponent(roomName)}&password=${encodeURIComponent(roomPass)}&name=${encodeURIComponent(userName)}`, { method: 'GET' });
    }
    resetSession();
    // Refresh the rooms list after logging out (new rooms may have been created)
    fetchRooms();
  });

  // Handle invite button: generate a shareable link for this room
  if (inviteBtn) {
    inviteBtn.addEventListener('click', async () => {
      if (!roomName) {
        alert('ルームに入室してから招待リンクを生成してください');
        return;
      }
      try {
        const resp = await fetch(`/invite/create?room=${encodeURIComponent(roomName)}&password=${encodeURIComponent(roomPass)}`, { method: 'GET' });
        if (!resp.ok) {
          const txt = await resp.text();
          alert('招待リンク生成に失敗しました: ' + txt);
          return;
        }
        const data = await resp.json();
        const link = `${window.location.origin}${data.link}`;
        // Copy to clipboard if possible
        try {
          await navigator.clipboard.writeText(link);
          alert(`招待リンクをコピーしました:\n${link}`);
        } catch (err) {
          // Fallback: show prompt with link
          prompt('招待リンク (コピーして共有してください)', link);
        }
      } catch (err) {
        alert('招待リンク生成中にエラーが発生しました');
      }
    });
  }

  // Handle notification toggle: request permission and update flag
  if (notifyToggle) {
    notifyToggle.addEventListener('change', async () => {
      if (notifyToggle.checked) {
        if (Notification.permission === 'granted') {
          notificationsEnabled = true;
        } else if (Notification.permission !== 'denied') {
          try {
            const perm = await Notification.requestPermission();
            notificationsEnabled = perm === 'granted';
            if (!notificationsEnabled) {
              notifyToggle.checked = false;
            }
          } catch (err) {
            notificationsEnabled = false;
            notifyToggle.checked = false;
          }
        } else {
          // Permission denied previously
          alert('通知の権限が許可されていません。ブラウザの設定から許可してください。');
          notificationsEnabled = false;
          notifyToggle.checked = false;
        }
      } else {
        notificationsEnabled = false;
      }
    });
  }

  // Handle file upload button and input
  if (fileBtn && fileInput) {
    // When the file button is clicked, open the file picker
    fileBtn.addEventListener('click', () => {
      if (!userName || !roomName) {
        alert('ルームに入室してからファイルを送信してください');
        return;
      }
      fileInput.click();
    });
    // When a file is selected, read and upload it
    fileInput.addEventListener('change', () => {
      if (!fileInput.files || fileInput.files.length === 0) return;
      const file = fileInput.files[0];
      // Limit file size to, e.g., 10 MB to prevent huge uploads
      const maxSize = 10 * 1024 * 1024;
      if (file.size > maxSize) {
        alert('10MB以下のファイルのみ送信できます');
        fileInput.value = '';
        return;
      }
      const reader = new FileReader();
      reader.onload = async () => {
        const dataUrl = reader.result;
        const base64 = dataUrl.split(',')[1];
        const mimeType = file.type || '';
        const payload = {
          name: userName,
          room: roomName,
          password: roomPass,
          fileName: file.name,
          mimeType: mimeType,
          data: base64,
        };
        try {
          const resp = await fetch('/upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          // If the server does not accept POST (for example, returns 405 or 403),
          // fall back to sending the data via a GET request with query parameters.
          if (!resp || !resp.ok) {
            const urlGet = `/upload?room=${encodeURIComponent(roomName)}&password=${encodeURIComponent(roomPass)}&name=${encodeURIComponent(userName)}&fileName=${encodeURIComponent(file.name)}&mimeType=${encodeURIComponent(mimeType)}&data=${encodeURIComponent(base64)}`;
            await fetch(urlGet, { method: 'GET' });
          }
        } catch (err) {
          // If POST request fails entirely (network error), try GET as fallback
          try {
            const urlGet = `/upload?room=${encodeURIComponent(roomName)}&password=${encodeURIComponent(roomPass)}&name=${encodeURIComponent(userName)}&fileName=${encodeURIComponent(file.name)}&mimeType=${encodeURIComponent(mimeType)}&data=${encodeURIComponent(base64)}`;
            await fetch(urlGet, { method: 'GET' });
          } catch (err2) {
            alert('ファイル送信に失敗しました');
          }
        }
        // Reset file input so the same file can be chosen again
        fileInput.value = '';
      };
      reader.readAsDataURL(file);
    });
  }

  /**
   * Save login details to localStorage if the remember checkbox is checked.
   */
  function saveLogin() {
    if (!rememberLoginCheckbox) return;
    if (rememberLoginCheckbox.checked) {
      const data = { name: userName, room: roomName, pass: roomPass };
      try {
        localStorage.setItem('kotachat-login', JSON.stringify(data));
      } catch (err) {
        console.warn('Could not save login info', err);
      }
    } else {
      try {
        localStorage.removeItem('kotachat-login');
      } catch (err) {
        // ignore
      }
    }
  }

  /**
   * Load saved login details from localStorage and populate the form fields.
   */
  function loadSavedLogin() {
    if (!rememberLoginCheckbox) return;
    try {
      const stored = localStorage.getItem('kotachat-login');
      if (stored) {
        const data = JSON.parse(stored);
        if (data.name) loginNameInput.value = data.name;
        if (data.room) loginRoomInput.value = data.room;
        if (data.pass) loginPassInput.value = data.pass;
        rememberLoginCheckbox.checked = true;
      }
    } catch (err) {
      console.warn('Could not load saved login info', err);
    }
  }

  /**
   * If a token is provided in the URL (invite), redeem it to prefill room/pass.
   */
  async function checkInviteToken() {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    if (!token) return;
    try {
      const resp = await fetch(`/invite/join?token=${encodeURIComponent(token)}`);
      if (!resp.ok) {
        const txt = await resp.text();
        alert('招待リンクが無効です: ' + txt);
        return;
      }
      const data = await resp.json();
      if (data.room) loginRoomInput.value = data.room;
      if (data.password) loginPassInput.value = data.password;
      // Move to end: highlight fields
      if (rememberLoginCheckbox) rememberLoginCheckbox.checked = false;
      alert('招待リンクが適用されました。ニックネームを入力して入室してください');
    } catch (err) {
      alert('招待リンクの処理中にエラーが発生しました');
    }
  }


  // Register service worker for PWA functionality.
  // To ensure that users always receive the latest assets, first unregister any
  // existing service workers before registering the current one. Without this
  // step, older service workers may continue to serve stale cached files,
  // causing the UI to appear outdated.
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      // Load saved login details before populating rooms
      loadSavedLogin();
      // Check if a token is present in the URL (invite) and prefill room/password
      checkInviteToken().finally(() => {
        // Populate the list of available rooms on initial load
        fetchRooms();
      });
      navigator.serviceWorker
        .getRegistrations()
        .then((regs) => {
          return Promise.all(
            regs.map((reg) => {
              return reg.unregister();
            }),
          );
        })
        .catch(() => {
          // Ignore errors during unregister; likely no service workers yet
        })
        .finally(() => {
          navigator.serviceWorker
            .register('/service-worker.js', { updateViaCache: 'none' })
            .then(() => {
              console.log('Service worker registered (updated)');
            })
            .catch((err) => {
              console.error('Service worker registration failed', err);
            });
        });
    });
  }

  /**
   * Fetch the list of available rooms from the server and populate the
   * dropdown. The first option remains a placeholder and is not removed.
   */
  async function fetchRooms() {
    if (!roomsSelect) return;
    try {
      const resp = await fetch('/rooms');
      if (!resp.ok) return;
      const list = await resp.json();
      // Remove existing options except the first placeholder
      while (roomsSelect.options.length > 1) {
        roomsSelect.remove(1);
      }
      list.forEach((room) => {
        const opt = document.createElement('option');
        opt.value = room;
        opt.textContent = room;
        roomsSelect.appendChild(opt);
      });
    } catch (err) {
      console.error('Failed to fetch rooms', err);
    }
  }

  // When a room is selected from the dropdown, update the room input
  if (roomsSelect) {
    roomsSelect.addEventListener('change', () => {
      const val = roomsSelect.value;
      if (val) {
        loginRoomInput.value = val;
      }
    });
  }
})();