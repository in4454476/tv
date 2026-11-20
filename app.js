const PLAYLIST_URL = "https://iptv-org.github.io/iptv/index.language.m3u";
const VOLUME_STEP = 0.04;
const BATCH_SIZE = 150; // Renders channels in chunks for fast APK performance

let allChannels = [];
let filteredChannels = [];
let renderedCount = 0;
let currentIndex = -1;
let currentPlayingChannel = null;
let favorites = JSON.parse(localStorage.getItem('iptv_favorites')) || [];
let savedSearchQuery = localStorage.getItem('iptv_search_query') || "";
let showOnlyFavorites = false;
let hls = null;
let nowPlayingTimeout = null;
let volumeTimeout = null;
let statusTimeout = null;
let activeItemEl = null;

const video = document.getElementById('videoPlayer');
const playerSection = document.getElementById('playerSection');
const channelListEl = document.getElementById('channelList');
const channelCountEl = document.getElementById('channelCount');
const nowPlayingEl = document.getElementById('nowPlaying');
const volumeOsd = document.getElementById('volumeOsd');
const waitingSpinner = document.getElementById('waitingSpinner');
const streamStatus = document.getElementById('streamStatus');
const playerFavBtn = document.getElementById('playerFavBtn');
const searchInput = document.getElementById('searchInput');
const clearSearchBtn = document.getElementById('clearSearchBtn');
const favFilterBtn = document.getElementById('favFilterBtn');

function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function showSpinner() { waitingSpinner.classList.remove('d-none'); }
function hideSpinner() { waitingSpinner.classList.add('d-none'); }

function showStatusMessage(msg, duration = 3500) {
  streamStatus.textContent = msg;
  streamStatus.classList.remove('d-none');
  clearTimeout(statusTimeout);
  if (duration > 0) {
    statusTimeout = setTimeout(() => streamStatus.classList.add('d-none'), duration);
  }
}

function hideStatusMessage() {
  clearTimeout(statusTimeout);
  streamStatus.classList.add('d-none');
}

video.addEventListener('loadstart', showSpinner);
video.addEventListener('waiting', showSpinner);
video.addEventListener('stalled', showSpinner);
video.addEventListener('playing', () => { hideSpinner(); hideStatusMessage(); });
video.addEventListener('canplay', hideSpinner);
video.addEventListener('error', () => {
  hideSpinner();
  if (video.src) showStatusMessage("Stream unavailable or blocked", 3500);
});

function syncFavFilterIcon() {
  favFilterBtn.textContent = showOnlyFavorites ? "★" : "☆";
  favFilterBtn.classList.toggle("active", showOnlyFavorites);
}

function releaseKeyboardFocus() {
  if (document.activeElement && document.activeElement !== document.body && document.activeElement !== searchInput) {
    document.activeElement.blur();
  }
  if (video) video.blur();
}

function showVolumeOsd(vol) {
  volumeOsd.textContent = `Volume: ${Math.round(vol * 100)}%`;
  volumeOsd.classList.remove('opacity-0');
  clearTimeout(volumeTimeout);
  volumeTimeout = setTimeout(() => volumeOsd.classList.add('opacity-0'), 1000);
}

function hideBannerAd(event) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  if (typeof hideBannerAdFunction === "function") {
    hideBannerAdFunction();
  } else {
    clearInterval(countdownTimer);
    document.getElementById('adOverlay').classList.add('d-none');
  }
}

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    playerSection.requestFullscreen().catch(() => {});
  } else {
    document.exitFullscreen();
  }
  releaseKeyboardFocus();
}

window.addEventListener('keydown', (e) => {
  const tag = document.activeElement ? document.activeElement.tagName : '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

  if (e.key === 'F11') {
    e.preventDefault();
    toggleFullscreen();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    stepChannelBy(-1);
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    stepChannelBy(1);
  } else if (e.key === 'ArrowRight') {
    e.preventDefault();
    video.volume = Math.min(1, +(video.volume + VOLUME_STEP).toFixed(2));
    showVolumeOsd(video.volume);
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    video.volume = Math.max(0, +(video.volume - VOLUME_STEP).toFixed(2));
    showVolumeOsd(video.volume);
  }
}, true);

