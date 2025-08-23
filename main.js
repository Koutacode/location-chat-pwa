// Client‑side script for the Location Chat PWA

(() => {
  // Helper: format timestamp into readable HH:MM
  function formatTime(ts) {
    const date = new Date(ts);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // Prompt the user for a display name; remember in localStorage
  let userName = localStorage.getItem('lc_userName') || '';
  if (!userName) {
    userName = prompt('表示名を入力してください (任意の名前)');
    if (!userName) {
      // If no name provided, generate a random guest name
      userName = 'ユーザー' + Math.floor(Math.random() * 1000);
    }
    localStorage.setItem('lc_userName', userName);
  }

  // DOM elements
  const messagesEl = document.getElementById('messages');
  const inputEl = document.getElementById('message-input');
  const sendBtn = document.getElementById('send-btn');
  const shareBtn = document.getElementById('share-btn');

  // Initialize map using Leaflet
  const map = L.map('map').setView([35.0, 135.0], 3); // Default to Japan
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);

  // Store markers keyed by user name
  const markers = {};

  /**
   * Add or update a marker on the map for a user.
   *
   * @param {string} name User name
   * @param {number} lat Latitude
   * @param {number} lon Longitude
   */
  function updateMarker(name, lat, lon) {
    if (markers[name]) {
      markers[name].setLatLng([lat, lon]);
    } else {
      const marker = L.marker([lat, lon]).addTo(map);
      marker.bindPopup(name);
      markers[name] = marker;
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
    const textVal = inputEl.value.trim();
    if (!textVal) return;
    const url = `/message?name=${encodeURIComponent(userName)}&text=${encodeURIComponent(textVal)}`;
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
  let watchId = null;
  function startSharing() {
    if (!navigator.geolocation) {
      alert('このブラウザでは位置情報がサポートされていません');
      return;
    }
    shareBtn.disabled = true;
    shareBtn.textContent = '共有中…';
    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        const urlLoc = `/location?name=${encodeURIComponent(userName)}&lat=${latitude}&lon=${longitude}`;
        fetch(urlLoc, { method: 'GET' });
      },
      (err) => {
        console.error(err);
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }
    );
  }
  shareBtn.addEventListener('click', startSharing);

  // Establish Server‑Sent Events connection to receive real‑time updates
  const es = new EventSource('/events');
  es.addEventListener('open', () => {
    console.log('SSE connection established');
  });
  es.addEventListener('error', (err) => {
    console.error('SSE error', err);
  });
  // Receive chat messages
  es.addEventListener('message', (e) => {
    try {
      const msg = JSON.parse(e.data);
      appendMessage(msg);
    } catch (err) {
      console.error('Failed to parse message event', err);
    }
  });
  // Receive location updates
  es.addEventListener('location', (e) => {
    try {
      const loc = JSON.parse(e.data);
      updateMarker(loc.name, loc.lat, loc.lon);
    } catch (err) {
      console.error('Failed to parse location event', err);
    }
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