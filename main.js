(() => {
  // ====== 状態 ======
  let userName = '';
  let roomName = '';
  let roomPass = '';
  let eventSource = null;
  let watchId = null;

  // SSE再接続用バックオフ設定
  let reconnectDelay = 1000;
  let reconnectTimeoutId = null;
  let notificationsEnabled = false;

  // Leaflet のマップと参加者位置マーカー管理
  let map = null;
  const markers = {};
  let hasCentered = false; // 自分の初回位置更新で一度だけセンタリング

  // ====== DOM要素 ======
  const messagesEl         = document.getElementById('messages');
  const inputEl            = document.getElementById('message-input');
  const sendBtn            = document.getElementById('send-btn');
  const shareBtn           = document.getElementById('share-btn');
  const inviteBtn          = document.getElementById('invite-btn');
  const connectionStatusEl = document.getElementById('connection-status');
  const notifyToggle       = document.getElementById('notify-toggle');
  const rememberLoginCheckbox = document.getElementById('remember-login');
  const userListEl         = document.getElementById('user-list');  // 参加者一覧

  // ログイン用オーバーレイUI
  const loginOverlay   = document.getElementById('login-overlay');
  const loginNameInput = document.getElementById('login-name');
  const loginRoomInput = document.getElementById('login-room');
  const loginPassInput = document.getElementById('login-pass');
  const loginBtn       = document.getElementById('login-btn');
  const deleteRoomBtn  = document.getElementById('delete-room-btn');
  const logoutBtn      = document.getElementById('logout-btn');

  // ルーム選択ドロップダウン・表示
  const roomsSelect    = document.getElementById('rooms-select');
  const roomDisplay    = document.getElementById('room-display');

  // ====== ユーティリティ ======

  /** 日付オブジェクトを時刻文字列に */
  function formatTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  /** メッセージを DOM に追加表示 */
  function appendMessage(msg) {
    const wrap  = document.createElement('div');
    wrap.className = 'message';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'name';
    nameSpan.textContent = msg.name;

    const timeSpan = document.createElement('span');
    timeSpan.className = 'time';
    timeSpan.textContent = formatTime(msg.time);

    wrap.appendChild(nameSpan);
    wrap.appendChild(timeSpan);

    if (msg.text) {
      const textSpan = document.createElement('span');
      textSpan.className = 'text';
      textSpan.textContent = ' ' + msg.text;
      wrap.appendChild(textSpan);
    }

    messagesEl.appendChild(wrap);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  /** 参加者一覧の表示を更新 */
  function updateUserList() {
    if (!userListEl) return;
    const names = Object.keys(markers).sort((a,b) => a.localeCompare(b,'ja'));
    userListEl.innerHTML = '';
    for (const n of names) {
      const pill = document.createElement('div');
      pill.className = 'user-list-item';
      pill.textContent = n;
      userListEl.appendChild(pill);
    }
  }

  /** マーカーを更新、初回のみ自動センタリング */
  function updateMarker(name, lat, lon) {
    if (!map) return;
    if (markers[name]) {
      markers[name].setLatLng([lat, lon]);
    } else {
      if (typeof L !== 'undefined') {
        const marker = L.marker([lat, lon]).addTo(map);
        marker.bindPopup(name);
        markers[name] = marker;
      }
    }
    // 自分のマーカー更新時は最初の1回のみセンタリング
    if (name === userName && !hasCentered) {
      const currentZoom = map.getZoom();
      const desiredZoom = currentZoom < 12 ? 12 : currentZoom;
      map.setView([lat, lon], desiredZoom);
      hasCentered = true;
    }
    updateUserList();
  }

  /** メッセージ送信 */
  function sendMessage() {
    if (!userName || !roomName) return;
    const txt = inputEl.value.trim();
    if (!txt) return;

    const url = `/message?room=${encodeURIComponent(roomName)}&password=${encodeURIComponent(roomPass)}&name=${encodeURIComponent(userName)}&text=${encodeURIComponent(txt)}`;
    fetch(url, { method: 'GET' });
    inputEl.value = '';
  }

  // 送信イベントの二重送信防止・IME確定中ガード
  let lastSendAt = 0;
  function safeSend() {
    const now = Date.now();
    if (now - lastSendAt < 350) return;
    lastSendAt = now;
    sendMessage();
  }

  /** 位置情報共有を開始 */
  function startSharing() {
    if (!userName || !roomName) return;
    if (!navigator.geolocation) {
      alert('このブラウザは位置情報に対応していません');
      return;
    }
    shareBtn.disabled = true;
    shareBtn.textContent = '共有中…';
    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        const url = `/location?room=${encodeURIComponent(roomName)}&password=${encodeURIComponent(roomPass)}&name=${encodeURIComponent(userName)}&lat=${latitude}&lon=${longitude}`;
        fetch(url, { method: 'GET' });
      },
      () => {},
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }
    );
  }

  /** SSEを開始 */
  function startSSE() {
    if (!roomName) return;

    // 既存接続を閉じて再接続処理を初期化
    if (eventSource) { eventSource.close(); eventSource = null; }
    if (reconnectTimeoutId) {
      clearTimeout(reconnectTimeoutId);
      reconnectTimeoutId = null;
    }

    const url = `/events?room=${encodeURIComponent(roomName)}&password=${encodeURIComponent(roomPass)}`;

    function connect() {
      if (!roomName) return;

      try {
        eventSource = new EventSource(url);
      } catch (err) {
        scheduleReconnect();
        return;
      }

      eventSource.onopen = () => {
        reconnectDelay = 1000;
        if (connectionStatusEl) connectionStatusEl.textContent = '接続中';
      };

      eventSource.onerror = () => {
        if (connectionStatusEl) connectionStatusEl.textContent = '再接続中…';
        if (eventSource) {
          eventSource.close();
          eventSource = null;
        }
        scheduleReconnect();
      };

      // メッセージ受信
      eventSource.addEventListener('message', (e) => {
        try {
          const msg = JSON.parse(e.data);
          appendMessage(msg);
          // 通知を表示
          if (notificationsEnabled && Notification.permission === 'granted') {
            if (document.hidden || !document.hasFocus()) {
              try {
                new Notification(`${msg.name} (${formatTime(msg.time)})`, { body: msg.text });
              } catch {}
            }
          }
        } catch {}
      });

      // 位置更新受信
      eventSource.addEventListener('location', (e) => {
        try {
          const loc = JSON.parse(e.data);
          updateMarker(loc.name, loc.lat, loc.lon);
          updateUserList(); // 念のため
        } catch {}
      });

      // 参加者が離脱
      eventSource.addEventListener('remove', (e) => {
        try {
          const data = JSON.parse(e.data);
          const name = data.name;
          if (markers[name]) {
            if (map && map.removeLayer) map.removeLayer(markers[name]);
            delete markers[name];
            updateUserList();
          }
        } catch {}
      });
    }

    function scheduleReconnect() {
      if (reconnectTimeoutId) return;
      reconnectTimeoutId = setTimeout(() => {
        reconnectTimeoutId = null;
        reconnectDelay = Math.min(reconnectDelay * 2, 30000);
        connect();
      }, reconnectDelay);
    }

    connect();
  }

  /** セッションのリセット（ログアウト等に使用） */
  function resetSession() {
    // SSEを停止
    if (eventSource) { eventSource.close(); eventSource = null; }
    // 再接続タイマーをクリア
    if (reconnectTimeoutId) {
      clearTimeout(reconnectTimeoutId);
      reconnectTimeoutId = null;
    }
    // 位置共有停止
    if (watchId != null) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
      shareBtn.disabled = false;
      shareBtn.textContent = '位置共有開始';
    }
    // 自分のマーカーを削除
    if (markers[userName]) {
      if (map && map.removeLayer) map.removeLayer(markers[userName]);
      delete markers[userName];
    }
    // チャット欄をクリア
    messagesEl.innerHTML = '';
    // 状態変数をクリア
    userName = '';
    roomName = '';
    roomPass = '';
    // ログインUIを表示、ログアウトボタンを非表示
    loginOverlay.style.display = 'flex';
    logoutBtn.style.display = 'none';
    // ルーム表示をクリア
    if (roomDisplay) roomDisplay.textContent = '';
    // 接続ステータスを更新
    if (connectionStatusEl) connectionStatusEl.textContent = '未接続';
    // 参加者リストをクリア・センタリングフラグをリセット
    if (userListEl) userListEl.innerHTML = '';
    hasCentered = false;
  }

  // ====== ログイン・ログアウト ======

  loginBtn.addEventListener('click', async () => {
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

    loginOverlay.style.display = 'none';
    logoutBtn.style.display = 'block';
    if (roomDisplay) roomDisplay.textContent = 'ルーム: ' + roomName;

    saveLogin();
    startSSE();
  });

  logoutBtn.addEventListener('click', () => {
    if (roomName && userName) {
      fetch(`/logout?room=${encodeURIComponent(roomName)}&password=${encodeURIComponent(roomPass)}&name=${encodeURIComponent(userName)}`, { method: 'GET' });
    }
    resetSession();
  });

  // 招待リンク生成ボタン
  inviteBtn.addEventListener('click', async () => {
    if (!roomName) {
      alert('ルームに入室してから招待リンクを生成してください');
      return;
    }
    try {
      const resp = await fetch(`/invite/create?room=${encodeURIComponent(roomName)}&password=${encodeURIComponent(roomPass)}`, { method: 'GET' });
      if (!resp.ok) {
        alert('招待リンク生成に失敗しました');
        return;
      }
      const data = await resp.json();
      const link = `${window.location.origin}${data.link}`;
      try {
        await navigator.clipboard.writeText(link);
        alert(`招待リンクをコピーしました:\n${link}`);
      } catch {
        prompt('招待リンク（コピーして共有してください）', link);
      }
    } catch {
      alert('招待リンク生成中にエラーが発生しました');
    }
  });

  // 送信ボタンとキーイベント
  sendBtn.addEventListener('click', safeSend);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      safeSend();
    }
  });
  inputEl.addEventListener('focus', () => {
    setTimeout(() => {
      try {
        inputEl.scrollIntoView({ block: 'center' });
      } catch {}
    }, 250);
  });

  // 通知トグル
  if (notifyToggle) {
    notifyToggle.addEventListener('change', async () => {
      if (notifyToggle.checked) {
        if (Notification.permission === 'granted') {
          notificationsEnabled = true;
        } else if (Notification.permission !== 'denied') {
          try {
            notificationsEnabled = (await Notification.requestPermission()) === 'granted';
          } catch {
            notificationsEnabled = false;
          }
          if (!notificationsEnabled) notifyToggle.checked = false;
        } else {
          alert('ブラウザの設定で通知がブロックされています');
          notificationsEnabled = false;
          notifyToggle.checked = false;
        }
      } else {
        notificationsEnabled = false;
      }
    });
  }

  // ルーム選択ドロップダウン
  if (roomsSelect) {
    roomsSelect.addEventListener('change', () => {
      const val = roomsSelect.value;
      if (val) loginRoomInput.value = val;
    });
  }

  // 既存ルーム一覧取得
  async function fetchRooms() {
    if (!roomsSelect) return;
    try {
      const resp = await fetch('/rooms');
      if (!resp.ok) return;
      const list = await resp.json();
      while (roomsSelect.options.length > 1) roomsSelect.remove(1);
      list.forEach((room) => {
        const opt = document.createElement('option');
        opt.value = room;
        opt.textContent = room;
        roomsSelect.appendChild(opt);
      });
    } catch {}
  }

  // 入室情報保存
  function saveLogin() {
    if (!rememberLoginCheckbox) return;
    if (rememberLoginCheckbox.checked) {
      try {
        localStorage.setItem('kotachat-login', JSON.stringify({ name: userName, room: roomName, pass: roomPass }));
      } catch {}
    } else {
      try {
        localStorage.removeItem('kotachat-login');
      } catch {}
    }
  }

  // 保存済み入室情報読み込み
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
    } catch {}
  }

  // 招待トークン付きURLを処理
  async function checkInviteToken() {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    if (!token) return;
    try {
      const resp = await fetch(`/invite/join?token=${encodeURIComponent(token)}`);
      if (!resp.ok) {
        alert('招待リンクが無効または期限切れです');
        return;
      }
      const data = await resp.json();
      if (data.room) loginRoomInput.value = data.room;
      if (data.password) loginPassInput.value = data.password;
      if (rememberLoginCheckbox) rememberLoginCheckbox.checked = false;
      alert('招待リンクを適用しました。ニックネームを入力して入室してください。');
    } catch {
      alert('招待リンクの適用に失敗しました');
    }
  }

  // ====== 起動時処理 ======
  window.addEventListener('load', async () => {
    // Leaflet初期化
    try {
      if (typeof L !== 'undefined') {
        map = L.map('map').setView([35.0, 135.0], 3);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          attribution: '© OpenStreetMap contributors',
        }).addTo(map);
      } else {
        console.warn('Leafletが読み込まれていないため地図機能は無効です');
      }
    } catch (err) {
      console.error('Leafletの初期化に失敗しました:', err);
      map = null;
    }
    loadSavedLogin();
    await checkInviteToken();
    await fetchRooms();
  });

  // 位置共有ボタン
  shareBtn.addEventListener('click', startSharing);
})();