function stepChannelBy(delta) {
  const total = filteredChannels.length;
  if (total === 0) return;

  let baseIdx = currentIndex;
  if (baseIdx < 0 || baseIdx >= total) {
    baseIdx = currentPlayingChannel ? Math.max(0, filteredChannels.findIndex(ch => ch._id === currentPlayingChannel._id)) : 0;
  }

  currentIndex = (baseIdx + delta + total) % total;
  playChannel(filteredChannels[currentIndex], true, currentIndex);
}

function playNextChannel() { stepChannelBy(1); releaseKeyboardFocus(); }
function playPreviousChannel() { stepChannelBy(-1); releaseKeyboardFocus(); }

function handleSearchInput() {
  const val = searchInput.value;
  localStorage.setItem('iptv_search_query', val);
  clearSearchBtn.style.display = val.length > 0 ? 'block' : 'none';
  filterChannels();
}

function clearSearch() {
  searchInput.value = "";
  localStorage.removeItem('iptv_search_query');
  clearSearchBtn.style.display = 'none';
  filterChannels();
  releaseKeyboardFocus();
}

async function fetchAndParseM3U(url) {
  channelCountEl.textContent = "Downloading playlist...";
  channelListEl.innerHTML = "";
  showSpinner();
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error("Failed to load M3U URL");
    const text = await response.text();
    parseM3U(text);
  } catch (err) {
    channelCountEl.textContent = "Error: " + err.message;
    hideSpinner();
  }
}

function parseM3U(data) {
  const lines = data.split('\n');
  const channels = [];
  let currentChannel = {};
  let idCounter = 0;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (line.startsWith('#EXTINF:')) {
      const commaIndex = line.lastIndexOf(',');
      const name = commaIndex !== -1 ? line.substring(commaIndex + 1).trim() : 'Unknown Channel';
      const logoMatch = line.match(/tvg-logo="([^"]*)"/);
      const logo = logoMatch && logoMatch[1] ? logoMatch[1] : '';
      const groupMatch = line.match(/group-title="([^"]*)"/);
      const group = groupMatch && groupMatch[1] ? groupMatch[1] : 'General';
      currentChannel = { name, logo, group };
    } else if (line && !line.startsWith('#')) {
      currentChannel.url = line;
      currentChannel._id = idCounter++;
      if (currentChannel.name) channels.push(currentChannel);
      currentChannel = {};
    }
  }

  allChannels = shuffleArray(channels);

  if (savedSearchQuery) {
    searchInput.value = savedSearchQuery;
    clearSearchBtn.style.display = 'block';
  }

  filterChannels();

  if (filteredChannels.length > 0) {
    currentIndex = 0;
    playChannel(filteredChannels[0], true, 0);
  } else if (allChannels.length > 0) {
    currentIndex = 0;
    playChannel(allChannels[0], true, 0);
  } else {
    hideSpinner();
  }
}

// Incremental Batch Rendering for fast APK performance
function appendChannelBatch() {
  if (renderedCount >= filteredChannels.length) return;
  const end = Math.min(renderedCount + BATCH_SIZE, filteredChannels.length);
  const fragment = document.createDocumentFragment();

  for (let idx = renderedCount; idx < end; idx++) {
    const ch = filteredChannels[idx];
    const isFav = favorites.includes(ch.url);
    const isActive = currentPlayingChannel && currentPlayingChannel._id === ch._id;

    const li = document.createElement('li');
    li.className = `channel-item d-flex align-items-center px-3 py-2 gap-2 ${isActive ? 'active' : ''}`;
    li.dataset.index = idx;
    if (isActive) activeItemEl = li;

    const img = document.createElement('img');
    img.className = 'bg-black rounded p-1 flex-shrink-0';
    img.src = ch.logo || 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36"><rect width="36" height="36" fill="%23222"/><text x="50%" y="55%" font-size="12" fill="%23aaa" text-anchor="middle">TV</text></svg>';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.onerror = function() { this.onerror = null; this.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36"><rect width="36" height="36" fill="%23222"/><text x="50%" y="55%" font-size="12" fill="%23aaa" text-anchor="middle">TV</text></svg>'; };

    const info = document.createElement('div');
    info.className = 'overflow-hidden flex-grow-1';
    info.onclick = () => selectAndPlayByIndex(idx);

    const nameDiv = document.createElement('div');
    nameDiv.className = 'text-truncate small fw-semibold';
    nameDiv.textContent = ch.name;

    const groupDiv = document.createElement('div');
    groupDiv.className = 'text-truncate text-white-50';
    groupDiv.style.fontSize = '0.75rem';
    groupDiv.textContent = ch.group;

    info.appendChild(nameDiv);
    info.appendChild(groupDiv);

    const favBtn = document.createElement('button');
    favBtn.type = 'button';
    favBtn.className = `btn btn-link text-decoration-none p-1 fs-5 flex-shrink-0 fav-btn ${isFav ? 'favorited' : 'text-secondary'}`;
    favBtn.textContent = isFav ? '★' : '☆';
    favBtn.onclick = (e) => toggleFavorite(ch.url, e);

    li.appendChild(img);
    li.appendChild(info);
    li.appendChild(favBtn);
    fragment.appendChild(li);
  }

  channelListEl.appendChild(fragment);
  renderedCount = end;
}

