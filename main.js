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
  // Login overlay and inputs
  const loginOverlay = document.getElementById('login-overlay');
  const loginNameInput = document.getElementById('login-name');
  const loginRoomInput = document.getElementById('login-room');
  const loginPassInput = document.getElementById('login-pass');
  const loginBtn = document.getElementById('login-btn');
  const deleteRoomBtn = document.getElementById('delete-room-btn');
  const logoutBtn = document.getElementById('logout-btn');

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
    }
    const url = `/events?room=${encodeURIComponent(roomName)}&password=${encodeURIComponent(roomPass)}`;
    eventSource = new EventSource(url);
    eventSource.addEventListener('open', () => {
      console.log('SSE connection established');
    });
    eventSource.addEventListener('error', (err) => {
      console.error('SSE error', err);
    });
    // Receive chat messages
    eventSource.addEventListener('message', (e) => {
      try {
        const msg = JSON.parse(e.data);
        appendMessage(msg);
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
  }

  // Handle login button: collect credentials and start session
  loginBtn.addEventListener('click', () => {
    const nameVal = loginNameInput.value.trim();
    const roomVal = loginRoomInput.value.trim();
    const passVal = loginPassInput.value;
    if (!nameVal || !roomVal) {
      alert('名前とルーム名を入力してください');
      return;
    }
    userName = nameVal;
    roomName = roomVal;
    roomPass = passVal || '';
    // Hide login overlay and show logout button
    loginOverlay.style.display = 'none';
    logoutBtn.style.display = 'block';
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
  });

  // Register service worker for PWA functionality
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker
        .register('/service-worker.js')
        .then(() => {
          console.log('Service worker registered');
        })
        .catch((err) => {
          console.error('Service worker registration failed', err);
        });
    });
  }
})();