channelListEl.addEventListener('scroll', () => {
  if (channelListEl.scrollTop + channelListEl.clientHeight >= channelListEl.scrollHeight - 250) {
    appendChannelBatch();
  }
});

function renderChannels() {
  channelListEl.innerHTML = "";
  activeItemEl = null;
  renderedCount = 0;
  appendChannelBatch();
}

function updateActiveHighlight(idx) {
  while (renderedCount <= idx && renderedCount < filteredChannels.length) {
    appendChannelBatch();
  }
  if (activeItemEl) activeItemEl.classList.remove('active');
  const target = channelListEl.querySelector(`.channel-item[data-index="${idx}"]`);
  if (target) {
    target.classList.add('active');
    activeItemEl = target;
    target.scrollIntoView({ block: 'nearest' });
  }
}

function selectAndPlayByIndex(index) {
  if (index >= 0 && index < filteredChannels.length) {
    currentIndex = index;
    playChannel(filteredChannels[currentIndex], true, currentIndex);
    releaseKeyboardFocus();
  }
}

function toggleFavorite(url, event) {
  event.stopPropagation();
  updateFavoriteStatus(url);
  releaseKeyboardFocus();
}

function toggleCurrentChannelFavorite() {
  if (currentPlayingChannel) updateFavoriteStatus(currentPlayingChannel.url);
  releaseKeyboardFocus();
}

function updateFavoriteStatus(url) {
  const index = favorites.indexOf(url);
  if (index > -1) favorites.splice(index, 1);
  else favorites.push(url);
  localStorage.setItem('iptv_favorites', JSON.stringify(favorites));
  
  if (currentPlayingChannel && currentPlayingChannel.url === url) {
    const isFav = favorites.includes(url);
    playerFavBtn.textContent = isFav ? '★' : '☆';
    playerFavBtn.classList.toggle('favorited', isFav);
  }

  channelListEl.querySelectorAll('.fav-btn').forEach((btn) => {
    const idx = parseInt(btn.parentElement.dataset.index, 10);
    if (filteredChannels[idx] && filteredChannels[idx].url === url) {
      const isFavNow = favorites.includes(url);
      btn.textContent = isFavNow ? '★' : '☆';
      btn.classList.toggle('favorited', isFavNow);
      btn.classList.toggle('text-secondary', !isFavNow);
    }
  });

  if (showOnlyFavorites) filterChannels();
}

function toggleFavoriteFilter() {
  showOnlyFavorites = !showOnlyFavorites;
  syncFavFilterIcon();
  filterChannels();
  releaseKeyboardFocus();
}

function filterChannels() {
  const query = searchInput.value.toLowerCase().trim();
  filteredChannels = allChannels.filter(ch => {
    const matchesSearch = ch.name.toLowerCase().includes(query) || ch.group.toLowerCase().includes(query);
    const matchesFav = showOnlyFavorites ? favorites.includes(ch.url) : true;
    return matchesSearch && matchesFav;
  });
  
  renderChannels();
  channelCountEl.textContent = `Showing: ${filteredChannels.length} channels`;

  if (currentPlayingChannel) {
    const foundIdx = filteredChannels.findIndex(ch => ch._id === currentPlayingChannel._id);
    if (foundIdx !== -1) {
      currentIndex = foundIdx;
      updateActiveHighlight(foundIdx);
    } else {
      currentIndex = -1;
    }
  }
}

function playDirectStream(streamUrl) {
  if (hls) { hls.destroy(); hls = null; }
  video.src = streamUrl;
  video.play().catch(e => {
    hideSpinner();
    if (e && e.name === "NotAllowedError") showStatusMessage("Click Play on video to start stream", 3500);
  });
}

function playChannel(channel, shouldScroll = true, explicitIndex = null) {
  if (!channel) return;
  currentPlayingChannel = channel;
  hideStatusMessage();
  showSpinner();

  const targetIdx = explicitIndex !== null ? explicitIndex : filteredChannels.findIndex(ch => ch._id === channel._id);
  if (targetIdx !== -1) {
    currentIndex = targetIdx;
    if (shouldScroll) updateActiveHighlight(targetIdx);
  }

  const isFav = favorites.includes(channel.url);
  playerFavBtn.textContent = isFav ? '★' : '☆';
  playerFavBtn.classList.toggle('favorited', isFav);

  nowPlayingEl.textContent = `Playing: ${channel.name}`;
  nowPlayingEl.classList.remove('fade-out');
  clearTimeout(nowPlayingTimeout);
  nowPlayingTimeout = setTimeout(() => nowPlayingEl.classList.add('fade-out'), 3000);

  if (typeof startAdScheduler === "function") startAdScheduler();

  if (Hls.isSupported() && channel.url.toLowerCase().includes('.m3u8')) {
    if (hls) hls.destroy();
    hls = new Hls();
    hls.loadSource(channel.url);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      video.play().catch(e => {
        hideSpinner();
        if (e && e.name === "NotAllowedError") showStatusMessage("Click Play on video to start stream", 3500);
      });
    });
    hls.on(Hls.Events.ERROR, (event, data) => {
      if (data.fatal) { hideSpinner(); showStatusMessage("Stream error or unavailable", 3500); }
    });
  } else {
    playDirectStream(channel.url);
  }
}

// Banner Ads Logic
const AD_CONFIG = {
  intervalMinutes: 1,            
  displayDurationSeconds: 10,    
  adsList: [
    {
      image: "https://blogger.googleusercontent.com/img/b/R29vZ2xl/AVvXsEha13scaPuuz4m1Ey5kTaalY7TZ0GCMTTKDGEOPr7YUvzp8sggUPATKz2UmDvy0US_YTKEBgXcSqRp5zIvTi6-80fJCADWhTSxfbRFaJTkLFWXHWUViUIx-uUv6SO0RnwTFXZE6JBxUSzGDs6LW3vt6OeoyTMlFsuKWBezeTnFI__QY0y5FAd_M_v3VGMss/s2624/ad.jpg",
      link: "https://3052654247286.gumroad.com/l/tibfqd?_gl=1*1kt4nd4*_ga*NDA0MDY0MjQzLjE3ODk4NzIyMDg.*_ga_6LJN6D94N6*czE3OTQ2MzU5NDgkbzQkZzEkdDE3OTQ2MzYwMzIkajQ5JGwwJGgw"
    }
  ]
};

let adIntervalTimer = null;
let countdownTimer = null;
let currentAdIndex = 0;

const adOverlay = document.getElementById('adOverlay');
const adCountdown = document.getElementById('adCountdown');
const adLink = document.getElementById('adLink');
const adImage = document.getElementById('adImage');

function startAdScheduler() {
  stopAdScheduler();
  adIntervalTimer = setInterval(showBannerAd, AD_CONFIG.intervalMinutes * 60 * 1000);
}

function showBannerAd() {
  if (!AD_CONFIG.adsList.length || !adOverlay || !adImage || !adLink) return;
  const ad = AD_CONFIG.adsList[currentAdIndex];
  adImage.src = ad.image;
  adLink.href = ad.link;
  currentAdIndex = (currentAdIndex + 1) % AD_CONFIG.adsList.length;

  let timeLeft = AD_CONFIG.displayDurationSeconds;
  if (adCountdown) adCountdown.innerText = timeLeft;
  adOverlay.classList.remove('d-none');

  clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    timeLeft--;
    if (adCountdown) adCountdown.innerText = timeLeft;
    if (timeLeft <= 0) hideBannerAd();
  }, 1000);
}

function stopAdScheduler() {
  clearInterval(adIntervalTimer);
  hideBannerAd();
}

window.onload = () => {
  syncFavFilterIcon();
  fetchAndParseM3U(PLAYLIST_URL);
  if (typeof startAdScheduler === "function") startAdScheduler();
};
